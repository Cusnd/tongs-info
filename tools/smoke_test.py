#!/usr/bin/env python3
"""
Tong's Information — HTTP Contract & Post-Deploy Smoke Test (Zero Dependencies)

Verifies both local builds (via preview_server.py) and live Cloudflare Workers deployments:
- Core bilingual HTML routes return HTTP 200 with expected publication name & Link: </llms.txt> header
- Canonical URL normalization (`/about` & `/about/index.html` -> 301/307/308 redirect to `/about/`,
  missing asset `/about/index.css` -> 404)
- Shared engine CSS/JS/favicon assets return HTTP 200 without unsafe `immutable` caching
- Machine endpoints (llms.txt, llms-full.txt, api/*.json, rss.xml, feed.json, sitemap.xml, robots.txt)
  return HTTP 200, strict UTF-8 charset, and valid JSON/XML matching catalog base_url
- Release identity verification (`--expect-dist <dir>`): asserts `/api/release.json` bundle_sha256,
  `/api/posts.json` exact payload parity, and lead article HTML/Markdown exact byte parity
  so stale previous deployments or misrouted Workers can never pass!
- All bilingual article HTML pages and Markdown twins return HTTP 200 (text/markdown; charset=utf-8, LF)
- `/_headers` and `/%5fheaders` return HTTP 404 (never exposed publicly)
- Unknown Chinese & English routes return HTTP 404 with localized 404 markup

Usage:
  python tools/smoke_test.py --site demo --local
  python tools/smoke_test.py --site demo --local --dist .dist/demo
  python tools/smoke_test.py --site prod --base-url https://www.esoren.com --expect-dist .dist/prod --retries 6
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import socket
import struct
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SITES_DIR = ROOT / "sites"
CF_BEACON_RE = re.compile(
    rb'<script\b[^>]*\bsrc="https://static\.cloudflareinsights\.com/beacon\.min\.js[^"]*"[^>]*></script>\s*',
    re.IGNORECASE,
)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


REMOTE_OPENER = urllib.request.build_opener(NoRedirect())
LOCAL_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())


def fetch(
    base_url: str,
    path: str,
    timeout: float = 15.0,
    *,
    local: bool = False,
    method: str = "GET",
    body: bytes | None = None,
    headers: dict[str, str] | None = None,
) -> tuple[int, dict[str, str], bytes]:
    url = base_url.rstrip("/") + path
    req_headers = {"User-Agent": "TongsInformation-SmokeTest/1.0"}
    if headers:
        req_headers.update(headers)
    req = urllib.request.Request(
        url,
        data=body,
        headers=req_headers,
        method=method,
    )
    opener = LOCAL_OPENER if local else REMOTE_OPENER
    try:
        with opener.open(req, timeout=timeout) as resp:
            resp_headers = {k.lower(): v for k, v in resp.headers.items()}
            return resp.status, resp_headers, resp.read()
    except urllib.error.HTTPError as exc:
        resp_headers = {k.lower(): v for k, v in exc.headers.items()}
        resp_body = exc.read()
        return exc.code, resp_headers, resp_body


def _solve_pow_local(gate_token: str, bits: int) -> str:
    full = bits // 8
    rem = bits % 8
    mask = (0xFF << (8 - rem)) & 0xFF if rem > 0 else 0
    for counter in range(2_000_000):
        cand = format(counter, "x")
        digest = hashlib.sha256(f"{gate_token}:{cand}".encode("utf-8")).digest()
        if all(digest[i] == 0 for i in range(full)) and (rem == 0 or (digest[full] & mask) == 0):
            return cand
    raise RuntimeError("Failed to solve local PoW challenge")


def _make_minimal_png(width: int = 2, height: int = 2) -> bytes:
    def chunk(tag: bytes, payload: bytes) -> bytes:
        crc = zlib.crc32(tag + payload) & 0xFFFFFFFF
        return struct.pack(">I", len(payload)) + tag + payload + struct.pack(">I", crc)

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    raw_scanlines = b"".join(b"\x00" + b"\x00\x47\xff" * width for _ in range(height))
    idat = zlib.compress(raw_scanlines)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b"")


def _build_multipart(payload_obj: dict[str, object], images: list[tuple[str, str, bytes]]) -> tuple[str, bytes]:
    boundary = "----TongsInfoSmokeBoundary7MA4YWxkTrZu0gW"
    parts: list[bytes] = []
    payload_bytes = json.dumps(payload_obj).encode("utf-8")
    parts.append(
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="payload"\r\n'
        f"Content-Type: application/json\r\n\r\n".encode("utf-8")
        + payload_bytes
        + b"\r\n"
    )
    for filename, mime, content in images:
        parts.append(
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="images"; filename="{filename}"\r\n'
            f"Content-Type: {mime}\r\n\r\n".encode("utf-8")
            + content
            + b"\r\n"
        )
    parts.append(f"--{boundary}--\r\n".encode("utf-8"))
    return f"multipart/form-data; boundary={boundary}", b"".join(parts)


def pick_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def wait_for_server(base_url: str, timeout: float = 10.0) -> None:
    deadline = time.monotonic() + timeout
    last_err: Exception | None = None
    while time.monotonic() < deadline:
        try:
            status, _, _ = fetch(base_url, "/robots.txt", timeout=2.0, local=True)
            if status == 200:
                return
        except Exception as exc:
            last_err = exc
        time.sleep(0.15)
    raise RuntimeError(f"Preview server failed to become ready at {base_url}: {last_err}")


def run_suite(
    base_url: str,
    catalog: dict,
    *,
    stream_data: dict | None = None,
    local: bool = False,
    expect_dist: Path | None = None,
    expect_comment_images: bool = False,
) -> list[str]:
    errors: list[str] = []
    site_name = catalog["site"]["name"]
    expected_base = catalog["site"]["base_url"].rstrip("/")

    # 1. Core bilingual HTML pages
    core_pages = [
        "/",
        "/en/",
        "/archive/",
        "/en/archive/",
        "/stream/",
        "/en/stream/",
        "/graph/",
        "/en/graph/",
        "/about/",
        "/en/about/",
    ]
    core_bodies: dict[str, bytes] = {}
    for path in core_pages:
        status, hdrs, body = fetch(base_url, path, local=local)
        if status != 200:
            errors.append(f"GET {path}: expected 200, got {status}")
            continue
        core_bodies[path] = body
        ct = hdrs.get("content-type", "").lower()
        if "text/html" not in ct:
            errors.append(f"GET {path}: expected text/html Content-Type, got {ct!r}")
        link_hdr = hdrs.get("link", "")
        if "/llms.txt" not in link_hdr:
            errors.append(f"GET {path}: missing Link header advertising /llms.txt (got {link_hdr!r})")
        text = body.decode("utf-8", errors="replace")
        if site_name not in text:
            errors.append(f"GET {path}: body missing expected site name {site_name!r}")

    # 2. Strict canonical URL normalization & missing asset 404 (M7)
    for req_path in ("/about", "/about/index.html"):
        status, hdrs, _ = fetch(base_url, req_path, local=local)
        if status not in (301, 307, 308):
            errors.append(f"GET {req_path}: expected 301/307/308 redirect to /about/, got {status}")
        else:
            loc = hdrs.get("location", "")
            if not loc.endswith("/about/"):
                errors.append(f"GET {req_path}: redirect Location expected to end with '/about/', got {loc!r}")

    status, _, _ = fetch(base_url, "/about/index.css", local=local)
    if status != 404:
        errors.append(f"GET /about/index.css: missing non-HTML asset must return 404, got {status}")

    # Standalone HTML canonicalization (auto-trailing-slash: /404.html & /404/ -> 307 /404 -> 200)
    for req_path in ("/404.html", "/404/"):
        status, hdrs, _ = fetch(base_url, req_path, local=local)
        if status not in (301, 307, 308):
            errors.append(f"GET {req_path}: expected 301/307/308 canonical redirect to /404, got {status}")
        else:
            loc = hdrs.get("location", "")
            if not loc.endswith("/404"):
                errors.append(f"GET {req_path}: redirect Location expected to end with '/404', got {loc!r}")

    status, hdrs, body = fetch(base_url, "/404", local=local)
    if status != 200 or "404" not in body.decode("utf-8", errors="replace"):
        errors.append(f"GET /404: expected 200 with 404 markup, got status={status}")

    # 3. Shared engine assets
    engine_assets = [
        "/assets/css/tokens.css",
        "/assets/css/editorial.css",
        "/assets/css/motion.css",
        "/assets/css/comments.css",
        "/assets/css/stream.css",
        "/assets/js/site.js",
        "/assets/js/transitions.js",
        "/assets/js/graph.js",
        "/assets/js/cover-model.js",
        "/assets/js/comments.js",
        "/assets/js/stream.js",
        "/assets/favicon.svg",
    ]
    for path in engine_assets:
        status, hdrs, body = fetch(base_url, path, local=local)
        if status != 200:
            errors.append(f"GET {path}: expected 200, got {status}")
            continue
        if not body:
            errors.append(f"GET {path}: empty response body")
        cc = hdrs.get("cache-control", "").lower()
        if "immutable" in cc:
            errors.append(f"GET {path}: unhashed asset must not declare immutable Cache-Control ({cc!r})")

    # 4. Text / JSON / XML machine endpoints
    for path in ("/llms.txt", "/llms-full.txt", "/robots.txt"):
        status, hdrs, body = fetch(base_url, path, local=local)
        if status != 200:
            errors.append(f"GET {path}: expected 200, got {status}")
            continue
        ct = hdrs.get("content-type", "").lower()
        if "charset=utf-8" not in ct:
            errors.append(f"GET {path}: missing charset=utf-8 in Content-Type ({ct!r})")
        if expected_base not in body.decode("utf-8", errors="replace"):
            errors.append(f"GET {path}: expected base_url {expected_base!r} in response")

    posts_payload_live: dict | None = None
    stream_payload_live: dict | None = None
    stream_raw_bodies: dict[str, bytes] = {}
    for path in ("/api/posts.json", "/api/graph.json", "/api/stream.json", "/feed.json", "/en/feed.json"):
        status, hdrs, body = fetch(base_url, path, local=local)
        if status != 200:
            errors.append(f"GET {path}: expected 200, got {status}")
            continue
        ct = hdrs.get("content-type", "").lower()
        if "charset=utf-8" not in ct:
            errors.append(f"GET {path}: missing charset=utf-8 in Content-Type ({ct!r})")
        try:
            payload = json.loads(body.decode("utf-8"))
        except Exception as exc:
            errors.append(f"GET {path}: invalid JSON ({exc})")
            continue
        if path == "/api/posts.json":
            posts_payload_live = payload
            actual_base = str(payload.get("site", {}).get("base_url", "")).rstrip("/")
            if actual_base != expected_base:
                errors.append(
                    f"GET /api/posts.json: site.base_url mismatch (got {actual_base!r}, expected {expected_base!r})"
                )
        elif path == "/api/stream.json":
            stream_payload_live = payload
            stream_raw_bodies[path] = body
            if payload.get("site") != site_name:
                errors.append(
                    f"GET /api/stream.json: site mismatch (got {payload.get('site')!r}, expected {site_name!r})"
                )
            if stream_data is not None:
                exp_entries = stream_data.get("entries") or []
                exp_ids = {str(e.get("id")) for e in exp_entries}
                live_entries = payload.get("entries") if isinstance(payload.get("entries"), list) else []
                live_id_list = [str(e.get("id")) for e in live_entries if isinstance(e, dict)]
                live_ids = set(live_id_list)
                if (
                    payload.get("count") != len(exp_ids)
                    or len(live_entries) != len(exp_ids)
                    or len(live_id_list) != len(exp_ids)
                    or live_ids != exp_ids
                ):
                    errors.append(
                        f"GET /api/stream.json: entry count/IDs mismatch "
                        f"(got count={payload.get('count')!r} len={len(live_entries)} ids={sorted(live_ids)}, expected {sorted(exp_ids)})"
                    )

    for path in ("/rss.xml", "/en/rss.xml", "/stream/rss.xml", "/en/stream/rss.xml", "/sitemap.xml"):
        status, hdrs, body = fetch(base_url, path, local=local)
        if status != 200:
            errors.append(f"GET {path}: expected 200, got {status}")
            continue
        ct = hdrs.get("content-type", "").lower()
        if "charset=utf-8" not in ct:
            errors.append(f"GET {path}: missing charset=utf-8 in Content-Type ({ct!r})")
        try:
            root_xml = ET.fromstring(body.decode("utf-8"))
        except Exception as exc:
            errors.append(f"GET {path}: invalid XML ({exc})")
            continue
        if path in ("/stream/rss.xml", "/en/stream/rss.xml"):
            stream_raw_bodies[path] = body
            exp_channel_link = f"{expected_base}/en/stream/" if path.startswith("/en/") else f"{expected_base}/stream/"
            channel_link = root_xml.findtext("./channel/link")
            if channel_link != exp_channel_link:
                errors.append(
                    f"GET {path}: channel link mismatch (got {channel_link!r}, expected {exp_channel_link!r})"
                )
            if stream_data is not None:
                exp_links = {f"{exp_channel_link}#t-{e['id']}" for e in stream_data.get("entries") or []}
                item_links_list = [
                    el.text.strip()
                    for el in root_xml.findall("./channel/item/link")
                    if el.text and el.text.strip()
                ]
                item_links = set(item_links_list)
                if len(item_links_list) != len(exp_links) or item_links != exp_links:
                    errors.append(
                        f"GET {path}: item links mismatch (got len={len(item_links_list)} {sorted(item_links)}, expected {sorted(exp_links)})"
                    )

    # 5. All bilingual posts & Markdown twins (strict LF fence check)
    fetched_bodies: dict[str, bytes] = {}
    for post in catalog["posts"]:
        for lang in ("zh", "en"):
            loc = post[lang]
            html_url = loc["url"]
            md_url = loc["md_url"]

            status, _, html_body = fetch(base_url, html_url, local=local)
            if status != 200:
                errors.append(f"GET {html_url}: expected 200, got {status}")
            else:
                fetched_bodies[html_url] = html_body

            status, hdrs, body = fetch(base_url, md_url, local=local)
            if status != 200:
                errors.append(f"GET {md_url}: expected 200, got {status}")
            else:
                fetched_bodies[md_url] = body
                ct = hdrs.get("content-type", "").lower()
                if "text/markdown" not in ct or "charset=utf-8" not in ct:
                    errors.append(f"GET {md_url}: expected text/markdown; charset=utf-8, got {ct!r}")
                if not body.startswith(b"---\n"):
                    errors.append(f"GET {md_url}: missing LF YAML frontmatter header ('---\\n')")

    for stream_md in ("/stream/index.md", "/en/stream/index.md"):
        status, hdrs, body = fetch(base_url, stream_md, local=local)
        if status != 200:
            errors.append(f"GET {stream_md}: expected 200, got {status}")
        else:
            stream_raw_bodies[stream_md] = body
            ct = hdrs.get("content-type", "").lower()
            if "text/markdown" not in ct or "charset=utf-8" not in ct:
                errors.append(f"GET {stream_md}: expected text/markdown; charset=utf-8, got {ct!r}")
            if not body.startswith(b"---\n"):
                errors.append(f"GET {stream_md}: missing LF YAML frontmatter header ('---\\n')")

    # 6. Release identity & staged bundle exact parity verification (M1)
    if expect_dist is not None:
        exp_release_file = expect_dist / "api" / "release.json"
        if not exp_release_file.is_file():
            errors.append(f"Staged bundle missing expected release stamp: {exp_release_file}")
        else:
            exp_release = json.loads(exp_release_file.read_text(encoding="utf-8"))
            status, hdrs, body = fetch(base_url, "/api/release.json", local=local)
            if status != 200:
                errors.append(f"GET /api/release.json: expected 200, got {status}")
            else:
                cc = hdrs.get("cache-control", "").lower()
                if "max-age=0" not in cc or "must-revalidate" not in cc:
                    errors.append(
                        f"GET /api/release.json: expected revalidating Cache-Control, got {cc!r}"
                    )
                try:
                    live_release = json.loads(body.decode("utf-8"))
                except Exception as exc:
                    errors.append(f"GET /api/release.json: invalid JSON ({exc})")
                else:
                    for key in ("site", "name", "base_url", "post_count", "bundle_sha256", "git_sha"):
                        if live_release.get(key) != exp_release.get(key):
                            errors.append(
                                f"GET /api/release.json: '{key}' mismatch "
                                f"(live={live_release.get(key)!r}, staged={exp_release.get(key)!r})"
                            )

        exp_posts_file = expect_dist / "api" / "posts.json"
        if exp_posts_file.is_file() and posts_payload_live is not None:
            exp_posts_payload = json.loads(exp_posts_file.read_text(encoding="utf-8"))
            if posts_payload_live != exp_posts_payload:
                errors.append("GET /api/posts.json: live catalog payload differs from staged bundle")

        exp_stream_file = expect_dist / "api" / "stream.json"
        if exp_stream_file.is_file() and stream_payload_live is not None:
            exp_stream_payload = json.loads(exp_stream_file.read_text(encoding="utf-8"))
            if stream_payload_live != exp_stream_payload:
                errors.append("GET /api/stream.json: live stream payload differs from staged bundle")

        for s_path in ("/stream/rss.xml", "/en/stream/rss.xml", "/stream/index.md", "/en/stream/index.md"):
            staged_file = expect_dist / s_path.lstrip("/")
            if staged_file.is_file():
                if s_path not in stream_raw_bodies:
                    errors.append(f"GET {s_path}: missing live response for byte parity check")
                elif stream_raw_bodies[s_path] != staged_file.read_bytes():
                    errors.append(f"GET {s_path}: live bytes differ from staged bundle")

        for s_html_path in ("/stream/", "/en/stream/"):
            staged_html = expect_dist / s_html_path.lstrip("/") / "index.html"
            if staged_html.is_file():
                if s_html_path not in core_bodies:
                    errors.append(f"GET {s_html_path}: missing live HTML response for byte parity check")
                else:
                    live_html = core_bodies[s_html_path]
                    if not local:
                        live_html = CF_BEACON_RE.sub(b"", live_html)
                    if live_html != staged_html.read_bytes():
                        errors.append(f"GET {s_html_path}: live HTML bytes differ from staged bundle")

        # Verify lead post HTML & Markdown twin exact byte parity using the already-verified responses
        if catalog["posts"]:
            lead = catalog["posts"][0]
            for lang in ("zh", "en"):
                loc = lead[lang]
                staged_html = expect_dist / loc["url"].lstrip("/") / "index.html"
                if staged_html.is_file():
                    if loc["url"] not in fetched_bodies:
                        errors.append(f"GET {loc['url']}: missing live HTML response for byte parity check")
                    else:
                        live_html = fetched_bodies[loc["url"]]
                        if not local:
                            # Strip Cloudflare Web Analytics beacon injected by the zone CDN before byte comparison
                            live_html = CF_BEACON_RE.sub(b"", live_html)
                        if live_html != staged_html.read_bytes():
                            errors.append(f"GET {loc['url']}: live HTML bytes differ from staged bundle")
                staged_md = expect_dist / loc["md_url"].lstrip("/")
                if staged_md.is_file():
                    if loc["md_url"] not in fetched_bodies:
                        errors.append(f"GET {loc['md_url']}: missing live Markdown response for byte parity check")
                    elif fetched_bodies[loc["md_url"]] != staged_md.read_bytes():
                        errors.append(f"GET {loc['md_url']}: live Markdown bytes differ from staged bundle")

    # 7. Security & localized 404 behavior
    status, _, _ = fetch(base_url, "/_headers", local=local)
    if status != 404:
        errors.append(f"GET /_headers: expected 404 (never exposed publicly), got {status}")

    status, hdrs, _ = fetch(base_url, "/%5fheaders", local=local)
    if status in (301, 307, 308):
        loc_hdr = hdrs.get("location", "")
        if not loc_hdr.endswith("/_headers"):
            errors.append(f"GET /%5fheaders: unexpected redirect target {loc_hdr!r}")
        else:
            final_status, _, _ = fetch(base_url, "/_headers", local=local)
            if final_status != 404:
                errors.append(f"GET /%5fheaders -> /_headers: expected final 404, got {final_status}")
    elif status != 404:
        errors.append(f"GET /%5fheaders: expected 404 or redirect to /_headers (404), got {status}")

    status, _, body = fetch(base_url, "/__smoke-nonexistent-zh__", local=local)
    if status != 404:
        errors.append(f"GET /__smoke-nonexistent-zh__: expected 404, got {status}")
    elif "404" not in body.decode("utf-8", errors="replace"):
        errors.append("GET /__smoke-nonexistent-zh__: missing 404 page content")

    status, _, body = fetch(base_url, "/en/__smoke-nonexistent-en__", local=local)
    if status != 404:
        errors.append(f"GET /en/__smoke-nonexistent-en__: expected 404, got {status}")
    elif "Page Not Found" not in body.decode("utf-8", errors="replace"):
        errors.append("GET /en/__smoke-nonexistent-en__: missing English 404 page content")

    # 8. Comments API contract & anti-abuse verification
    if catalog["posts"]:
        lead_slug = catalog["posts"][0]["slug"]
        status, hdrs, body = fetch(base_url, f"/api/comments?slug={urllib.parse.quote(lead_slug)}", local=local)
        if status != 200:
            errors.append(f"GET /api/comments?slug={lead_slug}: expected 200, got {status}")
        else:
            cc = hdrs.get("cache-control", "").lower()
            if "no-store" not in cc:
                errors.append(f"GET /api/comments: expected Cache-Control: no-store, got {cc!r}")
            try:
                cdata = json.loads(body.decode("utf-8"))
            except Exception as exc:
                errors.append(f"GET /api/comments: invalid JSON ({exc})")
                cdata = {}
            if cdata.get("ok") is not True or not isinstance(cdata.get("comments"), list):
                errors.append("GET /api/comments: malformed response payload")
            else:
                cfg = cdata.get("config") or {}
                gate = cdata.get("gate") or {}
                if not str(gate.get("token") or "").strip():
                    errors.append("GET /api/comments: missing signed gate.token")
                if expect_comment_images and cfg.get("imagesEnabled") is not True:
                    errors.append(
                        f"GET /api/comments: site declares r2_bucket_name but config.imagesEnabled is {cfg.get('imagesEnabled')!r} "
                        "(apply migrations/0002_comment_images.sql and bind COMMENTS_IMAGES R2 bucket)"
                    )
            if local and cdata.get("ok") is True and isinstance(cdata.get("comments"), list):
                gate = cdata.get("gate") or {}
                gate_tok = str(gate.get("token") or "")
                fb_bits = int(gate.get("fallbackPowBits") or 14)

                # 8a. Invalid slug rejected with 400
                bad_st, _, _ = fetch(base_url, "/api/comments?slug=BAD_SLUG!!", local=True)
                if bad_st != 400:
                    errors.append(f"GET /api/comments?slug=BAD_SLUG!!: expected 400, got {bad_st}")

                # 8b. Missing PoW rejected with 403
                p_bad, _, _ = fetch(
                    base_url,
                    "/api/comments",
                    local=True,
                    method="POST",
                    headers={"Content-Type": "application/json"},
                    body=json.dumps({
                        "slug": lead_slug,
                        "lang": "zh",
                        "body": "Smoke test without PoW",
                        "gateToken": gate_tok,
                        "powNonce": "bad",
                        "fallbackMode": True,
                    }).encode("utf-8"),
                )
                if p_bad != 403:
                    errors.append(f"POST /api/comments (bad PoW): expected 403, got {p_bad}")

                # 8c. Honeypot silently shadow-drops (201 without persisting)
                hp_st, _, _ = fetch(
                    base_url,
                    "/api/comments",
                    local=True,
                    method="POST",
                    headers={"Content-Type": "application/json"},
                    body=json.dumps({
                        "slug": lead_slug,
                        "lang": "zh",
                        "body": "Spam bot honeypot probe",
                        "websiteHp": "https://spam.example",
                        "gateToken": gate_tok,
                        "fallbackMode": True,
                    }).encode("utf-8"),
                )
                if hp_st != 201:
                    errors.append(f"POST /api/comments (honeypot): expected shadow-drop 201, got {hp_st}")

                # 8d. Valid PoW persists comment; replaying gate nonce with DIFFERENT body must fail with gate_replayed (409)
                nonce = _solve_pow_local(gate_tok, fb_bits)
                good_payload = json.dumps({
                    "slug": lead_slug,
                    "lang": "zh",
                    "authorName": "Smoke Reader",
                    "body": "Smoke test comment verifying PoW & single-use gate.",
                    "gateToken": gate_tok,
                    "powNonce": nonce,
                    "fallbackMode": True,
                }).encode("utf-8")
                p_ok, _, p_body = fetch(
                    base_url,
                    "/api/comments",
                    local=True,
                    method="POST",
                    headers={"Content-Type": "application/json"},
                    body=good_payload,
                )
                if p_ok != 201:
                    errors.append(f"POST /api/comments (valid PoW): expected 201, got {p_ok} ({p_body.decode('utf-8', 'replace')})")
                else:
                    created = json.loads(p_body.decode("utf-8"))
                    cid = created.get("comment", {}).get("id", "")
                    replay_payload = json.dumps({
                        "slug": lead_slug,
                        "lang": "zh",
                        "authorName": "Smoke Reader",
                        "body": "Different body reusing spent single-use gate nonce.",
                        "gateToken": gate_tok,
                        "powNonce": nonce,
                        "fallbackMode": True,
                    }).encode("utf-8")
                    p_rep, _, p_rep_body = fetch(
                        base_url,
                        "/api/comments",
                        local=True,
                        method="POST",
                        headers={"Content-Type": "application/json"},
                        body=replay_payload,
                    )
                    rep_err = json.loads(p_rep_body.decode("utf-8", "replace")).get("error") if p_rep_body else None
                    if p_rep != 409 or rep_err != "gate_replayed":
                        errors.append(f"POST /api/comments (gate replay): expected 409 gate_replayed, got {p_rep} ({rep_err!r})")

                    # Author verify & delete cleanup
                    auth_st, _, _ = fetch(
                        base_url,
                        "/api/comments/author/verify",
                        local=True,
                        method="POST",
                        headers={"X-Author-Key": "smoke-test-author-key"},
                    )
                    if auth_st != 200:
                        errors.append(f"POST /api/comments/author/verify: expected 200, got {auth_st}")
                    del_st, _, _ = fetch(
                        base_url,
                        f"/api/comments/{urllib.parse.quote(cid)}",
                        local=True,
                        method="DELETE",
                        headers={"X-Author-Key": "smoke-test-author-key"},
                    )
                    if del_st != 200:
                        errors.append(f"DELETE /api/comments/{cid}: expected 200, got {del_st}")

                # 8e. Comment image attachment contract (upload, serve, ETag 304, security headers, reject SVG/truncated/overflow, parent+reply cascade delete)
                cfg = cdata.get("config") or {}
                if cfg.get("imagesEnabled") is not True or cfg.get("maxImages") != 3:
                    errors.append(f"GET /api/comments: expected config.imagesEnabled=True & maxImages=3, got {cfg!r}")
                else:
                    g2_st, _, g2_body = fetch(
                        base_url, f"/api/comments?slug={urllib.parse.quote(lead_slug)}", local=True
                    )
                    g2_gate = (json.loads(g2_body.decode("utf-8")).get("gate") or {}) if g2_st == 200 else {}
                    g2_tok = str(g2_gate.get("token") or "")
                    g2_bits = int(g2_gate.get("fallbackPowBits") or 14)

                    # Reject SVG disguised as PNG
                    svg_bytes = b'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
                    ct_svg, body_svg = _build_multipart(
                        {
                            "slug": lead_slug,
                            "lang": "zh",
                            "body": "Disguised SVG probe",
                            "gateToken": g2_tok,
                            "powNonce": _solve_pow_local(g2_tok, g2_bits),
                            "fallbackMode": True,
                        },
                        [("evil.png", "image/png", svg_bytes)],
                    )
                    svg_st, _, _ = fetch(
                        base_url,
                        "/api/comments",
                        local=True,
                        method="POST",
                        headers={"Content-Type": ct_svg},
                        body=body_svg,
                    )
                    if svg_st != 400:
                        errors.append(f"POST /api/comments (disguised SVG): expected 400, got {svg_st}")

                    # Reject truncated PNG missing IEND
                    png_bytes = _make_minimal_png(3, 2)
                    ct_trunc, body_trunc = _build_multipart(
                        {
                            "slug": lead_slug,
                            "lang": "zh",
                            "body": "Truncated PNG probe",
                            "gateToken": g2_tok,
                            "powNonce": _solve_pow_local(g2_tok, g2_bits),
                            "fallbackMode": True,
                        },
                        [("trunc.png", "image/png", png_bytes[:-12])],
                    )
                    trunc_st, _, _ = fetch(
                        base_url,
                        "/api/comments",
                        local=True,
                        method="POST",
                        headers={"Content-Type": ct_trunc},
                        body=body_trunc,
                    )
                    if trunc_st != 400:
                        errors.append(f"POST /api/comments (truncated PNG): expected 400, got {trunc_st}")

                    # Reject > 3 images
                    ct_many, body_many = _build_multipart(
                        {"slug": lead_slug, "lang": "zh", "body": "Too many images"},
                        [(f"p{i}.png", "image/png", png_bytes) for i in range(4)],
                    )
                    many_st, _, _ = fetch(
                        base_url,
                        "/api/comments",
                        local=True,
                        method="POST",
                        headers={"Content-Type": ct_many},
                        body=body_many,
                    )
                    if many_st != 400:
                        errors.append(f"POST /api/comments (>3 images): expected 400, got {many_st}")

                    # Valid image-only parent comment (empty text body + 1 PNG + alt text) with PoW
                    ct_ok, body_ok = _build_multipart(
                        {
                            "slug": lead_slug,
                            "lang": "en",
                            "authorName": "Photo Reader",
                            "body": "",
                            "imageAlts": ["Blue test square"],
                            "gateToken": g2_tok,
                            "powNonce": _solve_pow_local(g2_tok, g2_bits),
                            "fallbackMode": True,
                        },
                        [("shot.png", "image/png", png_bytes)],
                    )
                    img_post_st, _, img_post_body = fetch(
                        base_url,
                        "/api/comments",
                        local=True,
                        method="POST",
                        headers={"Content-Type": ct_ok},
                        body=body_ok,
                    )
                    if img_post_st != 201:
                        errors.append(
                            f"POST /api/comments (image-only multipart): expected 201, got {img_post_st} ({img_post_body.decode('utf-8', 'replace')})"
                        )
                    else:
                        img_created = json.loads(img_post_body.decode("utf-8"))
                        img_cid = img_created.get("comment", {}).get("id", "")
                        imgs = img_created.get("comment", {}).get("images") or []
                        next_gate = img_created.get("nextGate") or {}
                        if (
                            len(imgs) != 1
                            or imgs[0].get("width") != 3
                            or imgs[0].get("height") != 2
                            or imgs[0].get("alt") != "Blue test square"
                        ):
                            errors.append(f"POST /api/comments (image metadata): unexpected {imgs!r}")
                        else:
                            img_url = str(imgs[0].get("url") or "")
                            get_img_st, img_hdrs, img_raw = fetch(base_url, img_url, local=True)
                            if get_img_st != 200 or img_raw != png_bytes:
                                errors.append(f"GET {img_url}: expected 200 with exact PNG bytes, got {get_img_st}")
                            else:
                                if img_hdrs.get("content-type", "").lower() != "image/png":
                                    errors.append(f"GET {img_url}: unexpected Content-Type {img_hdrs.get('content-type')!r}")
                                if "sandbox" not in img_hdrs.get("content-security-policy", "").lower():
                                    errors.append(f"GET {img_url}: missing sandbox CSP ({img_hdrs.get('content-security-policy')!r})")
                                if img_hdrs.get("x-content-type-options", "").lower() != "nosniff":
                                    errors.append(f"GET {img_url}: missing X-Content-Type-Options: nosniff")
                                if img_hdrs.get("cross-origin-resource-policy", "").lower() != "same-origin":
                                    errors.append(f"GET {img_url}: missing CORP same-origin")
                                if "no-cache" not in img_hdrs.get("cache-control", "").lower():
                                    errors.append(f"GET {img_url}: expected revalidating Cache-Control, got {img_hdrs.get('cache-control')!r}")
                                etag = img_hdrs.get("etag", "")
                                if not etag:
                                    errors.append(f"GET {img_url}: missing ETag header")
                                else:
                                    st_304, _, _ = fetch(
                                        base_url, img_url, local=True, headers={"If-None-Match": etag}
                                    )
                                    if st_304 != 304:
                                        errors.append(f"GET {img_url} (If-None-Match): expected 304, got {st_304}")
                                head_st, head_hdrs, head_raw = fetch(base_url, img_url, local=True, method="HEAD")
                                if head_st != 200 or head_raw != b"" or head_hdrs.get("content-length") != str(len(png_bytes)):
                                    errors.append(f"HEAD {img_url}: expected 200 empty body with exact Content-Length, got {head_st}")

                            # Post an image-bearing reply under that parent and verify parent deletion cascades to both images (strictly asserted)
                            reply_img_url = ""
                            r_png = _make_minimal_png(4, 3)
                            r_tok = str(next_gate.get("token") or "")
                            r_bits = int(next_gate.get("fallbackPowBits") or 14)
                            if not r_tok:
                                g3_st, _, g3_body = fetch(
                                    base_url, f"/api/comments?slug={urllib.parse.quote(lead_slug)}", local=True
                                )
                                g3_gate = (json.loads(g3_body.decode("utf-8")).get("gate") or {}) if g3_st == 200 else {}
                                r_tok = str(g3_gate.get("token") or "")
                                r_bits = int(g3_gate.get("fallbackPowBits") or 14)
                            if not r_tok:
                                errors.append("POST /api/comments (image reply): missing gate token for reply step")
                            else:
                                ct_rep, body_rep = _build_multipart(
                                    {
                                        "slug": lead_slug,
                                        "lang": "en",
                                        "parentId": img_cid,
                                        "body": "Reply with attachment",
                                        "gateToken": r_tok,
                                        "powNonce": _solve_pow_local(r_tok, r_bits),
                                        "fallbackMode": True,
                                    },
                                    [("reply.png", "image/png", r_png)],
                                )
                                rep_st, _, rep_body = fetch(
                                    base_url,
                                    "/api/comments",
                                    local=True,
                                    method="POST",
                                    headers={"Content-Type": ct_rep},
                                    body=body_rep,
                                )
                                if rep_st != 201:
                                    errors.append(f"POST /api/comments (image reply): expected 201, got {rep_st}")
                                else:
                                    rep_imgs = json.loads(rep_body.decode("utf-8")).get("comment", {}).get("images") or []
                                    if len(rep_imgs) != 1 or not str(rep_imgs[0].get("url") or "").strip():
                                        errors.append(f"POST /api/comments (image reply): expected 1 reply image URL, got {rep_imgs!r}")
                                    else:
                                        reply_img_url = str(rep_imgs[0]["url"])
                                        rep_get_st, _, rep_get_raw = fetch(base_url, reply_img_url, local=True)
                                        if rep_get_st != 200 or rep_get_raw != r_png:
                                            errors.append(
                                                f"GET {reply_img_url} before parent delete: expected 200 with exact PNG bytes, got {rep_get_st}"
                                            )

                            # Cascade delete hides & removes both parent and reply images immediately
                            del_img_st, _, _ = fetch(
                                base_url,
                                f"/api/comments/{urllib.parse.quote(img_cid)}",
                                local=True,
                                method="DELETE",
                                headers={"X-Author-Key": "smoke-test-author-key"},
                            )
                            if del_img_st != 200:
                                errors.append(f"DELETE /api/comments/{img_cid}: expected 200, got {del_img_st}")
                            else:
                                gone_st, _, _ = fetch(base_url, img_url, local=True)
                                if gone_st != 404:
                                    errors.append(f"GET {img_url} after parent delete: expected 404, got {gone_st}")
                                if not reply_img_url:
                                    errors.append("DELETE cascade verification: reply image was never created to verify 404 cascade")
                                else:
                                    rep_gone_st, _, _ = fetch(base_url, reply_img_url, local=True)
                                    if rep_gone_st != 404:
                                        errors.append(f"GET {reply_img_url} after parent delete: expected 404, got {rep_gone_st}")

    return errors


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="HTTP contract smoke test for local & live deployments")
    parser.add_argument("--site", required=True, help="Site name under sites/ (e.g. demo, prod)")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--local", action="store_true", help="Spawn local preview_server.py and test against it")
    group.add_argument("--base-url", help="Live base URL to smoke-test (e.g. https://www.esoren.com)")
    parser.add_argument("--dist", help="With --local: serve a staged flat directory (e.g. .dist/demo)")
    parser.add_argument(
        "--expect-dist",
        help="Verify live or local responses match the staged bundle's api/release.json and api/posts.json",
    )
    parser.add_argument("--retries", type=int, default=1, help="Number of attempts (useful for live edge propagation)")
    parser.add_argument("--retry-delay", type=float, default=5.0, help="Seconds between retries")
    args = parser.parse_args(argv)

    catalog_path = SITES_DIR / args.site / "catalog.json"
    if not catalog_path.is_file():
        print(f"[smoke_test] ERROR: missing {catalog_path}")
        return 2
    catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    stream_path = SITES_DIR / args.site / "stream.json"
    stream_data = json.loads(stream_path.read_text(encoding="utf-8")) if stream_path.is_file() else None
    expect_comment_images = False
    registry_path = SITES_DIR / "sites.json"
    if registry_path.is_file():
        registry = json.loads(registry_path.read_text(encoding="utf-8"))
        site_reg = (registry.get("sites") or {}).get(args.site) or {}
        comments_reg = site_reg.get("comments") or {}
        r2_name = comments_reg.get("r2_bucket_name")
        expect_comment_images = isinstance(r2_name, str) and bool(r2_name.strip())

    expect_dist: Path | None = None
    if args.expect_dist:
        expect_dist = Path(args.expect_dist).resolve()
    elif args.local and args.dist:
        expect_dist = Path(args.dist).resolve()

    server_proc: subprocess.Popen[str] | None = None
    try:
        if args.local:
            port = pick_free_port()
            target_url = f"http://127.0.0.1:{port}"
            cmd = [
                sys.executable,
                str(ROOT / "tools" / "preview_server.py"),
                "--host",
                "127.0.0.1",
                "--port",
                str(port),
                "--ephemeral-db",
                "--min-dwell-ms",
                "0",
                "--quiet",
            ]
            if args.dist:
                cmd.extend(["--dir", args.dist])
            else:
                cmd.extend(["--site", args.site])
            child_env = os.environ.copy()
            child_env["TI_LOCAL_AUTHOR_KEY"] = "smoke-test-author-key"
            server_proc = subprocess.Popen(
                cmd,
                env=child_env,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            wait_for_server(target_url)
        else:
            target_url = args.base_url.rstrip("/")

        attempts = max(1, args.retries)
        errors: list[str] = []
        for attempt in range(1, attempts + 1):
            try:
                errors = run_suite(
                    target_url,
                    catalog,
                    stream_data=stream_data,
                    local=args.local,
                    expect_dist=expect_dist,
                    expect_comment_images=expect_comment_images,
                )
            except Exception as exc:
                errors = [f"Request failure against {target_url}: {exc}"]
            if not errors:
                print(
                    f"[smoke_test:{args.site}] PASSED against {target_url} "
                    f"(attempt {attempt}/{attempts}, {len(catalog['posts'])} bilingual issues verified)."
                )
                return 0
            if attempt < attempts:
                print(
                    f"[smoke_test:{args.site}] Attempt {attempt}/{attempts} found {len(errors)} issue(s); "
                    f"retrying in {args.retry_delay:.0f}s..."
                )
                time.sleep(args.retry_delay)

        print(f"[smoke_test:{args.site}] FAILED against {target_url} ({len(errors)} issue(s)):")
        for err in errors:
            print(f"  - {err}")
        return 1
    finally:
        if server_proc is not None:
            server_proc.terminate()
            try:
                server_proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                server_proc.kill()


if __name__ == "__main__":
    raise SystemExit(main())
