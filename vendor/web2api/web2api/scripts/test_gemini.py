#!/usr/bin/env python3
"""Quick connectivity test for Gemini web session."""

from __future__ import annotations

import argparse
from pathlib import Path

from web2api import gemini
from web2api.auth import gemini_available, load_gemini_auth
from web2api.auth.paths import GEMINI_AUTH_FILE


def main() -> None:
    parser = argparse.ArgumentParser(description="Test Gemini Web2API client.")
    parser.add_argument("--auth-file", type=Path, default=None, help="Path to gemini.local.json")
    parser.add_argument("--message", default="Say hello in one short sentence.")
    parser.add_argument("--model", default="unspecified")
    args = parser.parse_args()

    auth_path = args.auth_file or GEMINI_AUTH_FILE
    if not gemini_available(auth_path):
        raise SystemExit(f"Missing auth file: {auth_path}")

    client = gemini.Client(load_gemini_auth(auth_path))
    print("authenticated:", bool(client.access_token))

    models = client.list_models()
    print("models:", ", ".join(model["id"] for model in models))

    answer = client.chat(args.message, model=args.model, stream=False)
    print("answer:", answer)


if __name__ == "__main__":
    main()
