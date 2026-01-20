import tools
from mcp_instance import mcp
import contextlib
from fastapi import FastAPI
import uvicorn
import os
# import debugpy
from remote_auth import authRouter
from logging_util import configure_logging, get_logger
from remote_auth import AuthMiddleware
from config import Settings
from starlette.middleware.sessions import SessionMiddleware
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
import asyncio
from contextlib import asynccontextmanager
from persistence import InMemoryProvider, ttl_cleanup_task
from remote_auth import registed_clients_store


Settings.HOSTED_LOCATION = Settings.CONSTANT_REMOTE_HOSTED_LOCATION

configure_logging(
    level="INFO",              # overall minimum
    console_level="INFO",       # console: only INFO+
    file_level="INFO",         # file: capture everything
    log_file="app.log",
    max_bytes=5 * 1024 * 1024,  # 5 MB
    backup_count=3,
)

logger = get_logger(__name__)
# Uncomment below line to start the debugger
# debugpy.listen(("0.0.0.0", 5678))

@asynccontextmanager
async def lifespan(app: FastAPI):

    bg_task = None
    if isinstance(registed_clients_store, InMemoryProvider):
        bg_task = asyncio.create_task(ttl_cleanup_task(registed_clients_store))
        logger.info("Background TTL scheduler started for InMemoryProvider.")

    async with mcp_server.lifespan(app):
        yield
    
    if bg_task:
        bg_task.cancel()
        try:
            await bg_task
        except asyncio.CancelledError:
            logger.info("Background TTL scheduler stopped.")

mcp_server = mcp.http_app(transport="streamable-http", path="/")
app = FastAPI(lifespan=lifespan)
app.mount("/static", StaticFiles(directory="static"), name="static")
app.add_middleware(AuthMiddleware)
app.add_middleware(SessionMiddleware, secret_key=Settings.SESSION_SECRET_KEY)
app.include_router(authRouter, prefix="")
app.mount("/mcp", mcp_server)



# This is required for testing with inspector. Uncomment when needed.
# app.add_middleware(
#     CORSMiddleware,
#     allow_origins=["http://localhost:6274"],
#     allow_credentials=True,
#     allow_methods=["*"],
#     allow_headers=["*"],
# )



def main():
    port = Settings.PORT
    uvicorn.run(app, host="0.0.0.0", port=port)

if __name__ == "__main__":
    main()