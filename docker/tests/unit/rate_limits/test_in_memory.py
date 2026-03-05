from src.auth.remote_auth import DynamicClientRegistrationRequest, register_client, StringList
from src.auth.rate_limiter import InMemoryTokenBucketRateLimiter, get_client_ip, rate_limit
import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from starlette.requests import Request
from starlette.datastructures import Headers
from src.auth.rate_limiter import _Bucket
import time
from unittest.mock import MagicMock, patch, ANY
import uuid
from src.config import Settings
from ipaddress import ip_network
from fastapi import HTTPException


class TestInMemoryTokenBucketRateLimiter:

    def make_limiter(self, capacity=5, window_seconds=10, ttl=3600):
        return InMemoryTokenBucketRateLimiter(capacity=capacity, window_seconds=window_seconds, entry_ttl_seconds=ttl)

    @pytest.mark.asyncio
    async def test_first_request_always_allowed(self):
        limiter = self.make_limiter(capacity=5, window_seconds=10)
        assert await limiter.allow("user1") is True

    @pytest.mark.asyncio
    async def test_requests_within_capacity_are_allowed(self):
        limiter = self.make_limiter(capacity=5, window_seconds=10)
        results = [await limiter.allow("user1") for _ in range(5)]
        assert all(results)

    @pytest.mark.asyncio
    async def test_request_exceeding_capacity_is_denied(self):
        limiter = self.make_limiter(capacity=3, window_seconds=10)
        for _ in range(3):
            await limiter.allow("user1")
        assert await limiter.allow("user1") is False

    @pytest.mark.asyncio
    async def test_different_keys_are_isolated(self):
        limiter = self.make_limiter(capacity=2, window_seconds=10)
        for _ in range(2):
            await limiter.allow("user1")

        # user1 is exhausted, user2 should still be allowed
        assert await limiter.allow("user1") is False
        assert await limiter.allow("user2") is True

    @pytest.mark.asyncio
    async def test_tokens_refill_over_time(self):
        limiter = self.make_limiter(capacity=2, window_seconds=10)

        with patch("time.monotonic") as mock_time:
            mock_time.return_value = 1000.0
            await limiter.allow("user1")
            await limiter.allow("user1")
            assert await limiter.allow("user1") is False  # exhausted

            # Advance time by a full window — should fully refill
            mock_time.return_value = 1010.0
            assert await limiter.allow("user1") is True

    @pytest.mark.asyncio
    async def test_partial_refill_grants_correct_tokens(self):
        """Half a window should refill ~half the tokens."""
        limiter = self.make_limiter(capacity=4, window_seconds=10)  # rate = 0.4/s

        with patch("time.monotonic") as mock_time:
            mock_time.return_value = 1000.0
            for _ in range(4):
                await limiter.allow("user1")
            assert await limiter.allow("user1") is False

            # Advance by 5s → refill 2 tokens
            mock_time.return_value = 1005.0
            assert await limiter.allow("user1") is True
            assert await limiter.allow("user1") is True
            assert await limiter.allow("user1") is False  # not a full refill

    @pytest.mark.asyncio
    async def test_expired_entry_resets_bucket(self):
        limiter = self.make_limiter(capacity=2, window_seconds=10, ttl=30)

        with patch("time.monotonic") as mock_time:
            mock_time.return_value = 1000.0
            await limiter.allow("user1")
            await limiter.allow("user1")
            assert await limiter.allow("user1") is False

            # Advance past TTL
            mock_time.return_value = 1031.0
            assert await limiter.allow("user1") is True  # bucket was reset

    def test_cleanup_removes_expired_entries(self):
        limiter = self.make_limiter(capacity=5, window_seconds=10, ttl=30)

        with patch("time.monotonic") as mock_time:
            mock_time.return_value = 1000.0
            limiter.buckets["old_key"] = _Bucket(tokens=5, last_refill=1000.0, last_access=1000.0)
            limiter.buckets["fresh_key"] = _Bucket(tokens=5, last_refill=1000.0, last_access=1000.0)

            mock_time.return_value = 1031.0
            # Touch fresh_key so its last_access is recent
            limiter.buckets["fresh_key"].last_access = 1031.0

            removed = limiter.cleanup()

        assert removed == 1
        assert "old_key" not in limiter.buckets
        assert "fresh_key" in limiter.buckets

    def test_cleanup_returns_zero_when_nothing_expired(self):
        limiter = self.make_limiter(ttl=3600)
        with patch("time.monotonic", return_value=1000.0):
            limiter.buckets["key"] = _Bucket(tokens=5, last_refill=1000.0, last_access=1000.0)
            removed = limiter.cleanup()
        assert removed == 0

    @pytest.mark.asyncio
    async def test_ttl_resets_bucket(self, monkeypatch):
        limiter = self.make_limiter(capacity=5, window_seconds=10, ttl=5)

        fake_time = 1000.0

        def fake_monotonic():
            return fake_time

        monkeypatch.setattr(time, "monotonic", fake_monotonic)

        # Use up capacity
        for _ in range(5):
            assert await limiter.allow("user1") is True

        assert await limiter.allow("user1") is False

        # Advance beyond TTL
        fake_time += 6.0

        # Should behave like fresh bucket
        assert await limiter.allow("user1") is True


    @pytest.mark.asyncio
    async def test_cleanup_with_rejected_requests_bug(self):
        """
        Correctly demonstrates the bug: rejected requests update last_access,
        preventing cleanup even when the user is truly inactive.
        """
        bucket = InMemoryTokenBucketRateLimiter(capacity=1, window_seconds=60, entry_ttl_seconds=1)

        # --- Setup: Create an entry and use up its token ---
        # Use a controlled starting time
        start_time = 1000.0
        with patch('time.monotonic', return_value=start_time):
            # 1. First request creates the bucket (tokens become capacity-1 = 0)
            await bucket.allow("key1")
            assert "key1" in bucket.buckets
            bucket1 = bucket.buckets["key1"]
            assert bucket1.tokens == 0
            # Record the last_access after this successful request
            last_access_after_success = bucket1.last_access
            assert last_access_after_success == start_time

        # --- Simulate a rejected request a bit later, but still within TTL ---
        rejected_request_time = start_time + 0.5
        with patch('time.monotonic', return_value=rejected_request_time):
            # 2. This request will be rejected because tokens are 0 and refill rate is slow
            result = await bucket.allow("key1")
            assert result is False

            # --- VERIFY THE BUG: last_access IS UPDATED on rejection ---
            bucket2 = bucket.buckets["key1"]
            # This assertion will FAIL in the buggy version, proving the bug exists
            assert bucket2.last_access == last_access_after_success, \
                f"BUG: last_access changed from {last_access_after_success} to {bucket2.last_access} on rejection!"

            # Cleanup now (still within TTL) should not remove the entry
            cleaned = bucket.cleanup()
            assert cleaned == 0
            assert "key1" in bucket.buckets

        # --- Simulate time passing beyond the TTL ---
        cleanup_time = start_time + 2.0  # Beyond the 1-second TTL
        with patch('time.monotonic', return_value=cleanup_time):
            # 3. Run cleanup. In a correct implementation, the entry should be removed
            #    because the last successful request was at start_time.
            cleaned = bucket.cleanup()

            # --- VERIFY THE CLEANUP FAILURE DUE TO THE BUG ---
            # In the BUGGY version, this assertion will FAIL (cleaned will be 0)
            # because last_access was updated to rejected_request_time (0.5s),
            # making the entry appear active.
            assert cleaned == 1, \
                "BUG: Entry was not cleaned up because last_access was updated by rejected requests!"
            assert "key1" not in bucket.buckets


    @pytest.mark.asyncio
    async def test_register_client_limits_to_five_per_ip(self):

        test_ip = "192.168.1.1"
        existing_client_ids = ["id1", "id2", "id3", "id4", "id5"] # Already at limit
        
        payload = DynamicClientRegistrationRequest(
            client_name="New Client",
            redirect_uris=["https://example.com"],
            scope="openid",
            grant_types=["authorization_code"],
            response_types=["code"]
        )

        mock_request = MagicMock(spec=Request)
        
        with patch("src.auth.remote_auth.get_client_ip", return_value=test_ip), \
            patch("src.auth.remote_auth.client_ip_vs_client_ids_store") as mock_ip_store, \
            patch("src.auth.remote_auth.registed_clients_store") as mock_reg_store, \
            patch("src.auth.remote_auth.Settings") as mock_settings:
            
            mock_ip_store.get.return_value = StringList(root=existing_client_ids[:])
            mock_settings.MCP_SERVER_PUBLIC_URL = "https://api.example.com"
            mock_settings.OAUTH_MAX_REDIRECT_URIS = 3
            mock_settings.OAUTH_MAX_CLIENT_NAME_LENGTH = 80
            mock_settings.OAUTH_MAX_SCOPE_LENGTH = 100
            mock_settings.OAUTH_MAX_GRANT_TYPES = 2
            mock_settings.OAUTH_MAX_RESPONSE_TYPES = 1
            mock_settings.OAUTH_MAX_STRING_LENGTH = 256
            mock_settings.OAUTH_DEFAULT_SCOPE = "openid profile"
            mock_settings.OAUTH_REGISTERED_CLIENTS_TTL = 3600
            mock_settings.OAUTH_CLIENT_IP_MAPPING_TTL = 18000
            mock_settings.get_max_clients_per_ip.return_value = 5

            await register_client(payload, mock_request)

            mock_ip_store.get.assert_called_with(test_ip)
            args, kwargs = mock_ip_store.set.call_args
            updated_list = args[1].root  # Access the underlying list from StringList
            
            assert len(updated_list) == 5
            assert "id1" not in updated_list
            assert any(isinstance(uuid.UUID(x), uuid.UUID) for x in updated_list if x not in existing_client_ids)

            mock_reg_store.delete.assert_called_once_with("id1")


    @pytest.mark.asyncio
    async def test_register_client_limits_are_per_ip_isolated(self):
        # 1. Setup
        ip_a = "192.168.1.1"
        ip_b = "10.0.0.1"
        
        # Both IPs are currently at 4 clients (under the limit of 5)
        ip_a_existing = ["a1", "a2", "a3", "a4"]
        ip_b_existing = ["b1", "b2", "b3", "b4"]

        payload = DynamicClientRegistrationRequest(
            client_name="Test Client",
            redirect_uris=["https://example.com"],
            scope="openid"
        )

        mock_request = MagicMock(spec=Request)
        
        with patch("src.auth.remote_auth.get_client_ip") as mock_get_ip, \
            patch("src.auth.remote_auth.client_ip_vs_client_ids_store") as mock_ip_store, \
            patch("src.auth.remote_auth.registed_clients_store") as mock_reg_store, \
            patch("src.auth.remote_auth.Settings") as mock_settings:
            
            mock_settings.MCP_SERVER_PUBLIC_URL = "https://api.example.com"
            mock_settings.OAUTH_MAX_REDIRECT_URIS = 3
            mock_settings.OAUTH_MAX_CLIENT_NAME_LENGTH = 80
            mock_settings.OAUTH_MAX_SCOPE_LENGTH = 100
            mock_settings.OAUTH_MAX_GRANT_TYPES = 2
            mock_settings.OAUTH_MAX_RESPONSE_TYPES = 1
            mock_settings.OAUTH_MAX_STRING_LENGTH = 256
            mock_settings.OAUTH_DEFAULT_SCOPE = "openid profile"
            mock_settings.OAUTH_REGISTERED_CLIENTS_TTL = 3600
            mock_settings.OAUTH_CLIENT_IP_MAPPING_TTL = 18000
            mock_settings.get_max_clients_per_ip.return_value = 5

            # --- STEP 1: Register for IP-A ---
            mock_get_ip.return_value = ip_a
            mock_ip_store.get.return_value = StringList(root=ip_a_existing[:]) 
            
            await register_client(payload, mock_request)

            # Verify IP-A's list was updated to 5 items and NO deletions happened
            assert mock_reg_store.delete.call_count == 0
            mock_ip_store.set.assert_called_with(ip_a, ANY, ttl_in_sec=18000)
            
            # --- STEP 2: Register for IP-B ---
            mock_get_ip.return_value = ip_b
            mock_ip_store.get.return_value = StringList(root=ip_b_existing[:]) 
            
            await register_client(payload, mock_request)

            # --- FINAL ASSERTIONS ---
            # 1. Deletions should STILL be 0 because both IPs are exactly at 5
            assert mock_reg_store.delete.call_count == 0
            
            # 2. Verify IP-B's set call specifically
            # This confirms that IP-B's registration didn't interfere with IP-A
            mock_ip_store.set.assert_called_with(ip_b, ANY, ttl_in_sec=18000)
            
            # 3. Double check the list length for the last call (IP-B)
            last_call_args = mock_ip_store.set.call_args[0]
            # last_call_args[0] is the key (IP), last_call_args[1] is the StringList
            assert len(last_call_args[1].root) == 5


