"""Unit tests for ChatGPT session extraction."""

from __future__ import annotations

import io
import json

from web2api.chatgpt.client import DEFAULT_PARENT_MESSAGE_ID, ChatStream


def _sse_line(payload: dict) -> bytes:
    return f"data: {json.dumps(payload)}\n\n".encode()


def test_chat_stream_extracts_conversation_and_parent_message_id() -> None:
    response = io.BytesIO(
        b"".join(
            [
                _sse_line(
                    {
                        "conversation_id": "conv-123",
                        "message": {
                            "id": "assistant-456",
                            "author": {"role": "assistant"},
                            "content": {"parts": ["Hello Alex"]},
                        },
                    }
                ),
                b"data: [DONE]\n\n",
            ]
        )
    )

    class FakeResponse:
        def iter_lines(self, decode_unicode=True):
            for line in response.getvalue().splitlines():
                yield line.decode() if decode_unicode else line

    stream = ChatStream(FakeResponse())
    chunks = list(stream)

    assert chunks == ["Hello Alex"]
    assert stream.session == {
        "conversation_id": "conv-123",
        "parent_message_id": "assistant-456",
    }


def test_chat_stream_uses_default_parent_when_only_conversation_id() -> None:
    response = io.BytesIO(
        b"".join(
            [
                _sse_line(
                    {
                        "conversation_id": "conv-123",
                        "message": {
                            "id": "user-789",
                            "author": {"role": "user"},
                            "content": {"parts": ["Hi"]},
                        },
                    }
                ),
                b"data: [DONE]\n\n",
            ]
        )
    )

    class FakeResponse:
        def iter_lines(self, decode_unicode=True):
            for line in response.getvalue().splitlines():
                yield line.decode() if decode_unicode else line

    stream = ChatStream(FakeResponse())
    list(stream)

    assert stream.session == {
        "conversation_id": "conv-123",
        "parent_message_id": DEFAULT_PARENT_MESSAGE_ID,
    }
