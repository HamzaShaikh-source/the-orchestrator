# Importing necessary modules
# re: Regular expressions for pattern matching
# sys: System-specific parameters and functions
# json: JSON parsing and serialization
# random: Random number generation
# mimetypes: Guessing MIME types of files
# uuid: Generating unique identifiers
# curl_cffi: HTTP requests and multipart form data handling
import json
import mimetypes
import random
import re
import sys
from uuid import uuid4

from curl_cffi import CurlMime, requests

from .config import (
    ACCOUNT_TIMEOUT,
    DEFAULT_HEADERS,
    ENDPOINT_AUTH_SESSION,
    ENDPOINT_AUTH_SIGNIN,
    ENDPOINT_SSE_ASK,
    ENDPOINT_UPLOAD_URL,
    SSE_CONNECT_TIMEOUT,
    SSE_READ_TIMEOUT,
)
from .logger import get_logger

logger = get_logger("client")


def _enrich_chunk(content_json: dict) -> dict:
    """Parse nested FINAL-step answer from SSE message payloads."""
    text = content_json.get("text")
    if not (text and isinstance(text, str)):
        return content_json
    try:
        text_parsed = json.loads(text)
    except (json.JSONDecodeError, TypeError):
        return content_json
    if isinstance(text_parsed, list):
        for step in text_parsed:
            if step.get("step_type") != "FINAL":
                continue
            final_content = step.get("content", {})
            if "answer" not in final_content:
                continue
            answer_data = json.loads(final_content["answer"])
            content_json["answer"] = answer_data.get("answer", "")
            content_json["chunks"] = answer_data.get("chunks", [])
            break
    content_json["text"] = text_parsed
    return content_json


def _answer_len(chunk: dict) -> int:
    answer = chunk.get("answer")
    if isinstance(answer, str):
        return len(answer.strip())
    return 0


def _pick_best_chunk(chunks: list) -> dict:
    """Prefer the chunk with the longest extracted answer (not necessarily the last SSE event)."""
    if not chunks:
        return {}
    best = max(chunks, key=_answer_len)
    if _answer_len(best) > 0:
        return best
    return chunks[-1]


