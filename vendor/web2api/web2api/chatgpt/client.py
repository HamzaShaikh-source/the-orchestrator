"""ChatGPT web session client with sentinel proof-of-work."""

from __future__ import annotations

import json
import uuid
from typing import Any, Iterator, Optional

import requests

from .config import BASE_URL, DEFAULT_HEADERS
from .proofofwork import get_answer_token, get_config, get_requirements_token

DEFAULT_PARENT_MESSAGE_ID = "00000000-0000-0000-0000-000000000000"


class ChatGPTError(Exception):
    pass


class ChatStream:
    """Streaming chat iterator that captures conversation session metadata."""

    def __init__(self, response: requests.Response):
        self._response = response
        self.session: dict[str, str] = {}

    def __iter__(self) -> Iterator[str]:
        last_text = ""
        conversation_id: Optional[str] = None
        parent_message_id: Optional[str] = None

        for line in self._response.iter_lines(decode_unicode=True):
            if not line:
                continue
            if line == "data: [DONE]":
                break
            if not line.startswith("data: "):
                continue
            try:
                event = json.loads(line[6:])
            except json.JSONDecodeError:
                continue

            if event.get("conversation_id"):
                conversation_id = event["conversation_id"]

            message = event.get("message") or {}
            message_id = message.get("id")
            role = (message.get("author") or {}).get("role")
            if message_id and role == "assistant":
                parent_message_id = message_id

            content = message.get("content") or {}
            parts = content.get("parts") or []
            if parts and isinstance(parts[0], str):
                last_text = parts[0]
                yield last_text

            if event.get("error"):
                raise ChatGPTError(str(event["error"]))

        session: dict[str, str] = {}
        if conversation_id:
            session["conversation_id"] = conversation_id
        if parent_message_id:
            session["parent_message_id"] = parent_message_id
        elif conversation_id:
            session["parent_message_id"] = DEFAULT_PARENT_MESSAGE_ID
        self.session = session


class Client:
    def __init__(self, auth: dict[str, Any]):
        self.account_id = auth.get("account_id") or auth.get("headers", {}).get("chatgpt-account-id")
        if not self.account_id:
            raise ChatGPTError("Missing account_id in auth config.")

        self.session = requests.Session()
        self.session.cookies.update(auth.get("cookies", {}))
        headers = DEFAULT_HEADERS.copy()
        headers.update(auth.get("headers", {}))
        self.session.headers.update(headers)
        self.user_agent = headers.get("user-agent", DEFAULT_HEADERS["user-agent"])
        self._models_cache: Optional[list[dict[str, str]]] = None

    def _raise_for_status(self, response: requests.Response, context: str) -> None:
        if response.ok:
            return
        detail = response.text[:500]
        try:
            payload = response.json()
            detail = payload.get("detail", detail)
        except ValueError:
            pass
        raise ChatGPTError(f"{context} failed ({response.status_code}): {detail}")

    def me(self) -> dict[str, Any]:
        response = self.session.get(f"{BASE_URL}/me", timeout=30)
        self._raise_for_status(response, "me")
        return response.json()

    def subscriptions(self) -> dict[str, Any]:
        response = self.session.get(
            f"{BASE_URL}/subscriptions",
            params={"account_id": self.account_id},
            timeout=30,
        )
        self._raise_for_status(response, "subscriptions")
        return response.json()

    def list_models(self) -> list[dict[str, str]]:
        if self._models_cache is not None:
            return self._models_cache

        response = self.session.get(f"{BASE_URL}/models", timeout=30)
        self._raise_for_status(response, "models")
        payload = response.json()
        models: list[dict[str, str]] = [{"id": "auto", "label": "Auto"}]

        for item in payload.get("models", []):
            slug = item.get("slug")
            title = item.get("title") or slug
            if slug:
                models.append({"id": slug, "label": title})

        self._models_cache = models
        return models

    def _get_chat_requirements(self) -> tuple[str, Optional[str]]:
        config = get_config(self.user_agent)
        proof_payload = get_requirements_token(config)
        response = self.session.post(
            f"{BASE_URL}/sentinel/chat-requirements",
            json={"p": proof_payload},
            timeout=30,
        )
        self._raise_for_status(response, "sentinel/chat-requirements")
        payload = response.json()

        chat_token = payload.get("token")
        if not chat_token:
            raise ChatGPTError("Missing sentinel chat token.")

        proof_token = None
        pow_info = payload.get("proofofwork") or {}
        if pow_info.get("required"):
            seed = pow_info.get("seed")
            difficulty = pow_info.get("difficulty")
            if not seed or not difficulty:
                raise ChatGPTError("Incomplete proof-of-work challenge.")
            proof_token, solved = get_answer_token(seed, difficulty, config)
            if not solved:
                raise ChatGPTError("Failed to solve proof-of-work challenge.")

        return chat_token, proof_token

    @staticmethod
    def _resolve_session(session: Optional[dict[str, Any]]) -> tuple[Optional[str], str]:
        session = session or {}
        conversation_id = session.get("conversation_id")
        parent_message_id = session.get("parent_message_id") or DEFAULT_PARENT_MESSAGE_ID
        if conversation_id is not None:
            conversation_id = str(conversation_id)
        parent_message_id = str(parent_message_id)
        return conversation_id, parent_message_id

    def chat(
        self,
        message: str,
        *,
        model: str = "auto",
        parent_message_id: str = DEFAULT_PARENT_MESSAGE_ID,
        conversation_id: Optional[str] = None,
        session: Optional[dict[str, Any]] = None,
        web_search: bool = False,
        stream: bool = True,
    ) -> Iterator[str] | str | ChatStream:
        message = message.strip()
        if not message:
            raise ChatGPTError("Message is required.")

        if session is not None:
            conversation_id, parent_message_id = self._resolve_session(session)

        chat_token, proof_token = self._get_chat_requirements()
        message_id = str(uuid.uuid4())

        payload: dict[str, Any] = {
            "action": "next",
            "messages": [
                {
                    "id": message_id,
                    "author": {"role": "user"},
                    "content": {"content_type": "text", "parts": [message]},
                    "metadata": {},
                }
            ],
            "parent_message_id": parent_message_id,
            "model": model,
            "timezone_offset_min": -480,
            "history_and_training_disabled": False,
            "conversation_mode": {"kind": "primary_assistant"},
            "force_paragen": False,
            "force_rate_limit": False,
            "force_use_sse": True,
            "reset_rate_limits": False,
            "websocket_request_id": str(uuid.uuid4()),
            "system_hints": ["search"] if web_search else [],
            "supported_encodings": ["v1"],
            "supports_buffering": True,
        }
        if conversation_id:
            payload["conversation_id"] = conversation_id

        headers = {
            "accept": "text/event-stream",
            "content-type": "application/json",
            "openai-sentinel-chat-requirements-token": chat_token,
        }
        if proof_token:
            headers["openai-sentinel-proof-token"] = proof_token

        response = self.session.post(
            f"{BASE_URL}/conversation",
            params={"account_id": self.account_id},
            json=payload,
            headers=headers,
            stream=True,
            timeout=120,
        )
        self._raise_for_status(response, "conversation")

        chat_stream = ChatStream(response)
        if not stream:
            last_text = ""
            for chunk in chat_stream:
                last_text = chunk
            return last_text

        return chat_stream
