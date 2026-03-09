"""
This is written as a separate script for now. Need to integrate it with pytest suite using fastapi's TestClient
"""

import requests
import os
import time
from dotenv import load_dotenv


load_dotenv()

BASE_URL =  os.getenv("MCP_SERVER_PUBLIC_URL")
REGISTER_URL = f"{BASE_URL}/register"

# Mirror limits defined in remote_auth.py
MAX_STRING_LENGTH = 256
MAX_CLIENT_NAME_LENGTH = 80
MAX_SCOPE_LENGTH  = 100
MAX_REDIRECT_URIS = 3


def test_register_rate_limit():
    """Test that rate limiting kicks in after 5 requests within 60 seconds."""
    payload = {
        "client_name": "TestClient",
        "redirect_uris": ["https://example.com/callback"],
        "grant_types": ["authorization_code"],
        "response_types": ["code"]
    }

    for i in range(7):
        response = requests.post(REGISTER_URL, json=payload)
        print(f"Request {i+1}: status={response.status_code}")
        if response.status_code == 429:
            print("  ✓ Rate limit triggered as expected")
            return True

    print("✗ Rate limit was NOT triggered after 7 requests")
    return False


VALID_PAYLOAD = {
    "client_name": "TestClient",
    "redirect_uris": ["https://example.com/callback"],
    "grant_types": ["authorization_code"],
    "response_types": ["code"]
}

def test_tokens_refill_after_window():
    """Exhaust the bucket, wait for refill, confirm requests succeed again."""
    print("\n=== Token Refill After Window ===")

    # Exhaust the bucket
    for i in range(6):
        r = requests.post(REGISTER_URL, json=VALID_PAYLOAD)
        print(f"  Exhaust {i+1}: {r.status_code}")

    # Wait for bucket to refill (60s window + small buffer)
    print("  Waiting 65 seconds for bucket to refill...")
    time.sleep(65)

    # Should succeed again
    for i in range(3):
        r = requests.post(REGISTER_URL, json=VALID_PAYLOAD)
        print(f"  Post-refill {i+1}: {r.status_code}")
        assert r.status_code == 200, f"Expected 200 after refill, got {r.status_code}"

    print("  ✓ Tokens refilled correctly after window")



def test_different_ip_independent_limits():
    """
    NOTE: IP spoofing is possible in testing only because test client and server are both running the same server (localhost)
    """
    print("\n=== Per-IP Independent Limits (manual/infra test) ===")
    print("  ⚠ This test requires two different source IPs to validate properly.")
    print("  Simulate by sending X-Forwarded-For headers if your app trusts them:")

    headers_ip1 = {"X-Forwarded-For": "10.0.0.1"}
    headers_ip2 = {"X-Forwarded-For": "10.0.0.2"}

    # Exhaust from IP1
    for i in range(6):
        r = requests.post(REGISTER_URL, json=VALID_PAYLOAD, headers=headers_ip1)
        print(f"  IP1 request {i+1}: {r.status_code}")

    # IP2 should still be unaffecte
    r = requests.post(REGISTER_URL, json=VALID_PAYLOAD, headers=headers_ip2)
    print(f"  IP2 request after IP1 exhausted: {r.status_code}")
    if r.status_code == 200:
        print("  ✓ Per-IP rate limiting working (IP2 unaffected by IP1)")
    else:
        print("  ⚠ IP2 was blocked — rate limiter may be global, not per-IP")


