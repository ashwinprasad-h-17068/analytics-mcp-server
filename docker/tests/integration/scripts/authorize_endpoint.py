"""
Integration tests for the /authorize endpoint.

Tests cover:
  1. Rate limiting (DOS prevention) – endpoint-specific standard rate limit
  2. Per-IP bucket isolation (requires BEHIND_PROXY + trusted proxy list)
  3. Payload / query-parameter size limits (FastAPI 422 responses)
  4. Flood probe across multiple rate-limit windows

Flow dependency:
  /register  →  /authorize

NOTE on rate-limit interaction:
  The global middleware rate limiter (capacity=30 req/60 s) applies to ALL
  requests regardless of path.  Running several test functions back-to-back
  may exhaust that global bucket before the endpoint-specific one (5 req/60 s).
  Add a short sleep between test functions or run them in separate processes
  if the global limiter starts interfering.

NOTE on 422 vs 429 ordering:
  FastAPI resolves query-parameter validation and `Depends(...)` in the same
  dependency-injection pass.  In practice, parameter validation errors (422)
  are returned before the rate-limiter dependency runs, so oversized-field
  tests should not consume rate-limit tokens.
"""

import base64
import hashlib
import os
import secrets
import time
from urllib.parse import parse_qs, urlparse

import requests
from dotenv import load_dotenv

load_dotenv()

BASE_URL      = os.getenv("MCP_SERVER_PUBLIC_URL")
REGISTER_URL  = f"{BASE_URL}/register"
AUTHORIZE_URL = f"{BASE_URL}/authorize"

# ── Configurable rate-limit parameters ───────────────────────────────────────
# Mirror the values in config.py / environment variables; adjust to match your
# deployment (PRIVATE vs PUBLIC scenario).
STANDARD_RATE_LIMIT_COUNT  = int(os.getenv("PRIVATE_OAUTH_STANDARD_RATE_LIMIT_COUNT",  "5"))
STANDARD_RATE_LIMIT_WINDOW = int(os.getenv("PRIVATE_OAUTH_STANDARD_RATE_LIMIT_WINDOW", "60"))

# ── Configurable /authorize query-parameter constraints ───────────────────────
# Mirror the Query(...) annotations in remote_auth.py
MAX_CLIENT_ID_LENGTH      = 100
MIN_CLIENT_ID_LENGTH      = 3
MAX_REDIRECT_URI_LENGTH   = 1000
MIN_REDIRECT_URI_LENGTH   = 10
MAX_SCOPE_LENGTH          = 100
MAX_STATE_LENGTH          = 500
MIN_STATE_LENGTH          = 8
MAX_CODE_CHALLENGE_LENGTH = 128
MIN_CODE_CHALLENGE_LENGTH = 43

# ── Fixed test values ─────────────────────────────────────────────────────────
VALID_REDIRECT_URI = "https://example.com/callback"
REGISTER_PAYLOAD = {
    "client_name": "AuthorizeTestClient",
    "redirect_uris": [VALID_REDIRECT_URI],
    "grant_types": ["authorization_code"],
    "response_types": ["code"],
}


# ── Shared helpers ────────────────────────────────────────────────────────────

def register_client() -> dict:
    """Register a fresh DCR client and return the full response JSON."""
    r = requests.post(REGISTER_URL, json=REGISTER_PAYLOAD)
    assert r.status_code == 200, f"Registration failed: {r.status_code} {r.text}"
    return r.json()


def make_pkce_pair(verifier_length: int = 64) -> tuple[str, str]:
    """
    Return (code_verifier, code_challenge) for S256 PKCE.
    code_verifier uses URL-safe base64 chars that satisfy ^[A-Za-z0-9\\-._~]+$.
    """
    code_verifier = secrets.token_urlsafe(verifier_length)[:verifier_length]
    digest        = hashlib.sha256(code_verifier.encode("ascii")).digest()
    code_challenge = (
        base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")
    )
    return code_verifier, code_challenge


def valid_authorize_params(client_id: str) -> dict:
    """Build a minimal, fully-valid set of /authorize query parameters."""
    _, code_challenge = make_pkce_pair()
    return {
        "client_id":            client_id,
        "redirect_uri":         VALID_REDIRECT_URI,
        "scope":                "ZohoAnalytics.fullaccess.all",
        "state":                "statevalue1",   # 11 chars – satisfies min_length=8
        "code_challenge":       code_challenge,
        "code_challenge_method": "S256",
    }


