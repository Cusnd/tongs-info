"""Shared Cloudflare-compatible `_headers` parser & evaluator (append + detach semantics)."""

from __future__ import annotations

import re
from pathlib import Path

HeaderRule = tuple[re.Pattern[str], list[tuple[str, str | None]]]


def compile_header_pattern(pattern: str) -> re.Pattern[str]:
    """Compile a Cloudflare _headers path pattern (* splat and :placeholder) into a regex."""
    out: list[str] = ["^"]
    i = 0
    n = len(pattern)
    while i < n:
        ch = pattern[i]
        if ch == "*":
            out.append(".*")
            i += 1
        elif ch == ":":
            j = i + 1
            while j < n and (pattern[j].isalnum() or pattern[j] == "_"):
                j += 1
            if j > i + 1:
                out.append("[^/]+")
                i = j
            else:
                out.append(re.escape(ch))
                i += 1
        else:
            out.append(re.escape(ch))
            i += 1
    out.append("$")
    return re.compile("".join(out))


def parse_headers_text(raw_text: str) -> list[HeaderRule]:
    """Parse Cloudflare-style _headers into ordered (regex, [(name, value_or_None)]) rules."""
    rules: list[HeaderRule] = []
    current_pat: re.Pattern[str] | None = None
    current_headers: list[tuple[str, str | None]] = []

    for raw_line in raw_text.splitlines():
        stripped = raw_line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if raw_line[0].isspace():
            if current_pat is None:
                continue
            if stripped.startswith("!"):
                name = stripped[1:].strip()
                if name:
                    current_headers.append((name, None))
            elif ":" in stripped:
                name, val = stripped.split(":", 1)
                current_headers.append((name.strip(), val.strip()))
        else:
            if current_pat is not None:
                rules.append((current_pat, current_headers))
            current_pat = compile_header_pattern(stripped)
            current_headers = []

    if current_pat is not None:
        rules.append((current_pat, current_headers))
    return rules


def parse_headers_file(headers_path: Path) -> list[HeaderRule]:
    if not headers_path.is_file():
        return []
    return parse_headers_text(headers_path.read_text(encoding="utf-8"))


def evaluate_headers(rules: list[HeaderRule], url_path: str) -> list[tuple[str, str]]:
    """
    Evaluate all matching Cloudflare _headers rules for url_path.

    Matches Cloudflare Workers Static Assets semantics:
    - Repeated matching headers APPEND additional values in rule order.
    - `! Header-Name` DETACHES all previously accumulated values for that header name.
    """
    entries_out: list[tuple[str, str]] = []
    for regex, rule_entries in rules:
        if not regex.match(url_path):
            continue
        for name, val in rule_entries:
            lname = name.lower()
            if val is None:
                entries_out = [(k, v) for k, v in entries_out if k.lower() != lname]
            else:
                entries_out.append((name, val))
    return entries_out


def evaluate_headers_map(rules: list[HeaderRule], url_path: str) -> dict[str, list[str]]:
    """Return lowercased header name -> ordered list of values."""
    out: dict[str, list[str]] = {}
    for name, val in evaluate_headers(rules, url_path):
        out.setdefault(name.lower(), []).append(val)
    return out
