"""Parse Gemini streaming response frames."""

from __future__ import annotations

import json
import re
from typing import Any


def get_nested_value(data: Any, path: list[int | str], default: Any = None) -> Any:
    current = data
    for key in path:
        if isinstance(key, int) and isinstance(current, list) and -len(current) <= key < len(current):
            current = current[key]
        elif isinstance(key, str) and isinstance(current, dict) and key in current:
            current = current[key]
        else:
            return default
    return current if current is not None else default


def parse_response_frames(content: str) -> list[Any]:
    if content.startswith(")]}'"):
        content = content[4:]
    content = content.lstrip()

    frames: list[Any] = []
    pos = 0
    total = len(content)
    marker = re.compile(r"(\d+)\n")

    while pos < total:
        while pos < total and content[pos].isspace():
            pos += 1
        if pos >= total:
            break
        match = marker.match(content, pos)
        if not match:
            break
        length = int(match.group(1))
        start = match.end()
        end = min(start + length, total)
        chunk = content[start:end].strip()
        pos = end
        if not chunk:
            continue
        try:
            parsed = json.loads(chunk)
            if isinstance(parsed, list):
                frames.extend(parsed)
            else:
                frames.append(parsed)
        except json.JSONDecodeError:
            continue

    if frames:
        return frames

    for line in content.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            parsed = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, list):
            frames.extend(parsed)
        else:
            frames.append(parsed)
    return frames


def extract_text_from_frames(frames: list[Any]) -> str:
    texts: list[str] = []

    for frame in frames:
        inner_json_str = get_nested_value(frame, [2])
        if not inner_json_str or not isinstance(inner_json_str, str):
            continue
        try:
            part_json = json.loads(inner_json_str)
        except json.JSONDecodeError:
            continue

        candidates = get_nested_value(part_json, [4], [])
        if not isinstance(candidates, list):
            continue

        for candidate in candidates:
            text = get_nested_value(candidate, [1, 0])
            if isinstance(text, str) and text.strip():
                texts.append(text)

        fallback = get_nested_value(part_json, [0, 0, 0, 0, 1, 0])
        if isinstance(fallback, str) and fallback.strip():
            texts.append(fallback)

    if not texts:
        for frame in frames:
            try:
                blob = json.dumps(frame)
            except TypeError:
                continue
            match = re.search(r'"\\u003cp\\u003e([^"\\]+)', blob)
            if match:
                texts.append(match.group(1))

    if not texts:
        return ""

    best = max(texts, key=len)
    return best.replace("\\n", "\n").strip()
