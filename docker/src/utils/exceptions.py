from fastapi.exceptions import RequestValidationError
from requests import Request
from fastapi.responses import JSONResponse
from src.logging_util import get_logger
import time
from fastapi import status


logger = get_logger(__name__)


async def validation_exception_handler(request: Request, exc: RequestValidationError):

    invalid_params = []

    for error in exc.errors():
        field = ".".join(map(str, error["loc"]))
        message = error["msg"]
        err_type = error["type"]

        invalid_params.append({
            "field": field,
            "reason": message,
            "type": err_type
        })

    # Build readable log message
    error_messages = [
        f"{param['field']} -> {param['reason']} ({param['type']})"
        for param in invalid_params
    ]

    log_message = (
        f"Validation failed | {request.method} {request.url} | "
        f"Errors: {'; '.join(error_messages)}"
    )

    logger.error(
        log_message,
        extra={
            "url": str(request.url),
            "method": request.method,
            "errors": invalid_params
        }
    )

    return JSONResponse(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        content={
            "success": False,
            "error_code": "VALIDATION_ERROR",
            "message": "The data provided is invalid.",
            "details": invalid_params,
            "timestamp": time.time()
        },
    )