from __future__ import annotations

from typing import Any, Optional

from pydantic import BaseModel, Field, field_validator

PROVIDER_PATTERN = "^(perplexity|chatgpt|gemini)$"
PERPLEXITY_SOURCE_PATTERN = "^(web|scholar|social)$"
MAX_FILE_BYTES = 10 * 1024 * 1024

PERPLEXITY_MODELS = [
    {"id": "auto", "label": "Auto", "mode": "auto", "model": None},
    {"id": "pro", "label": "Pro", "mode": "pro", "model": None},
    {"id": "pro-sonar", "label": "Sonar", "mode": "pro", "model": "sonar"},
    {"id": "pro-gpt52", "label": "GPT-5.2", "mode": "pro", "model": "gpt-5.2"},
    {"id": "pro-claude", "label": "Claude 4.5 Sonnet", "mode": "pro", "model": "claude-4.5-sonnet"},
    {"id": "pro-grok", "label": "Grok 4.1", "mode": "pro", "model": "grok-4.1"},
    {"id": "reasoning", "label": "Reasoning", "mode": "reasoning", "model": None},
    {"id": "reasoning-gpt52", "label": "GPT-5.2 Thinking", "mode": "reasoning", "model": "gpt-5.2-thinking"},
    {"id": "reasoning-gpt54", "label": "GPT-5.4 Thinking", "mode": "reasoning", "model": "gpt-5.4-thinking"},
    {"id": "reasoning-claude", "label": "Claude 4.5 Thinking", "mode": "reasoning", "model": "claude-4.5-sonnet-thinking"},
    {"id": "reasoning-gemini", "label": "Gemini 3.0 Pro", "mode": "reasoning", "model": "gemini-3.0-pro"},
    {"id": "reasoning-kimi", "label": "Kimi K2 Thinking", "mode": "reasoning", "model": "kimi-k2-thinking"},
    {"id": "reasoning-grok", "label": "Grok 4.1 Reasoning", "mode": "reasoning", "model": "grok-4.1-reasoning"},
    {"id": "deep-research", "label": "Deep Research", "mode": "deep research", "model": None},
]

PERPLEXITY_MODEL_LOOKUP = {item["id"]: item for item in PERPLEXITY_MODELS}


class FileAttachment(BaseModel):
    filename: str = Field(min_length=1, max_length=255)
    content_base64: str = Field(min_length=1)


class ChatRequest(BaseModel):
    provider: str = Field(default="perplexity", pattern=PROVIDER_PATTERN)
    message: str = Field(min_length=1, max_length=8000)
    model_id: str = "auto"
    web_search: bool = True
    sources: Optional[list[str]] = None
    session: Optional[dict[str, Any]] = Field(
        default=None,
        description=(
            "Provider-specific conversation state. "
            "Perplexity: backend follow-up payload. "
            "ChatGPT: conversation_id + parent_message_id. "
            "Gemini: conversation_id + response_id + choice_id."
        ),
    )
    follow_up: Optional[dict[str, Any]] = Field(
        default=None,
        description="Deprecated Perplexity alias for session.",
    )
    files: list[FileAttachment] = Field(default_factory=list, max_length=10)

    @field_validator("sources")
    @classmethod
    def validate_sources(cls, value: Optional[list[str]]) -> Optional[list[str]]:
        if value is None:
            return None
        import re

        pattern = re.compile(PERPLEXITY_SOURCE_PATTERN)
        for source in value:
            if not pattern.match(source):
                raise ValueError(f"Invalid source: {source}")
        return value
