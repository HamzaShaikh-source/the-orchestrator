# Contributing to Web2API

Thank you for your interest in contributing.

## Development Setup

```bash
git clone https://github.com/AbdullahArean/web2api.git
cd web2api
python3 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev,test]"
```

Copy auth templates and configure your session cookies as described in [docs/COOKIES.md](docs/COOKIES.md).

## Running Checks

```bash
# Unit tests (no live provider credentials required)
pytest

# Lint
ruff check web2api tests

# Integration checks (require configured auth)
web2api-test-perplexity
web2api-test-chatgpt
web2api-test-gemini
```

## Pull Request Guidelines

1. Keep changes focused and well-scoped.
2. Do not commit secrets, cookies, or `*.local.json` files.
3. Add or update tests for behavior changes where practical.
4. Update documentation when user-facing behavior changes.
5. Follow existing code style and naming conventions.

## Code of Conduct

This project follows the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md).

## Questions

Open a GitHub issue for bugs, feature requests, or documentation improvements.
