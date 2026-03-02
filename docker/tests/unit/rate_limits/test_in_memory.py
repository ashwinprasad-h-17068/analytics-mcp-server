from src.auth.rate_limiter import InMemoryTokenBucket
import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from starlette.requests import Request
from starlette.datastructures import Headers
from src.auth.rate_limiter import _Bucket
import time


class TestInMemoryTokenBucket:

    def make_limiter(self, capacity=5, window_seconds=10, ttl=3600):
        return InMemoryTokenBucket(capacity=capacity, window_seconds=window_seconds, entry_ttl_seconds=ttl)

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
        bucket = InMemoryTokenBucket(capacity=1, window_seconds=60, entry_ttl_seconds=1)

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