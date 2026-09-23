"""Logging helpers for the Perplexity client."""

from __future__ import annotations

import logging

from .config import LOG_FORMAT, LOG_LEVEL

_CONFIGURED = False


def _configure_logging() -> None:
    global _CONFIGURED
    if _CONFIGURED:
        return
    logging.basicConfig(format=LOG_FORMAT, level=getattr(logging, LOG_LEVEL, logging.INFO))
    _CONFIGURED = True


def get_logger(name: str) -> logging.Logger:
    _configure_logging()
    return logging.getLogger(f"web2api.perplexity.{name}")
