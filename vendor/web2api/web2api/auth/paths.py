"""Default auth file locations."""

from __future__ import annotations

import os
from pathlib import Path


def _resolve_auth_dir() -> Path:
    env_dir = os.environ.get("WEB2API_AUTH_DIR", "").strip()
    if env_dir:
        return Path(env_dir)

    cwd_auth = Path.cwd() / "auth"
    if cwd_auth.exists():
        return cwd_auth

    source_root = Path(__file__).resolve().parents[2]
    package_auth = source_root / "auth"
    if package_auth.exists() and any(package_auth.glob("*.example")):
        return package_auth

    return cwd_auth


AUTH_DIR = _resolve_auth_dir()
PERPLEXITY_COOKIES_FILE = AUTH_DIR / "cookies.local.json"
CHATGPT_AUTH_FILE = AUTH_DIR / "chatgpt.local.json"
GEMINI_AUTH_FILE = AUTH_DIR / "gemini.local.json"
