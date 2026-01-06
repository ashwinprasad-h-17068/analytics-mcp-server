from abc import ABC, abstractmethod
from typing import Optional, Type, TypeVar, Generic, Dict, Tuple
from pydantic import BaseModel
import redis
import time
import asyncio
from logging_util import get_logger
from config import Settings
from collections import deque
import zcatalyst_sdk
from zcatalyst_sdk import credentials
from zcatalyst_sdk.types import ICatalystOptions
import math
from dataclasses import dataclass
import threading


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





class CatalystAppRegistry:
    """
    Thread-safe registry for Catalyst SDK app instances.
    """

    _lock = threading.Lock()
    _apps: Dict[Tuple[int, str, str], object] = {}


    @staticmethod
    def _get_option(options: ICatalystOptions, key: str):
        if isinstance(options, dict):
            return options.get(key)
        return getattr(options, key)

    @classmethod
    def get_app(
        cls,
        *,
        credential: credentials.RefreshTokenCredential,
        options: ICatalystOptions,
        app_name: str,
    ):
        project_id = cls._get_option(options, "project_id")
        environment = cls._get_option(options, "environment")

        if project_id is None or environment is None:
            raise ValueError("Invalid Catalyst options: project_id/environment missing")

        key = (project_id, environment, app_name)
        app = cls._apps.get(key)
        if app is not None:
            return app

        with cls._lock:
            app = cls._apps.get(key)
            if app is not None:
                return app
                
            app = zcatalyst_sdk.initialize_app(
                credential=credential,
                options=options,
                name=app_name,
            )
            cls._apps[key] = app
            return app


class CatalystCacheProvider(PersistenceProvider[T]):
    """
    PersistenceProvider using Zoho Catalyst Cloud Scale Cache.

    - Keys and values in Catalyst cache are strings.
    - TTL is specified in HOURS in segment.put(key, value, expiry_in_hours).
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
        self._segment_id = segment_id

        cred_payload = {
            "refresh_token": cfg.refresh_token,
            "client_id": cfg.client_id,
            "client_secret": cfg.client_secret,
        }
        catalyst_credential = credentials.RefreshTokenCredential(cred_payload)

        catalyst_options = ICatalystOptions(
            project_id=cfg.project_id,
            project_key=cfg.project_key,     
            project_domain=cfg.project_domain,
            environment=cfg.environment,
        )

        self._catalyst_app = CatalystAppRegistry.get_app(
            credential=catalyst_credential,
            options=catalyst_options,
            app_name=cfg.app_name,
        )

        cache_service = self._catalyst_app.cache()
        self._segment = (
            cache_service.segment(self._segment_id)
            if self._segment_id
            else cache_service.segment()
        )

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
        full_key = self._get_key(key)
        payload = value.model_dump_json()

        expiry_hours = self._sec_to_expiry_hours(ttl_in_sec)

        if expiry_hours is None:
            self._segment.put(full_key, payload)
        else:
            self._segment.put(full_key, payload, expiry_hours)

    def get(self, key: str) -> Optional[T]:
        full_key = self._get_key(key)
        raw = self._segment.get_value(full_key)
        if not raw:
            return None
        return self.model_class.model_validate_json(raw)

    def delete(self, key: str) -> None:
        full_key = self._get_key(key)
        self._segment.delete(full_key)



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
                environment=Settings.CATALYST_ENVIRONMENT,  # "Development" or "Production"
                client_id=Settings.CATALYST_CLIENT_ID,
                client_secret=Settings.CATALYST_CLIENT_SECRET,
                refresh_token=Settings.CATALYST_REFRESH_TOKEN,
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
