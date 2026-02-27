from unittest.mock import patch

import fakeredis.aioredis
import pytest

from src.auth.rate_limiter import RedisTokenBucketRateLimiter

# Patch target: time module inside fakeredis's TIME command implementation.
# The Redis TIME command in fakeredis calls time.time(), so patching this
# module-level reference controls the clock seen by the Lua token-bucket script.
_FAKEREDIS_TIME_MODULE = "fakeredis.commands_mixins.server_mixin.time"


class TestRedisTokenBucketRateLimiter:

    def make_limiter(self, capacity: int = 5, window_seconds: int = 10):
        """
        Return a (redis_client, limiter) pair backed by an isolated FakeRedis
        instance. Each call creates a completely independent Redis namespace,
        so tests never share state.
        """
        r = fakeredis.aioredis.FakeRedis(decode_responses=True)
        limiter = RedisTokenBucketRateLimiter(
            redis_client=r,
            capacity=capacity,
            window_seconds=window_seconds,
        )
        return r, limiter

    # ------------------------------------------------------------------ #
    # Basic allow / deny behaviour                                         #
    # ------------------------------------------------------------------ #

    async def test_first_request_always_allowed(self):
        _, limiter = self.make_limiter(capacity=5, window_seconds=10)
        assert await limiter.allow("user1") is True

    async def test_requests_within_capacity_are_allowed(self):
        _, limiter = self.make_limiter(capacity=5, window_seconds=10)
        results = [await limiter.allow("user1") for _ in range(5)]
        assert all(results)

    async def test_request_exceeding_capacity_is_denied(self):
        _, limiter = self.make_limiter(capacity=3, window_seconds=10)
        for _ in range(3):
            await limiter.allow("user1")
        assert await limiter.allow("user1") is False

    async def test_different_keys_are_isolated(self):
        _, limiter = self.make_limiter(capacity=2, window_seconds=10)
        for _ in range(2):
            await limiter.allow("user1")

        # user1 is exhausted; user2 has its own independent bucket
        assert await limiter.allow("user1") is False
        assert await limiter.allow("user2") is True

    # ------------------------------------------------------------------ #
    # Time-based token refill                                              #
    # ------------------------------------------------------------------ #

    async def test_tokens_refill_over_time(self):
        _, limiter = self.make_limiter(capacity=2, window_seconds=10)

        with patch(_FAKEREDIS_TIME_MODULE) as mock_time_mod:
            mock_time_mod.time.return_value = 1000.0

            await limiter.allow("user1")
            await limiter.allow("user1")
            assert await limiter.allow("user1") is False  # exhausted

            # Advance by a full window — should fully refill
            mock_time_mod.time.return_value = 1010.0
            assert await limiter.allow("user1") is True

    async def test_partial_refill_grants_correct_tokens(self):
        """Half a window should refill ~half the tokens."""
        _, limiter = self.make_limiter(capacity=4, window_seconds=10)  # rate = 0.0004 tokens/ms

        with patch(_FAKEREDIS_TIME_MODULE) as mock_time_mod:
            mock_time_mod.time.return_value = 1000.0

            for _ in range(4):
                await limiter.allow("user1")
            assert await limiter.allow("user1") is False  # exhausted

            # Advance by 5 s → refill 2 tokens
            mock_time_mod.time.return_value = 1005.0
            assert await limiter.allow("user1") is True
            assert await limiter.allow("user1") is True
            assert await limiter.allow("user1") is False  # only 2 tokens refilled

    # ------------------------------------------------------------------ #
    # Redis-specific behaviour                                             #
    # ------------------------------------------------------------------ #

    async def test_key_is_prefixed_with_rl(self):
        """allow() stores bucket state under 'rl:<key>', not '<key>'."""
        r, limiter = self.make_limiter(capacity=5, window_seconds=10)
        await limiter.allow("myuser")

        keys = await r.keys("*")
        assert "rl:myuser" in keys
        assert "myuser" not in keys

    async def test_allow_tokens_consumes_multiple_tokens(self):
        """allow_tokens(key, n) atomically deducts n tokens in one script call."""
        _, limiter = self.make_limiter(capacity=5, window_seconds=10)
        assert await limiter.allow_tokens("user1", 3) is True   # 5 -> 2 tokens remain
        assert await limiter.allow_tokens("user1", 3) is False  # only 2 remain, need 3

    async def test_allow_tokens_exact_boundary(self):
        """Consuming exactly the remaining capacity should succeed; next call fails."""
        _, limiter = self.make_limiter(capacity=5, window_seconds=10)
        assert await limiter.allow_tokens("user1", 5) is True   # drains bucket fully
        assert await limiter.allow_tokens("user1", 1) is False  # empty

    async def test_key_ttl_is_set_after_request(self):
        """
        The Lua script calls PEXPIRE after every request.
        TTL = ceil(capacity / refill_rate_ms) = window_seconds * 1000 ms.
        """
        r, limiter = self.make_limiter(capacity=5, window_seconds=10)
        await limiter.allow("user1")

        pttl = await r.pttl("rl:user1")
        expected_ms = 10 * 1000  # window_seconds * 1000

        assert pttl > 0
        assert abs(pttl - expected_ms) < 1000  # generous slack for execution time

    async def test_key_ttl_is_refreshed_on_subsequent_requests(self):
        """Each allow() call resets the key TTL, keeping the bucket alive."""
        r, limiter = self.make_limiter(capacity=5, window_seconds=10)
        await limiter.allow("user1")
        await limiter.allow("user1")

        pttl = await r.pttl("rl:user1")
        assert pttl > 0

    async def test_denied_request_still_refreshes_ttl(self):
        """
        Even a denied request invokes the Lua script, which always calls
        PEXPIRE — so the key's TTL is renewed regardless of whether the
        request was allowed.
        """
        r, limiter = self.make_limiter(capacity=1, window_seconds=10)
        await limiter.allow("user1")               # consumes the single token
        assert await limiter.allow("user1") is False  # denied

        pttl = await r.pttl("rl:user1")
        assert pttl > 0

    async def test_expired_key_resets_bucket(self):
        """
        When the Redis key expires (TTL elapses), the next allow() call
        finds no bucket and creates a fresh one — behaving like the first
        request for that key.
        """
        r, limiter = self.make_limiter(capacity=2, window_seconds=10)
        await limiter.allow("user1")
        await limiter.allow("user1")
        assert await limiter.allow("user1") is False  # exhausted

        # Simulate natural TTL expiry by removing the key from Redis
        await r.delete("rl:user1")

        assert await limiter.allow("user1") is True   # fresh bucket after expiry

    async def test_allow_is_atomic_across_keys(self):
        """
        Separate keys in the same Redis instance are completely independent;
        exhausting one never affects another.
        """
        _, limiter = self.make_limiter(capacity=1, window_seconds=10)
        assert await limiter.allow("a") is True
        assert await limiter.allow("b") is True
        assert await limiter.allow("a") is False  # a exhausted
        assert await limiter.allow("b") is False  # b exhausted independently
        assert await limiter.allow("c") is True   # c untouched
