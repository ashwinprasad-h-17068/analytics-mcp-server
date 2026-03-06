"""
Integration tests for the /auth/callback endpoint.

Tests cover:
  1. Rate limiting (DOS prevention) – endpoint-specific standard rate limit
  2. Payload / query-parameter size limits (FastAPI 422 responses)
  3. Flood probe across multiple rate-limit windows

Flow dependency:
  /register  →  /authorize  →  /auth/callback

Background:
  /auth/callback is the Redirect URI that the upstream OAuth provider (Zoho
  Accounts) calls after the user grants consent.  In production:

    upstream provider  →  GET /auth/callback?code=<upstream_code>&state=<txn_id>

  The `state` parameter carries the proxy's transaction_id (created in
  /authorize).  This endpoint brokers the upstream code into a new proxy-
  issued authorization code and redirects the MCP client back to its
  redirect_uri.

  In testing we call /auth/callback directly.  We can:
  • Obtain a real transaction_id via /register → /authorize and use it as
    `state` to exercise the full happy path (302 redirect to client).
  • Use an arbitrary fake `state` value (within max_length=100) to exercise
    the "invalid transaction" error path (400) while still consuming a token
    in the rate-limit bucket.

NOTE on 422 vs 429 ordering:
  See authorize_endpoint.py for the same caveat on dependency-resolution order.
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
CALLBACK_URL  = f"{BASE_URL}/auth/callback"

# ── Configurable rate-limit parameters ───────────────────────────────────────
STANDARD_RATE_LIMIT_COUNT  = int(os.getenv("PRIVATE_OAUTH_STANDARD_RATE_LIMIT_COUNT",  "5"))
STANDARD_RATE_LIMIT_WINDOW = int(os.getenv("PRIVATE_OAUTH_STANDARD_RATE_LIMIT_WINDOW", "60"))

# ── Configurable /auth/callback query-parameter constraints ───────────────────
# Mirror Query(...) annotations in remote_auth.py
MAX_CODE_LENGTH     = 100
MAX_STATE_LENGTH    = 100
MAX_LOCATION_LENGTH = 200

# ── Fixed test values ─────────────────────────────────────────────────────────
VALID_REDIRECT_URI = "https://example.com/callback"
REGISTER_PAYLOAD = {
    "client_name": "CallbackTestClient",
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
    """Return (code_verifier, code_challenge) for S256 PKCE."""
    code_verifier  = secrets.token_urlsafe(verifier_length)[:verifier_length]
    digest         = hashlib.sha256(code_verifier.encode("ascii")).digest()
    code_challenge = base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")
    return code_verifier, code_challenge


def get_transaction_id(client_id: str) -> str | None:
    """
    Call /authorize and extract the transaction_id from the 302 Location header.
    Returns None on unexpected status.
    """
    _, code_challenge = make_pkce_pair()
    params = {
        "client_id":            client_id,
        "redirect_uri":         VALID_REDIRECT_URI,
        "scope":                "ZohoAnalytics.fullaccess.all",
        "state":                "statevalue1",
        "code_challenge":       code_challenge,
        "code_challenge_method": "S256",
    }
    r = requests.get(AUTHORIZE_URL, params=params, allow_redirects=False)
    if r.status_code != 302:
        return None
    location = r.headers.get("Location", "")
    qs       = parse_qs(urlparse(location).query)
    return qs.get("transaction_id", [None])[0]


def invoke_callback(
    code: str,
    state: str,
    location: str | None = None,
    **kwargs,
) -> requests.Response:
    """
    Call GET /auth/callback with the given parameters.
    allow_redirects=False by default so we can inspect the 302.
    """
    params: dict = {"code": code, "state": state}
    if location is not None:
        params["location"] = location
    return requests.get(CALLBACK_URL, params=params, allow_redirects=False, **kwargs)


# ── Rate-limit tests ──────────────────────────────────────────────────────────

def test_callback_rate_limit() -> bool:
    """
    Exhaust the per-path standard rate-limit bucket on /auth/callback and
    verify 429 is returned.

    Strategy:
      1. Obtain one real transaction_id so the first call can succeed (302).
      2. Reuse the same transaction_id for all subsequent requests.  The proxy
         does NOT delete the transaction after a successful callback, so
         repeated calls with the same state are 302 (or 302 again if the txn
         is still alive) until the rate limit kicks in.
      3. All code / state values are kept within their max_length bounds so
         that FastAPI validation passes and the rate-limiter dependency fires.
    """
    print("\n=== /auth/callback Rate Limit Test ===")
    client         = register_client()
    transaction_id = get_transaction_id(client["client_id"])
    assert transaction_id, "Could not obtain a transaction_id via /authorize"

    fake_upstream_code = "upstreamcode000001"   # within max_length=100

    for i in range(STANDARD_RATE_LIMIT_COUNT + 3):
        r = invoke_callback(
            code=fake_upstream_code,
            state=transaction_id,
        )
        print(f"  Request {i+1}: status={r.status_code}")
        if r.status_code == 429:
            print("  ✓ Rate limit triggered as expected")
            return True

    print("  ✗ Rate limit was NOT triggered after all requests")
    return False


def test_callback_tokens_refill_after_window():
    """Exhaust the /auth/callback bucket, wait for it to refill, confirm success."""
    print(f"\n=== /auth/callback Token Refill After {STANDARD_RATE_LIMIT_WINDOW}s Window ===")
    client         = register_client()
    transaction_id = get_transaction_id(client["client_id"])
    assert transaction_id, "Could not obtain a transaction_id via /authorize"

    for i in range(STANDARD_RATE_LIMIT_COUNT + 1):
        r = invoke_callback(code="upstreamcode000002", state=transaction_id)
        print(f"  Exhaust {i+1}: {r.status_code}")

    wait = STANDARD_RATE_LIMIT_WINDOW + 5
    print(f"  Waiting {wait}s for bucket to refill...")
    time.sleep(wait)

    # Obtain a fresh transaction for the post-refill check
    client2        = register_client()
    transaction_id2 = get_transaction_id(client2["client_id"])
    assert transaction_id2, "Could not obtain post-refill transaction_id"

    for i in range(2):
        r = invoke_callback(code="upstreamcode000003", state=transaction_id2)
        print(f"  Post-refill {i+1}: {r.status_code}")
        assert r.status_code in (302, 400), (
            f"Expected 302 or 400 after refill, got {r.status_code}"
        )
    print("  ✓ Bucket refilled correctly after window")


def test_different_ip_independent_limits():
    """
    Validate per-IP bucket isolation for /auth/callback via X-Forwarded-For.
    See authorize_endpoint.py for proxy configuration requirements.
    """
    print("\n=== /auth/callback Per-IP Independent Limits ===")
    print("  ⚠ Requires BEHIND_PROXY=True and the test host in TRUSTED_PROXY_LIST")

    client         = register_client()
    transaction_id = get_transaction_id(client["client_id"])
    assert transaction_id, "Could not obtain a transaction_id via /authorize"

    headers_ip1 = {"X-Forwarded-For": "10.0.0.5"}
    headers_ip2 = {"X-Forwarded-For": "10.0.0.6"}

    for i in range(STANDARD_RATE_LIMIT_COUNT + 1):
        r = requests.get(
            CALLBACK_URL,
            params={"code": "upstreamcode000004", "state": transaction_id},
            headers=headers_ip1,
            allow_redirects=False,
        )
        print(f"  IP1 request {i+1}: {r.status_code}")

    r = requests.get(
        CALLBACK_URL,
        params={"code": "upstreamcode000004", "state": transaction_id},
        headers=headers_ip2,
        allow_redirects=False,
    )
    print(f"  IP2 request after IP1 exhausted: {r.status_code}")
    if r.status_code in (302, 400):
        print("  ✓ Per-IP rate limiting working (IP2 unaffected by IP1)")
    else:
        print("  ⚠ IP2 was also blocked — rate limiter may be global, not per-IP")


# ── Payload / field-size limit tests ─────────────────────────────────────────

def test_callback_code_too_long():
    """code > MAX_CODE_LENGTH chars → 422."""
    print("\n=== /auth/callback code Too Long ===")
    r = invoke_callback(
        code="c" * (MAX_CODE_LENGTH + 1),
        state="validstate000000000",
    )
    print(f"  Status: {r.status_code}")
    assert r.status_code == 422, f"Expected 422, got {r.status_code}"
    print("  ✓ Rejected oversized code")


def test_callback_state_too_long():
    """state > MAX_STATE_LENGTH chars → 422."""
    print("\n=== /auth/callback state (transaction_id) Too Long ===")
    r = invoke_callback(
        code="validcode000001",
        state="s" * (MAX_STATE_LENGTH + 1),
    )
    print(f"  Status: {r.status_code}")
    assert r.status_code == 422, f"Expected 422, got {r.status_code}"
    print("  ✓ Rejected oversized state")


def test_callback_location_too_long():
    """location > MAX_LOCATION_LENGTH chars → 422."""
    print("\n=== /auth/callback location Too Long ===")
    r = invoke_callback(
        code="validcode000002",
        state="validstate000000001",
        location="https://accounts.zoho.com/" + "x" * MAX_LOCATION_LENGTH,
    )
    print(f"  Status: {r.status_code}")
    assert r.status_code == 422, f"Expected 422, got {r.status_code}"
    print("  ✓ Rejected oversized location")


def test_callback_missing_required_params():
    """Calling /auth/callback without required `code` and `state` → 422."""
    print("\n=== /auth/callback Missing Required Params ===")
    r = requests.get(CALLBACK_URL, allow_redirects=False)
    print(f"  Status: {r.status_code}")
    assert r.status_code == 422, f"Expected 422, got {r.status_code}"
    print("  ✓ Rejected request with missing required parameters")


def test_callback_invalid_state():
    """
    Valid-length code and state that do not correspond to any active
    transaction → 400 (invalid_state_or_transaction_expired).
    """
    print("\n=== /auth/callback Invalid / Non-existent state ===")
    r = invoke_callback(
        code="someupstreamcode",
        state="nonexistent-transaction-id-00000000",
    )
    print(f"  Status: {r.status_code}")
    assert r.status_code == 400, f"Expected 400, got {r.status_code}"
    print("  ✓ Returned 400 for unknown transaction_id in state")


def test_callback_happy_path():
    """
    Full happy-path flow:
      1. Register client
      2. Authorize → get transaction_id
      3. Call /auth/callback with fake upstream code + real transaction_id
      4. Expect 302 redirect to client's redirect_uri containing a proxy-
         issued authorization code.

    NOTE: The server does NOT call the real upstream at this step; it only
    stores the upstream_code value locally for the later /token exchange.
    The upstream_code is fake here – the actual /token exchange would fail,
    but that is outside the scope of this test.
    """
    print("\n=== /auth/callback Happy Path ===")
    client         = register_client()
    transaction_id = get_transaction_id(client["client_id"])
    assert transaction_id, "Could not obtain a transaction_id via /authorize"

    r = invoke_callback(
        code="fake-upstream-code-for-test",
        state=transaction_id,
        location="https://accounts.zoho.com",
    )
    print(f"  Status: {r.status_code}")
    assert r.status_code == 302, (
        f"Expected 302 redirect to client, got {r.status_code}\n{r.text}"
    )

    location   = r.headers.get("Location", "")
    qs         = parse_qs(urlparse(location).query)
    proxy_code = qs.get("code", [None])[0]

    assert proxy_code, f"No proxy authorization code in redirect: {location}"
    print(f"  ✓ Proxy code issued: {proxy_code[:8]}...")
    print(f"  Redirect URL: {location[:80]}...")
    return proxy_code


# ── DOS flood probe ───────────────────────────────────────────────────────────

def test_callback_large_flood():
    """
    Attempt DOS via repeated /auth/callback requests carrying maximum-size
    valid parameters.

    Attack surface:
      Each accepted callback call creates an AuthorizationCode object stored
      in auth_codes_store with a 120-second TTL.  Sustained flood across
      rate-limit windows accumulates stored objects that may degrade
      performance or exhaust memory.

    Strategy:
      We reuse the same transaction_id across all requests in a window (the
      proxy does not delete the transaction after a callback).  A new
      transaction_id is obtained before each window to keep the transaction
      alive within its 120-second TTL.  REQUESTS_PER_WINDOW < STANDARD_RATE_LIMIT_COUNT
      so the rate limiter is not exhausted within a window.
    """
    print("\n=== /auth/callback Large Payload Flood (DOS probe) ===")

    client         = register_client()
    transaction_id = get_transaction_id(client["client_id"])
    assert transaction_id, "Could not obtain a transaction_id via /authorize"

    # Fake upstream code at max allowed length
    max_code     = "c" * MAX_CODE_LENGTH
    max_location = "https://accounts.zoho.com/" + "x" * (MAX_LOCATION_LENGTH - len("https://accounts.zoho.com/"))

    NUM_WINDOWS         = 3
    REQUESTS_PER_WINDOW = STANDARD_RATE_LIMIT_COUNT - 1
    WINDOW_WAIT_SECONDS = STANDARD_RATE_LIMIT_WINDOW + 5

    total_sent = total_ok = total_rate_limited = total_errors = 0
    response_times: list[float] = []

    for window in range(NUM_WINDOWS):
        print(f"\n  Window {window+1}/{NUM_WINDOWS}  "
              f"(cumulative successful so far: {total_ok})")

        for i in range(REQUESTS_PER_WINDOW):
            start = time.monotonic()
            try:
                r = requests.get(
                    CALLBACK_URL,
                    params={
                        "code":     max_code,
                        "state":    transaction_id,
                        "location": max_location,
                    },
                    allow_redirects=False,
                    timeout=10,
                )
                elapsed = time.monotonic() - start
                response_times.append(elapsed)
                total_sent += 1

                if r.status_code in (302, 400):
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
                print(f"    [{window+1}-{i+1}] CONNECTION ERROR ({elapsed:.3f}s)")
            except requests.exceptions.Timeout:
                total_errors += 1
                total_sent   += 1
                print(f"    [{window+1}-{i+1}] TIMEOUT")

        # Obtain a fresh transaction_id for the next window (txn TTL = 120 s)
        client2 = register_client()
        new_txn = get_transaction_id(client2["client_id"])
        if new_txn:
            transaction_id = new_txn

        if window < NUM_WINDOWS - 1:
            print(f"  Waiting {WINDOW_WAIT_SECONDS}s for rate-limit bucket to refill...")
            time.sleep(WINDOW_WAIT_SECONDS)

    # ── Final health probe ────────────────────────────────────────────────────
    print("\n  Final health probe...")
    try:
        probe = requests.get(
            CALLBACK_URL,
            params={"code": "probecode", "state": "probe-state-00000000000000"},
            allow_redirects=False,
            timeout=10,
        )
        print(f"  Probe: {probe.status_code}")
        server_alive = probe.status_code in (302, 400, 429)
    except (requests.exceptions.ConnectionError, requests.exceptions.Timeout):
        server_alive = False
        print("  Probe FAILED — server unreachable after flood")

    # ── Summary ───────────────────────────────────────────────────────────────
    print("\n  === Summary ===")
    print(f"  Total requests : {total_sent}")
    print(f"  Non-error      : {total_ok}  "
          f"(~{total_ok} AuthorizationCode objects stored server-side)")
    print(f"  Rate Limited   : {total_rate_limited}")
    print(f"  Server Errors  : {total_errors}")

    if response_times:
        half       = max(len(response_times) // 2, 1)
        avg_first  = sum(response_times[:half]) / half
        avg_second = sum(response_times[half:]) / max(len(response_times) - half, 1)
        print(f"  Avg latency first half  : {avg_first:.3f}s")
        print(f"  Avg latency second half : {avg_second:.3f}s")
        if avg_second > avg_first * 1.5:
            print("  ⚠ Latency increased >50% — possible memory pressure")
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
    test_callback_code_too_long()
    test_callback_state_too_long()
    test_callback_location_too_long()
    test_callback_missing_required_params()
    test_callback_invalid_state()

    # Happy-path flow validation
    test_callback_happy_path()

    # Rate-limit checks
    test_callback_rate_limit()
    test_different_ip_independent_limits()
    test_callback_large_flood()

    # Long-running refill test — comment out if time-constrained
    test_callback_tokens_refill_after_window()