def get_transaction_id(client_id: str) -> str | None:
    """
    Call /authorize with valid params and extract the transaction_id from the
    302 Location header (redirect to /consent?transaction_id=<uuid>).
    Returns None on unexpected status.
    """
    params = valid_authorize_params(client_id)
    r      = requests.get(AUTHORIZE_URL, params=params, allow_redirects=False)
    if r.status_code != 302:
        return None
    location = r.headers.get("Location", "")
    qs       = parse_qs(urlparse(location).query)
    return qs.get("transaction_id", [None])[0]


# ── Rate-limit tests ──────────────────────────────────────────────────────────

def test_authorize_rate_limit() -> bool:
    """
    Exhaust the per-path standard rate-limit bucket and verify 429 is returned.

    The endpoint-specific rate limiter uses key '<path>:<client_ip>', so this
    bucket is separate from /register, /consent, /token, etc.
    All requests use valid-sized parameters to ensure they reach the limiter
    (oversized params would short-circuit at 422 before hitting the limiter).
    """
    print("\n=== /authorize Rate Limit Test ===")
    client = register_client()
    params = valid_authorize_params(client["client_id"])

    for i in range(STANDARD_RATE_LIMIT_COUNT + 3):
        r = requests.get(AUTHORIZE_URL, params=params, allow_redirects=False)
        print(f"  Request {i+1}: status={r.status_code}")
        if r.status_code == 429:
            print("  ✓ Rate limit triggered as expected")
            return True

    print("  ✗ Rate limit was NOT triggered after all requests")
    return False


def test_authorize_tokens_refill_after_window():
    """
    Exhaust the bucket, wait for the full window to elapse, then confirm that
    new requests are accepted again.
    """
    print(f"\n=== /authorize Token Refill After {STANDARD_RATE_LIMIT_WINDOW}s Window ===")
    client = register_client()
    params = valid_authorize_params(client["client_id"])

    # Exhaust the bucket
    for i in range(STANDARD_RATE_LIMIT_COUNT + 1):
        r = requests.get(AUTHORIZE_URL, params=params, allow_redirects=False)
        print(f"  Exhaust {i+1}: {r.status_code}")

    wait = STANDARD_RATE_LIMIT_WINDOW + 5
    print(f"  Waiting {wait}s for bucket to refill...")
    time.sleep(wait)

    # Register a new client so the rate-limited client_id doesn't matter
    client2 = register_client()
    params2 = valid_authorize_params(client2["client_id"])

    for i in range(2):
        r = requests.get(AUTHORIZE_URL, params=params2, allow_redirects=False)
        print(f"  Post-refill {i+1}: {r.status_code}")
        assert r.status_code in (302, 401), (
            f"Expected 302/401 after refill, got {r.status_code}"
        )

    print("  ✓ Bucket refilled correctly after window")


def test_different_ip_independent_limits():
    """
    Validate per-IP bucket isolation via X-Forwarded-For spoofing.

    IMPORTANT: This test only functions correctly when BEHIND_PROXY=True and
    the test runner's IP is listed in TRUSTED_PROXY_LIST.  Otherwise the
    server ignores the X-Forwarded-For header and both IPs map to the same
    bucket.
    """
    print("\n=== /authorize Per-IP Independent Limits ===")
    print("  ⚠ Requires BEHIND_PROXY=True and the test host in TRUSTED_PROXY_LIST")

    client = register_client()
    params = valid_authorize_params(client["client_id"])

    headers_ip1 = {"X-Forwarded-For": "10.0.0.1"}
    headers_ip2 = {"X-Forwarded-For": "10.0.0.2"}

    # Exhaust IP1's bucket
    for i in range(STANDARD_RATE_LIMIT_COUNT + 1):
        r = requests.get(
            AUTHORIZE_URL, params=params, headers=headers_ip1,
            allow_redirects=False
        )
        print(f"  IP1 request {i+1}: {r.status_code}")

    # IP2 should still have a full bucket
    r = requests.get(
        AUTHORIZE_URL, params=params, headers=headers_ip2,
        allow_redirects=False
    )
    print(f"  IP2 request after IP1 exhausted: {r.status_code}")
    if r.status_code in (302, 401, 400):
        print("  ✓ Per-IP rate limiting working (IP2 unaffected by IP1)")
    else:
        print("  ⚠ IP2 was blocked — rate limiter may be global, not per-IP")


