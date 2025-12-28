"""
Simple logging utility with console + rotating file handlers.

Usage:

    from logging_util import configure_logging, get_logger

    configure_logging(
        level="DEBUG",
        log_file="app.log",
        max_bytes=5 * 1024 * 1024,  # 5 MB
        backup_count=5,
    )

    logger = get_logger(__name__)
    logger.info("Hello from my module")
"""

import logging
from logging.handlers import RotatingFileHandler
from typing import Optional, Union


_LEVEL_MAP = {
    "CRITICAL": logging.CRITICAL,
    "ERROR": logging.ERROR,
    "WARNING": logging.WARNING,
    "INFO": logging.INFO,
    "DEBUG": logging.DEBUG,
}


def _to_level(level: Union[int, str]) -> int:
    """Convert string/int level to a logging level int."""
    if isinstance(level, int):
        return level
    level = level.upper()
    return _LEVEL_MAP.get(level, logging.INFO)


def configure_logging(
    *,
    level: Union[int, str] = "INFO",
    console_level: Optional[Union[int, str]] = None,
    file_level: Optional[Union[int, str]] = None,
    log_file: Optional[str] = None,
    max_bytes: int = 10 * 1024 * 1024,  # 10 MB
    backup_count: int = 5,
    fmt: str = "%(asctime)s | %(levelname)-8s | %(name)s | %(message)s",
    datefmt: str = "%Y-%m-%d %H:%M:%S",
    clear_existing: bool = True,
) -> None:
    """
    Configure application-wide logging.

    Parameters
    ----------
    level:
        Root logger level (min level you care about). Can be int or string (e.g. "DEBUG").
    console_level:
        Specific level for console. Defaults to `level` if not provided.
    file_level:
        Specific level for file handler. Defaults to `level` if not provided.
    log_file:
        If provided, logs will also go to a rotating file using RotatingFileHandler.
    max_bytes:
        Maximum size (in bytes) of each log file before rotation.
        Only used if `log_file` is provided.
    backup_count:
        How many rotated log files to keep.
        Only used if `log_file` is provided.
    fmt:
        Log message format.
    datefmt:
        Datetime format in logs.
    clear_existing:
        If True (default), removes existing handlers from the root logger
        before adding new ones. This avoids duplicate logs when `configure_logging`
        is called multiple times.
    """
    root = logging.getLogger()

    root_level = _to_level(level)
    root.setLevel(root_level)

    if clear_existing:
        for h in list(root.handlers):
            root.removeHandler(h)

    formatter = logging.Formatter(fmt=fmt, datefmt=datefmt)

    # --- Console handler ---
    console_handler = logging.StreamHandler()
    console_handler.setLevel(_to_level(console_level or level))
    console_handler.setFormatter(formatter)
    root.addHandler(console_handler)

    # --- Optional rotating file handler ---
    if log_file:
        file_handler = RotatingFileHandler(
            filename=log_file,
            maxBytes=max_bytes,
            backupCount=backup_count,
            encoding="utf-8",
        )
        file_handler.setLevel(_to_level(file_level or level))
        file_handler.setFormatter(formatter)
        root.addHandler(file_handler)


def get_logger(name: Optional[str] = None) -> logging.Logger:
    """
    Get a logger for a module or component.

    Usage:
        logger = get_logger(__name__)
    """
    return logging.getLogger(name)
