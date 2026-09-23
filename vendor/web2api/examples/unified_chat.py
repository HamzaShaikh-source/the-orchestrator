#!/usr/bin/env python3
"""Send one message through each configured provider."""

from __future__ import annotations

from web2api.auth import (
    chatgpt_available,
    gemini_available,
    get_client,
    perplexity_available,
)


def run_provider(provider: str, message: str) -> None:
    print(f"\n== {provider} ==")
    try:
        client = get_client(provider)
    except Exception as exc:  # noqa: BLE001
        print("skip:", exc)
        return

    if provider == "perplexity":
        response = client.search(message, mode="auto", stream=False)
        print(response.get("answer") if isinstance(response, dict) else response)
        return

    answer = client.chat(message, stream=False)
    print(answer)


def main() -> None:
    message = "Reply with exactly one short greeting sentence."

    if perplexity_available():
        run_provider("perplexity", message)
    else:
        print("Perplexity auth not configured.")

    if chatgpt_available():
        run_provider("chatgpt", message)
    else:
        print("ChatGPT auth not configured.")

    if gemini_available():
        run_provider("gemini", message)
    else:
        print("Gemini auth not configured.")


if __name__ == "__main__":
    main()
