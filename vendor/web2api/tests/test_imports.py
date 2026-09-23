"""Unit tests for package imports."""

from __future__ import annotations


def test_import_web2api() -> None:
    import web2api

    assert hasattr(web2api, "perplexity")
    assert hasattr(web2api, "chatgpt")
    assert hasattr(web2api, "gemini")
    assert hasattr(web2api, "load_perplexity_cookies")


def test_import_perplexity_utils() -> None:
    from web2api.perplexity.utils import sanitize_query, validate_search_params

    assert sanitize_query("  hello  ") == "hello"
    validate_search_params("auto", None, ["web"])


def test_import_perplexity_logger() -> None:
    from web2api.perplexity.logger import get_logger

    logger = get_logger("tests")
    assert logger.name == "web2api.perplexity.tests"
