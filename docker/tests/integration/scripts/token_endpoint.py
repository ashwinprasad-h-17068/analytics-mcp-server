"""
Integration tests for the /token endpoint.

Tests cover:
  1. Rate limiting (DOS prevention) – endpoint-specific standard rate limit
  2. Payload / form-field size limits (FastAPI 422 responses)
  3. Application-level rejections: invalid client credentials (401),
     unsupported grant_type (400), missing required fields (422)
  4. Flood probe across multiple rate-limit windows

Flow dependency:
  /register  →  /token  (for field-size and error-condition tests)
  /register  →  /authorize  →  /auth/callback  →  /token  (for the happy-path
    authorization_code exchange – NOT exercised here because completing the
    exchange requires real upstream Zoho credentials)

Scope of these tests:
  • The authorization_code grant happy path is intentionally excluded because
    it requires a real upstream token from Zoho Accounts.
  • The refresh_token grant happy path is similarly excluded for the same
    reason (a real refresh_token from the upstream is required).
  • All tests that reach the "call upstream" step will return 502 (upstream
    exchange failed); this is expected and NOT treated as a test failure.
  • The primary goal here is to validate that the rate-limiter, field-size
    validators, client-credential checker, and grant-type validator all fire
    correctly before any upstream call is made.

NOTE on 422 vs 429 ordering:
  See authorize_endpoint.py for the same caveat on dependency-resolution order.
  For /token, parameters are form fields, but the same principle applies.
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
TOKEN_URL     = f"{BASE_URL}/token"

# ── Configurable rate-limit parameters ───────────────────────────────────────
STANDARD_RATE_LIMIT_COUNT  = int(os.getenv("PRIVATE_OAUTH_STANDARD_RATE_LIMIT_COUNT",  "5"))
STANDARD_RATE_LIMIT_WINDOW = int(os.getenv("PRIVATE_OAUTH_STANDARD_RATE_LIMIT_WINDOW", "60"))

# ── Configurable /token form-field constraints ────────────────────────────────
# Mirror Form(..., max_length=N) annotations in remote_auth.py
MAX_GRANT_TYPE_LENGTH    = 100
MAX_CODE_LENGTH          = 200
MAX_REDIRECT_URI_LENGTH  = 200
MAX_CLIENT_ID_LENGTH     = 100
MAX_CLIENT_SECRET_LENGTH = 200
MAX_REFRESH_TOKEN_LENGTH = 200
MAX_CODE_VERIFIER_LENGTH = 500

# ── Fixed test values ─────────────────────────────────────────────────────────
VALID_REDIRECT_URI = "https://example.com/callback"
REGISTER_PAYLOAD = {
    "client_name": "TokenTestClient",
    "redirect_uris": [VALID_REDIRECT_URI],
    "grant_types": ["authorization_code", "refresh_token"],
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


def get_proxy_auth_code(client: dict) -> tuple[str, str] | tuple[None, None]:
    """
    Run the /authorize → /auth/callback sub-flow to obtain a proxy-issued
    authorization code and the corresponding code_verifier.

    Returns (proxy_code, code_verifier) on success, (None, None) on failure.

    The resulting proxy_code is valid for use in /token (grant_type=
    authorization_code), but the upstream token exchange will fail because
    the upstream_code stored by /auth/callback is fake (no real Zoho session).
    """
    code_verifier, code_challenge = make_pkce_pair()
    authorize_params = {
        "client_id":            client["client_id"],
        "redirect_uri":         VALID_REDIRECT_URI,
        "scope":                "ZohoAnalytics.fullaccess.all",
        "state":                "statevalue1",
        "code_challenge":       code_challenge,
        "code_challenge_method": "S256",
    }

    auth_r = requests.get(AUTHORIZE_URL, params=authorize_params, allow_redirects=False)
    if auth_r.status_code != 302:
        return None, None

    location       = auth_r.headers.get("Location", "")
    qs             = parse_qs(urlparse(location).query)
    transaction_id = qs.get("transaction_id", [None])[0]
    if not transaction_id:
        return None, None

    cb_r = requests.get(
        CALLBACK_URL,
        params={"code": "fake-upstream-code", "state": transaction_id},
        allow_redirects=False,
    )
    if cb_r.status_code != 302:
        return None, None

    cb_location = cb_r.headers.get("Location", "")
    cb_qs       = parse_qs(urlparse(cb_location).query)
    proxy_code  = cb_qs.get("code", [None])[0]
    return proxy_code, code_verifier


def post_token(data: dict, **kwargs) -> requests.Response:
    """POST to /token with form-encoded data."""
    return requests.post(TOKEN_URL, data=data, **kwargs)


# ── Rate-limit tests ──────────────────────────────────────────────────────────

def test_token_rate_limit() -> bool:
    """
    Exhaust the per-path standard rate-limit bucket on /token and verify 429.

    Strategy:
      Send requests with a valid client_id/secret but an unsupported
      grant_type that will be rejected with 400 before any upstream call.
      This ensures the rate-limit dependency fires on each request without
      consuming upstream bandwidth.
    """
    print("\n=== /token Rate Limit Test ===")
    client = register_client()

    for i in range(STANDARD_RATE_LIMIT_COUNT + 3):
        r = post_token({
            "grant_type":    "authorization_code",
            "client_id":     client["client_id"],
            "client_secret": client["client_secret"],
            "code":          "fake-code-for-rate-limit-test",
        })
        print(f"  Request {i+1}: status={r.status_code}")
        if r.status_code == 429:
            print("  ✓ Rate limit triggered as expected")
            return True

    print("  ✗ Rate limit was NOT triggered after all requests")
    return False


def test_token_tokens_refill_after_window():
    """Exhaust the /token bucket, wait for it to refill, confirm response improves."""
    print(f"\n=== /token Token Refill After {STANDARD_RATE_LIMIT_WINDOW}s Window ===")
    client = register_client()

    for i in range(STANDARD_RATE_LIMIT_COUNT + 1):
        r = post_token({
            "grant_type":    "authorization_code",
            "client_id":     client["client_id"],
            "client_secret": client["client_secret"],
            "code":          "fake-code-refill",
        })
        print(f"  Exhaust {i+1}: {r.status_code}")

    wait = STANDARD_RATE_LIMIT_WINDOW + 5
    print(f"  Waiting {wait}s for bucket to refill...")
    time.sleep(wait)

    client2 = register_client()
    for i in range(2):
        r = post_token({
            "grant_type":    "authorization_code",
            "client_id":     client2["client_id"],
            "client_secret": client2["client_secret"],
            "code":          "fake-code-post-refill",
        })
        print(f"  Post-refill {i+1}: {r.status_code}")
        # Should be 400 (invalid_grant) or 401 (if client expired), NOT 429
        assert r.status_code != 429, (
            f"Rate limit should have cleared; still got 429 after window"
        )
    print("  ✓ Bucket refilled correctly after window")


def test_different_ip_independent_limits():
    """
    Validate per-IP bucket isolation for /token via X-Forwarded-For.
    See authorize_endpoint.py for proxy configuration requirements.
    """
    print("\n=== /token Per-IP Independent Limits ===")
    print("  ⚠ Requires BEHIND_PROXY=True and the test host in TRUSTED_PROXY_LIST")

    client = register_client()

    headers_ip1 = {"X-Forwarded-For": "10.0.0.7"}
    headers_ip2 = {"X-Forwarded-For": "10.0.0.8"}

    form = {
        "grant_type":    "authorization_code",
        "client_id":     client["client_id"],
        "client_secret": client["client_secret"],
        "code":          "fake-code-ip-test",
    }

    for i in range(STANDARD_RATE_LIMIT_COUNT + 1):
        r = requests.post(TOKEN_URL, data=form, headers=headers_ip1)
        print(f"  IP1 request {i+1}: {r.status_code}")

    r = requests.post(TOKEN_URL, data=form, headers=headers_ip2)
    print(f"  IP2 request after IP1 exhausted: {r.status_code}")
    if r.status_code != 429:
        print("  ✓ Per-IP rate limiting working (IP2 unaffected by IP1)")
    else:
        print("  ⚠ IP2 was also blocked — rate limiter may be global, not per-IP")


# ── Payload / form-field size limit tests ────────────────────────────────────

def test_grant_type_too_long():
    """grant_type > MAX_GRANT_TYPE_LENGTH chars → 422."""
    print("\n=== /token grant_type Too Long ===")
    r = post_token({
        "grant_type":    "g" * (MAX_GRANT_TYPE_LENGTH + 1),
        "client_id":     "someclientid",
        "client_secret": "somesecret",
    })
    print(f"  Status: {r.status_code}")
    assert r.status_code == 422, f"Expected 422, got {r.status_code}"
    print("  ✓ Rejected oversized grant_type")


def test_code_too_long():
    """code > MAX_CODE_LENGTH chars → 422."""
    print("\n=== /token code Too Long ===")
    r = post_token({
        "grant_type":    "authorization_code",
        "client_id":     "someclientid",
        "client_secret": "somesecret",
        "code":          "c" * (MAX_CODE_LENGTH + 1),
    })
    print(f"  Status: {r.status_code}")
    assert r.status_code == 422, f"Expected 422, got {r.status_code}"
    print("  ✓ Rejected oversized code")


def test_redirect_uri_too_long():
    """redirect_uri > MAX_REDIRECT_URI_LENGTH chars → 422."""
    print("\n=== /token redirect_uri Too Long ===")
    r = post_token({
        "grant_type":    "authorization_code",
        "client_id":     "someclientid",
        "client_secret": "somesecret",
        "code":          "validcode",
        "redirect_uri":  "https://example.com/" + "x" * MAX_REDIRECT_URI_LENGTH,
    })
    print(f"  Status: {r.status_code}")
    assert r.status_code == 422, f"Expected 422, got {r.status_code}"
    print("  ✓ Rejected oversized redirect_uri")


def test_client_id_too_long():
    """client_id > MAX_CLIENT_ID_LENGTH chars → 422."""
    print("\n=== /token client_id Too Long ===")
    r = post_token({
        "grant_type":    "authorization_code",
        "client_id":     "c" * (MAX_CLIENT_ID_LENGTH + 1),
        "client_secret": "somesecret",
    })
    print(f"  Status: {r.status_code}")
    assert r.status_code == 422, f"Expected 422, got {r.status_code}"
    print("  ✓ Rejected oversized client_id")


def test_client_secret_too_long():
    """client_secret > MAX_CLIENT_SECRET_LENGTH chars → 422."""
    print("\n=== /token client_secret Too Long ===")
    r = post_token({
        "grant_type":    "authorization_code",
        "client_id":     "someclientid",
        "client_secret": "s" * (MAX_CLIENT_SECRET_LENGTH + 1),
    })
    print(f"  Status: {r.status_code}")
    assert r.status_code == 422, f"Expected 422, got {r.status_code}"
    print("  ✓ Rejected oversized client_secret")


def test_refresh_token_too_long():
    """refresh_token > MAX_REFRESH_TOKEN_LENGTH chars → 422."""
    print("\n=== /token refresh_token Too Long ===")
    r = post_token({
        "grant_type":     "refresh_token",
        "client_id":      "someclientid",
        "client_secret":  "somesecret",
        "refresh_token":  "r" * (MAX_REFRESH_TOKEN_LENGTH + 1),
    })
    print(f"  Status: {r.status_code}")
    assert r.status_code == 422, f"Expected 422, got {r.status_code}"
    print("  ✓ Rejected oversized refresh_token")


def test_code_verifier_too_long():
    """code_verifier > MAX_CODE_VERIFIER_LENGTH chars → 422."""
    print("\n=== /token code_verifier Too Long ===")
    r = post_token({
        "grant_type":    "authorization_code",
        "client_id":     "someclientid",
        "client_secret": "somesecret",
        "code":          "validcode",
        "code_verifier": "v" * (MAX_CODE_VERIFIER_LENGTH + 1),
    })
    print(f"  Status: {r.status_code}")
    assert r.status_code == 422, f"Expected 422, got {r.status_code}"
    print("  ✓ Rejected oversized code_verifier")


def test_missing_required_fields():
    """POST /token with no form fields → 422 (client_id and grant_type required)."""
    print("\n=== /token Missing Required Fields ===")
    r = post_token({})
    print(f"  Status: {r.status_code}")
    assert r.status_code == 422, f"Expected 422, got {r.status_code}"
    print("  ✓ Rejected request with missing required fields")


# ── Application-level error tests ─────────────────────────────────────────────

def test_invalid_client_credentials():
    """
    Valid-sized fields but wrong client_secret → 401 (invalid_client).

    The client_id belongs to a real registered client; the secret is wrong.
    This validates that the credential check fires before any upstream call.
    """
    print("\n=== /token Invalid Client Secret → 401 ===")
    client = register_client()
    r = post_token({
        "grant_type":    "authorization_code",
        "client_id":     client["client_id"],
        "client_secret": "this-is-the-wrong-secret",
        "code":          "any-code",
    })
    print(f"  Status: {r.status_code}")
    assert r.status_code == 401, f"Expected 401 invalid_client, got {r.status_code}"
    body = r.json()
    assert body.get("error") == "invalid_client", f"Unexpected error: {body}"
    print("  ✓ Returned 401 invalid_client for wrong secret")


def test_unknown_client_id():
    """
    Completely unknown client_id → 401 (invalid_client).
    """
    print("\n=== /token Unknown client_id → 401 ===")
    r = post_token({
        "grant_type":    "authorization_code",
        "client_id":     "00000000-0000-0000-0000-nonexistent00",
        "client_secret": "doesnotmatter",
        "code":          "any-code",
    })
    print(f"  Status: {r.status_code}")
    assert r.status_code == 401, f"Expected 401 invalid_client, got {r.status_code}"
    print("  ✓ Returned 401 invalid_client for unknown client_id")


def test_unsupported_grant_type():
    """
    Valid client credentials but an unsupported grant_type → 400
    (unsupported_grant_type).
    """
    print("\n=== /token Unsupported grant_type → 400 ===")
    client = register_client()
    r = post_token({
        "grant_type":    "implicit",
        "client_id":     client["client_id"],
        "client_secret": client["client_secret"],
    })
    print(f"  Status: {r.status_code}")
    assert r.status_code == 400, f"Expected 400, got {r.status_code}"
    print("  ✓ Returned 400 unsupported_grant_type for 'implicit' grant")


def test_authorization_code_grant_invalid_code():
    """
    Valid credentials, grant_type=authorization_code, but a non-existent code
    → 400 (invalid_grant).
    """
    print("\n=== /token authorization_code With Invalid Code → 400 ===")
    client = register_client()
    r = post_token({
        "grant_type":    "authorization_code",
        "client_id":     client["client_id"],
        "client_secret": client["client_secret"],
        "code":          "this-code-does-not-exist-in-store",
    })
    print(f"  Status: {r.status_code}")
    assert r.status_code == 400, f"Expected 400 invalid_grant, got {r.status_code}"
    print("  ✓ Returned 400 invalid_grant for unknown authorization code")


def test_refresh_token_grant_missing_token():
    """
    grant_type=refresh_token but no refresh_token field → 400
    (refresh_token_required).
    """
    print("\n=== /token refresh_token Grant Without refresh_token → 400 ===")
    client = register_client()
    r = post_token({
        "grant_type":    "refresh_token",
        "client_id":     client["client_id"],
        "client_secret": client["client_secret"],
    })
    print(f"  Status: {r.status_code}")
    assert r.status_code == 400, f"Expected 400, got {r.status_code}"
    print("  ✓ Returned 400 refresh_token_required when refresh_token is absent")


def test_authorization_code_grant_reaches_upstream():
    """
    Obtain a real proxy-issued authorization code via the full sub-flow
    (/authorize → /auth/callback) and submit it to /token.

    Expected outcomes:
      • 502 (upstream_token_exchange_failed) – normal in test environments
        without real Zoho credentials.  This still confirms that the server
        correctly passed all local validations and attempted the upstream call.
      • 400 (invalid_request / invalid_grant) – if PKCE validation fails
        (should not happen since make_pkce_pair() generates a correct pair).
      • 200 – only if the server is configured with real upstream credentials.

    This test does NOT assert a specific status to avoid being environment-
    specific; it just prints the outcome for manual inspection.
    """
    print("\n=== /token authorization_code Grant (proxy code + PKCE) ===")
    client          = register_client()
    proxy_code, code_verifier = get_proxy_auth_code(client)

    if not proxy_code:
        print("  ⚠ Could not obtain a proxy authorization code – skipping")
        return

    print(f"  Using proxy_code: {proxy_code[:8]}...")

    r = post_token({
        "grant_type":    "authorization_code",
        "client_id":     client["client_id"],
        "client_secret": client["client_secret"],
        "code":          proxy_code,
        "redirect_uri":  VALID_REDIRECT_URI,
        "code_verifier": code_verifier,
    })
    print(f"  Status: {r.status_code}")
    if r.status_code == 502:
        print("  ✓ Server reached upstream exchange (502 expected without real credentials)")
    elif r.status_code == 200:
        print("  ✓ Token exchange succeeded (real upstream credentials present)")
    elif r.status_code in (400, 401):
        print(f"  ⚠ Rejected locally ({r.status_code}): {r.text[:200]}")
    else:
        print(f"  ⚠ Unexpected status: {r.status_code}")


# ── DOS flood probe ───────────────────────────────────────────────────────────

def test_token_large_payload_flood():
    """
    Attempt DOS via repeated /token requests with maximum-size form fields.

    Attack surface:
      Each request that passes credential validation triggers a code or
      token store lookup, potentially a PKCE computation, and then an
      upstream HTTP call.  Even requests rejected at the credential check
      (401) consume CPU for the string comparison.  Sustained flood across
      rate-limit windows may increase response latency or trigger OOM.

    Strategy:
      • Use a valid client_id/secret so requests reach the application logic.
      • Use an invalid code so requests are rejected at the code-lookup
        stage (400), avoiding real upstream calls.
      • Keep all field sizes at their maximum valid lengths to maximise per-
        request payload handling cost.
      • Stay below STANDARD_RATE_LIMIT_COUNT per window to avoid 429 masking
        latency measurements.
    """
    print("\n=== /token Large Payload Flood (DOS probe) ===")

    client = register_client()

    max_form = {
        "grant_type":    "authorization_code",
        "client_id":     client["client_id"],
        "client_secret": client["client_secret"],
        "code":          "c" * MAX_CODE_LENGTH,
        "redirect_uri":  "https://example.com/" + "x" * (MAX_REDIRECT_URI_LENGTH - len("https://example.com/")),
        "code_verifier": "v" * MAX_CODE_VERIFIER_LENGTH,
    }

    NUM_WINDOWS         = 3
    REQUESTS_PER_WINDOW = STANDARD_RATE_LIMIT_COUNT - 1
    WINDOW_WAIT_SECONDS = STANDARD_RATE_LIMIT_WINDOW + 5

    total_sent = total_ok = total_rate_limited = total_errors = 0
    response_times: list[float] = []

    for window in range(NUM_WINDOWS):
        print(f"\n  Window {window+1}/{NUM_WINDOWS}  "
              f"(cumulative requests so far: {total_sent})")

        for i in range(REQUESTS_PER_WINDOW):
            start = time.monotonic()
            try:
                r       = post_token(max_form, timeout=10)
                elapsed = time.monotonic() - start
                response_times.append(elapsed)
                total_sent += 1

                if r.status_code in (400, 401):
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

        # Re-register so the client stays valid across windows
        client              = register_client()
        max_form["client_id"]     = client["client_id"]
        max_form["client_secret"] = client["client_secret"]

        if window < NUM_WINDOWS - 1:
            print(f"  Waiting {WINDOW_WAIT_SECONDS}s for rate-limit bucket to refill...")
            time.sleep(WINDOW_WAIT_SECONDS)

    # ── Final health probe ────────────────────────────────────────────────────
    print("\n  Final health probe...")
    try:
        probe_client = register_client()
        probe = post_token({
            "grant_type":    "authorization_code",
            "client_id":     probe_client["client_id"],
            "client_secret": probe_client["client_secret"],
            "code":          "probeonly",
        }, timeout=10)
        print(f"  Probe: {probe.status_code}")
        server_alive = probe.status_code in (400, 401, 200, 429)
    except (requests.exceptions.ConnectionError, requests.exceptions.Timeout):
        server_alive = False
        print("  Probe FAILED — server unreachable after flood")

    # ── Summary ───────────────────────────────────────────────────────────────
    print("\n  === Summary ===")
    print(f"  Total requests : {total_sent}")
    print(f"  Processed (4xx): {total_ok}")
    print(f"  Rate Limited   : {total_rate_limited}")
    print(f"  Server Errors  : {total_errors}")

    if response_times:
        half       = max(len(response_times) // 2, 1)
        avg_first  = sum(response_times[:half]) / half
        avg_second = sum(response_times[half:]) / max(len(response_times) - half, 1)
        print(f"  Avg latency first half  : {avg_first:.3f}s")
        print(f"  Avg latency second half : {avg_second:.3f}s")
        if avg_second > avg_first * 1.5:
            print("  ⚠ Latency increased >50% — possible server memory/CPU pressure")
        else:
            print("  ✓ Latency remained stable")

    if not server_alive:
        print("  ✗ Server unreachable after flood — possible OOM crash")
    elif total_errors > 0:
        print("  ⚠ Server returned errors — investigate memory / CPU risk")
    else:
        print("  ✓ Server survived; review server-side metrics for long-term risk")


if __name__ == "__main__":
    # Payload / field-size checks (fast, no waits)
    test_grant_type_too_long()
    test_code_too_long()
    test_redirect_uri_too_long()
    test_client_id_too_long()
    test_client_secret_too_long()
    test_refresh_token_too_long()
    test_code_verifier_too_long()
    test_missing_required_fields()

    # Application-level error conditions
    test_invalid_client_credentials()
    test_unknown_client_id()
    test_unsupported_grant_type()
    test_authorization_code_grant_invalid_code()
    test_refresh_token_grant_missing_token()
    test_authorization_code_grant_reaches_upstream()

    # Rate-limit checks
    test_token_rate_limit()
    test_different_ip_independent_limits()
    test_token_large_payload_flood()

    # Long-running refill test — comment out if time-constrained
    test_token_tokens_refill_after_window()
