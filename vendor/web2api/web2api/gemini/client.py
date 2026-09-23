"""Gemini web session client."""

from __future__ import annotations

import json
import random
import re
import uuid
from typing import Any, Iterator, Optional

import requests

from .config import BUILD_LABEL, DEFAULT_HEADERS, GENERATE_URL, INIT_URL, MODEL_REGISTRY, MODELS
from .parser import extract_text_from_frames, parse_response_frames


class GeminiError(Exception):
    pass


class Client:
    def __init__(self, auth: dict):
        cookies = auth.get("cookies", {})
        if not cookies.get("__Secure-1PSID"):
            raise GeminiError("Missing __Secure-1PSID cookie.")

        self.session = requests.Session()
        self.session.cookies.update(cookies)
        headers = DEFAULT_HEADERS.copy()
        headers.update(auth.get("headers", {}))
        self.session.headers.update(headers)
        self.access_token: Optional[str] = None
        self.build_label = auth.get("build_label") or BUILD_LABEL
        self._reqid = random.randint(10000, 99999)
        self._init()

    def _init(self) -> None:
        response = self.session.get(INIT_URL, timeout=60)
        if response.status_code != 200:
            raise GeminiError(f"Gemini init failed ({response.status_code}).")

        token_match = re.search(r'"SNlM0e":"([^"]+)"', response.text)
        if not token_match:
            raise GeminiError("Could not extract Gemini access token (SNlM0e).")

        self.access_token = token_match.group(1)
        build_match = re.search(r'"cfb2h":"([^"]+)"', response.text)
        if build_match:
            self.build_label = build_match.group(1)

    def list_models(self) -> list[dict[str, str]]:
        return MODELS.copy()

    @staticmethod
    def normalize_session(session: Optional[dict[str, Any]]) -> dict[str, str]:
        session = session or {}
        return {
            "conversation_id": str(session.get("conversation_id") or ""),
            "response_id": str(session.get("response_id") or ""),
            "choice_id": str(session.get("choice_id") or ""),
        }

    def _build_payload(
        self,
        message: str,
        session: dict[str, str],
        *,
        web_search: bool = False,
    ) -> list[Any]:
        payload: list[Any] = [
            [message, 0, None, [], None, None, 0],
            ["en"],
            [
                session["conversation_id"],
                session["response_id"],
                session["choice_id"],
                None,
                None,
                [],
            ],
            None,
            None,
            None,
            [1],
            0,
            [],
            [],
            1,
            0,
        ]
        if web_search:
            while len(payload) <= 16:
                payload.append(None)
            payload[16] = [[0, [None, None, None, [1]]]]
        return payload

    def _model_headers(self, model: str) -> dict[str, str]:
        registry_entry = MODEL_REGISTRY.get(model) or MODEL_REGISTRY["unspecified"]
        header = registry_entry.get("header")
        if isinstance(header, dict):
            return header.copy()
        return {}

    @staticmethod
    def _extract_session_from_frames(frames: list[Any], session: dict[str, str]) -> dict[str, str]:
        updated = session.copy()
        for frame in frames:
            inner_json_str = frame[2] if isinstance(frame, list) and len(frame) > 2 else None
            if not isinstance(inner_json_str, str):
                continue
            try:
                part_json = json.loads(inner_json_str)
            except json.JSONDecodeError:
                continue
            meta = part_json[1] if isinstance(part_json, list) and len(part_json) > 1 else None
            if isinstance(meta, list):
                if len(meta) > 0 and meta[0]:
                    updated["conversation_id"] = meta[0]
                if len(meta) > 1 and meta[1]:
                    updated["response_id"] = meta[1]
            candidates = part_json[4] if isinstance(part_json, list) and len(part_json) > 4 else None
            if isinstance(candidates, list) and candidates:
                choice = candidates[0]
                if isinstance(choice, list) and choice and choice[0]:
                    updated["choice_id"] = choice[0]
        return updated

    def _send(
        self,
        message: str,
        *,
        model: str = "unspecified",
        session: Optional[dict[str, Any]] = None,
        web_search: bool = False,
    ) -> tuple[str, dict[str, str]]:
        if not self.access_token:
            raise GeminiError("Gemini session is not initialized.")

        current_session = self.normalize_session(session)
        self._reqid += 100000
        params = {
            "bl": self.build_label,
            "_reqid": str(self._reqid),
            "rt": "c",
        }
        data = {
            "at": self.access_token,
            "f.req": json.dumps(
                [None, json.dumps(self._build_payload(message, current_session, web_search=web_search))]
            ),
        }

        headers = {
            "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
            "x-same-domain": "1",
            **self._model_headers(model),
            "x-goog-ext-525005358-jspb": f'["{str(uuid.uuid4()).upper()}",1]',
        }

        response = self.session.post(
            GENERATE_URL,
            params=params,
            data=data,
            headers=headers,
            timeout=120,
        )

        if response.status_code != 200:
            detail = response.text[:500]
            raise GeminiError(f"Gemini chat failed ({response.status_code}): {detail}")

        frames = parse_response_frames(response.text)
        answer = extract_text_from_frames(frames)
        if not answer:
            raise GeminiError("No response received from Gemini.")

        updated_session = self._extract_session_from_frames(frames, current_session)
        return answer, updated_session

    def chat(
        self,
        message: str,
        *,
        model: str = "unspecified",
        session: Optional[dict[str, Any]] = None,
        web_search: bool = False,
        stream: bool = True,
    ) -> Iterator[str] | str:
        message = message.strip()
        if not message:
            raise GeminiError("Message is required.")

        answer, _updated_session = self._send(
            message,
            model=model,
            session=session,
            web_search=web_search,
        )
        if not stream:
            return answer
        return iter([answer])

    def chat_with_session(
        self,
        message: str,
        *,
        model: str = "unspecified",
        session: Optional[dict[str, Any]] = None,
        web_search: bool = False,
    ) -> tuple[str, dict[str, str]]:
        message = message.strip()
        if not message:
            raise GeminiError("Message is required.")
        return self._send(message, model=model, session=session, web_search=web_search)
