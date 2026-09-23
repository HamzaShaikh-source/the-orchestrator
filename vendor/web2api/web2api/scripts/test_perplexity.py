#!/usr/bin/env python3
"""Quick connectivity test for Perplexity web session."""

from __future__ import annotations

import argparse
from pathlib import Path

from web2api import perplexity
from web2api.auth import load_perplexity_cookies, perplexity_available
from web2api.auth.paths import PERPLEXITY_COOKIES_FILE


def main() -> None:
    parser = argparse.ArgumentParser(description="Test Perplexity Web2API client.")
    parser.add_argument("--auth-file", type=Path, default=None, help="Path to cookies.local.json")
    parser.add_argument("--message", default="Say hello in one short sentence.")
    args = parser.parse_args()

    auth_path = args.auth_file or PERPLEXITY_COOKIES_FILE
    if not perplexity_available(auth_path):
        raise SystemExit(f"Missing auth file: {auth_path}")

    client = perplexity.Client(load_perplexity_cookies(auth_path))
    print("authenticated:", client.own)
    print("pro_quota:", client.copilot if client.copilot != float("inf") else "unlimited")

    response = client.search(args.message, mode="auto", stream=False)
    answer = response.get("answer") if isinstance(response, dict) else response
    print("answer:", answer)


if __name__ == "__main__":
    main()