# ── Payload / field-size limit tests ─────────────────────────────────────────

def test_client_id_too_long():
    """client_id > MAX_CLIENT_ID_LENGTH chars → 422."""
    print("\n=== /authorize client_id Too Long ===")
    params = {
        "client_id":   "a" * (MAX_CLIENT_ID_LENGTH + 1),
        "redirect_uri": VALID_REDIRECT_URI,
    }
    r = requests.get(AUTHORIZE_URL, params=params, allow_redirects=False)
    print(f"  Status: {r.status_code}")
    assert r.status_code == 422, f"Expected 422, got {r.status_code}"
    print("  ✓ Rejected oversized client_id")


def test_client_id_too_short():
    """client_id < MIN_CLIENT_ID_LENGTH chars → 422."""
    print("\n=== /authorize client_id Too Short ===")
    params = {
        "client_id":   "ab",          # 2 chars; min is 3
        "redirect_uri": VALID_REDIRECT_URI,
    }
    r = requests.get(AUTHORIZE_URL, params=params, allow_redirects=False)
    print(f"  Status: {r.status_code}")
    assert r.status_code == 422, f"Expected 422, got {r.status_code}"
    print("  ✓ Rejected undersized client_id")


def test_client_id_invalid_pattern():
    """client_id with chars outside ^[a-zA-Z0-9_\\-\\.]+$ → 422."""
    print("\n=== /authorize client_id Invalid Pattern ===")
    params = {
        "client_id":   "invalid client!",    # spaces and ! not in allowed set
        "redirect_uri": VALID_REDIRECT_URI,
    }
    r = requests.get(AUTHORIZE_URL, params=params, allow_redirects=False)
    print(f"  Status: {r.status_code}")
    assert r.status_code == 422, f"Expected 422, got {r.status_code}"
    print("  ✓ Rejected client_id with disallowed characters")


def test_redirect_uri_too_long():
    """redirect_uri > MAX_REDIRECT_URI_LENGTH chars → 422."""
    print("\n=== /authorize redirect_uri Too Long ===")
    params = {
        "client_id":   "someclientid",
        "redirect_uri": "https://example.com/" + "x" * MAX_REDIRECT_URI_LENGTH,
    }
    r = requests.get(AUTHORIZE_URL, params=params, allow_redirects=False)
    print(f"  Status: {r.status_code}")
    assert r.status_code == 422, f"Expected 422, got {r.status_code}"
    print("  ✓ Rejected oversized redirect_uri")


def test_redirect_uri_too_short():
    """redirect_uri < MIN_REDIRECT_URI_LENGTH chars → 422."""
    print("\n=== /authorize redirect_uri Too Short ===")
    params = {
        "client_id":   "someclientid",
        "redirect_uri": "http://x",    # 8 chars; min is 10
    }
    r = requests.get(AUTHORIZE_URL, params=params, allow_redirects=False)
    print(f"  Status: {r.status_code}")
    assert r.status_code == 422, f"Expected 422, got {r.status_code}"
    print("  ✓ Rejected undersized redirect_uri")


def test_scope_too_long():
    """scope > MAX_SCOPE_LENGTH chars → 422."""
    print("\n=== /authorize scope Too Long ===")
    client = register_client()
    params = {
        "client_id":   client["client_id"],
        "redirect_uri": VALID_REDIRECT_URI,
        "scope":        "s" * (MAX_SCOPE_LENGTH + 1),
    }
    r = requests.get(AUTHORIZE_URL, params=params, allow_redirects=False)
    print(f"  Status: {r.status_code}")
    assert r.status_code == 422, f"Expected 422, got {r.status_code}"
    print("  ✓ Rejected oversized scope")


def test_state_too_long():
    """state > MAX_STATE_LENGTH chars → 422."""
    print("\n=== /authorize state Too Long ===")
    client = register_client()
    params = {
        "client_id":   client["client_id"],
        "redirect_uri": VALID_REDIRECT_URI,
        "state":        "s" * (MAX_STATE_LENGTH + 1),
    }
    r = requests.get(AUTHORIZE_URL, params=params, allow_redirects=False)
    print(f"  Status: {r.status_code}")
    assert r.status_code == 422, f"Expected 422, got {r.status_code}"
    print("  ✓ Rejected oversized state")


