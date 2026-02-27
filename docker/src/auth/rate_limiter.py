from abc import ABC, abstractmethod
from dataclasses import dataclass
import time
from collections import defaultdict
import asyncio
from typing import Optional, Dict
from ..config import Settings
from functools import lru_cache
from fastapi import Request, HTTPException, status
from ..sdk.redis_client import RedisClientSingleton
from ..logging_util import get_logger
from ipaddress import ip_address, ip_network


logger = get_logger(__name__)

class RateLimiter(ABC):
    @abstractmethod
    async def allow(self, key: str) -> bool:
        pass

@dataclass(slots=True)
class _Bucket:
    tokens: float
    last_refill: float
    last_access: float


class InMemoryTokenBucket:

    __slots__ = (
        "capacity",
        "refill_rate",
        "entry_ttl_seconds",
        "buckets",
    )

    def __init__(
        self,
        capacity: int,
        window_seconds: int,
        entry_ttl_seconds: int = 3600,
    ):
        self.capacity = capacity
        self.refill_rate = capacity / window_seconds
        self.entry_ttl_seconds = entry_ttl_seconds
        self.buckets: Dict[str, _Bucket] = {}

    async def allow(self, key: str) -> bool:
        now = time.monotonic()
        bucket = self.buckets.get(key)
        if bucket is None:
            self.buckets[key] = _Bucket(
                tokens=self.capacity - 1,
                last_refill=now,
                last_access=now,
            )
            return True

        if now - bucket.last_access > self.entry_ttl_seconds:
            bucket.tokens = self.capacity - 1
            bucket.last_refill = now
            bucket.last_access = now
            return True

        delta = now - bucket.last_refill
        if delta > 0:
            bucket.tokens = min(
                self.capacity,
                bucket.tokens + delta * self.refill_rate,
            )
            bucket.last_refill = now

        
        if bucket.tokens < 1:
            return False


        bucket.last_access = now
        bucket.tokens -= 1
        return True

    def cleanup(self) -> int:
        now = time.monotonic()
        to_delete = [
            key
            for key, bucket in self.buckets.items()
            if now - bucket.last_access > self.entry_ttl_seconds
        ]

        for key in to_delete:
            del self.buckets[key]

        return len(to_delete)
        

TOKEN_BUCKET_SCRIPT = """
local key = KEYS[1]

local capacity = tonumber(ARGV[1])
local refill_rate = tonumber(ARGV[2]) -- tokens per millisecond
local requested = tonumber(ARGV[3])

-- Use Redis server time
local now_data = redis.call("TIME")
local now = now_data[1] * 1000 + math.floor(now_data[2] / 1000)

-- Get existing bucket
local bucket = redis.call("HMGET", key, "tokens", "last_refill")
local tokens = tonumber(bucket[1])
local last_refill = tonumber(bucket[2])

if tokens == nil then
    tokens = capacity
    last_refill = now
else
    -- Refill tokens
    local delta = now - last_refill
    local refill = delta * refill_rate
    tokens = math.min(capacity, tokens + refill)
    last_refill = now
end

local allowed = 0

if tokens >= requested then
    tokens = tokens - requested
    allowed = 1
end

-- Save state
redis.call("HMSET", key,
    "tokens", tokens,
    "last_refill", last_refill
)

-- Auto-expire bucket (idle cleanup)
-- TTL = time to fully refill from empty
local ttl = math.ceil(capacity / refill_rate)
redis.call("PEXPIRE", key, ttl)

return allowed
"""


class RedisTokenBucketRateLimiter(RateLimiter):
    def __init__(self, redis_client, capacity: int, window_seconds: int):
        """
        capacity: max burst (e.g., 5 requests)
        window_seconds: time window to fully refill (e.g., 60 seconds)
        """
        self.redis = redis_client
        self.capacity = capacity
        
        # refill_rate = tokens per millisecond
        self.refill_rate = capacity / (window_seconds * 1000)

        self.script = self.redis.register_script(TOKEN_BUCKET_SCRIPT)

    async def allow_tokens(self, key: str, tokens: int = 1) -> bool:
        key = f"rl:{key}"

        allowed = await self.script(
            keys=[key],
            args=[self.capacity, self.refill_rate, tokens]
        )

        return bool(allowed)


    async def allow(self, key: str) -> bool:
        return await self.allow_tokens(key)
    

