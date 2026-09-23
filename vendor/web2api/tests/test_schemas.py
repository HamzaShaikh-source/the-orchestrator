"""Unit tests for server schemas."""

from __future__ import annotations

import base64

import pytest
from pydantic import ValidationError

from web2api.server.schemas import PERPLEXITY_MODEL_LOOKUP, ChatRequest, FileAttachment


def test_chat_request_defaults() -> None:
    body = ChatRequest(message="Hello")
    assert body.provider == "perplexity"
    assert body.model_id == "auto"
    assert body.web_search is True
    assert body.session is None
    assert body.files == []


def test_chat_request_accepts_session_and_files() -> None:
    body = ChatRequest(
        message="Hello",
        provider="chatgpt",
        session={"conversation_id": "abc"},
        files=[
            FileAttachment(
                filename="doc.txt",
                content_base64=base64.b64encode(b"data").decode(),
            )
        ],
    )
    assert body.session == {"conversation_id": "abc"}
    assert len(body.files) == 1


def test_chat_request_rejects_empty_message() -> None:
    with pytest.raises(ValidationError):
        ChatRequest(message="")


def test_chat_request_rejects_invalid_provider() -> None:
    with pytest.raises(ValidationError):
        ChatRequest(provider="openai", message="Hello")


def test_chat_request_rejects_invalid_sources() -> None:
    with pytest.raises(ValidationError):
        ChatRequest(message="Hello", sources=["news"])


def test_perplexity_model_lookup_contains_auto() -> None:
    assert "auto" in PERPLEXITY_MODEL_LOOKUP
    assert PERPLEXITY_MODEL_LOOKUP["auto"]["mode"] == "auto"