def test_state_too_short():
    """state < MIN_STATE_LENGTH chars → 422 (min_length=8)."""
    print("\n=== /authorize state Too Short ===")
    client = register_client()
    params = {
        "client_id":   client["client_id"],
        "redirect_uri": VALID_REDIRECT_URI,
        "state":        "short",    # 5 chars; min is 8
    }
    r = requests.get(AUTHORIZE_URL, params=params, allow_redirects=False)
    print(f"  Status: {r.status_code}")
    assert r.status_code == 422, f"Expected 422, got {r.status_code}"
    print("  ✓ Rejected undersized state")


def test_code_challenge_too_long():
    """code_challenge > MAX_CODE_CHALLENGE_LENGTH chars → 422."""
    print("\n=== /authorize code_challenge Too Long ===")
    client = register_client()
    params = {
        "client_id":            client["client_id"],
        "redirect_uri":         VALID_REDIRECT_URI,
        "state":                "statevalue1",
        "code_challenge":       "A" * (MAX_CODE_CHALLENGE_LENGTH + 1),
        "code_challenge_method": "S256",
    }
    r = requests.get(AUTHORIZE_URL, params=params, allow_redirects=False)
    print(f"  Status: {r.status_code}")
    assert r.status_code == 422, f"Expected 422, got {r.status_code}"
    print("  ✓ Rejected oversized code_challenge")


def test_code_challenge_too_short():
    """code_challenge < MIN_CODE_CHALLENGE_LENGTH chars → 422 (min_length=43)."""
    print("\n=== /authorize code_challenge Too Short ===")
    client = register_client()
    params = {
        "client_id":            client["client_id"],
        "redirect_uri":         VALID_REDIRECT_URI,
        "state":                "statevalue1",
        "code_challenge":       "A" * (MIN_CODE_CHALLENGE_LENGTH - 1),  # 42 chars
        "code_challenge_method": "S256",
    }
    r = requests.get(AUTHORIZE_URL, params=params, allow_redirects=False)
    print(f"  Status: {r.status_code}")
    assert r.status_code == 422, f"Expected 422, got {r.status_code}"
    print("  ✓ Rejected undersized code_challenge")


# ── DOS flood probe ───────────────────────────────────────────────────────────

