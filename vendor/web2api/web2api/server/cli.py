"""CLI entry point for web2api-serve."""

from __future__ import annotations

import argparse


def main() -> None:
    parser = argparse.ArgumentParser(description="Start the Web2API REST server.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument("--reload", action="store_true")
    args = parser.parse_args()

    import uvicorn

    uvicorn.run("web2api.server.app:app", host=args.host, port=args.port, reload=args.reload)


if __name__ == "__main__":
    main()
