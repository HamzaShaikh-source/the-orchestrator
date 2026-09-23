"""Unit tests for the FastAPI server."""

from __future__ import annotations

import importlib

import pytest
from fastapi.testclient import TestClient

server_app = importlib.import_module("web2api.server.app")


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setattr(server_app, "API_KEY", "")
    return TestClient(server_app.app)


def test_healthz(client: TestClient) -> None:
    response = client.get("/healthz")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_providers_without_auth(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(server_app, "perplexity_available", lambda: False)
    monkeypatch.setattr(server_app, "chatgpt_available", lambda: False)
    monkeypatch.setattr(server_app, "gemini_available", lambda: False)

    response = client.get("/api/providers")
    assert response.status_code == 200
    assert response.json() == {"providers": []}


def test_api_key_required_when_configured(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("WEB2API_API_KEY", "secret-key")
    reloaded = importlib.reload(server_app)
    client = TestClient(reloaded.app)

    response = client.get("/api/providers")
    assert response.status_code == 401

    response = client.get("/api/providers", headers={"Authorization": "Bearer secret-key"})
    assert response.status_code == 200

    monkeypatch.delenv("WEB2API_API_KEY", raising=False)
    importlib.reload(server_app)


def test_chat_rejects_empty_message(client: TestClient) -> None:
    response = client.post("/api/chat", json={"provider": "perplexity", "message": "   "})
    assert response.status_code == 400


class _FakeChatStream:
    def __init__(self, chunks: list[str], session: dict[str, str]):
        self._chunks = chunks
        self.session = session

    def __iter__(self):
        yield from self._chunks


def test_chatgpt_done_includes_session(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(server_app, "chatgpt_available", lambda: True)

    class FakeChatGPTClient:
        def chat(self, message, **kwargs):
            assert kwargs["session"] == {"conversation_id": "conv-1"}
            assert kwargs["web_search"] is True
            return _FakeChatStream(
                ["Hi Alex"],
                {"conversation_id": "conv-1", "parent_message_id": "msg-1"},
            )

    monkeypatch.setattr(server_app, "get_chatgpt_client", lambda: FakeChatGPTClient())

    response = client.post(
        "/api/chat",
        json={
            "provider": "chatgpt",
            "message": "My name is Alex",
            "web_search": True,
            "session": {"conversation_id": "conv-1"},
        },
    )
    assert response.status_code == 200
    assert '"session": {"conversation_id": "conv-1", "parent_message_id": "msg-1"}' in response.text
    assert "event: done" in response.text


def test_gemini_done_includes_session(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(server_app, "gemini_available", lambda: True)

    class FakeGeminiClient:
        def chat_with_session(self, message, **kwargs):
            assert kwargs["session"]["conversation_id"] == "gem-old"
            assert kwargs["web_search"] is False
            return (
                "Your name is Alex.",
                {"conversation_id": "gem-new", "response_id": "r1", "choice_id": "c1"},
            )

    monkeypatch.setattr(server_app, "get_gemini_client", lambda: FakeGeminiClient())

    response = client.post(
        "/api/chat",
        json={
            "provider": "gemini",
            "message": "What is my name?",
            "model_id": "gemini-2.5-flash",
            "web_search": False,
            "session": {"conversation_id": "gem-old"},
        },
    )
    assert response.status_code == 200
    assert '"conversation_id": "gem-new"' in response.text
    assert "event: done" in response.text