class Client:
    """
    A client for interacting with the Perplexity AI API.
    """

    def __init__(self, cookies={}):
        # Initialize an HTTP session with default headers and optional cookies
        self.session = requests.Session(
            headers=DEFAULT_HEADERS.copy(),
            cookies=cookies,
            impersonate="chrome",
            timeout=(SSE_CONNECT_TIMEOUT, SSE_READ_TIMEOUT),
        )

        # Flags and counters for account and query management
        self.own = bool(cookies)  # Indicates if the client uses its own account
        self.copilot = 0 if not cookies else float("inf")  # Remaining pro queries
        self.file_upload = 0 if not cookies else float("inf")  # Remaining file uploads

        # Regular expression for extracting sign-in links
        self.signin_regex = re.compile(
            r'"(https://www\\.perplexity\\.ai/api/auth/callback/email\\?' r'callbackUrl=.*?)"'
        )

        # Unique timestamp for session identification
        self.timestamp = format(random.getrandbits(32), "08x")

        # Initialize session by making a GET request
        self.session.get(ENDPOINT_AUTH_SESSION)

    def create_account(self, cookies):
        """
        Create a new Perplexity account using Emailnator cookies.

        This is an optional upstream feature and is not supported in Web2API core.
        """
        try:
            from .emailnator import Emailnator
        except ImportError as exc:
            raise NotImplementedError(
                "Account creation requires the emailnator module, which is not included in Web2API core."
            ) from exc

        emailnator_cli = None
        max_attempts = 5
        for attempt in range(1, max_attempts + 1):
            try:
                emailnator_cli = Emailnator(cookies)

                resp = self.session.post(
                    ENDPOINT_AUTH_SIGNIN,
                    data={
                        "email": emailnator_cli.email,
                        "csrfToken": self.session.cookies.get_dict()["next-auth.csrf-token"].split(
                            "%"
                        )[0],
                        "callbackUrl": "https://www.perplexity.ai/",
                        "json": "true",
                    },
                )

                if resp.ok:
                    new_msgs = emailnator_cli.reload(
                        wait_for=lambda x: x["subject"] == "Sign in to Perplexity",
                        timeout=ACCOUNT_TIMEOUT,
                    )
                    if new_msgs:
                        break

                    logger.warning("Sign-in email not received yet (attempt %s/%s)", attempt, max_attempts)
                else:
                    logger.warning(
                        "Perplexity account creation failed (attempt %s/%s): HTTP %s",
                        attempt,
                        max_attempts,
                        resp.status_code,
                    )
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "Perplexity account creation error (attempt %s/%s): %s",
                    attempt,
                    max_attempts,
                    exc,
                )
        else:
            raise RuntimeError("Failed to create a Perplexity account after multiple attempts.")

        # Extract the sign-in link from the email
        msg = emailnator_cli.get(func=lambda x: x["subject"] == "Sign in to Perplexity")
        new_account_link = self.signin_regex.search(emailnator_cli.open(msg["messageID"])).group(1)

        # Complete the account creation process
        self.session.get(new_account_link)

        # Update query and file upload limits
        self.copilot = 5
        self.file_upload = 10

        return True

    def search(
        self,
        query,
        mode="auto",
        model=None,
        sources=["web"],
        files={},
        stream=False,
        language="en-US",
        follow_up=None,
        incognito=False,
    ):
        """
        Executes a search query on Perplexity AI.

        Parameters:
        - query: The search query string.
        - mode: Search mode ('auto', 'pro', 'reasoning', 'deep research').
        - model: Specific model to use for the query.
        - sources: List of sources ('web', 'scholar', 'social').
        - files: Dictionary of files to upload.
        - stream: Whether to stream the response.
        - language: Language code (ISO 639).
        - follow_up: Information for follow-up queries.
        - incognito: Whether to enable incognito mode.
        """
        # Validate input parameters
        assert mode in [
            "auto",
            "pro",
            "reasoning",
            "deep research",
        ], "Invalid search mode."
        assert (
            model
            in {
                "auto": [None],
                "pro": [
                    None,
                    "sonar",
                    "gpt-5.2",
                    "claude-4.5-sonnet",
                    "grok-4.1",
                ],
                "reasoning": [
                    None,
                    "gpt-5.2-thinking",
                    "gpt-5.4-thinking",
                    "claude-4.5-sonnet-thinking",
                    "gemini-3.0-pro",
                    "kimi-k2-thinking",
                    "grok-4.1-reasoning",
                ],
                "deep research": [None],
            }[mode]
            if self.own
            else True
        ), "Invalid model for the selected mode."
        assert all(
            [source in ("web", "scholar", "social") for source in sources]
        ), "Invalid sources."
        assert (
            self.copilot > 0 if mode in ["pro", "reasoning", "deep research"] else True
        ), "No remaining pro queries."
        assert self.file_upload - len(files) >= 0 if files else True, "File upload limit exceeded."

        # Update query and file upload counters
        self.copilot = (
            self.copilot - 1 if mode in ["pro", "reasoning", "deep research"] else self.copilot
        )
        self.file_upload = self.file_upload - len(files) if files else self.file_upload

        # Upload files and prepare the query payload
        uploaded_files = []
        for filename, file in files.items():
            file_type = mimetypes.guess_type(filename)[0]
            file_upload_info = (
                self.session.post(
                    ENDPOINT_UPLOAD_URL,
                    params={"version": "2.18", "source": "default"},
                    json={
                        "content_type": file_type,
                        "file_size": sys.getsizeof(file),
                        "filename": filename,
                        "force_image": False,
                        "source": "default",
                    },
                )
            ).json()

            # Upload the file to the server
            mp = CurlMime()
            for key, value in file_upload_info["fields"].items():
                mp.addpart(name=key, data=value)
            mp.addpart(
                name="file",
                content_type=file_type,
                filename=filename,
                data=file,
            )

            upload_resp = self.session.post(file_upload_info["s3_bucket_url"], multipart=mp)

            if not upload_resp.ok:
                raise Exception("File upload error", upload_resp)

            # Extract the uploaded file URL
            if "image/upload" in file_upload_info["s3_object_url"]:
                uploaded_url = re.sub(
                    r"/private/s--.*?--/v\\d+/user_uploads/",
                    "/private/user_uploads/",
                    upload_resp.json()["secure_url"],
                )
            else:
                uploaded_url = file_upload_info["s3_object_url"]

            uploaded_files.append(uploaded_url)

        # Prepare the JSON payload for the query
        json_data = {
            "query_str": query,
            "params": {
                "attachments": (
                    uploaded_files + (follow_up.get("attachments") or [])
                    if follow_up
                    else uploaded_files
                ),
                "frontend_context_uuid": str(uuid4()),
                "frontend_uuid": str(uuid4()),
                "is_incognito": incognito,
                "language": language,
                "last_backend_uuid": (follow_up.get("backend_uuid") if follow_up else None),
                "mode": "concise" if mode == "auto" else "copilot",
                "model_preference": {
                    "auto": {None: "turbo"},
                    "pro": {
                        None: "pplx_pro",
                        "sonar": "experimental",
                        "gpt-5.2": "gpt52",
                        "claude-4.5-sonnet": "claude45sonnet",
                        "grok-4.1": "grok41nonreasoning",
                    },
                    "reasoning": {
                        None: "pplx_reasoning",
                        "gpt-5.2-thinking": "gpt52_thinking",
                        "gpt-5.4-thinking": "gpt54_thinking",
                        "claude-4.5-sonnet-thinking": "claude45sonnetthinking",
                        "gemini-3.0-pro": "gemini30pro",
                        "kimi-k2-thinking": "kimik2thinking",
                        "grok-4.1-reasoning": "grok41reasoning",
                    },
                    "deep research": {None: "pplx_alpha"},
                }[mode][model],
                "source": "default",
                "sources": sources,
                "version": "2.18",
            },
        }

        # Send the query request and handle the response (long read timeout for reasoning SSE)
        resp = self.session.post(
            ENDPOINT_SSE_ASK,
            json=json_data,
            stream=True,
            timeout=(SSE_CONNECT_TIMEOUT, SSE_READ_TIMEOUT),
        )
        if resp.status_code != 200:
            detail = resp.text[:200] if resp.text else "empty error page"
            raise RuntimeError(
                f"Perplexity HTTP {resp.status_code} (rejected immediately, not a slow-response timeout): {detail}"
            )
        chunks = []

        def stream_response(resp):
            """
            Generator for streaming responses.
            """
            for chunk in resp.iter_lines(delimiter=b"\r\n\r\n"):
                content = chunk.decode("utf-8")

                if content.startswith("event: message\r\n"):
                    try:
                        content_json = _enrich_chunk(
                            json.loads(content[len("event: message\r\ndata: ") :])
                        )
                        chunks.append(content_json)
                        yield chunks[-1]
                    except (json.JSONDecodeError, KeyError):
                        continue

                elif content.startswith("event: end_of_stream\r\n"):
                    return _pick_best_chunk(chunks)

        if stream:
            return stream_response(resp)

        for chunk in resp.iter_lines(delimiter=b"\r\n\r\n"):
            content = chunk.decode("utf-8")

            if content.startswith("event: message\r\n"):
                try:
                    content_json = _enrich_chunk(
                        json.loads(content[len("event: message\r\ndata: ") :])
                    )
                    chunks.append(content_json)
                except (json.JSONDecodeError, KeyError):
                    continue

            elif content.startswith("event: end_of_stream\r\n"):
                return _pick_best_chunk(chunks)

        return _pick_best_chunk(chunks)
