"""Unit tests for auth loaders."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from web2api.auth import (
    AuthError,
    chatgpt_available,
    gemini_available,
    get_client,
    load_chatgpt_auth,
    load_perplexity_cookies,
    perplexity_available,
)


def test_load_perplexity_cookies_from_file(tmp_path: Path) -> None:
    cookies = {"session": "abc123"}
    path = tmp_path / "cookies.local.json"
    path.write_text(json.dumps(cookies), encoding="utf-8")

    assert load_perplexity_cookies(path) == cookies


def test_load_perplexity_cookies_from_env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("PERPLEXITY_COOKIES", '{"token":"env-value"}')
    path = tmp_path / "missing.json"

    assert load_perplexity_cookies(path) == {"token": "env-value"}


def test_load_perplexity_cookies_empty_when_missing(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.delenv("PERPLEXITY_COOKIES", raising=False)
    path = tmp_path / "missing.json"

    assert load_perplexity_cookies(path) == {}


def test_load_chatgpt_auth_missing_raises(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("CHATGPT_AUTH", raising=False)
    path = tmp_path / "missing.json"

    with pytest.raises(AuthError, match="ChatGPT auth not found"):
        load_chatgpt_auth(path)


def test_load_chatgpt_auth_from_env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    payload = {"cookies": {"a": "b"}, "headers": {"authorization": "Bearer x"}, "account_id": "1"}
    monkeypatch.setenv("CHATGPT_AUTH", json.dumps(payload))

    assert load_chatgpt_auth(tmp_path / "missing.json") == payload


def test_provider_availability(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("PERPLEXITY_COOKIES", raising=False)
    monkeypatch.delenv("CHATGPT_AUTH", raising=False)
    monkeypatch.delenv("GEMINI_AUTH", raising=False)

    assert not perplexity_available(tmp_path / "cookies.local.json")
    assert not chatgpt_available(tmp_path / "chatgpt.local.json")
    assert not gemini_available(tmp_path / "gemini.local.json")

    (tmp_path / "cookies.local.json").write_text("{}", encoding="utf-8")
    assert perplexity_available(tmp_path / "cookies.local.json")


def test_get_client_unknown_provider() -> None:
    with pytest.raises(AuthError, match="Unknown provider"):
        get_client("unknown")
