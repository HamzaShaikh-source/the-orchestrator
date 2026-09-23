"""FastAPI REST server for Web2API providers."""

from __future__ import annotations

import json
import os
import threading
from typing import Any, Optional

from fastapi import Depends, FastAPI, Header, HTTPException, Query
from fastapi.responses import StreamingResponse

from web2api import chatgpt, gemini, perplexity
from web2api.auth import (
    AuthError,
    chatgpt_available,
    gemini_available,
    load_chatgpt_auth,
    load_gemini_auth,
    load_perplexity_cookies,
    perplexity_available,
)
from web2api.server.schemas import (
    PERPLEXITY_MODEL_LOOKUP,
    PERPLEXITY_MODELS,
    PROVIDER_PATTERN,
    ChatRequest,
)
from web2api.server.session_utils import (
    decode_file_attachments,
    resolve_chatgpt_session,
    resolve_gemini_session,
    resolve_perplexity_session,
    resolve_perplexity_sources,
)

_pplx_client: Optional[perplexity.Client] = None
_chatgpt_client: Optional[chatgpt.Client] = None
_gemini_client: Optional[gemini.Client] = None
_pplx_lock = threading.Lock()
_chatgpt_lock = threading.Lock()
_gemini_lock = threading.Lock()

API_KEY = os.environ.get("WEB2API_API_KEY", "").strip()

app = FastAPI(
    title="Web2API",
    version="1.1.0",
    description="Cookie-based AI provider REST API by Abdullah Ibne Hanif Arean (abdullaharean.com)",
)


def require_api_key(authorization: Optional[str] = Header(default=None)) -> None:
    if not API_KEY:
        return
    if not authorization or authorization != f"Bearer {API_KEY}":
        raise HTTPException(status_code=401, detail="Invalid or missing API key.")


def get_perplexity_client() -> perplexity.Client:
    global _pplx_client
    with _pplx_lock:
        if _pplx_client is None:
            _pplx_client = perplexity.Client(load_perplexity_cookies())
        return _pplx_client


def get_chatgpt_client() -> chatgpt.Client:
    global _chatgpt_client
    with _chatgpt_lock:
        if _chatgpt_client is None:
            try:
                _chatgpt_client = chatgpt.Client(load_chatgpt_auth())
            except AuthError as exc:
                raise HTTPException(status_code=503, detail=str(exc)) from exc
        return _chatgpt_client


def get_gemini_client() -> gemini.Client:
    global _gemini_client
    with _gemini_lock:
        if _gemini_client is None:
            try:
                _gemini_client = gemini.Client(load_gemini_auth())
            except AuthError as exc:
                raise HTTPException(status_code=503, detail=str(exc)) from exc
        return _gemini_client


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/providers", dependencies=[Depends(require_api_key)])
def providers() -> dict[str, Any]:
    items = []
    if perplexity_available():
        items.append({"id": "perplexity", "label": "Perplexity", "available": True})
    if chatgpt_available():
        items.append({"id": "chatgpt", "label": "ChatGPT", "available": True})
    if gemini_available():
        items.append({"id": "gemini", "label": "Gemini", "available": True})
    return {"providers": items}


@app.post("/api/reload", dependencies=[Depends(require_api_key)])
def reload_clients() -> dict[str, str]:
    global _pplx_client, _chatgpt_client, _gemini_client
    with _pplx_lock:
        _pplx_client = None
    with _chatgpt_lock:
        _chatgpt_client = None
    with _gemini_lock:
        _gemini_client = None
    return {"status": "ok"}


@app.get("/api/health", dependencies=[Depends(require_api_key)])
def health(provider: str = Query(default="perplexity", pattern=PROVIDER_PATTERN)) -> dict[str, Any]:
    payload: dict[str, Any] = {"status": "ok", "provider": provider}

    if provider == "perplexity":
        if not perplexity_available():
            raise HTTPException(status_code=503, detail="Perplexity is not configured.")
        client = get_perplexity_client()
        payload.update(
            {
                "authenticated": client.own,
                "pro_quota": client.copilot if client.copilot != float("inf") else "unlimited",
            }
        )
        return payload

    if provider == "chatgpt":
        if not chatgpt_available():
            raise HTTPException(status_code=503, detail="ChatGPT is not configured.")
        client = get_chatgpt_client()
        profile = client.me()
        subscription = client.subscriptions()
        payload.update(
            {
                "email": profile.get("email"),
                "plan_type": subscription.get("plan_type"),
            }
        )
        return payload

    if not gemini_available():
        raise HTTPException(status_code=503, detail="Gemini is not configured.")
    client = get_gemini_client()
    payload.update({"authenticated": bool(client.access_token)})
    return payload