# ---------------------------------------------------------------------------
# Extended cleanup edge-case tests
# ---------------------------------------------------------------------------

class TestInMemoryCleanupEdgeCases:
    """Comprehensive edge-case coverage for InMemoryTokenBucketRateLimiter.cleanup()."""

    def make_limiter(self, capacity=5, window_seconds=10, ttl=30):
        return InMemoryTokenBucketRateLimiter(
            capacity=capacity, window_seconds=window_seconds, entry_ttl_seconds=ttl
        )

    def test_cleanup_empty_store_returns_zero(self):
        """cleanup() on a fresh limiter with no buckets returns 0."""
        limiter = self.make_limiter()
        assert limiter.cleanup() == 0

    def test_cleanup_removes_all_expired_entries(self):
        """When every entry is past TTL, cleanup removes them all."""
        limiter = self.make_limiter(ttl=30)
        with patch("time.monotonic") as mock_time:
            mock_time.return_value = 1000.0
            for key in ["a", "b", "c"]:
                limiter.buckets[key] = _Bucket(tokens=5, last_refill=1000.0, last_access=1000.0)

            mock_time.return_value = 1031.0
            removed = limiter.cleanup()

        assert removed == 3
        assert len(limiter.buckets) == 0

    def test_cleanup_partial_expiry_mixed_entries(self):
        """Only expired entries are removed; fresh entries survive."""
        limiter = self.make_limiter(ttl=30)
        with patch("time.monotonic") as mock_time:
            mock_time.return_value = 1000.0
            for key in ["expired1", "expired2", "fresh1", "fresh2"]:
                limiter.buckets[key] = _Bucket(tokens=5, last_refill=1000.0, last_access=1000.0)

            mock_time.return_value = 1031.0
            # Bump fresh entries' last_access to the current (non-expired) time
            limiter.buckets["fresh1"].last_access = 1031.0
            limiter.buckets["fresh2"].last_access = 1031.0

            removed = limiter.cleanup()

        assert removed == 2
        assert "expired1" not in limiter.buckets
        assert "expired2" not in limiter.buckets
        assert "fresh1" in limiter.buckets
        assert "fresh2" in limiter.buckets

    def test_cleanup_exact_ttl_boundary_is_not_expired(self):
        """
        An entry whose age equals exactly the TTL is NOT removed because the
        condition is strictly greater-than: now - last_access > ttl.
        """
        limiter = self.make_limiter(ttl=30)
        with patch("time.monotonic") as mock_time:
            mock_time.return_value = 1000.0
            limiter.buckets["key"] = _Bucket(tokens=5, last_refill=1000.0, last_access=1000.0)

            mock_time.return_value = 1030.0  # age == 30 == ttl  →  NOT expired
            removed = limiter.cleanup()

        assert removed == 0
        assert "key" in limiter.buckets

    def test_cleanup_one_tick_past_ttl_is_expired(self):
        """An entry one second past the TTL IS removed."""
        limiter = self.make_limiter(ttl=30)
        with patch("time.monotonic") as mock_time:
            mock_time.return_value = 1000.0
            limiter.buckets["key"] = _Bucket(tokens=5, last_refill=1000.0, last_access=1000.0)

            mock_time.return_value = 1031.0  # age == 31 > 30 == ttl  →  expired
            removed = limiter.cleanup()

        assert removed == 1
        assert "key" not in limiter.buckets

    def test_cleanup_is_idempotent(self):
        """A second cleanup call after the first has nothing left to remove."""
        limiter = self.make_limiter(ttl=30)
        with patch("time.monotonic") as mock_time:
            mock_time.return_value = 1000.0
            limiter.buckets["key"] = _Bucket(tokens=5, last_refill=1000.0, last_access=1000.0)

            mock_time.return_value = 1031.0
            first = limiter.cleanup()
            second = limiter.cleanup()

        assert first == 1
        assert second == 0
        assert "key" not in limiter.buckets

    def test_cleanup_return_value_matches_removed_count_exactly(self):
        """Return value equals the precise number of removed entries."""
        limiter = self.make_limiter(ttl=30)
        n_expired = 7
        n_fresh = 3

        with patch("time.monotonic") as mock_time:
            mock_time.return_value = 1000.0
            for i in range(n_expired):
                limiter.buckets[f"expired_{i}"] = _Bucket(
                    tokens=5, last_refill=1000.0, last_access=1000.0
                )
            for i in range(n_fresh):
                # last_access is already "in the future" relative to cleanup time
                limiter.buckets[f"fresh_{i}"] = _Bucket(
                    tokens=5, last_refill=1000.0, last_access=1031.0
                )

            mock_time.return_value = 1031.0
            removed = limiter.cleanup()

        assert removed == n_expired
        assert len(limiter.buckets) == n_fresh

    @pytest.mark.asyncio
    async def test_cleanup_preserves_recently_active_user(self):
        """A user who made a request within the TTL window is never cleaned up."""
        limiter = self.make_limiter(capacity=5, window_seconds=10, ttl=30)
        with patch("time.monotonic") as mock_time:
            mock_time.return_value = 1000.0
            await limiter.allow("active_user")

            # Advance to within TTL (20 s < 30 s)
            mock_time.return_value = 1020.0
            removed = limiter.cleanup()

        assert removed == 0
        assert "active_user" in limiter.buckets

    @pytest.mark.asyncio
    async def test_cleanup_only_removes_inactive_users_not_active_ones(self):
        """Mix of active and inactive users: only inactive ones are cleaned up."""
        limiter = self.make_limiter(capacity=5, window_seconds=10, ttl=30)
        with patch("time.monotonic") as mock_time:
            mock_time.return_value = 1000.0
            await limiter.allow("active")
            await limiter.allow("inactive")

            # inactive user's last_access stays at 1000.0
            # Manually rewind inactive to ensure it reads as old
            mock_time.return_value = 1031.0
            limiter.buckets["active"].last_access = 1031.0  # still fresh
            # inactive.last_access remains 1000.0

            removed = limiter.cleanup()

        assert removed == 1
        assert "active" in limiter.buckets
        assert "inactive" not in limiter.buckets

    def test_cleanup_large_number_of_entries(self):
        """cleanup() scales correctly with many entries."""
        limiter = self.make_limiter(ttl=30)
        n = 1000
        with patch("time.monotonic") as mock_time:
            mock_time.return_value = 1000.0
            for i in range(n):
                limiter.buckets[f"key_{i}"] = _Bucket(
                    tokens=5, last_refill=1000.0, last_access=1000.0
                )
            # Half expire, half stay fresh
            for i in range(n // 2):
                limiter.buckets[f"key_{i}"].last_access = 1031.0

            mock_time.return_value = 1031.0
            removed = limiter.cleanup()

        assert removed == n // 2
        assert len(limiter.buckets) == n // 2


# ---------------------------------------------------------------------------
# get_client_ip tests
# ---------------------------------------------------------------------------

class TestGetClientIp:
    """Unit tests for the get_client_ip() helper in rate_limiter.py."""

    def make_request(self, client_host: str = "1.2.3.4", headers: dict | None = None):
        request = MagicMock(spec=Request)
        request.client = MagicMock()
        request.client.host = client_host
        request.headers = Headers(headers or {})
        return request

    # -- Direct (no-proxy) mode --

    def test_no_proxy_returns_connecting_ip(self):
        """Without proxy mode, always returns the direct connecting IP."""
        request = self.make_request(client_host="203.0.113.1")
        with patch.object(Settings, "BEHIND_PROXY", False):
            assert get_client_ip(request) == "203.0.113.1"

    def test_no_client_returns_none(self):
        """Returns None when request.client is None."""
        request = MagicMock(spec=Request)
        request.client = None
        with patch.object(Settings, "BEHIND_PROXY", False):
            assert get_client_ip(request) is None

    def test_empty_client_host_returns_none(self):
        """Returns None when client.host is an empty string."""
        request = self.make_request(client_host="")
        with patch.object(Settings, "BEHIND_PROXY", False):
            assert get_client_ip(request) is None

    # -- Custom header (CLIENT_IP_HEADER) --

    def test_custom_ip_header_used_when_present(self):
        """Uses CLIENT_IP_HEADER value when configured and the header is present."""
        request = self.make_request(
            client_host="10.0.0.1",
            headers={"CF-Connecting-IP": "5.6.7.8"},
        )
        with patch.object(Settings, "BEHIND_PROXY", True), \
             patch.object(Settings, "CLIENT_IP_HEADER", "CF-Connecting-IP"), \
             patch.object(Settings, "TRUSTED_PROXY_LIST", []):
            assert get_client_ip(request) == "5.6.7.8"

    def test_custom_ip_header_falls_through_to_x_real_ip_when_absent(self):
        """Falls through to X-Real-IP when CLIENT_IP_HEADER header is missing."""
        request = self.make_request(
            client_host="10.0.0.1",
            headers={"X-Real-IP": "9.9.9.9"},
        )
        with patch.object(Settings, "BEHIND_PROXY", True), \
             patch.object(Settings, "CLIENT_IP_HEADER", "CF-Connecting-IP"), \
             patch.object(Settings, "TRUSTED_PROXY_LIST", []):
            assert get_client_ip(request) == "9.9.9.9"

    def test_custom_ip_header_with_invalid_value_falls_through(self):
        """Falls through when CLIENT_IP_HEADER contains a non-IP string."""
        request = self.make_request(
            client_host="10.0.0.1",
            headers={"X-Custom-IP": "not-an-ip", "X-Real-IP": "8.8.8.8"},
        )
        with patch.object(Settings, "BEHIND_PROXY", True), \
             patch.object(Settings, "CLIENT_IP_HEADER", "X-Custom-IP"), \
             patch.object(Settings, "TRUSTED_PROXY_LIST", []):
            assert get_client_ip(request) == "8.8.8.8"

    # -- XFF / trusted-proxy chain --

    def test_xff_extracts_real_client_ip_from_trusted_proxy(self):
        """Extracts the real client IP from XFF when the connecting IP is a trusted proxy."""
        request = self.make_request(
            client_host="10.0.0.1",
            headers={"X-Forwarded-For": "203.0.113.5, 10.0.0.1"},
        )
        with patch.object(Settings, "BEHIND_PROXY", True), \
             patch.object(Settings, "CLIENT_IP_HEADER", None), \
             patch.object(Settings, "TRUSTED_PROXY_LIST", [ip_network("10.0.0.0/24")]):
            assert get_client_ip(request) == "203.0.113.5"

    def test_untrusted_connecting_ip_returned_directly(self):
        """Returns the connecting IP directly when it is not in TRUSTED_PROXY_LIST."""
        request = self.make_request(
            client_host="99.0.0.1",
            headers={"X-Forwarded-For": "5.5.5.5, 99.0.0.1"},
        )
        with patch.object(Settings, "BEHIND_PROXY", True), \
             patch.object(Settings, "CLIENT_IP_HEADER", None), \
             patch.object(Settings, "TRUSTED_PROXY_LIST", [ip_network("10.0.0.0/24")]):
            assert get_client_ip(request) == "99.0.0.1"

    def test_xff_chain_skips_all_trusted_proxies(self):
        """Walks XFF chain rightmost-first, skipping every trusted proxy."""
        request = self.make_request(
            client_host="10.0.0.3",
            headers={"X-Forwarded-For": "203.0.113.5, 10.0.0.1, 10.0.0.2"},
        )
        with patch.object(Settings, "BEHIND_PROXY", True), \
             patch.object(Settings, "CLIENT_IP_HEADER", None), \
             patch.object(Settings, "TRUSTED_PROXY_LIST", [ip_network("10.0.0.0/24")]):
            assert get_client_ip(request) == "203.0.113.5"

    def test_cidr_range_proxy_matching(self):
        """Connecting IP is matched against a CIDR range in TRUSTED_PROXY_LIST."""
        request = self.make_request(
            client_host="172.16.50.100",
            headers={"X-Forwarded-For": "1.2.3.4, 172.16.50.100"},
        )
        with patch.object(Settings, "BEHIND_PROXY", True), \
             patch.object(Settings, "CLIENT_IP_HEADER", None), \
             patch.object(Settings, "TRUSTED_PROXY_LIST", [ip_network("172.16.0.0/12")]):
            assert get_client_ip(request) == "1.2.3.4"

    def test_xff_all_trusted_falls_back_to_connecting_ip(self):
        """
        When every IP in the XFF chain is trusted, no real client IP is found
        in the chain, so the function falls through to the connecting IP.
        """
        request = self.make_request(
            client_host="10.0.0.3",
            headers={"X-Forwarded-For": "10.0.0.1, 10.0.0.2"},
        )
        with patch.object(Settings, "BEHIND_PROXY", True), \
             patch.object(Settings, "CLIENT_IP_HEADER", None), \
             patch.object(Settings, "TRUSTED_PROXY_LIST", [ip_network("10.0.0.0/24")]):
            # No non-trusted IP in XFF → falls through to X-Real-IP → fallback connecting_ip
            assert get_client_ip(request) == "10.0.0.3"

    # -- X-Real-IP fallback --

    def test_x_real_ip_fallback_when_no_trusted_proxy_list(self):
        """Falls back to X-Real-IP header when TRUSTED_PROXY_LIST is empty."""
        request = self.make_request(
            client_host="10.0.0.1",
            headers={"X-Real-IP": "8.8.8.8"},
        )
        with patch.object(Settings, "BEHIND_PROXY", True), \
             patch.object(Settings, "CLIENT_IP_HEADER", None), \
             patch.object(Settings, "TRUSTED_PROXY_LIST", []):
            assert get_client_ip(request) == "8.8.8.8"

    def test_fallback_to_connecting_ip_when_no_headers_in_proxy_mode(self):
        """Returns the connecting IP when in proxy mode but no forwarding headers exist."""
        request = self.make_request(client_host="10.0.0.1")
        with patch.object(Settings, "BEHIND_PROXY", True), \
             patch.object(Settings, "CLIENT_IP_HEADER", None), \
             patch.object(Settings, "TRUSTED_PROXY_LIST", []):
            assert get_client_ip(request) == "10.0.0.1"

    def test_single_entry_xff_with_trusted_proxy(self):
        """Single-IP XFF where that IP is the real client (connecting IP is proxy)."""
        request = self.make_request(
            client_host="10.0.0.1",
            headers={"X-Forwarded-For": "203.0.113.99"},
        )
        with patch.object(Settings, "BEHIND_PROXY", True), \
             patch.object(Settings, "CLIENT_IP_HEADER", None), \
             patch.object(Settings, "TRUSTED_PROXY_LIST", [ip_network("10.0.0.0/24")]):
            assert get_client_ip(request) == "203.0.113.99"


# ---------------------------------------------------------------------------
# rate_limit FastAPI dependency tests
# ---------------------------------------------------------------------------

class TestRateLimitDependency:
    """Tests for the rate_limit() FastAPI dependency factory."""

    def make_request(
        self,
        client_host: str = "1.2.3.4",
        path: str = "/api/test",
        host: str = "example.com",
    ):
        request = MagicMock(spec=Request)
        request.client = MagicMock()
        request.client.host = client_host
        request.headers = Headers({"host": host})
        request.url = MagicMock()
        request.url.path = path
        return request

    async def _call(self, request, capacity: int = 5, window: int = 60):
        dep = rate_limit(capacity, window)
        return await dep(request)

    # -- private_network scenario --

    @pytest.mark.asyncio
    async def test_private_network_allows_any_ip(self):
        """In private_network mode any IP is permitted; no access-control check."""
        mock_limiter = AsyncMock()
        mock_limiter.allow.return_value = True
        request = self.make_request(client_host="192.168.1.100")

        with patch("src.auth.rate_limiter.build_rate_limiter", new=AsyncMock(return_value=mock_limiter)), \
             patch.object(Settings, "DEPLOYMENT_SCENARIO", "private_network"), \
             patch("src.auth.rate_limiter.get_client_ip", return_value="192.168.1.100"):
            await self._call(request)  # no exception expected
            mock_limiter.allow.assert_called_once_with("/api/test:192.168.1.100")

    @pytest.mark.asyncio
    async def test_private_network_rate_limit_exceeded_raises_429(self):
        """Rate-limit exhaustion in private_network raises HTTP 429."""
        mock_limiter = AsyncMock()
        mock_limiter.allow.return_value = False
        request = self.make_request()

        with patch("src.auth.rate_limiter.build_rate_limiter", new=AsyncMock(return_value=mock_limiter)), \
             patch.object(Settings, "DEPLOYMENT_SCENARIO", "private_network"), \
             patch("src.auth.rate_limiter.get_client_ip", return_value="1.2.3.4"):
            with pytest.raises(HTTPException) as exc_info:
                await self._call(request)
            assert exc_info.value.status_code == 429

    # -- public_network scenario – IP access control --

    @pytest.mark.asyncio
    async def test_public_network_trusted_ip_is_allowed(self):
        """In public_network, a request from a trusted IP passes access control."""
        mock_limiter = AsyncMock()
        mock_limiter.allow.return_value = True
        request = self.make_request(client_host="203.0.113.5")

        with patch("src.auth.rate_limiter.build_rate_limiter", new=AsyncMock(return_value=mock_limiter)), \
             patch.object(Settings, "DEPLOYMENT_SCENARIO", "public_network"), \
             patch.object(Settings, "TRUSTED_IP_NETWORKS", [ip_network("203.0.113.0/24")]), \
             patch.object(Settings, "TRUSTED_DOMAINS", []), \
             patch("src.auth.rate_limiter.get_client_ip", return_value="203.0.113.5"):
            await self._call(request)  # no exception expected

    @pytest.mark.asyncio
    async def test_public_network_trusted_ip_cidr_range(self):
        """In public_network, any IP within a CIDR range is trusted."""
        mock_limiter = AsyncMock()
        mock_limiter.allow.return_value = True
        request = self.make_request(client_host="10.20.30.40")

        with patch("src.auth.rate_limiter.build_rate_limiter", new=AsyncMock(return_value=mock_limiter)), \
             patch.object(Settings, "DEPLOYMENT_SCENARIO", "public_network"), \
             patch.object(Settings, "TRUSTED_IP_NETWORKS", [ip_network("10.20.0.0/16")]), \
             patch.object(Settings, "TRUSTED_DOMAINS", []), \
             patch("src.auth.rate_limiter.get_client_ip", return_value="10.20.30.40"):
            await self._call(request)  # no exception expected

    @pytest.mark.asyncio
    async def test_public_network_untrusted_ip_raises_403(self):
        """In public_network, a request from an untrusted IP with no trusted domain raises 403."""
        mock_limiter = AsyncMock()
        mock_limiter.allow.return_value = True
        request = self.make_request(client_host="10.0.0.1", host="unknown.example.com")

        with patch("src.auth.rate_limiter.build_rate_limiter", new=AsyncMock(return_value=mock_limiter)), \
             patch.object(Settings, "DEPLOYMENT_SCENARIO", "public_network"), \
             patch.object(Settings, "TRUSTED_IP_NETWORKS", [ip_network("203.0.113.0/24")]), \
             patch.object(Settings, "TRUSTED_DOMAINS", []), \
             patch("src.auth.rate_limiter.get_client_ip", return_value="10.0.0.1"):
            with pytest.raises(HTTPException) as exc_info:
                await self._call(request)
            assert exc_info.value.status_code == 403

    @pytest.mark.asyncio
    async def test_public_network_empty_trusted_lists_blocks_everyone(self):
        """In public_network with no trusted IPs or domains, every request is blocked."""
        mock_limiter = AsyncMock()
        mock_limiter.allow.return_value = True
        request = self.make_request(client_host="1.2.3.4")

        with patch("src.auth.rate_limiter.build_rate_limiter", new=AsyncMock(return_value=mock_limiter)), \
             patch.object(Settings, "DEPLOYMENT_SCENARIO", "public_network"), \
             patch.object(Settings, "TRUSTED_IP_NETWORKS", []), \
             patch.object(Settings, "TRUSTED_DOMAINS", []), \
             patch("src.auth.rate_limiter.get_client_ip", return_value="1.2.3.4"):
            with pytest.raises(HTTPException) as exc_info:
                await self._call(request)
            assert exc_info.value.status_code == 403

    # -- public_network scenario – domain access control --

    @pytest.mark.asyncio
    async def test_public_network_trusted_domain_is_allowed(self):
        """In public_network, a request with a trusted Host header domain is allowed."""
        mock_limiter = AsyncMock()
        mock_limiter.allow.return_value = True
        request = self.make_request(client_host="5.5.5.5", host="api.mycompany.com")

        with patch("src.auth.rate_limiter.build_rate_limiter", new=AsyncMock(return_value=mock_limiter)), \
             patch.object(Settings, "DEPLOYMENT_SCENARIO", "public_network"), \
             patch.object(Settings, "TRUSTED_IP_NETWORKS", []), \
             patch.object(Settings, "TRUSTED_DOMAINS", ["api.mycompany.com"]), \
             patch("src.auth.rate_limiter.get_client_ip", return_value="5.5.5.5"):
            await self._call(request)  # no exception expected

    @pytest.mark.asyncio
    async def test_public_network_domain_matching_is_case_insensitive(self):
        """Domain matching lowercases the Host header before comparing."""
        mock_limiter = AsyncMock()
        mock_limiter.allow.return_value = True
        request = self.make_request(client_host="5.5.5.5", host="API.MyCompany.COM")

        with patch("src.auth.rate_limiter.build_rate_limiter", new=AsyncMock(return_value=mock_limiter)), \
             patch.object(Settings, "DEPLOYMENT_SCENARIO", "public_network"), \
             patch.object(Settings, "TRUSTED_IP_NETWORKS", []), \
             patch.object(Settings, "TRUSTED_DOMAINS", ["api.mycompany.com"]), \
             patch("src.auth.rate_limiter.get_client_ip", return_value="5.5.5.5"):
            await self._call(request)  # no exception expected

    @pytest.mark.asyncio
    async def test_public_network_host_header_port_is_stripped(self):
        """Host header containing a port (e.g. domain:8080) is stripped before matching."""
        mock_limiter = AsyncMock()
        mock_limiter.allow.return_value = True
        request = self.make_request(client_host="5.5.5.5", host="api.mycompany.com:8080")

        with patch("src.auth.rate_limiter.build_rate_limiter", new=AsyncMock(return_value=mock_limiter)), \
             patch.object(Settings, "DEPLOYMENT_SCENARIO", "public_network"), \
             patch.object(Settings, "TRUSTED_IP_NETWORKS", []), \
             patch.object(Settings, "TRUSTED_DOMAINS", ["api.mycompany.com"]), \
             patch("src.auth.rate_limiter.get_client_ip", return_value="5.5.5.5"):
            await self._call(request)  # no exception expected

    @pytest.mark.asyncio
    async def test_public_network_untrusted_domain_no_trusted_ip_raises_403(self):
        """Untrusted domain and untrusted IP together → 403."""
        mock_limiter = AsyncMock()
        mock_limiter.allow.return_value = True
        request = self.make_request(client_host="5.5.5.5", host="evil.attacker.com")

        with patch("src.auth.rate_limiter.build_rate_limiter", new=AsyncMock(return_value=mock_limiter)), \
             patch.object(Settings, "DEPLOYMENT_SCENARIO", "public_network"), \
             patch.object(Settings, "TRUSTED_IP_NETWORKS", [ip_network("203.0.113.0/24")]), \
             patch.object(Settings, "TRUSTED_DOMAINS", ["api.mycompany.com"]), \
             patch("src.auth.rate_limiter.get_client_ip", return_value="5.5.5.5"):
            with pytest.raises(HTTPException) as exc_info:
                await self._call(request)
            assert exc_info.value.status_code == 403

    @pytest.mark.asyncio
    async def test_public_network_trusted_ip_overrides_untrusted_domain(self):
        """Trusted IP is sufficient even when the domain is not in the trusted list."""
        mock_limiter = AsyncMock()
        mock_limiter.allow.return_value = True
        request = self.make_request(client_host="203.0.113.5", host="some-random-host.com")

        with patch("src.auth.rate_limiter.build_rate_limiter", new=AsyncMock(return_value=mock_limiter)), \
             patch.object(Settings, "DEPLOYMENT_SCENARIO", "public_network"), \
             patch.object(Settings, "TRUSTED_IP_NETWORKS", [ip_network("203.0.113.0/24")]), \
             patch.object(Settings, "TRUSTED_DOMAINS", ["api.mycompany.com"]), \
             patch("src.auth.rate_limiter.get_client_ip", return_value="203.0.113.5"):
            await self._call(request)  # no exception expected

    @pytest.mark.asyncio
    async def test_public_network_trusted_domain_overrides_untrusted_ip(self):
        """Trusted domain is sufficient even when the IP is not in the trusted list."""
        mock_limiter = AsyncMock()
        mock_limiter.allow.return_value = True
        request = self.make_request(client_host="99.99.99.99", host="api.mycompany.com")

        with patch("src.auth.rate_limiter.build_rate_limiter", new=AsyncMock(return_value=mock_limiter)), \
             patch.object(Settings, "DEPLOYMENT_SCENARIO", "public_network"), \
             patch.object(Settings, "TRUSTED_IP_NETWORKS", [ip_network("203.0.113.0/24")]), \
             patch.object(Settings, "TRUSTED_DOMAINS", ["api.mycompany.com"]), \
             patch("src.auth.rate_limiter.get_client_ip", return_value="99.99.99.99"):
            await self._call(request)  # no exception expected

    @pytest.mark.asyncio
    async def test_public_network_rate_limit_exceeded_raises_429(self):
        """Rate-limit exhaustion in public_network raises HTTP 429 even for trusted IPs."""
        mock_limiter = AsyncMock()
        mock_limiter.allow.return_value = False
        request = self.make_request(client_host="203.0.113.5")

        with patch("src.auth.rate_limiter.build_rate_limiter", new=AsyncMock(return_value=mock_limiter)), \
             patch.object(Settings, "DEPLOYMENT_SCENARIO", "public_network"), \
             patch.object(Settings, "TRUSTED_IP_NETWORKS", [ip_network("203.0.113.0/24")]), \
             patch.object(Settings, "TRUSTED_DOMAINS", []), \
             patch("src.auth.rate_limiter.get_client_ip", return_value="203.0.113.5"):
            with pytest.raises(HTTPException) as exc_info:
                await self._call(request)
            assert exc_info.value.status_code == 429

    # -- Error / edge cases --

    @pytest.mark.asyncio
    async def test_missing_client_ip_raises_400(self):
        """When get_client_ip returns None the dependency raises HTTP 400."""
        mock_limiter = AsyncMock()
        request = self.make_request()

        with patch("src.auth.rate_limiter.build_rate_limiter", new=AsyncMock(return_value=mock_limiter)), \
             patch.object(Settings, "DEPLOYMENT_SCENARIO", "private_network"), \
             patch("src.auth.rate_limiter.get_client_ip", return_value=None):
            with pytest.raises(HTTPException) as exc_info:
                await self._call(request)
            assert exc_info.value.status_code == 400

    @pytest.mark.asyncio
    async def test_invalid_deployment_scenario_raises_500(self):
        """An unrecognised DEPLOYMENT_SCENARIO value raises HTTP 500."""
        mock_limiter = AsyncMock()
        mock_limiter.allow.return_value = True
        request = self.make_request()

        with patch("src.auth.rate_limiter.build_rate_limiter", new=AsyncMock(return_value=mock_limiter)), \
             patch.object(Settings, "DEPLOYMENT_SCENARIO", "unknown_mode"), \
             patch("src.auth.rate_limiter.get_client_ip", return_value="1.2.3.4"):
            with pytest.raises(HTTPException) as exc_info:
                await self._call(request)
            assert exc_info.value.status_code == 500

    @pytest.mark.asyncio
    async def test_rate_limit_key_combines_path_and_ip(self):
        """The limiter is called with a key in the form '<path>:<client_ip>'."""
        mock_limiter = AsyncMock()
        mock_limiter.allow.return_value = True
        request = self.make_request(client_host="1.2.3.4", path="/oauth/token")

        with patch("src.auth.rate_limiter.build_rate_limiter", new=AsyncMock(return_value=mock_limiter)), \
             patch.object(Settings, "DEPLOYMENT_SCENARIO", "private_network"), \
             patch("src.auth.rate_limiter.get_client_ip", return_value="1.2.3.4"):
            await self._call(request)
            mock_limiter.allow.assert_called_once_with("/oauth/token:1.2.3.4")

    @pytest.mark.asyncio
    async def test_different_paths_have_independent_rate_limit_keys(self):
        """Two paths for the same IP are treated as independent rate-limit buckets."""
        limiter = InMemoryTokenBucketRateLimiter(capacity=1, window_seconds=60)
        request_a = self.make_request(client_host="1.2.3.4", path="/oauth/token")
        request_b = self.make_request(client_host="1.2.3.4", path="/oauth/authorize")

        with patch("src.auth.rate_limiter.build_rate_limiter", new=AsyncMock(return_value=limiter)), \
             patch.object(Settings, "DEPLOYMENT_SCENARIO", "private_network"), \
             patch("src.auth.rate_limiter.get_client_ip", return_value="1.2.3.4"):
            # Both paths are fresh → first request for each allowed
            await self._call(request_a)
            await self._call(request_b)
            # Both paths exhausted → second request for each denied
            with pytest.raises(HTTPException) as exc:
                await self._call(request_a)
            assert exc.value.status_code == 429
            with pytest.raises(HTTPException) as exc:
                await self._call(request_b)
            assert exc.value.status_code == 429

    @pytest.mark.asyncio
    async def test_two_different_ips_have_independent_rate_limits(self):
        """Two clients from different IPs are rate-limited independently."""
        limiter = InMemoryTokenBucketRateLimiter(capacity=1, window_seconds=60)
        request_a = self.make_request(client_host="1.1.1.1", path="/test")
        request_b = self.make_request(client_host="2.2.2.2", path="/test")

        with patch("src.auth.rate_limiter.build_rate_limiter", new=AsyncMock(return_value=limiter)), \
             patch.object(Settings, "DEPLOYMENT_SCENARIO", "private_network"):
            # First request for each IP is allowed
            with patch("src.auth.rate_limiter.get_client_ip", return_value="1.1.1.1"):
                await self._call(request_a)
            with patch("src.auth.rate_limiter.get_client_ip", return_value="2.2.2.2"):
                await self._call(request_b)

            # Second request for each IP is denied
            with patch("src.auth.rate_limiter.get_client_ip", return_value="1.1.1.1"):
                with pytest.raises(HTTPException) as exc:
                    await self._call(request_a)
                assert exc.value.status_code == 429

            with patch("src.auth.rate_limiter.get_client_ip", return_value="2.2.2.2"):
                with pytest.raises(HTTPException) as exc:
                    await self._call(request_b)
                assert exc.value.status_code == 429