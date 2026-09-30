#!/usr/bin/env python3
"""capture_cookies.py — read provider session cookies from a local Chromium
browser profile and convert them into Web2API auth files.

This is the "no manual cookie extraction" path for the Node harness: instead of
copying cURL requests out of DevTools, it reads the browser's own cookie database
directly and writes vendor/web2api/auth/*.local.json.

Usage:
    python scripts/capture_cookies.py --list
    python scripts/capture_cookies.py --provider perplexity --browser brave
    python scripts/capture_cookies.py --provider all --browser auto

Notes:
  * Close the target browser first, or Chromium may hold a lock on the database.
    (A read-only copy is taken, so a lock is usually survivable.)
  * Values never leave the machine and are never printed — only key counts.
  * Chrome/Brave/Edge encrypt cookie values on Windows. Set WEB2API_COOKIE_KEY
    to that browser's Local State `os_crypt.encrypted_key` value (base64), or
    pass --strict to require decryption for every cookie.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import shutil
import sqlite3
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
AUTH_DIR = ROOT / "vendor" / "web2api" / "auth"

# provider -> (cookie db domain filter, output file, shape)
PROVIDERS = {
    "perplexity": {
        "domains": ("perplexity.ai",),
        "file": "cookies.local.json",
        "shape": "flat",
    },
    "chatgpt": {
        "domains": ("chatgpt.com", "openai.com"),
        "file": "chatgpt.local.json",
        "shape": "chatgpt",
    },
    "gemini": {
        "domains": ("gemini.google.com", "google.com"),
        "file": "gemini.local.json",
        "shape": "gemini",
        # Only these are useful for Gemini; keeps the jar small and tidy.
        "keep": (
            "SID", "HSID", "SSID", "APISID", "SAPISID",
            "__Secure-1PSID", "__Secure-3PSID",
            "__Secure-1PSIDTS", "__Secure-3PSIDTS",
            "__Secure-1PAPISID", "__Secure-3PAPISID",
            "NID", "COMPASS", "SIDCC",
        ),
    },
}

BROWSERS = {
    "chrome": ("Google/Chrome/User Data", "Google/Chrome Beta/User Data"),
    "brave": ("BraveSoftware/Brave-Browser/User Data",),
    "edge": ("Microsoft/Edge/User Data",),
    "vivaldi": ("Vivaldi/User Data",),
    "chromium": ("Chromium/User Data",),
}


def local_appdata() -> Path:
    return Path(os.environ.get("LOCALAPPDATA") or Path.home() / ".local" / "share")


def find_profiles(browser: str) -> list[Path]:
    bases: list[Path] = []
    for rel in BROWSERS.get(browser, ()):
        bases.append(local_appdata() / rel)
    profiles: list[Path] = []
    for base in bases:
        if not base.is_dir():
            continue
        for entry in sorted(base.iterdir()):
            if entry.is_dir() and (entry.name == "Default" or entry.name.startswith("Profile")):
                if (entry / "Cookies").is_file():
                    profiles.append(entry)
    return profiles


def detect_browsers() -> list[str]:
    return [name for name in BROWSERS if find_profiles(name)]


def decrypt_value(encrypted: bytes, key: bytes | None) -> str | None:
    """Best-effort Chromium cookie decryption (Windows DPAPI / AES-GCM)."""
    if not encrypted:
        return None
    prefix = encrypted[:3]
    if prefix in (b"v10", b"v11"):
        if not key:
            return None
        try:
            from cryptography.hazmat.primitives.ciphers.aead import AESGCM  # type: ignore
        except Exception:
            return None
        nonce, payload = encrypted[3:15], encrypted[15:]
        if len(payload) < 16:
            return None
        try:
            return AESGCM(key).decrypt(nonce, payload, None).decode("utf-8", "replace")
        except Exception:
            return None
    # Unencrypted (older builds / Linux) — value may itself be utf-8.
    try:
        return encrypted.decode("utf-8")
    except Exception:
        return None


def load_key(browser: str) -> bytes | None:
    env = os.environ.get("WEB2API_COOKIE_KEY", "").strip()
    if env:
        try:
            raw = base64.b64decode(env)
            return raw[5:] if raw[:5] == b"DPAPI" else raw
        except Exception:
            print("  ! WEB2API_COOKIE_KEY is not valid base64 — ignoring", file=sys.stderr)
    return None


def read_cookies(profile: Path, domains: tuple[str, ...], key: bytes | None, strict: bool):
    tmp = Path(tempfile.mkdtemp(prefix="orch-cookies-")) / "Cookies"
    try:
        shutil.copy2(profile / "Cookies", tmp)
    except Exception as exc:
        print(f"  ! cannot read {profile / 'Cookies'}: {exc}", file=sys.stderr)
        return {}, 0
    jar: dict[str, str] = {}
    skipped = 0
    try:
        con = sqlite3.connect(f"file:{tmp}?mode=ro", uri=True)
        rows = con.execute("SELECT host_key, name, value, encrypted_value FROM cookies").fetchall()
        con.close()
    except Exception as exc:
        print(f"  ! cannot query cookie db: {exc}", file=sys.stderr)
        return {}, 0
    finally:
        shutil.rmtree(tmp.parent, ignore_errors=True)

    for host, name, value, enc in rows:
        if not any(d in (host or "") for d in domains):
            continue
        if not name:
            continue
        if value:
            resolved = value
        else:
            resolved = decrypt_value(enc, key)
            if not resolved:
                skipped += 1
                continue
        if resolved:
            jar[name] = resolved
    if strict and skipped:
        raise SystemExit(
            f"  ! {skipped} cookie value(s) could not be decrypted. "
            "Set WEB2API_COOKIE_KEY to the browser's os_crypt.encrypted_key."
        )
    return jar, skipped


def build_payload(shape: str, jar: dict[str, str]) -> dict:
    if shape == "flat":
        return jar
    if shape == "chatgpt":
        return {"cookies": jar, "headers": {}, "account_id": ""}
    return {"cookies": jar, "headers": {}, "build_label": ""}


def capture(provider: str, browser: str, profiles: list[Path], strict: bool) -> bool:
    spec = PROVIDERS[provider]
    key = load_key(browser)
    print(f"[{provider}] scanning {len(profiles)} profile(s) in {browser}")
    best: dict[str, str] = {}
    skipped_total = 0
    for profile in profiles:
        jar, skipped = read_cookies(profile, spec["domains"], key, strict)
        skipped_total += skipped
        if spec.get("keep"):
            jar = {k: v for k, v in jar.items() if k in spec["keep"]}
        if len(jar) > len(best):
            best = jar
            if jar:
                print(f"  profile {profile.name}: {len(jar)} usable cookie(s)")
    if not best:
        print(f"  -> no {provider} cookies found"
              + (f" ({skipped_total} encrypted values skipped — set WEB2API_COOKIE_KEY)" if skipped_total else ""))
        return False
    if provider == "gemini" and "__Secure-1PSID" not in best:
        print("  ! __Secure-1PSID missing — you are probably not logged into Gemini in this browser")
        return False
    if provider == "chatgpt" and not any("session-token" in k for k in best):
        print("  ! no ChatGPT session token found — log in to chatgpt.com in this browser")
        return False

    AUTH_DIR.mkdir(parents=True, exist_ok=True)
    out = AUTH_DIR / spec["file"]
    payload = build_payload(spec["shape"], best)
    tmp = out.with_suffix(out.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    tmp.replace(out)
    print(f"  -> wrote {out.relative_to(ROOT)} ({len(best)} cookie(s))")
    return True


def main() -> int:
    ap = argparse.ArgumentParser(description="Capture provider cookies into Web2API auth files.")
    ap.add_argument("--provider", default="all",
                    choices=["all", *PROVIDERS.keys()], help="which provider to capture")
    ap.add_argument("--browser", default="auto",
                    choices=["auto", *BROWSERS.keys()], help="which browser profile to read")
    ap.add_argument("--list", action="store_true", help="list detected browsers and exit")
    ap.add_argument("--strict", action="store_true", help="fail if any cookie cannot be decrypted")
    ap.add_argument("--json", action="store_true", help="emit a machine-readable summary on stdout")
    args = ap.parse_args()

    found = detect_browsers()
    if args.list:
        if not found:
            print("No Chromium browser profiles found.")
        for name in found:
            profiles = find_profiles(name)
            print(f"{name}: {len(profiles)} profile(s)")
            for p in profiles:
                print(f"  - {p}")
        return 0

    if args.browser == "auto":
        if not found:
            if args.json:
                print(json.dumps({"captured": [], "browsers": [], "detail": "no chromium browser found"}))
            else:
                print("No Chromium browser with a cookie database was found.")
                print("Supported: " + ", ".join(BROWSERS))
            return 1
        browsers = found
    else:
        browsers = [args.browser]

    providers = list(PROVIDERS) if args.provider == "all" else [args.provider]
    captured: list[str] = []
    if args.json:
        # Silence the human-readable chatter; only JSON on stdout.
        devnull = open(os.devnull, "w")
        real_stdout = sys.stdout
        sys.stdout = devnull
    for provider in providers:
        for browser in browsers:
            profiles = find_profiles(browser)
            if not profiles:
                continue
            if capture(provider, browser, profiles, args.strict):
                captured.append(provider)
                break
    if args.json:
        sys.stdout = real_stdout
        devnull.close()
        print(json.dumps({"captured": captured, "browsers": browsers}))
        return 0 if captured else 1

    if not captured:
        print("\nNothing captured. Make sure you are logged into the provider in that browser,")
        print("then re-run. Tip: the Chrome extension (Option A) needs no cookies at all.")
        return 1
    print("\nDone. Restart the server (or it will pick these up on next provider check).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())