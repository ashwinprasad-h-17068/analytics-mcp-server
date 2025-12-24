from abc import ABC, abstractmethod
from typing import Optional, Type, TypeVar, Generic
from pydantic import BaseModel
import redis
import os
import time
import asyncio
from logging_util import get_logger

logger = get_logger(__name__)

T = TypeVar("T", bound=BaseModel)

class PersistenceProvider(ABC, Generic[T]):
    def __init__(self, model_class: Type[T]):
        self.model_class = model_class

    @abstractmethod
    def set(self, key: str, value: T, ttl_in_sec: Optional[int] = None) -> None:
        """Store the model instance with an optional TTL."""
        pass

    @abstractmethod
    def get(self, key: str) -> Optional[T]:
        """Retrieve and validate the model instance."""
        pass

    @abstractmethod
    def delete(self, key: str) -> None:
        """Remove the key from storage."""
        pass


class InMemoryProvider(PersistenceProvider[T]):
    def __init__(self, model_class: Type[T]):
        super().__init__(model_class)
        self._data: dict[str, str] = {}

    def set(self, key: str, value: T, ttl_in_sec: Optional[int] = None) -> None:
        self._data[key] = value.model_dump_json()
        if ttl_in_sec:
            expiry_time = time.time() + ttl_in_sec
            self._expiry_queue.append((expiry_time, key))

    def get(self, key: str) -> Optional[T]:
        raw = self._data.get(key)
        return self.model_class.model_validate_json(raw) if raw else None

    def delete(self, key: str) -> None:
        self._data.pop(key, None)

    def cleanup_expired(self) -> int:
        """Removes expired items and returns the count of deleted items."""
        now = time.time()
        count = 0
        while self._expiry_queue and self._expiry_queue[0][0] <= now:
            _, key = self._expiry_queue.popleft()
            if key in self._data:
                logger.debug(f"Cleaning up expired key: {key}")
                del self._data[key]
                count += 1
        return count



class RedisProvider(PersistenceProvider[T]):
    def __init__(self, model_class: Type[T], host: str, port: int, prefix: str):
        super().__init__(model_class)
        self.client = redis.Redis(host=host, port=port, decode_responses=True)
        self.prefix = prefix

    def _get_key(self, key: str) -> str:
        return f"{self.prefix}:{key}"

    def set(self, key: str, value: T, ttl_in_sec: Optional[int] = None) -> None:
        full_key = self._get_key(key)
        self.client.set(full_key, value.model_dump_json(), ex=ttl_in_sec)

    def get(self, key: str) -> Optional[T]:
        raw = self.client.get(self._get_key(key))
        return self.model_class.model_validate_json(raw) if raw else None

    def delete(self, key: str) -> None:
        self.client.delete(self._get_key(key))


class PersistenceFactory:
    @staticmethod
    def create(model_class: Type[T], scope: str) -> PersistenceProvider[T]:
        mode = os.getenv("STORAGE_MODE", "memory").lower()
        
        if mode == "redis":
            return RedisProvider(
                model_class=model_class,
                host=os.getenv("REDIS_HOST", "localhost"),
                port=int(os.getenv("REDIS_PORT", 6379)),
                prefix=scope
            )
        return InMemoryProvider(model_class=model_class)


async def ttl_cleanup_task(provider: InMemoryProvider):
    logger.debug(f"Starting TTL cleanup task for registered clients store")
    while True:
        try:
            provider.cleanup_expired()
        except Exception as e:
            print(f"Cleanup error: {e}")
        await asyncio.sleep(60)