@app.get("/api/models", dependencies=[Depends(require_api_key)])
def models(provider: str = Query(default="perplexity", pattern=PROVIDER_PATTERN)) -> dict[str, Any]:
    if provider == "perplexity":
        if not perplexity_available():
            raise HTTPException(status_code=503, detail="Perplexity is not configured.")
        return {"provider": provider, "models": PERPLEXITY_MODELS}

    if provider == "chatgpt":
        if not chatgpt_available():
            raise HTTPException(status_code=503, detail="ChatGPT is not configured.")
        client = get_chatgpt_client()
        return {"provider": provider, "models": client.list_models()}

    if not gemini_available():
        raise HTTPException(status_code=503, detail="Gemini is not configured.")
    client = get_gemini_client()
    return {"provider": provider, "models": client.list_models()}


def _sse(event: str, payload: dict[str, Any]) -> str:
    return f"event: {event}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"


def _extract_perplexity_answer(chunk: dict[str, Any]) -> str:
    answer = chunk.get("answer")
    if isinstance(answer, str):
        return answer
    return ""


def _stream_perplexity(body: ChatRequest):
    model_cfg = PERPLEXITY_MODEL_LOOKUP.get(body.model_id)
    if not model_cfg:
        raise HTTPException(status_code=400, detail="Unknown model")

    message = body.message.strip()
    sources = resolve_perplexity_sources(body)
    session = resolve_perplexity_session(body)
    client = get_perplexity_client()

    try:
        files = decode_file_attachments(body.files)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    def event_stream():
        last_answer = ""
        final_response: dict[str, Any] = {}

        try:
            stream = client.search(
                message,
                mode=model_cfg["mode"],
                model=model_cfg["model"],
                sources=sources,
                stream=True,
                follow_up=session,
                files=files,
            )

            for chunk in stream:
                if not isinstance(chunk, dict):
                    continue

                final_response = chunk
                answer = _extract_perplexity_answer(chunk)
                if answer and answer != last_answer:
                    yield _sse("delta", {"content": answer})
                    last_answer = answer

            if not final_response:
                yield _sse("error", {"message": "No response received from Perplexity."})
                return

            done_payload = {
                "content": _extract_perplexity_answer(final_response) or last_answer,
                "session": final_response,
                "follow_up": final_response,
            }
            yield _sse("done", done_payload)
        except Exception as exc:  # noqa: BLE001
            yield _sse("error", {"message": str(exc)})

    return event_stream()


def _stream_chatgpt(body: ChatRequest):
    message = body.message.strip()
    session = resolve_chatgpt_session(body)
    client = get_chatgpt_client()

    def event_stream():
        last_answer = ""
        try:
            stream = client.chat(
                message,
                model=body.model_id,
                session=session or None,
                web_search=body.web_search,
                stream=True,
            )

            for chunk in stream:
                if chunk and chunk != last_answer:
                    yield _sse("delta", {"content": chunk})
                    last_answer = chunk

            if not last_answer:
                yield _sse("error", {"message": "No response received from ChatGPT."})
                return

            yield _sse(
                "done",
                {
                    "content": last_answer,
                    "session": getattr(stream, "session", {}),
                },
            )
        except chatgpt.ChatGPTError as exc:
            yield _sse("error", {"message": str(exc)})
        except Exception as exc:  # noqa: BLE001
            yield _sse("error", {"message": str(exc)})

    return event_stream()


def _stream_gemini(body: ChatRequest):
    message = body.message.strip()
    session = resolve_gemini_session(body)
    model_id = body.model_id if body.model_id != "auto" else "unspecified"
    client = get_gemini_client()

    def event_stream():
        last_answer = ""
        try:
            answer, updated_session = client.chat_with_session(
                message,
                model=model_id,
                session=session,
                web_search=body.web_search,
            )
            if answer and answer != last_answer:
                yield _sse("delta", {"content": answer})
                last_answer = answer

            if not last_answer:
                yield _sse("error", {"message": "No response received from Gemini."})
                return

            yield _sse(
                "done",
                {
                    "content": last_answer,
                    "session": updated_session,
                },
            )
        except gemini.GeminiError as exc:
            yield _sse("error", {"message": str(exc)})
        except Exception as exc:  # noqa: BLE001
            yield _sse("error", {"message": str(exc)})

    return event_stream()


@app.post("/api/chat", dependencies=[Depends(require_api_key)])
def chat(body: ChatRequest) -> StreamingResponse:
    message = body.message.strip()
    if not message:
        raise HTTPException(status_code=400, detail="Message is required.")

    if body.provider == "perplexity":
        if not perplexity_available():
            raise HTTPException(status_code=503, detail="Perplexity is not configured.")
        event_stream = _stream_perplexity(body)
    elif body.provider == "chatgpt":
        if not chatgpt_available():
            raise HTTPException(status_code=503, detail="ChatGPT is not configured.")
        event_stream = _stream_chatgpt(body)
    else:
        if not gemini_available():
            raise HTTPException(status_code=503, detail="Gemini is not configured.")
        event_stream = _stream_gemini(body)

    return StreamingResponse(
        event_stream,
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
