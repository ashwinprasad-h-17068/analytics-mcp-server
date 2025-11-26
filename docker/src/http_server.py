import tools
from mcp_instance import mcp
import contextlib
from fastapi import FastAPI
import uvicorn
import os
# import debugpy
from remote_auth import authRouter
from logging_util import configure_logging
from remote_auth import AuthMiddleware
from config import Settings
from starlette.middleware.sessions import SessionMiddleware
from fastapi.middleware.cors import CORSMiddleware


Settings.HOSTED_LOCATION = "REMOTE"

# Uncomment below line to start the debugger
# debugpy.listen(("0.0.0.0", 5678))


mcp_server = mcp.http_app(transport="streamable-http", path="/mcp")

app = FastAPI(lifespan=mcp_server.lifespan)
app.add_middleware(AuthMiddleware)
app.add_middleware(SessionMiddleware, secret_key="YOUR_VERY_SECURE_SECRET")
app.include_router(authRouter, prefix="")
app.mount("/analytics", mcp_server)

# app.add_middleware(
#     CORSMiddleware,
#     allow_origins=["http://localhost:6274"],
#     allow_credentials=True,
#     allow_methods=["*"],
#     allow_headers=["*"],
# )

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