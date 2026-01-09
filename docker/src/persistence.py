from abc import ABC, abstractmethod
from typing import Optional, Type, TypeVar, Generic, Dict, Tuple
from pydantic import BaseModel
import redis
import time
import asyncio
from logging_util import get_logger
from config import Settings
from collections import deque
import math
from dataclasses import dataclass
import threading
from CatalystClient import CatalystCache


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
        self._expiry_queue = deque()  # (expiry_time, key)

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


@dataclass(frozen=True)
class CatalystSDKConfig:
    project_id: int
    project_key: str  # ZAID
    environment: str  # "Development" or "Production"
    client_id: str
    client_secret: str
    refresh_token: str
    project_domain: str = "https://api.catalyst.zoho.in"
    app_name: str = "MyAppCatalystSDK"



class CatalystCacheProvider(PersistenceProvider[T]):
    """
    Async PersistenceProvider using Zoho Catalyst Cloud Scale Cache via REST API.

    - Keys and values in Catalyst cache are strings.
    - TTL is specified in HOURS.
    - Uses direct REST API calls with async/await instead of the Catalyst SDK.
    """

    def __init__(
        self,
        model_class: Type[T],
        cfg: CatalystSDKConfig,
        prefix: str,
        segment_id: Optional[str] = None,
    ):
        super().__init__(model_class)
        self.prefix = prefix
        
        if not segment_id:
            raise ValueError("segment_id is required for REST API implementation")
        
        # Initialize the async REST API cache client
        self._cache_client = CatalystCache(
            client_id=cfg.client_id,
            client_secret=cfg.client_secret,
            refresh_token=cfg.refresh_token,
            project_id=str(cfg.project_id),
            segment_id=segment_id,
            api_domain=cfg.project_domain,
            accounts_server_url=self._get_accounts_url(cfg.project_domain)
        )



    @staticmethod
    def _get_accounts_url(project_domain: str) -> str:
        region_map = {
            ".zoho.in": "https://accounts.zoho.in",
            ".zoho.eu": "https://accounts.zoho.eu",
            ".zoho.com.au": "https://accounts.zoho.com.au",
            ".zoho.jp": "https://accounts.zoho.jp",
        }
        for suffix, url in region_map.items():
            if project_domain.endswith(suffix):
                return url
        return "https://accounts.zoho.com"

    def _get_key(self, key: str) -> str:
        return f"{self.prefix}:{key}"
    
    @staticmethod
    def _sec_to_expiry_hours(ttl_in_sec: Optional[int]) -> Optional[int]:
        if ttl_in_sec is None:
            return None
        if ttl_in_sec <= 0:
            return None
        return max(1, int(math.ceil(ttl_in_sec / 3600)))

    def set(self, key: str, value: T, ttl_in_sec: Optional[int] = None) -> None:
        """Store the model instance with an optional TTL."""
        full_key = self._get_key(key)
        payload = value.model_dump_json()
        expiry_hours = self._sec_to_expiry_hours(ttl_in_sec)
        self._cache_client.insert(
            cache_name=full_key,
            cache_value=payload,
            expiry_in_hours=expiry_hours
        )

    def get(self, key: str) -> Optional[T]:
        """Retrieve and validate the model instance."""
        full_key = self._get_key(key)
        try:
            response = self._cache_client.get(full_key)
            # Response structure: {"status": "success", "data": {"cache_value": "...", ...}}
            if response and response.get("status") == "success":
                data = response.get("data", {})
                raw_value = data.get("cache_value")
                if raw_value:
                    return self.model_class.model_validate_json(raw_value)
            return None
        except Exception:
            return None

    def delete(self, key: str) -> None:
        """Remove the key from storage."""
        full_key = self._get_key(key)
        self._cache_client.delete(full_key)

    def close(self) -> None:
        """Close the cache client and cleanup resources."""
        self._cache_client.close()
        if self._loop and not self._loop.is_closed():
            self._loop.close()

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.close()


class PersistenceFactory:
    @staticmethod
    def create(model_class: Type[T], scope: str) -> PersistenceProvider[T]:
        mode = Settings.STORAGE_BACKEND
        
        if mode == "redis":
            return RedisProvider(
                model_class=model_class,
                host=Settings.REDIS_HOST,
                port=Settings.REDIS_PORT,
                prefix=scope
            )
        
        if mode == "catalyst":
            cfg = CatalystSDKConfig(
                project_id=Settings.CATALYST_PROJECT_ID,
                project_key=Settings.CATALYST_ZAID,
                environment=Settings.CATALYST_ENVIRONMENT,
                client_id=Settings.CATALYST_CLIENT_ID,
                client_secret=Settings.CATALYST_CLIENT_SECRET,
                refresh_token=Settings.CATALYST_REFRESH_TOKEN,
                project_domain=Settings.CATALYST_PROJECT_DOMAIN,
                app_name=Settings.CATALYST_SDK_APP_NAME,
            )
            return CatalystCacheProvider(
                model_class=model_class,
                cfg=cfg,
                prefix=scope,
                segment_id=Settings.CATALYST_CACHE_SEGMENT_ID,
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
