import asyncio
from redis.asyncio import Redis
from typing import Optional
from src.config import Settings


class RedisClientSingleton:
    _instance: Optional[Redis] = None
    _lock = asyncio.Lock()

    @classmethod
    async def get_client(cls) -> Redis:
        if cls._instance is None:
            async with cls._lock:
                if cls._instance is None:
                    cls._instance = Redis(
                        host=Settings.REDIS_HOST,
                        port=Settings.REDIS_PORT,
                        password=Settings.REDIS_PASSWORD,
                        decode_responses=True,
                        max_connections=35,
                    )
                    await cls._instance.ping()
        return cls._instance

    @classmethod
    async def close(cls):
        if cls._instance:
            await cls._instance.close()
            cls._instance = None