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

    # ------------------------------------------------------------------ #
    # TTL / implicit cleanup behaviour                                     #
    # ------------------------------------------------------------------ #

    async def test_ttl_is_larger_for_larger_window(self):
        """
        A larger window_seconds produces a proportionally larger key TTL.
        TTL formula: ceil(capacity / refill_rate_ms) == window_seconds * 1000 ms.
        """
        r_short, limiter_short = self.make_limiter(capacity=5, window_seconds=10)
        r_long, limiter_long = self.make_limiter(capacity=5, window_seconds=60)

        await limiter_short.allow("user1")
        await limiter_long.allow("user1")

        pttl_short = await r_short.pttl("rl:user1")
        pttl_long = await r_long.pttl("rl:user1")

        # window=60 s should yield ~6 × the TTL of window=10 s
        assert pttl_long > pttl_short
        assert abs(pttl_short - 10_000) < 1_000   # ~10 000 ms
        assert abs(pttl_long - 60_000) < 1_000    # ~60 000 ms

    async def test_multiple_keys_each_have_independent_ttl(self):
        """Every key created in Redis gets its own TTL, independently of others."""
        r, limiter = self.make_limiter(capacity=5, window_seconds=10)
        await limiter.allow("user1")
        await limiter.allow("user2")
        await limiter.allow("user3")

        pttl1 = await r.pttl("rl:user1")
        pttl2 = await r.pttl("rl:user2")
        pttl3 = await r.pttl("rl:user3")

        assert pttl1 > 0
        assert pttl2 > 0
        assert pttl3 > 0

    async def test_expired_key_resets_to_full_capacity(self):
        """
        After a key's TTL expires (key deleted), the next request creates a
        completely fresh bucket with full capacity.
        """
        r, limiter = self.make_limiter(capacity=3, window_seconds=10)
        for _ in range(3):
            await limiter.allow("user1")
        assert await limiter.allow("user1") is False  # exhausted

        await r.delete("rl:user1")  # simulate TTL expiry

        # Fresh bucket: all 3 tokens available again
        assert await limiter.allow("user1") is True
        assert await limiter.allow("user1") is True
        assert await limiter.allow("user1") is True
        assert await limiter.allow("user1") is False  # exhausted again

    async def test_ttl_set_even_on_denied_request(self):
        """
        The Lua script calls PEXPIRE unconditionally, so even a denied request
        refreshes the key TTL — key is never abandoned with a stale TTL.
        """
        r, limiter = self.make_limiter(capacity=2, window_seconds=30)
        await limiter.allow("user1")
        await limiter.allow("user1")
        assert await limiter.allow("user1") is False  # denied

        pttl = await r.pttl("rl:user1")
        assert pttl > 0
        assert abs(pttl - 30_000) < 1_000

    async def test_key_ttl_is_reset_on_each_subsequent_request(self):
        """Each successive allow() call resets the TTL back to the full window."""
        r, limiter = self.make_limiter(capacity=5, window_seconds=10)

        for _ in range(3):
            await limiter.allow("user1")

        pttl = await r.pttl("rl:user1")
        assert pttl > 0
        assert abs(pttl - 10_000) < 1_000

    # ------------------------------------------------------------------ #
    # allow_tokens edge cases                                              #
    # ------------------------------------------------------------------ #

    async def test_allow_tokens_single_token_equivalent_to_allow(self):
        """allow_tokens(key, 1) behaves identically to allow(key)."""
        _, limiter = self.make_limiter(capacity=3, window_seconds=10)

        assert await limiter.allow_tokens("user1", 1) is True
        assert await limiter.allow("user1") is True
        assert await limiter.allow_tokens("user1", 1) is True
        # 3 tokens consumed — bucket empty
        assert await limiter.allow("user1") is False

    async def test_allow_tokens_denied_does_not_consume_partial_tokens(self):
        """
        When allow_tokens is denied (not enough tokens), zero tokens are
        deducted — the Lua script is atomic and only subtracts on success.
        """
        _, limiter = self.make_limiter(capacity=4, window_seconds=10)

        # Consume 3, leaving 1
        for _ in range(3):
            await limiter.allow("user1")

        # Request 3 — denied; the 1 remaining token must be untouched
        assert await limiter.allow_tokens("user1", 3) is False

        # The single remaining token should still be usable
        assert await limiter.allow("user1") is True
        assert await limiter.allow("user1") is False  # now truly empty

    async def test_allow_tokens_larger_than_capacity_always_denied(self):
        """Requesting more tokens than the bucket capacity is always denied."""
        _, limiter = self.make_limiter(capacity=3, window_seconds=10)
        assert await limiter.allow_tokens("user1", 4) is False  # fresh bucket, still denied

    async def test_allow_tokens_sequential_partial_draining(self):
        """Sequential allow_tokens calls drain the bucket correctly."""
        _, limiter = self.make_limiter(capacity=10, window_seconds=60)

        assert await limiter.allow_tokens("user1", 4) is True   # 10 → 6
        assert await limiter.allow_tokens("user1", 4) is True   # 6  → 2
        assert await limiter.allow_tokens("user1", 3) is False  # need 3, only 2 remain
        assert await limiter.allow_tokens("user1", 2) is True   # 2  → 0
        assert await limiter.allow_tokens("user1", 1) is False  # empty

    # ------------------------------------------------------------------ #
    # Refill ceiling / capacity cap                                        #
    # ------------------------------------------------------------------ #

    async def test_refill_cannot_exceed_capacity(self):
        """
        Even after a very long idle period (10× the window), the bucket refills
        to exactly capacity — never above it.
        """
        _, limiter = self.make_limiter(capacity=5, window_seconds=10)

        with patch(_FAKEREDIS_TIME_MODULE) as mock_time_mod:
            mock_time_mod.time.return_value = 1000.0
            for _ in range(5):
                await limiter.allow("user1")
            assert await limiter.allow("user1") is False  # exhausted

            # Advance by 10× the window
            mock_time_mod.time.return_value = 1100.0

            # Exactly capacity tokens available — no more
            for _ in range(5):
                assert await limiter.allow("user1") is True
            assert await limiter.allow("user1") is False

    async def test_capacity_one_allows_exactly_one_then_denies(self):
        """A capacity=1 bucket permits exactly one request per full window."""
        _, limiter = self.make_limiter(capacity=1, window_seconds=10)
        assert await limiter.allow("user1") is True
        assert await limiter.allow("user1") is False

    async def test_capacity_one_refills_after_full_window(self):
        """After a full window elapses, a capacity=1 bucket grants one more request."""
        _, limiter = self.make_limiter(capacity=1, window_seconds=10)

        with patch(_FAKEREDIS_TIME_MODULE) as mock_time_mod:
            mock_time_mod.time.return_value = 1000.0
            assert await limiter.allow("user1") is True
            assert await limiter.allow("user1") is False

            mock_time_mod.time.return_value = 1010.0  # full window elapsed
            assert await limiter.allow("user1") is True
            assert await limiter.allow("user1") is False
