from mcp_instance import mcp
import contextlib
from fastapi import FastAPI
import uvicorn
import os
import debugpy
from remote_auth import authRouter
from logging_util import configure_logging
from remote_auth import AuthMiddleware


# Uncomment below line to start the debugger
# debugpy.listen(("0.0.0.0", 5678))

@contextlib.asynccontextmanager
async def app_lifespan(app: FastAPI):
    yield

mcp_server = mcp.http_app(transport="streamable-http", path="/mcp")

@contextlib.asynccontextmanager
async def combined_lifespan(app: FastAPI):
    async with app_lifespan(app):
        async with mcp_server.lifespan(app):
            yield

app = FastAPI(lifespan=combined_lifespan)
app.add_middleware(AuthMiddleware)
app.include_router(authRouter, prefix="")
app.mount("/analytics", mcp_server)


configure_logging(
    level="DEBUG",              # overall minimum
    console_level="INFO",       # console: only INFO+
    file_level="DEBUG",         # file: capture everything
    log_file="app.log",
    max_bytes=5 * 1024 * 1024,  # 5 MB
    backup_count=3,
)


def main():
    port = int(os.getenv("PORT","4000"))
    uvicorn.run(app, host="0.0.0.0", port=port)

if __name__ == "__main__":
    main()