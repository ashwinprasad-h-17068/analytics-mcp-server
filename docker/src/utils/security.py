import anyio
from starlette.types import ASGIApp, Receive, Scope, Send
from starlette.responses import JSONResponse
from starlette.datastructures import Headers, MutableHeaders
from starlette.requests import Request
from src.logging_util import get_logger
from src.auth.rate_limiter import get_client_ip

logger = get_logger(__name__)

class BodyTooLargeException(Exception):
    """Internal exception for flow control."""
    pass


class MaxBodySizeMiddleware:
    """
    Enforces a maximum request body size for HTTP requests.

    Notes:
    - Limits are enforced as the downstream app reads from `receive()`.
    - For true "front-door" protection (even if the app never reads the body),
      also configure a server/proxy body-size limit.
    """

    def __init__(
        self,
        app: ASGIApp,
        max_body_size: int = 1_000_000,
        drain_timeout_seconds: float = 1.0,
        close_connection_on_reject: bool = True,
    ):
        self.app = app
        self.max_body_size = max_body_size
        self.drain_timeout_seconds = drain_timeout_seconds
        self.close_connection_on_reject = close_connection_on_reject

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        headers = Headers(scope=scope)
        content_length = headers.get("content-length")

        # Track whether we started sending a response already
        response_started = False

        async def tracking_send(message):
            nonlocal response_started
            if message["type"] == "http.response.start":
                response_started = True
            await send(message)


        async def reject(detail: str, status_code: int = 413):
            await self._drain_body(receive)

            extra_headers = {}
            if self.close_connection_on_reject:
                extra_headers["Connection"] = "close"

            response = JSONResponse(
                {"detail": detail},
                status_code=status_code,
                headers=extra_headers if extra_headers else None,
            )


            async def final_dummy_receive():
                return {"type": "http.request", "body": b"", "more_body": False}

            await response(scope, final_dummy_receive, send)


        if content_length is not None:
            try:
                if int(content_length) > self.max_body_size:
                    await reject("Content-Length too large", status_code=413)
                    return
            except ValueError:
                await reject("Invalid Content-Length", status_code=400)
                return


        total_received = 0
        async def limited_receive() -> dict:
            nonlocal total_received
            message = await receive()

            if message["type"] == "http.request":
                chunk = message.get("body", b"") or b""
                total_received += len(chunk)
                if total_received > self.max_body_size:
                    raise BodyTooLargeException()

            return message

        try:
            await self.app(scope, limited_receive, tracking_send)
        except BodyTooLargeException:
            if response_started:
                raise
            await reject("Body size limit exceeded", status_code=413)

    async def _drain_body(self, receive: Receive) -> None:
        """
        Best-effort drain of remaining request body with a strict timeout.
        Helps the client see a proper HTTP response instead of a TCP reset.
        """
        try:
            with anyio.fail_after(self.drain_timeout_seconds):
                more_body = True
                while more_body:
                    message = await receive()
                    if message["type"] == "http.disconnect":
                        break
                    more_body = bool(message.get("more_body", False))
        except Exception:
            pass


class GlobalRateLimiterMiddleware:
    
    def __init__(
        self, 
        app: ASGIApp,
        error_message: str = "Rate limit exceeded. Try again later.",
    ):
        self.app = app
        self.error_message = error_message


    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        request = Request(scope)
        rate_limiter = getattr(request.app.state, "global_rate_limiter", None)

        if rate_limiter is None:
            logger.error("global_rate_limiter not found in app.state")
            await self.app(scope, receive, send)
            return
        
        client_ip = get_client_ip(request)
        if not client_ip:
            logger.warning("Could not determine client IP for rate limiting")
            response = JSONResponse(
                status_code=400,
                content="Unable to determine client IP for rate limiting.",
            )
            await response(scope, receive, send)
            return

        try:
            if not await rate_limiter.allow(client_ip):
                logger.warning(f"Rate limit exceeded for IP: {client_ip}")
                response = JSONResponse(
                    status_code=429,
                    content={"detail": self.error_message},
                )
                await response(scope, receive, send)
                return
        except Exception as e:
            logger.error(f"Error checking rate limit: {e}")
            await self.app(scope, receive, send)
            return

        await self.app(scope, receive, send)