_rate_limiter_cache = {}
_rate_limiter_lock = asyncio.Lock()

async def build_rate_limiter(capacity: int, window_seconds: int) -> RateLimiter:
    key = (capacity, window_seconds)

    """
    The double checked locking pattern might not be necessary here since this is an ASGI application
    but it's not harmful either. Keeping it here for an additional safety guarantee.
    """
    if key in _rate_limiter_cache:
        return _rate_limiter_cache[key]

    async with _rate_limiter_lock:
        if key in _rate_limiter_cache:
            return _rate_limiter_cache[key]

        backend = Settings.STORAGE_BACKEND

        if backend == "redis":
            redis_client = await RedisClientSingleton.get_client()
            limiter = RedisTokenBucketRateLimiter(
                redis_client=redis_client,
                capacity=capacity,
                window_seconds=window_seconds,
            )
        else:
            limiter = InMemoryTokenBucket(
                capacity=capacity,
                window_seconds=window_seconds
            )

        _rate_limiter_cache[key] = limiter
        return limiter


def get_client_ip(request: Request) -> str | None:
    """
    Extracts the client IP address based on application settings.

    - BEHIND_PROXY=False (default): Use request.client.host directly.
    - BEHIND_PROXY=True: Trust X-Forwarded-For only if the immediate
      connecting IP is in TRUSTED_PROXY_LIST, then walk the XFF chain
      to find the first non-private, non-trusted IP (the real client).
    """

    def _is_trusted_proxy(ip: str) -> bool:
        try:
            addr = ip_address(ip)
            for net in Settings.TRUSTED_PROXY_LIST:
                if addr in ip_network(net):
                    return True
        except ValueError:
            pass
        return False
    
    # def _is_public_ip(ip: str) -> bool:
    #     try:
    #         addr = ip_address(ip)
    #         return (
    #             not addr.is_private
    #             and not addr.is_loopback
    #             and not addr.is_reserved
    #             and not addr.is_multicast
    #         )
    #     except ValueError:
    #         return False


    connecting_ip: str | None = request.client.host if request.client else None

    if not connecting_ip:
        return None

    if not Settings.BEHIND_PROXY:
        return connecting_ip
    
    # If direct peer is not trusted → treat as client
    if not _is_trusted_proxy(connecting_ip):
        return connecting_ip
    
    # Parse X-Forwarded-For: leftmost = original client, rightmost = last proxy
    # Format: "client, proxy1, proxy2"
    xff = request.headers.get("X-Forwarded-For")
    if xff:
        # Walk from rightmost to leftmost, skipping trusted proxies,
        # and return the first IP that is NOT in our trusted list.
        ips = [ip.strip() for ip in xff.split(",")]
        for ip in reversed(ips):
            if not _is_trusted_proxy(ip):
                return ip

    
    # Fallback to X-Real-IP
    x_real_ip = request.headers.get("X-Real-IP")
    if x_real_ip:
        return x_real_ip
    
    return connecting_ip



def rate_limit(capacity: int, window_seconds: int):

    async def dependency(request: Request):
        
        limiter: RateLimiter = await build_rate_limiter(capacity, window_seconds)
        client_ip = get_client_ip(request)

        if not client_ip:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Unable to determine client IP for rate limiting.",
            )

        key = f"{request.url.path}:{client_ip}"
        allowed = await limiter.allow(key)

        if not allowed:
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail="Rate limit exceeded. Try again later.",
            )

    return dependency


async def rate_limiter_cleanup_task(limiter: InMemoryTokenBucket, interval_seconds: int = 60):
    logger.info(f"Starting rate limiter cleanup task with interval {interval_seconds} seconds.")
    try:
        while True:
            removed = limiter.cleanup()
            logger.info(f"Rate limiter cleanup: removed {removed} expired buckets.")
            await asyncio.sleep(interval_seconds)
    except asyncio.CancelledError:
        logger.info("Rate limiter cleanup task cancelled.")
            