def test_authorize_large_payload_flood():
    """
    Attempt DOS via repeated /authorize requests carrying maximum-size valid
    parameters.

    Attack surface:
      Each accepted request causes the server to create an AuthorizationTransaction
      object stored in auth_transactions_store with a 120-second TTL.  If an
      attacker can sustain requests across rate-limit windows the cumulative
      heap footprint of stored transactions may degrade performance or exhaust
      memory.

    What this test measures:
      1. Whether the server accepts max-size parameters without rejecting them.
      2. Whether response latency degrades over successive windows (GC / memory
         pressure indicator).
      3. Whether the server returns 5xx errors or drops connections (OOM signal).

    REQUESTS_PER_WINDOW stays below STANDARD_RATE_LIMIT_COUNT so registrations
    keep succeeding; we intentionally probe the storage accumulation, not the
    rate limiter.
    """
    print("\n=== /authorize Large Payload Flood (DOS probe) ===")

    client            = register_client()
    _, code_challenge = make_pkce_pair()

    max_params = {
        "client_id":            client["client_id"],
        "redirect_uri":         VALID_REDIRECT_URI,
        "scope":                "s" * MAX_SCOPE_LENGTH,
        "state":                "s" * MAX_STATE_LENGTH,
        "code_challenge":       code_challenge,
        "code_challenge_method": "S256",
    }

    NUM_WINDOWS         = 3
    REQUESTS_PER_WINDOW = STANDARD_RATE_LIMIT_COUNT - 1  # stay within cap
    WINDOW_WAIT_SECONDS = STANDARD_RATE_LIMIT_WINDOW + 5

    total_sent = total_ok = total_rate_limited = total_errors = 0
    response_times: list[float] = []

    for window in range(NUM_WINDOWS):
        print(f"\n  Window {window+1}/{NUM_WINDOWS}  "
              f"(cumulative successful so far: {total_ok})")

        for i in range(REQUESTS_PER_WINDOW):
            start = time.monotonic()
            try:
                r       = requests.get(
                    AUTHORIZE_URL, params=max_params,
                    allow_redirects=False, timeout=10
                )
                elapsed = time.monotonic() - start
                response_times.append(elapsed)
                total_sent += 1

                if r.status_code in (302, 401, 400):
                    total_ok += 1
                    print(f"    [{window+1}-{i+1}] {r.status_code}  ({elapsed:.3f}s)")
                elif r.status_code == 429:
                    total_rate_limited += 1
                    print(f"    [{window+1}-{i+1}] 429 Rate Limited ({elapsed:.3f}s)")
                elif r.status_code >= 500:
                    total_errors += 1
                    print(f"    [{window+1}-{i+1}] {r.status_code} SERVER ERROR")
                else:
                    print(f"    [{window+1}-{i+1}] {r.status_code}  ({elapsed:.3f}s)")

            except requests.exceptions.ConnectionError:
                elapsed = time.monotonic() - start
                total_errors += 1
                total_sent   += 1
                print(f"    [{window+1}-{i+1}] CONNECTION ERROR ({elapsed:.3f}s) "
                      "— server may be down")
            except requests.exceptions.Timeout:
                total_errors += 1
                total_sent   += 1
                print(f"    [{window+1}-{i+1}] TIMEOUT — server unresponsive")

        # Re-register so the client stays fresh across windows
        client                  = register_client()
        max_params["client_id"] = client["client_id"]

        if window < NUM_WINDOWS - 1:
            print(f"  Waiting {WINDOW_WAIT_SECONDS}s for rate-limit bucket to refill...")
            time.sleep(WINDOW_WAIT_SECONDS)

    # ── Final health probe ────────────────────────────────────────────────────
    print("\n  Final health probe with minimal payload...")
    try:
        probe_client = register_client()
        probe_params = valid_authorize_params(probe_client["client_id"])
        probe_start  = time.monotonic()
        probe        = requests.get(
            AUTHORIZE_URL, params=probe_params,
            allow_redirects=False, timeout=10
        )
        probe_elapsed = time.monotonic() - probe_start
        print(f"  Probe: {probe.status_code}  ({probe_elapsed:.3f}s)")
        server_alive = probe.status_code in (302, 401, 400, 429)
    except (requests.exceptions.ConnectionError, requests.exceptions.Timeout):
        server_alive = False
        print("  Probe FAILED — server unreachable after flood")

    # ── Summary ───────────────────────────────────────────────────────────────
    print("\n  === Summary ===")
    print(f"  Total requests : {total_sent}")
    print(f"  Non-error      : {total_ok}")
    print(f"  Rate Limited   : {total_rate_limited}")
    print(f"  Server Errors  : {total_errors}")

    if response_times:
        half       = max(len(response_times) // 2, 1)
        avg_first  = sum(response_times[:half]) / half
        avg_second = sum(response_times[half:]) / max(len(response_times) - half, 1)
        print(f"  Avg latency first half  : {avg_first:.3f}s")
        print(f"  Avg latency second half : {avg_second:.3f}s")
        if avg_second > avg_first * 1.5:
            print("  ⚠ Latency increased >50% — possible server memory pressure")
        else:
            print("  ✓ Latency remained stable")

    if not server_alive:
        print("  ✗ Server unreachable after flood — possible OOM crash")
    elif total_errors > 0:
        print("  ⚠ Server returned errors — investigate memory risk")
    else:
        print("  ✓ Server survived; review server-side memory metrics for long-term risk")


if __name__ == "__main__":
    # Payload / field-size checks (fast, no waits)
    test_client_id_too_long()
    test_client_id_too_short()
    test_client_id_invalid_pattern()
    test_redirect_uri_too_long()
    test_redirect_uri_too_short()
    test_scope_too_long()
    test_state_too_long()
    test_state_too_short()
    test_code_challenge_too_long()
    test_code_challenge_too_short()

    # Rate-limit checks (may trigger waits)
    test_authorize_rate_limit()
    test_different_ip_independent_limits()
    test_authorize_large_payload_flood()

    # Long-running refill test — comment out if time-constrained
    test_authorize_tokens_refill_after_window()