def test_oom_via_large_payload_flood():
    """
    Attempt a DOS via OOM by repeatedly registering clients with maximum-size
    valid payloads — no IP spoofing, no forged headers.

    Attack surface:
      Each successful POST /register stores a DynamicClientRegistrationRequest
      in `registed_clients_store` with a 10-hour TTL.  If an attacker can
      sustain registrations across multiple rate-limit windows, the cumulative
      heap footprint of stored objects may exhaust server memory.

    What this test measures:
      1. Whether the server accepts max-size payloads without rejecting them
         (i.e. current validators do not cap total request body size).
      2. Whether response latency increases over successive windows, which
         indicates growing memory / GC pressure.
      3. Whether the server returns 5xx errors or drops connections entirely,
         which indicates an OOM crash or restart.

    Each window sends REQUESTS_PER_WINDOW requests (≤ rate-limit cap) with
    a payload sized as close to the per-field maximums as possible:
      - 5 redirect_uris × 256 chars each
      - client_name of 256 chars
      - scope of 256 chars
    After every window the test waits for the rate-limit bucket to refill.
    """
    print("\n=== OOM DOS via Large Payload Flood ===")

    # Build a URI that is exactly MAX_STRING_LENGTH characters long.
    # Format: "https://" (8) + filler (244) + ".com" (4) = 256
    _filler = "a" * (MAX_CLIENT_NAME_LENGTH - len("https://") - len(".com"))
    max_redirect_uri = f"https://{_filler}.com"

    max_payload = {
        "client_name": "x" * MAX_CLIENT_NAME_LENGTH,
        "redirect_uris": [max_redirect_uri] * MAX_REDIRECT_URIS,
        "scope": "s" * MAX_SCOPE_LENGTH,
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
    }

    NUM_WINDOWS        = 5   # number of rate-limit windows to iterate over
    REQUESTS_PER_WINDOW = 5  # stay within the per-window cap to keep registrations succeeding
    WINDOW_WAIT_SECONDS = 65 # slightly longer than the 60-second window

    total_sent        = 0
    total_ok          = 0
    total_rate_limited = 0
    total_errors      = 0
    response_times: list[float] = []

    for window in range(NUM_WINDOWS):
        print(f"\n  Window {window + 1}/{NUM_WINDOWS}  "
              f"(cumulative registrations so far: {total_ok})")

        for i in range(REQUESTS_PER_WINDOW):
            start = time.monotonic()
            try:
                r = requests.post(REGISTER_URL, json=max_payload, timeout=10)
                elapsed = time.monotonic() - start
                response_times.append(elapsed)
                total_sent += 1

                if r.status_code == 200:
                    total_ok += 1
                    print(f"    [{window+1}-{i+1}] 200 OK          ({elapsed:.3f}s)")
                elif r.status_code == 429:
                    total_rate_limited += 1
                    print(f"    [{window+1}-{i+1}] 429 Rate Limited ({elapsed:.3f}s)")
                elif r.status_code >= 500:
                    total_errors += 1
                    print(f"    [{window+1}-{i+1}] {r.status_code} SERVER ERROR  "
                          "— possible OOM / restart")
                else:
                    print(f"    [{window+1}-{i+1}] {r.status_code}               ({elapsed:.3f}s)")

            except requests.exceptions.ConnectionError:
                elapsed = time.monotonic() - start
                total_errors += 1
                total_sent += 1
                print(f"    [{window+1}-{i+1}] CONNECTION ERROR ({elapsed:.3f}s) "
                      "— server may be down (OOM crash?)")
            except requests.exceptions.Timeout:
                total_errors += 1
                total_sent += 1
                print(f"    [{window+1}-{i+1}] TIMEOUT          "
                      "— server unresponsive (memory pressure?)")

        if window < NUM_WINDOWS - 1:
            print(f"  Waiting {WINDOW_WAIT_SECONDS}s for rate-limit bucket to refill...")
            time.sleep(WINDOW_WAIT_SECONDS)

    # ── Final health probe ────────────────────────────────────────────────────
    print("\n  Final health probe with minimal payload...")
    try:
        probe_start = time.monotonic()
        probe = requests.post(REGISTER_URL, json=VALID_PAYLOAD, timeout=10)
        probe_elapsed = time.monotonic() - probe_start
        print(f"  Probe status: {probe.status_code}  ({probe_elapsed:.3f}s)")
        server_alive = probe.status_code in (200, 429)  # 429 still means server is up
    except (requests.exceptions.ConnectionError, requests.exceptions.Timeout):
        server_alive = False
        print("  Probe FAILED — server unreachable after flood")

    # ── Summary ───────────────────────────────────────────────────────────────
    print("\n  === Summary ===")
    print(f"  Total requests sent : {total_sent}")
    print(f"  200 OK              : {total_ok}  "
          f"(~{total_ok * len(str(max_payload))} bytes stored server-side, rough estimate)")
    print(f"  429 Rate Limited    : {total_rate_limited}")
    print(f"  Server errors/down  : {total_errors}")

    if response_times:
        first_half  = response_times[: len(response_times) // 2]
        second_half = response_times[len(response_times) // 2 :]
        avg_first  = sum(first_half)  / len(first_half)  if first_half  else 0
        avg_second = sum(second_half) / len(second_half) if second_half else 0
        print(f"  Avg latency (first half)  : {avg_first:.3f}s")
        print(f"  Avg latency (second half) : {avg_second:.3f}s")
        if avg_second > avg_first * 1.5:
            print("  ⚠ Latency increased >50 % over the course of the test "
                  "— possible memory pressure")
        else:
            print("  ✓ Latency remained stable")

    if not server_alive:
        print("  ✗ Server is unreachable after flood — OOM crash likely")
    elif total_errors > 0:
        print("  ⚠ Server returned errors during flood — investigate OOM risk")
    else:
        print("  ✓ Server survived the flood; "
              "review server-side memory metrics for long-term risk")


if __name__ == "__main__":
    test_register_rate_limit()
    test_different_ip_independent_limits()
    test_tokens_refill_after_window()
    test_oom_via_large_payload_flood()