"""Unified auth loading for all providers."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Union

from web2api import chatgpt, gemini, perplexity

from .paths import CHATGPT_AUTH_FILE, GEMINI_AUTH_FILE, PERPLEXITY_COOKIES_FILE

ProviderName = str
Client = Union[perplexity.Client, chatgpt.Client, gemini.Client]


class AuthError(Exception):
    pass


def _load_json_file(path: Path) -> dict[str, Any]:
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def load_perplexity_cookies(path: Path | None = None) -> dict[str, str]:
    auth_path = path or PERPLEXITY_COOKIES_FILE
    if auth_path.exists():
        data = _load_json_file(auth_path)
        return data if isinstance(data, dict) else {}

    raw = os.environ.get("PERPLEXITY_COOKIES", "").strip()
    if raw:
        return json.loads(raw)
    return {}


def load_chatgpt_auth(path: Path | None = None) -> dict[str, Any]:
    auth_path = path or CHATGPT_AUTH_FILE
    if auth_path.exists():
        return _load_json_file(auth_path)

    raw = os.environ.get("CHATGPT_AUTH", "").strip()
    if raw:
        return json.loads(raw)
    raise AuthError(f"ChatGPT auth not found. Create {auth_path} or set CHATGPT_AUTH.")


def load_gemini_auth(path: Path | None = None) -> dict[str, Any]:
    auth_path = path or GEMINI_AUTH_FILE
    if auth_path.exists():
        return _load_json_file(auth_path)

    raw = os.environ.get("GEMINI_AUTH", "").strip()
    if raw:
        return json.loads(raw)
    raise AuthError(f"Gemini auth not found. Create {auth_path} or set GEMINI_AUTH.")


def perplexity_available(path: Path | None = None) -> bool:
    auth_path = path or PERPLEXITY_COOKIES_FILE
    return auth_path.exists() or bool(os.environ.get("PERPLEXITY_COOKIES", "").strip())


def chatgpt_available(path: Path | None = None) -> bool:
    auth_path = path or CHATGPT_AUTH_FILE
    return auth_path.exists() or bool(os.environ.get("CHATGPT_AUTH", "").strip())


def gemini_available(path: Path | None = None) -> bool:
    auth_path = path or GEMINI_AUTH_FILE
    return auth_path.exists() or bool(os.environ.get("GEMINI_AUTH", "").strip())


def get_client(provider: ProviderName, *, auth_path: Path | None = None) -> Client:
    if provider == "perplexity":
        return perplexity.Client(load_perplexity_cookies(auth_path))
    if provider == "chatgpt":
        return chatgpt.Client(load_chatgpt_auth(auth_path))
    if provider == "gemini":
        return gemini.Client(load_gemini_auth(auth_path))
    raise AuthError(f"Unknown provider: {provider}")
