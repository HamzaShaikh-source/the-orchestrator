"""Web2API: cookie-based clients for Perplexity, ChatGPT, and Gemini.

Author: Abdullah Ibne Hanif Arean — https://abdullaharean.com
"""

from web2api import chatgpt, gemini, perplexity
from web2api.auth import (
    AuthError,
    get_client,
    load_chatgpt_auth,
    load_gemini_auth,
    load_perplexity_cookies,
)

__all__ = [
    "AuthError",
    "chatgpt",
    "gemini",
    "get_client",
    "load_chatgpt_auth",
    "load_gemini_auth",
    "load_perplexity_cookies",
    "perplexity",
]
