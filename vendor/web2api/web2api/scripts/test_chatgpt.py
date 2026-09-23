#!/usr/bin/env python3
"""Quick connectivity test for ChatGPT web session."""

from __future__ import annotations

import argparse
from pathlib import Path

from web2api import chatgpt
from web2api.auth import chatgpt_available, load_chatgpt_auth
from web2api.auth.paths import CHATGPT_AUTH_FILE


def main() -> None:
    parser = argparse.ArgumentParser(description="Test ChatGPT Web2API client.")
    parser.add_argument("--auth-file", type=Path, default=None, help="Path to chatgpt.local.json")
    parser.add_argument("--message", default="Say hello in one short sentence.")
    parser.add_argument("--model", default="auto")
    args = parser.parse_args()

    auth_path = args.auth_file or CHATGPT_AUTH_FILE
    if not chatgpt_available(auth_path):
        raise SystemExit(f"Missing auth file: {auth_path}")

    client = chatgpt.Client(load_chatgpt_auth(auth_path))

    profile = client.me()
    print("me:", profile.get("email"), profile.get("name"))

    subscription = client.subscriptions()
    print("plan:", subscription.get("plan_type"))

    models = client.list_models()
    print("models:", ", ".join(model["id"] for model in models[:6]), "...")

    answer = client.chat(args.message, model=args.model, stream=False)
    print("answer:", answer)


if __name__ == "__main__":
    main()
