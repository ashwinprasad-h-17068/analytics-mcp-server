import requests
import os
import time
from dotenv import load_dotenv

load_dotenv()

BASE_URL =  os.getenv("MCP_SERVER_PUBLIC_URL")
REGISTER_URL = f"{BASE_URL}/register"
MAX_REDIRECT_URIS = 3
MAX_STRING_LENGTH=256
MAX_CLIENT_NAME_LENGTH=80
MAX_SCOPE_LENGTH=256

VALID_PAYLOAD = {
    "client_name": "TestClient",
    "redirect_uris": ["https://example.com/callback"],
    "grant_types": ["authorization_code"],
    "response_types": ["code"]
}



def test_redirect_uris_over_limit(max_redirect_uris: int = 8):
    """Send more redirect_uris than MAX_REDIRECT_URIS."""
    print("\n=== redirect_uris Over Limit ===")

    payload = {
        **VALID_PAYLOAD,
        "redirect_uris": [f"https://example.com/cb{i}" for i in range(MAX_REDIRECT_URIS + 1)]
    }
    print(payload)
    r = requests.post(REGISTER_URL, json=payload)
    print(f"  Status: {r.status_code}")
    assert r.status_code == 422, f"Expected 422, got {r.status_code}"
    print("  ✓ Rejected oversized redirect_uris list")



def test_client_name_too_long():
    """Send a client_name exceeding MAX_CLIENT_NAME_LENGTH."""
    print("\n=== client_name Too Long ===")

    payload = {
        **VALID_PAYLOAD,
        "client_name": "x" * (MAX_CLIENT_NAME_LENGTH + 1)
    }
    r = requests.post(REGISTER_URL, json=payload)
    print(f"  Status: {r.status_code}")
    assert r.status_code == 422, f"Expected 422, got {r.status_code}"
    print("  ✓ Rejected oversized client_name")


def test_scope_too_long():
    """Send a scope exceeding MAX_SCOPE_LENGTH."""
    print("\n=== scope Too Long ===")

    payload = {
        **VALID_PAYLOAD,
        "scope": "x" * (MAX_SCOPE_LENGTH + 1)
    }
    r = requests.post(REGISTER_URL, json=payload)
    print(f"  Status: {r.status_code}")
    assert r.status_code == 422, f"Expected 422, got {r.status_code}"
    print("  ✓ Rejected oversized scope")


def test_redirect_uri_string_too_long():
    """Individual redirect_uri string exceeds MAX_STRING_LENGTH."""
    print("\n=== Individual redirect_uri String Too Long ===")

    payload = {
        **VALID_PAYLOAD,
        "redirect_uris": ["https://example.com/" + "x" * (MAX_STRING_LENGTH + 1)]
    }
    r = requests.post(REGISTER_URL, json=payload)
    print(f"  Status: {r.status_code}")
    assert r.status_code == 422, f"Expected 422, got {r.status_code}"
    print("  ✓ Rejected oversized individual redirect_uri string")


if __name__ == "__main__":
    test_redirect_uris_over_limit()
    test_client_name_too_long()
    test_scope_too_long()
    test_redirect_uri_string_too_long()