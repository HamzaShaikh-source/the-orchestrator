"""Helpers for resolving provider session state on chat requests."""

from __future__ import annotations

import base64
import binascii
from typing import Any, Optional

from web2api.server.schemas import MAX_FILE_BYTES, ChatRequest, FileAttachment


def resolve_perplexity_session(body: ChatRequest) -> Optional[dict[str, Any]]:
    return body.session or body.follow_up


def resolve_chatgpt_session(body: ChatRequest) -> dict[str, Any]:
    session = body.session or {}
    if not isinstance(session, dict):
        return {}
    return session


def resolve_gemini_session(body: ChatRequest) -> dict[str, str]:
    session = body.session or {}
    if not isinstance(session, dict):
        session = {}
    return {
        "conversation_id": str(session.get("conversation_id") or ""),
        "response_id": str(session.get("response_id") or ""),
        "choice_id": str(session.get("choice_id") or ""),
    }


def resolve_perplexity_sources(body: ChatRequest) -> list[str]:
    if body.sources is not None:
        return body.sources
    return ["web"] if body.web_search else []


def decode_file_attachments(files: list[FileAttachment]) -> dict[str, bytes]:
    decoded: dict[str, bytes] = {}
    for attachment in files:
        try:
            content = base64.b64decode(attachment.content_base64, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise ValueError(f"Invalid base64 for file {attachment.filename!r}.") from exc
        if len(content) > MAX_FILE_BYTES:
            raise ValueError(
                f"File {attachment.filename!r} exceeds the {MAX_FILE_BYTES // (1024 * 1024)} MB limit."
            )
        decoded[attachment.filename] = content
    return decoded
