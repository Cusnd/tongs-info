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
import json
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SITES_DIR = ROOT / "sites"


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


REMOTE_OPENER = urllib.request.build_opener(NoRedirect())
LOCAL_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())


def fetch(base_url: str, path: str, timeout: float = 15.0, *, local: bool = False) -> tuple[int, dict[str, str], bytes]:
    url = base_url.rstrip("/") + path
    req = urllib.request.Request(
        url,
        headers={"User-Agent": "TongsInformation-SmokeTest/1.0"},
        method="GET",
    )
    opener = LOCAL_OPENER if local else REMOTE_OPENER
    try:
        with opener.open(req, timeout=timeout) as resp:
            headers = {k.lower(): v for k, v in resp.headers.items()}
            return resp.status, headers, resp.read()
    except urllib.error.HTTPError as exc:
        headers = {k.lower(): v for k, v in exc.headers.items()}
        body = exc.read()
        return exc.code, headers, body


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
    local: bool = False,
    expect_dist: Path | None = None,
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
        "/graph/",
        "/en/graph/",
        "/about/",
        "/en/about/",
    ]
    for path in core_pages:
        status, hdrs, body = fetch(base_url, path, local=local)
        if status != 200:
            errors.append(f"GET {path}: expected 200, got {status}")
            continue
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
        "/assets/js/site.js",
        "/assets/js/transitions.js",
        "/assets/js/graph.js",
        "/assets/js/cover-model.js",
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
    for path in ("/api/posts.json", "/api/graph.json", "/feed.json", "/en/feed.json"):
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

    for path in ("/rss.xml", "/en/rss.xml", "/sitemap.xml"):
        status, hdrs, body = fetch(base_url, path, local=local)
        if status != 200:
            errors.append(f"GET {path}: expected 200, got {status}")
            continue
        ct = hdrs.get("content-type", "").lower()
        if "charset=utf-8" not in ct:
            errors.append(f"GET {path}: missing charset=utf-8 in Content-Type ({ct!r})")
        try:
            ET.fromstring(body.decode("utf-8"))
        except Exception as exc:
            errors.append(f"GET {path}: invalid XML ({exc})")

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

        # Verify lead post HTML & Markdown twin exact byte parity using the already-verified responses
        if catalog["posts"]:
            lead = catalog["posts"][0]
            for lang in ("zh", "en"):
                loc = lead[lang]
                staged_html = expect_dist / loc["url"].lstrip("/") / "index.html"
                if staged_html.is_file():
                    if loc["url"] not in fetched_bodies:
                        errors.append(f"GET {loc['url']}: missing live HTML response for byte parity check")
                    elif fetched_bodies[loc["url"]] != staged_html.read_bytes():
                        errors.append(f"GET {loc['url']}: live HTML bytes differ from staged bundle")
                staged_md = expect_dist / loc["md_url"].lstrip("/")
                if staged_md.is_file():
                    if loc["md_url"] not in fetched_bodies:
                        errors.append(f"GET {loc['md_url']}: missing live Markdown response for byte parity check")
                    elif fetched_bodies[loc["md_url"]] != staged_md.read_bytes():
                        errors.append(f"GET {loc['md_url']}: live Markdown bytes differ from staged bundle")

    # 7. Security & localized 404 behavior
    for forbidden in ("/_headers", "/%5fheaders"):
        status, _, _ = fetch(base_url, forbidden, local=local)
        if status != 404:
            errors.append(f"GET {forbidden}: expected 404 (never exposed publicly), got {status}")

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
                "--quiet",
            ]
            if args.dist:
                cmd.extend(["--dir", args.dist])
            else:
                cmd.extend(["--site", args.site])
            server_proc = subprocess.Popen(
                cmd,
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
                errors = run_suite(target_url, catalog, local=args.local, expect_dist=expect_dist)
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
