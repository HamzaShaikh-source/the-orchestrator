"""Unit tests for server session helpers."""

from __future__ import annotations

import base64

import pytest

from web2api.server.schemas import ChatRequest, FileAttachment
from web2api.server.session_utils import (
    decode_file_attachments,
    resolve_chatgpt_session,
    resolve_gemini_session,
    resolve_perplexity_session,
    resolve_perplexity_sources,
)


def test_resolve_perplexity_session_prefers_session_over_follow_up() -> None:
    body = ChatRequest(
        message="Hi",
        session={"backend_uuid": "new"},
        follow_up={"backend_uuid": "old"},
    )
    assert resolve_perplexity_session(body) == {"backend_uuid": "new"}


def test_resolve_perplexity_session_falls_back_to_follow_up() -> None:
    body = ChatRequest(message="Hi", follow_up={"backend_uuid": "legacy"})
    assert resolve_perplexity_session(body) == {"backend_uuid": "legacy"}


def test_resolve_gemini_session_normalizes_values() -> None:
    body = ChatRequest(
        message="Hi",
        provider="gemini",
        session={"conversation_id": "abc", "response_id": 1, "choice_id": None},
    )
    assert resolve_gemini_session(body) == {
        "conversation_id": "abc",
        "response_id": "1",
        "choice_id": "",
    }


def test_resolve_chatgpt_session() -> None:
    body = ChatRequest(
        message="Hi",
        provider="chatgpt",
        session={"conversation_id": "abc", "parent_message_id": "parent"},
    )
    assert resolve_chatgpt_session(body) == {
        "conversation_id": "abc",
        "parent_message_id": "parent",
    }


def test_resolve_perplexity_sources_from_list() -> None:
    body = ChatRequest(message="Hi", sources=["web", "scholar"])
    assert resolve_perplexity_sources(body) == ["web", "scholar"]


def test_resolve_perplexity_sources_from_web_search_flag() -> None:
    body = ChatRequest(message="Hi", web_search=False)
    assert resolve_perplexity_sources(body) == []


def test_decode_file_attachments() -> None:
    content = b"hello"
    files = [
        FileAttachment(
            filename="note.txt",
            content_base64=base64.b64encode(content).decode(),
        )
    ]
    assert decode_file_attachments(files) == {"note.txt": content}


def test_decode_file_attachments_rejects_invalid_base64() -> None:
    files = [FileAttachment(filename="bad.txt", content_base64="not-base64!!")]
    with pytest.raises(ValueError, match="Invalid base64"):
        decode_file_attachments(files)
