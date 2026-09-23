"""ChatGPT sentinel proof-of-work helpers."""

from __future__ import annotations

import hashlib
import json
import random
import time
import uuid
from datetime import datetime, timedelta, timezone

import pybase64

CORES = [8, 16, 24, 32]
TIME_LAYOUT = "%a %b %d %Y %H:%M:%S"
DEFAULT_SCRIPT = "https://chatgpt.com/backend-api/sentinel/sdk.js"
DEFAULT_DPL = "prod-416f923815498ec49bee0e42b239a45b74e8e0c9"


def get_parse_time() -> str:
    now = datetime.now(timezone(timedelta(hours=-5)))
    return now.strftime(TIME_LAYOUT) + " GMT-0500 (Eastern Standard Time)"


def get_config(user_agent: str, *, dpl: str = DEFAULT_DPL) -> list:
    return [
        random.choice([1920 + 1080, 2560 + 1440, 1920 + 1200, 2560 + 1600]),
        get_parse_time(),
        4294705152,
        0,
        user_agent,
        DEFAULT_SCRIPT,
        dpl,
        "en-US",
        "en-US,es-US,en,es",
        0,
        "webdriver-false",
        "location",
        "window",
        time.perf_counter() * 1000,
        str(uuid.uuid4()),
        "",
        random.choice(CORES),
        time.time() * 1000 - (time.perf_counter() * 1000),
    ]


def generate_answer(seed: str, diff: str, config: list) -> tuple[str, bool]:
    diff_len = len(diff)
    seed_encoded = seed.encode()
    static_config_part1 = (json.dumps(config[:3], separators=(",", ":"), ensure_ascii=False)[:-1] + ",").encode()
    static_config_part2 = (
        "," + json.dumps(config[4:9], separators=(",", ":"), ensure_ascii=False)[1:-1] + ","
    ).encode()
    static_config_part3 = ("," + json.dumps(config[10:], separators=(",", ":"), ensure_ascii=False)[1:]).encode()
    target_diff = bytes.fromhex(diff)

    for i in range(500000):
        dynamic_json_i = str(i).encode()
        dynamic_json_j = str(i >> 1).encode()
        final_json_bytes = static_config_part1 + dynamic_json_i + static_config_part2 + dynamic_json_j + static_config_part3
        base_encode = pybase64.b64encode(final_json_bytes)
        hash_value = hashlib.sha3_512(seed_encoded + base_encode).digest()
        if hash_value[:diff_len] <= target_diff:
            return base_encode.decode(), True

    fallback = "wQ8Lk5FbGpA2NcR9dShT6gYjU7VxZ4D" + pybase64.b64encode(f'"{seed}"'.encode()).decode()
    return fallback, False


def get_requirements_token(config: list) -> str:
    token, _ = generate_answer(format(random.random()), "0fffff", config)
    return "gAAAAAC" + token


def get_answer_token(seed: str, diff: str, config: list) -> tuple[str, bool]:
    answer, solved = generate_answer(seed, diff, config)
    return "gAAAAAB" + answer, solved
