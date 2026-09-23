"""Unit tests for Gemini request-scoped session handling."""

from __future__ import annotations

import json

from web2api.gemini.client import Client


def test_normalize_session_defaults() -> None:
    assert Client.normalize_session(None) == {
        "conversation_id": "",
        "response_id": "",
        "choice_id": "",
    }


def test_build_payload_uses_request_session_not_shared_state() -> None:
    client = object.__new__(Client)
    session_a = {"conversation_id": "a", "response_id": "b", "choice_id": "c"}
    session_b = {"conversation_id": "x", "response_id": "y", "choice_id": "z"}

    payload_a = client._build_payload("hello", session_a)
    payload_b = client._build_payload("hello", session_b)

    assert payload_a[2][:3] == ["a", "b", "c"]
    assert payload_b[2][:3] == ["x", "y", "z"]


def test_build_payload_enables_web_search_flag() -> None:
    client = object.__new__(Client)
    session = Client.normalize_session(None)

    without_search = client._build_payload("hello", session, web_search=False)
    with_search = client._build_payload("hello", session, web_search=True)

    assert len(without_search) == 12
    assert len(with_search) > 16
    assert with_search[16] == [[0, [None, None, None, [1]]]]


def test_extract_session_from_frames_updates_ids() -> None:
    inner = json.dumps(
        [
            None,
            ["conv-new", "resp-new"],
            None,
            None,
            [["choice-new"]],
        ]
    )
    frames = [[None, None, inner]]
    session = Client.normalize_session(
        {"conversation_id": "old", "response_id": "old", "choice_id": "old"}
    )

    updated = Client._extract_session_from_frames(frames, session)
    assert updated == {
        "conversation_id": "conv-new",
        "response_id": "resp-new",
        "choice_id": "choice-new",
    }


def test_model_headers_for_known_model() -> None:
    client = object.__new__(Client)
    headers = client._model_headers("gemini-2.5-pro")
    assert "x-goog-ext-525001261-jspb" in headers
    assert "9d8ca3786ebdfbea" in headers["x-goog-ext-525001261-jspb"]
