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
        invalid_params.append({
            "field": ".".join(map(str, error["loc"])), # e.g., "body.items.0.name"
            "reason": error["msg"],
            "type": error["type"]
        })


    log_extra = {
        "url": str(request.url),
        "method": request.method,
        "errors": invalid_params
    }
    logger.error(f"Validation failed for {request.method} {request.url}", extra=log_extra)


    return JSONResponse(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        content={
            "success": False,
            "error_code": "VALIDATION_ERROR",
            "message": "The data provided is invalid. Please check the 'details' field.",
            "details": invalid_params,
            "timestamp": time.time()
        },
    )