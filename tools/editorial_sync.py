#!/usr/bin/env python3
"""
Tong's Information — Deterministic Multi-Site Editorial Sync, Audit Gate & Dist Stager
Zero third-party dependencies (Python 3.10+ stdlib only).

Layout:
  engine/                     Shared static engine (_headers, assets/css, assets/js, favicon.svg)
  editorial/partials/         Shared header/footer HTML partials (hydrated from each site's catalog.json)
  sites/sites.json            Version-controlled site -> Worker / Preview Worker / base_url registry
  sites/<site>/catalog.json   Site metadata, concepts, and bilingual issue catalog
  sites/<site>/sources/       Raw bilingual Markdown manuscripts
  sites/<site>/public/        Site HTML pages, site-specific images, and derived machine artifacts
  .dist/<site>/               Ephemeral staged flat directory (engine/ + sites/<site>/public/ + api/release.json)

Usage:
  python tools/editorial_sync.py                           # Sync & audit all sites under sites/
  python tools/editorial_sync.py --site prod               # Sync & audit sites/prod
  python tools/editorial_sync.py --all --check             # Read-only CI release gate across all sites
  python tools/editorial_sync.py --site demo --check --stage
  python tools/editorial_sync.py --site prod --check --stage --expect-base-url https://www.esoren.com
"""

from __future__ import annotations

import argparse
import contextlib
import datetime as dt
import email.utils
import hashlib
import html as html_lib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import xml.etree.ElementTree as ET
from html.parser import HTMLParser
from pathlib import Path
from typing import Iterator
from xml.sax.saxutils import escape as xml_escape

if os.name == "nt":
    import msvcrt
else:
    import fcntl

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _headers_eval import evaluate_headers_map, parse_headers_text

ROOT = Path(__file__).resolve().parent.parent
ENGINE_DIR = ROOT / "engine"
SITES_DIR = ROOT / "sites"
REGISTRY_PATH = SITES_DIR / "sites.json"
DIST_DIR = ROOT / ".dist"
PARTIALS_DIR = ROOT / "editorial" / "partials"

HEADER_RE = re.compile(
    r"(<!-- @partial:header -->)(.*?)(<!-- @endpartial:header -->)",
    re.DOTALL,
)
FOOTER_RE = re.compile(
    r"(<!-- @partial:footer -->)(.*?)(<!-- @endpartial:footer -->)",
    re.DOTALL,
)
STREAM_RE = re.compile(
    r"(<!-- @partial:stream -->)(.*?)(<!-- @endpartial:stream -->)",
    re.DOTALL,
)
STREAM_COUNT_RE = re.compile(
    r"(<!-- @partial:stream-count -->)(.*?)(<!-- @endpartial:stream-count -->)",
    re.DOTALL,
)
INLINE_VT_OPTIN_RE = re.compile(
    r"<head\b[^>]*>.*?<style[^>]*>[^<]*@media\s*\(\s*prefers-reduced-motion\s*:\s*no-preference\s*\)\s*\{\s*@view-transition\s*\{\s*navigation\s*:\s*auto\s*;?\s*\}\s*\}[^<]*</style>.*?</head>",
    re.DOTALL | re.IGNORECASE,
)
SITE_NAME_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
CONCEPT_ID_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
SLUG_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
ISO_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
STREAM_ID_RE = re.compile(r"^[0-9]{3,4}$")
HHMM_RE = re.compile(r"^(?:[01]\d|2[0-3]):[0-5]\d$")
INLINE_CODE_RE = re.compile(r"`([^`\n]+)`")
STREAM_KINDS: dict[str, dict[str, str]] = {
    "musing": {"zh": "随想", "en": "Musing"},
    "quote": {"zh": "摘录", "en": "Quote"},
    "question": {"zh": "待解", "en": "Question"},
    "snippet": {"zh": "切片", "en": "Snippet"},
}
STREAM_KIND_ORDER = ("musing", "quote", "question", "snippet")
CSS_URL_RE = re.compile(r"""url\(\s*(?:(['"])(.*?)\1|([^)"'\s]+))\s*\)""")
JS_FETCH_RE = re.compile(r"""\bfetch\(\s*(['"])(/[^'"?#]+)[^'"]*\1""")
RESERVED_OUTPUT_NAMES = {"_headers", "_redirects"}
DYNAMIC_WORKER_API_PREFIXES = ("/api/comments",)


def is_link_or_junction(path: Path) -> bool:
    if path.is_symlink():
        return True
    isjunction = getattr(os.path, "isjunction", None)
    if isjunction is not None:
        try:
            return bool(isjunction(path))
        except OSError:
            return False
    if os.name == "nt":
        try:
            attrs = getattr(os.lstat(path), "st_file_attributes", 0)
            return bool(attrs & 0x400)  # FILE_ATTRIBUTE_REPARSE_POINT (junctions/symlinks on Python 3.10-3.11)
        except OSError:
            return False
    return False


def assert_contained_no_links(target: Path, allowed_root: Path, *, label: str) -> Path:
    """Verify target stays strictly inside allowed_root and traverses no symlinks or junctions."""
    if is_link_or_junction(allowed_root):
        raise ValueError(f"{label}: root directory itself is a symlink/junction ({allowed_root})")
    for ancestor in allowed_root.parents:
        if is_link_or_junction(ancestor):
            raise ValueError(f"{label}: root ancestor is a symlink/junction ({ancestor})")

    root_res = allowed_root.resolve()
    cur = allowed_root
    rel = target.relative_to(allowed_root) if target.is_relative_to(allowed_root) else None
    if rel is None:
        raise ValueError(f"{label}: path '{target}' is outside '{allowed_root}'")

    for part in rel.parts:
        cur = cur / part
        if is_link_or_junction(cur):
            raise ValueError(f"{label}: path traverses symlink/junction '{cur}'")

    target_res = target.resolve()
    try:
        target_res.relative_to(root_res)
    except ValueError as exc:
        raise ValueError(f"{label}: resolved path '{target_res}' escapes '{root_res}'") from exc
    return target_res


def read_utf8_exact(path: Path) -> str:
    """Read raw UTF-8 bytes without universal-newline normalization so CRLF drift is detected."""
    return path.read_bytes().decode("utf-8")


@contextlib.contextmanager
def file_lock(lock_path: Path, *, timeout_sec: float = 60.0) -> Iterator[None]:
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with open(lock_path, "a+b") as fh:
        fh.seek(0)
        if os.name == "nt":
            fh.write(b"\0")
            fh.flush()
            deadline = time.monotonic() + timeout_sec
            while True:
                fh.seek(0)
                try:
                    msvcrt.locking(fh.fileno(), msvcrt.LK_NBLCK, 1)
                    break
                except OSError:
                    if time.monotonic() >= deadline:
                        raise TimeoutError(f"Timed out waiting for lock {lock_path} after {timeout_sec:.0f}s")
                    time.sleep(0.2)
            try:
                yield
            finally:
                fh.seek(0)
                msvcrt.locking(fh.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            fcntl.flock(fh.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(fh.fileno(), fcntl.LOCK_UN)


def html_text_escape(value: str) -> str:
    """Escape HTML text content while keeping ASCII apostrophes clean for CJK/Latin typography."""
    return html_lib.escape(str(value), quote=False)


def html_attr_escape(value: str) -> str:
    """Escape a double-quoted HTML attribute value."""
    return html_lib.escape(str(value), quote=False).replace('"', "&quot;")


def load_site_registry() -> dict[str, dict]:
    if not REGISTRY_PATH.is_file():
        return {}
    raw = json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))
    sites = raw.get("sites", {})
    if not isinstance(sites, dict):
        raise ValueError("sites/sites.json: 'sites' must be an object")
    return sites


def discover_sites() -> list[str]:
    if not SITES_DIR.is_dir():
        return []
    found: list[str] = []
    for entry in sorted(SITES_DIR.iterdir()):
        if entry.is_dir() and SITE_NAME_RE.match(entry.name) and (entry / "catalog.json").is_file():
            found.append(entry.name)
    return found


def site_paths(site_name: str) -> tuple[Path, Path, Path]:
    site_root = SITES_DIR / site_name
    catalog_path = site_root / "catalog.json"
    public_dir = site_root / "public"
    return site_root, catalog_path, public_dir


def rel_url_from_html(html_path: Path, public_dir: Path) -> str:
    rel = html_path.relative_to(public_dir).as_posix()
    if rel == "index.html":
        return "/"
    if rel.endswith("/index.html"):
        return "/" + rel[: -len("index.html")]
    return "/" + rel


def detect_lang(url_path: str, content: str) -> str:
    if url_path == "/en/" or url_path.startswith("/en/"):
        return "en"
    if re.search(r'<html[^>]+lang="en"', content, re.IGNORECASE):
        return "en"
    return "zh"


def counterpart_url(url_path: str, lang: str) -> str:
    if url_path == "/404.html":
        return "/en/404.html"
    if url_path == "/en/404.html":
        return "/404.html"
    if lang == "en":
        if url_path == "/en/":
            return "/"
        return url_path[3:] if url_path.startswith("/en/") else "/"
    if url_path == "/":
        return "/en/"
    return "/en" + url_path


def nav_section(url_path: str) -> str:
    norm = url_path[3:] if url_path.startswith("/en/") else url_path
    if norm in ("/", ""):
        return "home"
    if norm.startswith("/archive/"):
        return "archive"
    if norm.startswith("/stream/"):
        return "stream"
    if norm.startswith("/graph/"):
        return "graph"
    if norm.startswith("/about/"):
        return "about"
    return ""


def compute_issue_order(catalog: dict) -> dict[str, int]:
    order: dict[str, int] = {}
    posts = catalog.get("posts", [])
    total = len(posts)
    for idx, p in enumerate(posts):
        slug = str(p["slug"])
        raw_no = str(p.get("issue_no", "")).strip()
        try:
            order_num = int(raw_no)
        except ValueError:
            order_num = total - idx
        order[slug] = order_num
    return order


def render_partial(template: str, url_path: str, lang: str, catalog: dict) -> str:
    section = nav_section(url_path)
    site_meta = catalog["site"]
    site_name = str(site_meta["name"])
    site_author = str(site_meta["author"])
    founded = str(site_meta.get("founded", "2026"))
    issue_order_json = json.dumps(compute_issue_order(catalog), ensure_ascii=False, separators=(",", ":"))

    replacements = {
        "{{LANG_SWITCH_HREF}}": counterpart_url(url_path, lang),
        "{{CURRENT_HOME}}": ' aria-current="page"' if section == "home" else "",
        "{{CURRENT_ARCHIVE}}": ' aria-current="page"' if section == "archive" else "",
        "{{CURRENT_STREAM}}": ' aria-current="page"' if section == "stream" else "",
        "{{CURRENT_GRAPH}}": ' aria-current="page"' if section == "graph" else "",
        "{{CURRENT_ABOUT}}": ' aria-current="page"' if section == "about" else "",
        "{{SITE_NAME_HTML}}": html_text_escape(site_name),
        "{{SITE_NAME_ATTR}}": html_attr_escape(site_name),
        "{{SITE_AUTHOR_ATTR}}": html_attr_escape(site_author),
        "{{ISSUE_ORDER_ATTR}}": html_attr_escape(issue_order_json),
        "{{FOUNDED}}": html_text_escape(founded),
    }
    out = template
    for key, val in replacements.items():
        out = out.replace(key, val)
    return out.strip()


def load_partials() -> dict[tuple[str, str], str]:
    return {
        ("header", "zh"): read_utf8_exact(PARTIALS_DIR / "header.zh.html").replace("\r\n", "\n"),
        ("header", "en"): read_utf8_exact(PARTIALS_DIR / "header.en.html").replace("\r\n", "\n"),
        ("footer", "zh"): read_utf8_exact(PARTIALS_DIR / "footer.zh.html").replace("\r\n", "\n"),
        ("footer", "en"): read_utf8_exact(PARTIALS_DIR / "footer.en.html").replace("\r\n", "\n"),
    }


def apply_partials_to_html(
    raw: str,
    url_path: str,
    partials: dict[tuple[str, str], str],
    catalog: dict,
    stream_data: dict | None = None,
) -> str:
    lang = detect_lang(url_path, raw)
    header_html = render_partial(partials[("header", lang)], url_path, lang, catalog)
    footer_html = render_partial(partials[("footer", lang)], url_path, lang, catalog)
    new_content = HEADER_RE.sub(
        lambda m: f"{m.group(1)}\n{header_html}\n  {m.group(3)}",
        raw,
    )
    if stream_data is not None and STREAM_COUNT_RE.search(new_content):
        total_stream = len(stream_data["entries"])
        count_text = f"{total_stream} / {total_stream} notes" if lang == "en" else f"显示 {total_stream} / {total_stream} 条"
        new_content = STREAM_COUNT_RE.sub(
            lambda m: f"{m.group(1)}{count_text}{m.group(3)}",
            new_content,
        )
    if stream_data is not None and STREAM_RE.search(new_content):
        stream_html = render_stream_partial(stream_data, catalog, lang)
        new_content = STREAM_RE.sub(
            lambda m: f"{m.group(1)}\n{stream_html}\n    {m.group(3)}",
            new_content,
        )
    new_content = FOOTER_RE.sub(
        lambda m: f"{m.group(1)}\n{footer_html}\n  {m.group(3)}",
        new_content,
    )
    return new_content


def expected_post_routes(slug: str, lang: str) -> tuple[str, str]:
    if lang == "en":
        return f"/en/posts/{slug}/", f"/en/posts/{slug}/index.md"
    return f"/posts/{slug}/", f"/posts/{slug}/index.md"


def validate_catalog(
    site_name: str,
    catalog: dict,
    site_root: Path,
    public_dir: Path,
    expect_base_url: str | None = None,
) -> list[str]:
    errors: list[str] = []
    site = catalog.get("site")
    if not isinstance(site, dict):
        return ["catalog.json: missing 'site' object"]
    base_url = str(site.get("base_url", "")).strip()
    if not base_url.startswith(("https://", "http://")):
        errors.append(f"catalog.json: invalid site.base_url '{base_url}'")

    # Cross-check against sites/sites.json registry if present
    registry = load_site_registry()
    if site_name in registry:
        reg_entry = registry[site_name]
        reg_base = str(reg_entry.get("base_url", "")).strip().rstrip("/")
        if reg_base and base_url.rstrip("/") != reg_base:
            errors.append(
                f"Registry mismatch: sites/sites.json declares base_url='{reg_base}' for '{site_name}', "
                f"but catalog.json has '{base_url.rstrip('/')}'"
            )
        all_rel_workers = {
            str(other.get("worker_name", "")).strip()
            for other in registry.values()
            if isinstance(other, dict)
        } - {""}
        preview_worker = str(reg_entry.get("preview_worker_name", "")).strip()
        if preview_worker and preview_worker in all_rel_workers:
            errors.append(
                f"sites/sites.json: site '{site_name}' preview_worker_name '{preview_worker}' "
                "must not match any release worker_name"
            )
        comments_cfg = reg_entry.get("comments")
        if isinstance(comments_cfg, dict) and comments_cfg.get("enabled"):
            d1_id = comments_cfg.get("d1_database_id")
            if not isinstance(d1_id, str) or not d1_id.strip():
                errors.append(f"sites/sites.json: site '{site_name}' comments enabled but missing d1_database_id")
            for bkey in ("r2_bucket_name", "preview_r2_bucket_name"):
                r2_bucket = comments_cfg.get(bkey)
                if r2_bucket is not None:
                    if not isinstance(r2_bucket, str) or not re.match(r"^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$", r2_bucket.strip()):
                        errors.append(
                            f"sites/sites.json: site '{site_name}' comments.{bkey} {r2_bucket!r} must be a valid R2 bucket name string or null"
                        )
            all_rel_d1_ids = {
                str((other.get("comments") or {}).get("d1_database_id") or "").strip()
                for other in registry.values()
                if isinstance(other.get("comments"), dict)
            } - {""}
            all_rel_d1_names = {
                str((other.get("comments") or {}).get("d1_database_name") or "").strip()
                for other in registry.values()
                if isinstance(other.get("comments"), dict)
            } - {""}
            all_rel_r2 = {
                str((other.get("comments") or {}).get("r2_bucket_name") or "").strip()
                for other in registry.values()
                if isinstance(other.get("comments"), dict)
                and isinstance((other.get("comments") or {}).get("r2_bucket_name"), str)
            } - {""}

            p_d1_id = comments_cfg.get("preview_d1_database_id")
            if p_d1_id is not None:
                if not isinstance(p_d1_id, str) or not p_d1_id.strip():
                    errors.append(f"sites/sites.json: site '{site_name}' comments.preview_d1_database_id must be a non-empty string or null")
                elif p_d1_id.strip() in all_rel_d1_ids:
                    errors.append(f"sites/sites.json: site '{site_name}' preview_d1_database_id must not match any release d1_database_id")
            p_d1_name = comments_cfg.get("preview_d1_database_name")
            if p_d1_name is not None:
                if not isinstance(p_d1_name, str) or not p_d1_name.strip():
                    errors.append(f"sites/sites.json: site '{site_name}' comments.preview_d1_database_name must be a non-empty string or null")
                elif p_d1_name.strip() in all_rel_d1_names:
                    errors.append(f"sites/sites.json: site '{site_name}' preview_d1_database_name must not match any release d1_database_name")
            p_r2 = comments_cfg.get("preview_r2_bucket_name")
            if isinstance(p_r2, str) and p_r2.strip() and p_r2.strip() in all_rel_r2:
                errors.append(f"sites/sites.json: site '{site_name}' preview_r2_bucket_name must not match any release r2_bucket_name")
            if not str(comments_cfg.get("turnstile_sitekey", "")).strip():
                errors.append(f"sites/sites.json: site '{site_name}' comments enabled but missing turnstile_sitekey")
            hosts = comments_cfg.get("allowed_hostnames")
            if not isinstance(hosts, list) or not hosts:
                errors.append(f"sites/sites.json: site '{site_name}' comments enabled but missing allowed_hostnames")
            else:
                for h in hosts:
                    hl = str(h).strip().lower()
                    if hl in ("localhost", "127.0.0.1", "::1"):
                        errors.append(
                            f"sites/sites.json: production allowed_hostnames for '{site_name}' must not include '{hl}'"
                        )

    if expect_base_url is not None:
        expected_norm = expect_base_url.strip().rstrip("/")
        actual_norm = base_url.rstrip("/")
        if actual_norm != expected_norm:
            errors.append(
                f"Domain mismatch guard failed: catalog site.base_url is '{actual_norm}', "
                f"expected '{expected_norm}'"
            )

    for req_site_key in ("name", "author"):
        if not str(site.get(req_site_key, "")).strip():
            errors.append(f"catalog.json: site.{req_site_key} must be non-empty")

    concepts = catalog.get("concepts")
    if not isinstance(concepts, list) or not concepts:
        errors.append("catalog.json: 'concepts' must be a non-empty list")
        concept_ids: set[str] = set()
    else:
        concept_ids = set()
        for idx, c in enumerate(concepts):
            cid = str(c.get("id", ""))
            if not CONCEPT_ID_RE.match(cid):
                errors.append(f"catalog.json: concepts[{idx}].id '{cid}' must match {CONCEPT_ID_RE.pattern}")
            elif cid in concept_ids:
                errors.append(f"catalog.json: duplicate concept id '{cid}'")
            else:
                concept_ids.add(cid)
            if not str(c.get("zh", "")).strip() or not str(c.get("en", "")).strip():
                errors.append(f"catalog.json: concept '{cid}' missing zh/en display label")

    posts = catalog.get("posts")
    if not isinstance(posts, list) or not posts:
        errors.append("catalog.json: 'posts' must be a non-empty list")
        return errors

    seen_slugs: set[str] = set()
    seen_issues: set[str] = set()
    seen_destinations: set[Path] = set()
    for idx, p in enumerate(posts):
        slug = str(p.get("slug", ""))
        issue_no = str(p.get("issue_no", ""))
        tier = str(p.get("tier", ""))
        if not SLUG_RE.match(slug):
            errors.append(f"catalog.json: posts[{idx}].slug '{slug}' is invalid")
        elif slug in seen_slugs:
            errors.append(f"catalog.json: duplicate post slug '{slug}'")
        else:
            seen_slugs.add(slug)

        if not issue_no.strip():
            errors.append(f"catalog.json: post '{slug}' missing issue_no")
        elif issue_no in seen_issues:
            errors.append(f"catalog.json: duplicate issue_no '{issue_no}'")
        else:
            seen_issues.add(issue_no)

        if tier not in ("essay", "feature"):
            errors.append(f"catalog.json: post '{slug}' has invalid tier '{tier}'")

        for field in ("date", "updated"):
            val = str(p.get(field, ""))
            if not ISO_DATE_RE.match(val):
                errors.append(f"catalog.json: post '{slug}' invalid {field} '{val}'")
            else:
                try:
                    dt.date.fromisoformat(val)
                except ValueError:
                    errors.append(f"catalog.json: post '{slug}' non-existent calendar {field} '{val}'")

        p_concepts = p.get("concepts", [])
        if not isinstance(p_concepts, list) or not p_concepts:
            errors.append(f"catalog.json: post '{slug}' must declare at least one concept")
        else:
            for cid in p_concepts:
                if not isinstance(cid, str) or cid not in concept_ids:
                    errors.append(f"catalog.json: post '{slug}' references undeclared concept '{cid}'")

        for lang in ("zh", "en"):
            loc = p.get(lang)
            if not isinstance(loc, dict):
                errors.append(f"catalog.json: post '{slug}' missing '{lang}' object")
                continue
            for req_key in ("title", "summary", "source", "url", "md_url"):
                if not str(loc.get(req_key, "")).strip():
                    errors.append(f"catalog.json: post '{slug}'.{lang} missing '{req_key}'")

            # B2: Require canonical url & md_url strictly derived from (lang, slug) and contained inside public_dir
            if SLUG_RE.match(slug):
                exp_url, exp_md_url = expected_post_routes(slug, lang)
                if loc.get("url") != exp_url:
                    errors.append(
                        f"catalog.json: post '{slug}'.{lang}.url must be '{exp_url}' (got {loc.get('url')!r})"
                    )
                if loc.get("md_url") != exp_md_url:
                    errors.append(
                        f"catalog.json: post '{slug}'.{lang}.md_url must be '{exp_md_url}' (got {loc.get('md_url')!r})"
                    )
                else:
                    dest_md = public_dir / exp_md_url.lstrip("/")
                    try:
                        dest_res = assert_contained_no_links(dest_md, public_dir, label=f"post '{slug}'.{lang}.md_url")
                    except ValueError as exc:
                        errors.append(f"catalog.json: {exc}")
                    else:
                        if dest_md.name.lower() in RESERVED_OUTPUT_NAMES:
                            errors.append(f"catalog.json: post '{slug}'.{lang}.md_url targets reserved file")
                        elif dest_res in seen_destinations:
                            errors.append(f"catalog.json: duplicate Markdown destination '{dest_md}'")
                        else:
                            seen_destinations.add(dest_res)

            src_rel = str(loc.get("source", "")).strip()
            if src_rel:
                src_candidate = site_root / src_rel
                try:
                    src_path = assert_contained_no_links(src_candidate, site_root, label=f"post '{slug}'.{lang}.source")
                except ValueError as exc:
                    errors.append(f"catalog.json: {exc}")
                    continue
                if not src_path.is_file():
                    errors.append(f"catalog.json: missing source manuscript '{src_rel}'")
                else:
                    try:
                        src_path.read_text(encoding="utf-8")
                    except UnicodeDecodeError as exc:
                        errors.append(f"catalog.json: source '{src_rel}' is not valid UTF-8 ({exc})")

    return errors


def yaml_quote(text: str) -> str:
    """Produce a YAML 1.2 double-quoted scalar safely escaping quotes, backslashes, and control chars."""
    return json.dumps(str(text), ensure_ascii=False)


def parse_frontmatter_strict(md_text: str) -> tuple[dict[str, object], str]:
    """Parse our deterministic YAML frontmatter block and validate types without third-party deps."""
    if not md_text.startswith("---\n"):
        raise ValueError("missing opening '---\\n' LF frontmatter fence")
    end_idx = md_text.find("\n---\n", 4)
    if end_idx == -1:
        raise ValueError("missing closing '\\n---\\n' LF frontmatter fence")
    block = md_text[4:end_idx]
    body = md_text[end_idx + 5 :]
    parsed: dict[str, object] = {}
    for line in block.splitlines():
        if ":" not in line:
            raise ValueError(f"malformed frontmatter line: {line!r}")
        key, raw_val = line.split(":", 1)
        key = key.strip()
        raw_val = raw_val.strip()
        if raw_val.startswith("[") and raw_val.endswith("]"):
            val = json.loads(raw_val)
            if not isinstance(val, list) or not all(isinstance(x, str) for x in val):
                raise ValueError(f"frontmatter '{key}' must be a list of strings")
            parsed[key] = val
        elif raw_val.startswith('"') and raw_val.endswith('"'):
            val = json.loads(raw_val)
            if not isinstance(val, str):
                raise ValueError(f"frontmatter '{key}' must decode to str")
            parsed[key] = val
        else:
            raise ValueError(f"frontmatter '{key}' must be a quoted scalar or JSON-compatible list")
    return parsed, body


def build_markdown_twins(
    catalog: dict,
    site_root: Path,
    public_dir: Path,
) -> tuple[dict[tuple[str, str], str], dict[Path, str]]:
    base_url = catalog["site"]["base_url"].rstrip("/")
    twins: dict[tuple[str, str], str] = {}
    outputs: dict[Path, str] = {}
    seen_res: set[Path] = set()

    for post in catalog["posts"]:
        slug = post["slug"]
        for lang in ("zh", "en"):
            loc = post[lang]
            other_lang = "en" if lang == "zh" else "zh"
            src_path = assert_contained_no_links(
                site_root / loc["source"], site_root, label=f"source for {slug} ({lang})"
            )
            body = src_path.read_text(encoding="utf-8").replace("\r\n", "\n").strip()

            exp_url, exp_md_url = expected_post_routes(slug, lang)
            _, other_md_url = expected_post_routes(slug, other_lang)
            concepts_yaml = json.dumps(post["concepts"], ensure_ascii=False)
            frontmatter = "\n".join(
                [
                    "---",
                    f"title: {yaml_quote(loc['title'])}",
                    f"publication: {yaml_quote(catalog['site']['name'])}",
                    f"author: {yaml_quote(catalog['site']['author'])}",
                    f"issue: {yaml_quote(post['issue_no'])}",
                    f"tier: {yaml_quote(post['tier'])}",
                    f"lang: {yaml_quote('zh-Hans' if lang == 'zh' else 'en')}",
                    f"date: {yaml_quote(post['date'])}",
                    f"updated: {yaml_quote(post['updated'])}",
                    f"concepts: {concepts_yaml}",
                    f"canonical_html: {yaml_quote(base_url + exp_url)}",
                    f"canonical_md: {yaml_quote(base_url + exp_md_url)}",
                    f"counterpart_md: {yaml_quote(base_url + other_md_url)}",
                    "---",
                ]
            )
            full_md = f"{frontmatter}\n\n{body}\n"
            fm_parsed, _ = parse_frontmatter_strict(full_md)
            if fm_parsed.get("title") != loc["title"] or fm_parsed.get("concepts") != post["concepts"]:
                raise ValueError(f"frontmatter round-trip mismatch for {slug} ({lang})")

            out_path = public_dir / exp_md_url.lstrip("/")
            out_res = assert_contained_no_links(out_path, public_dir, label=f"Markdown twin for {slug} ({lang})")
            if out_path.name.lower() in RESERVED_OUTPUT_NAMES or out_res in seen_res:
                raise ValueError(f"Duplicate or reserved output path: {out_path}")
            seen_res.add(out_res)

            twins[(slug, lang)] = full_md
            outputs[out_path] = full_md

    return twins, outputs


STREAM_STALE_PATHS = (
    "stream/index.html",
    "en/stream/index.html",
    "stream/index.md",
    "en/stream/index.md",
    "stream/rss.xml",
    "en/stream/rss.xml",
    "api/stream.json",
)


def load_stream_data(site_root: Path, public_dir: Path | None = None) -> tuple[dict | None, list[str]]:
    stream_path = site_root / "stream.json"
    if not stream_path.exists():
        if public_dir is not None:
            stale = [rel for rel in STREAM_STALE_PATHS if (public_dir / rel).exists()]
            if stale:
                return None, [
                    f"stream.json is missing while Stream pages/artifacts still exist under public/: {', '.join(stale)}"
                ]
        return None, []
    try:
        resolved = assert_contained_no_links(stream_path, site_root, label="stream.json")
        data = json.loads(resolved.read_text(encoding="utf-8"))
    except Exception as exc:
        return None, [f"stream.json: failed to load ({exc})"]
    if not isinstance(data, dict):
        return None, ["stream.json: root must be a JSON object"]
    return data, []


def _is_safe_stream_url(raw: str) -> bool:
    val = str(raw or "").strip()
    return val.startswith(("/", "https://", "http://")) and not val.startswith("//")


def _markdown_fence_for(code_text: str) -> str:
    longest = max((len(m.group(0)) for m in re.finditer(r"`+", code_text)), default=0)
    return "`" * max(3, longest + 1)


def _escape_md_label(text: str) -> str:
    return text.replace("\\", "\\\\").replace("[", "\\[").replace("]", "\\]")


def _format_md_dest(url: str) -> str:
    cleaned = url.replace("\\", "%5C").replace("<", "%3C").replace(">", "%3E").replace(" ", "%20")
    return f"<{cleaned}>"


def validate_stream(stream_data: dict, catalog: dict) -> list[str]:
    errors: list[str] = []
    concept_ids = {str(c.get("id", "")) for c in catalog.get("concepts", [])}
    post_slugs = {str(p.get("slug", "")) for p in catalog.get("posts", [])}

    now_block = stream_data.get("now")
    if now_block is not None:
        if not isinstance(now_block, dict):
            errors.append("stream.json: 'now' must be an object")
        else:
            upd = now_block.get("updated")
            if not isinstance(upd, str) or not ISO_DATE_RE.match(upd):
                errors.append(f"stream.json: now.updated {upd!r} must be a YYYY-MM-DD string")
            else:
                try:
                    dt.date.fromisoformat(upd)
                except ValueError:
                    errors.append(f"stream.json: now.updated '{upd}' is not a valid calendar date")
            for lang in ("zh", "en"):
                items = now_block.get(lang)
                if not isinstance(items, list) or not items:
                    errors.append(f"stream.json: now.{lang} must be a non-empty list")
                else:
                    for idx, item in enumerate(items):
                        if (
                            not isinstance(item, dict)
                            or not isinstance(item.get("label"), str)
                            or not item["label"].strip()
                            or not isinstance(item.get("value"), str)
                            or not item["value"].strip()
                        ):
                            errors.append(f"stream.json: now.{lang}[{idx}] requires non-empty string label and value")

    entries = stream_data.get("entries")
    if not isinstance(entries, list) or not entries:
        errors.append("stream.json: 'entries' must be a non-empty list")
        return errors

    seen_ids: set[str] = set()
    for idx, entry in enumerate(entries):
        if not isinstance(entry, dict):
            errors.append(f"stream.json: entries[{idx}] must be an object")
            continue
        raw_id = entry.get("id")
        eid = raw_id if isinstance(raw_id, str) else f"#{idx}"
        if not isinstance(raw_id, str) or not STREAM_ID_RE.match(raw_id):
            errors.append(f"stream.json: entries[{idx}].id {raw_id!r} must be a string matching {STREAM_ID_RE.pattern}")
        elif raw_id in seen_ids:
            errors.append(f"stream.json: duplicate entry id '{raw_id}'")
        else:
            seen_ids.add(raw_id)

        date_str = entry.get("date")
        if not isinstance(date_str, str) or not ISO_DATE_RE.match(date_str):
            errors.append(f"stream.json: entry '{eid}' invalid date {date_str!r} (expected YYYY-MM-DD string)")
        else:
            try:
                dt.date.fromisoformat(date_str)
            except ValueError:
                errors.append(f"stream.json: entry '{eid}' non-existent calendar date '{date_str}'")

        time_str = entry.get("time")
        if time_str is not None and (not isinstance(time_str, str) or not HHMM_RE.match(time_str)):
            errors.append(f"stream.json: entry '{eid}' invalid HH:MM string time {time_str!r}")

        kind = entry.get("kind")
        if not isinstance(kind, str) or kind not in STREAM_KINDS:
            errors.append(f"stream.json: entry '{eid}' invalid kind {kind!r}")

        e_concepts = entry.get("concepts", [])
        if not isinstance(e_concepts, list):
            errors.append(f"stream.json: entry '{eid}'.concepts must be a list")
        else:
            for cid in e_concepts:
                if not isinstance(cid, str) or cid not in concept_ids:
                    errors.append(f"stream.json: entry '{eid}' references undeclared concept '{cid}'")

        promoted = entry.get("promoted_to")
        if promoted is not None and (not isinstance(promoted, str) or promoted not in post_slugs):
            errors.append(f"stream.json: entry '{eid}'.promoted_to '{promoted}' is not a catalog post slug")

        for lang in ("zh", "en"):
            loc = entry.get(lang)
            if not isinstance(loc, dict):
                errors.append(f"stream.json: entry '{eid}' missing '{lang}' object")
                continue
            lead = loc.get("lead")
            if lead is not None and (not isinstance(lead, str) or not lead.strip()):
                errors.append(f"stream.json: entry '{eid}'.{lang}.lead must be a non-empty string")
            body = loc.get("body")
            if not isinstance(body, list) or not body or not all(isinstance(p, str) and p.strip() for p in body):
                errors.append(f"stream.json: entry '{eid}'.{lang}.body must be a non-empty list of strings")
            quote = loc.get("quote")
            if quote is not None:
                if not isinstance(quote, dict):
                    errors.append(f"stream.json: entry '{eid}'.{lang}.quote must be an object")
                else:
                    q_text = quote.get("text")
                    if not isinstance(q_text, str) or not q_text.strip():
                        errors.append(f"stream.json: entry '{eid}'.{lang}.quote.text must be a non-empty string")
                    q_src = quote.get("source")
                    if q_src is not None and (not isinstance(q_src, str) or not q_src.strip()):
                        errors.append(f"stream.json: entry '{eid}'.{lang}.quote.source must be a non-empty string")
                    q_url = quote.get("url")
                    if q_url is not None and (not isinstance(q_url, str) or not _is_safe_stream_url(q_url)):
                        errors.append(f"stream.json: entry '{eid}'.{lang}.quote.url must be a local '/' or http(s) URL string")
            code = loc.get("code")
            if code is not None:
                if not isinstance(code, dict):
                    errors.append(f"stream.json: entry '{eid}'.{lang}.code must be an object")
                else:
                    c_content = code.get("content")
                    if not isinstance(c_content, str) or not c_content.strip():
                        errors.append(f"stream.json: entry '{eid}'.{lang}.code.content must be a non-empty string")
                    c_lang = code.get("lang")
                    if c_lang is not None and not isinstance(c_lang, str):
                        errors.append(f"stream.json: entry '{eid}'.{lang}.code.lang must be a string")
            updates = loc.get("updates")
            if updates is not None:
                if not isinstance(updates, list):
                    errors.append(f"stream.json: entry '{eid}'.{lang}.updates must be a list")
                else:
                    for uidx, upd_item in enumerate(updates):
                        if not isinstance(upd_item, dict):
                            errors.append(f"stream.json: entry '{eid}'.{lang}.updates[{uidx}] must be an object")
                            continue
                        udate = upd_item.get("date")
                        if not isinstance(udate, str) or not ISO_DATE_RE.match(udate):
                            errors.append(f"stream.json: entry '{eid}'.{lang}.updates[{uidx}].date invalid ({udate!r})")
                        else:
                            try:
                                dt.date.fromisoformat(udate)
                            except ValueError:
                                errors.append(f"stream.json: entry '{eid}'.{lang}.updates[{uidx}].date invalid calendar date '{udate}'")
                        utext = upd_item.get("text")
                        if not isinstance(utext, str) or not utext.strip():
                            errors.append(f"stream.json: entry '{eid}'.{lang}.updates[{uidx}].text must be a non-empty string")

    return errors


def sorted_stream_entries(stream_data: dict) -> list[dict]:
    return sorted(
        stream_data["entries"],
        key=lambda e: (str(e["date"]), str(e.get("time") or "00:00"), str(e["id"])),
        reverse=True,
    )


def stream_latest_date(stream_data: dict) -> str:
    dates = [str(e["date"]) for e in stream_data["entries"]]
    now_block = stream_data.get("now")
    if isinstance(now_block, dict) and now_block.get("updated"):
        dates.append(str(now_block["updated"]))
    for e in stream_data["entries"]:
        for lang in ("zh", "en"):
            for upd in e.get(lang, {}).get("updates") or []:
                if upd.get("date"):
                    dates.append(str(upd["date"]))
    return max(dates)


def format_stream_inline_html(text: str) -> str:
    escaped = html_text_escape(text)
    return INLINE_CODE_RE.sub(lambda m: f"<code>{m.group(1)}</code>", escaped)


def render_stream_partial(stream_data: dict, catalog: dict, lang: str) -> str:
    is_en = lang == "en"
    entries = sorted_stream_entries(stream_data)
    total = len(entries)
    latest_iso = stream_latest_date(stream_data)
    latest_date_obj = dt.date.fromisoformat(latest_iso)

    concept_map = {c["id"]: c for c in catalog["concepts"]}
    post_map = {p["slug"]: p for p in catalog["posts"]}

    kind_counts: dict[str, int] = {k: 0 for k in STREAM_KIND_ORDER}
    concept_counts: dict[str, int] = {}
    date_entries: dict[str, list[dict]] = {}
    months_order: list[str] = []
    months_map: dict[str, list[dict]] = {}

    for e in entries:
        kind_counts[e["kind"]] = kind_counts.get(e["kind"], 0) + 1
        for cid in e.get("concepts", []):
            concept_counts[cid] = concept_counts.get(cid, 0) + 1
        date_entries.setdefault(e["date"], []).append(e)
        ym = e["date"][:7]
        if ym not in months_map:
            months_order.append(ym)
            months_map[ym] = []
        months_map[ym].append(e)

    lines: list[str] = []

    # Main Stream Workspace (Toolbar + Two-Track Ledger)
    lines.append(
        f'    <section class="shell stream-section" aria-label="{"Stream filters and entries" if is_en else "思维筛选与编年记录"}">'
    )
    lines.append('      <div class="stream-toolbar" data-stream-js hidden>')
    lines.append('        <div class="filter-bar stream-filter-bar">')
    lines.append(
        f'          <div class="filter-group" data-filter-group="kind" role="group" aria-label="{"Filter by fragment kind" if is_en else "按片段形态筛选"}">'
    )
    lines.append(
        f'            <button type="button" class="btn subtle" data-stream-kind="all" aria-pressed="true">'
        f'{"All" if is_en else "全部"}</button>'
    )
    for k in STREAM_KIND_ORDER:
        if kind_counts.get(k, 0) > 0:
            label = STREAM_KINDS[k][lang]
            lines.append(
                f'            <button type="button" class="btn subtle" data-stream-kind="{k}" aria-pressed="false">'
                f"{html_text_escape(label)}</button>"
            )
    lines.append("          </div>")
    lines.append('          <div class="stream-toolbar-actions">')
    random_label = "Serendipity" if is_en else "随机捞一条"
    lines.append(
        '            <button type="button" class="btn subtle stream-random-btn" data-stream-random>'
        f'<span data-random-label>{random_label}</span>'
        '<span class="stream-random-glyph" aria-hidden="true">↻</span>'
        "</button>"
    )
    lines.append("          </div>")
    lines.append("        </div>")

    lines.append('        <div class="stream-active-filter" data-stream-active-bar hidden>')
    lines.append('          <span class="stream-active-label" data-stream-active-label></span>')
    lines.append(
        f'          <button type="button" class="btn subtle stream-clear-btn" data-stream-reset>'
        f'{"Clear" if is_en else "清除筛选"} ×</button>'
    )
    lines.append("        </div>")
    lines.append("      </div>")
    lines.append("")

    # Two-track layout
    lines.append('      <div class="stream-layout">')

    # Left Sticky Rail
    lines.append(f'        <aside class="stream-rail" aria-label="{"Chronology and index" if is_en else "时间索引与概念导览"}">')

    # Rail Block 1: Months
    lines.append('          <div class="stream-rail-block">')
    lines.append(f'            <div class="stream-rail-title mono">{"Chronology" if is_en else "时间轴"}</div>')
    lines.append('            <ul class="toc-list stream-month-list">')
    for ym in months_order:
        ym_disp = ym.replace("-", " / ")
        ym_cnt = len(months_map[ym])
        lines.append(
            f'              <li><a href="#m-{ym}" data-rail-month="{ym}">'
            f'<span>{ym_disp}</span><span class="mono stream-rail-num">{ym_cnt:02d}</span></a></li>'
        )
    lines.append("            </ul>")
    lines.append("          </div>")

    # Rail Block 2: 35-Day Swiss Cadence Matrix
    lines.append('          <div class="stream-rail-block stream-matrix-block">')
    lines.append('            <div class="stream-rail-head">')
    lines.append(f'              <span class="stream-rail-title mono">{"35-Day Cadence" if is_en else "近 35 日节律"}</span>')
    lines.append(
        f'              <span class="stream-rail-sub mono">{(latest_date_obj - dt.timedelta(days=34)).strftime("%m.%d")}–{latest_date_obj.strftime("%m.%d")}</span>'
    )
    lines.append("            </div>")
    lines.append(
        f'            <div class="stream-matrix" role="group" aria-label="{"35-day thought activity matrix" if is_en else "近 35 日思维活跃点阵"}">'
    )
    for offset in range(34, -1, -1):
        day_obj = latest_date_obj - dt.timedelta(days=offset)
        day_iso = day_obj.isoformat()
        day_disp = day_iso.replace("-", ".")
        day_list = date_entries.get(day_iso, [])
        cnt = len(day_list)
        if cnt > 0:
            lvl = 1 if cnt == 1 else (2 if cnt == 2 else 3)
            first_id = day_list[0]["id"]
            aria_lbl = (
                f"{day_disp}: {cnt} {'note' if cnt == 1 else 'notes'}, jump to #{first_id}"
                if is_en
                else f"{day_disp}：{cnt} 条思维，点击定位至 #{first_id}"
            )
            lines.append(
                f'              <a class="stream-cell is-active" href="#t-{first_id}" '
                f'data-matrix-date="{day_iso}" data-count="{cnt}" data-level="{lvl}" '
                f'data-first-id="{first_id}" aria-label="{html_attr_escape(aria_lbl)}"></a>'
            )
        else:
            lines.append(
                f'              <span class="stream-cell" data-date="{day_iso}" aria-hidden="true"></span>'
            )
    lines.append("            </div>")
    default_readout = "Select a lit cell to jump" if is_en else "点击高亮点定位当日记录"
    lines.append(
        f'            <div class="stream-matrix-readout mono" data-matrix-readout '
        f'data-default-label="{html_attr_escape(default_readout)}">{default_readout}</div>'
    )
    lines.append("          </div>")

    # Rail Block 3: Concepts used in Stream
    archive_base = "/en/archive/" if is_en else "/archive/"
    used_concepts = [c for c in catalog["concepts"] if concept_counts.get(c["id"], 0) > 0]
    if used_concepts:
        lines.append('          <div class="stream-rail-block">')
        lines.append(f'            <div class="stream-rail-title mono">{"Concepts" if is_en else "关联概念"}</div>')
        lines.append('            <ul class="stream-rail-concepts">')
        for c in used_concepts:
            cid = c["id"]
            clabel = c[lang]
            ccnt = concept_counts[cid]
            lines.append(
                f'              <li><a class="stream-rail-concept-btn" '
                f'href="{archive_base}?concept={html_attr_escape(cid)}" '
                f'data-stream-concept="{html_attr_escape(cid)}">'
                f'<span>{html_text_escape(clabel)}</span>'
                f'<span class="mono stream-rail-num">{ccnt:02d}</span></a></li>'
            )
        lines.append("            </ul>")
        lines.append("          </div>")

    lines.append("        </aside>")
    lines.append("")

    # Right Ledger
    lines.append('        <div class="stream-ledger" data-stream-ledger>')
    for ym in months_order:
        month_entries = months_map[ym]
        ym_disp = ym.replace("-", " / ")
        m_cnt_label = (
            f"{len(month_entries):02d} {'note' if len(month_entries) == 1 else 'notes'}"
            if is_en
            else f"{len(month_entries):02d} 条"
        )
        lines.append(f'          <section class="stream-month-group" id="m-{ym}" data-month="{ym}">')
        lines.append('            <header class="stream-month-head">')
        lines.append(f'              <h2 class="stream-month-title mono">{ym_disp}</h2>')
        lines.append(f'              <span class="stream-month-count mono" data-month-count="{ym}">{m_cnt_label}</span>')
        lines.append("            </header>")
        lines.append('            <ol class="stream-list">')

        for e in month_entries:
            eid = e["id"]
            kind = e["kind"]
            kind_label = STREAM_KINDS[kind][lang]
            e_concepts = e.get("concepts", [])
            concepts_csv = ",".join(e_concepts)
            loc = e[lang]
            date_iso = e["date"]
            time_str = e.get("time") or ""
            dt_attr = f"{date_iso}T{time_str}" if time_str else date_iso
            md_disp = date_iso[5:].replace("-", ".")
            time_disp = f"{md_disp} · {time_str}" if time_str else md_disp

            lines.append(
                f'              <li class="stream-item" data-stream-item data-stream-id="{eid}" '
                f'data-kind="{kind}" data-date="{date_iso}" data-month="{ym}" '
                f'data-concepts="{html_attr_escape(concepts_csv)}">'
            )
            lines.append(f'                <article class="stream-entry" id="t-{eid}">')

            # Meta rail
            lines.append('                  <div class="stream-entry-meta">')
            anchor_aria = f"Permalink to note #{eid}" if is_en else f"思维碎片 #{eid} 锚点链接"
            lines.append(
                f'                    <a class="stream-anchor mono" href="#t-{eid}" '
                f'data-stream-anchor="{eid}" aria-label="{html_attr_escape(anchor_aria)}">#{eid}</a>'
            )
            lines.append(
                f'                    <time class="stream-time mono" datetime="{html_attr_escape(dt_attr)}">{time_disp}</time>'
            )
            lines.append(
                f'                    <span class="stream-kind-cue">{html_text_escape(kind_label)}</span>'
            )
            lines.append("                  </div>")

            # Content body
            lines.append('                  <div class="stream-entry-body">')
            if loc.get("lead"):
                lines.append(f'                    <p class="stream-lead">{format_stream_inline_html(loc["lead"])}</p>')

            if loc.get("quote"):
                q = loc["quote"]
                lines.append('                    <blockquote class="stream-quote">')
                lines.append(f'                      <p>{format_stream_inline_html(q["text"])}</p>')
                if q.get("source"):
                    src_html = html_text_escape(q["source"])
                    if q.get("url"):
                        qurl = str(q["url"])
                        ext_attrs = ' target="_blank" rel="noopener noreferrer"' if qurl.startswith(("http://", "https://")) else ""
                        lines.append(
                            f'                      <footer>— <a href="{html_attr_escape(qurl)}"{ext_attrs}>{src_html}</a></footer>'
                        )
                    else:
                        lines.append(f"                      <footer>— {src_html}</footer>")
                lines.append("                    </blockquote>")

            lines.append('                    <div class="stream-prose">')
            for para in loc["body"]:
                lines.append(f"                      <p>{format_stream_inline_html(para)}</p>")
            lines.append("                    </div>")

            if loc.get("code"):
                code_obj = loc["code"]
                code_lang = str(code_obj.get("lang") or "").strip().upper()
                code_aria = (
                    f"{code_lang} code snippet" if code_lang else "Code snippet"
                ) if is_en else (
                    f"{code_lang} 代码片段" if code_lang else "代码片段"
                )
                lines.append('                    <div class="stream-code">')
                if code_lang:
                    lines.append(f'                      <div class="stream-code-head mono">{html_text_escape(code_lang)}</div>')
                lines.append(
                    f'                      <pre role="region" aria-label="{html_attr_escape(code_aria)}" tabindex="0">'
                    f'<code>{html_text_escape(code_obj["content"])}</code></pre>'
                )
                lines.append("                    </div>")

            if loc.get("updates"):
                lines.append('                    <ol class="stream-updates">')
                for upd in loc["updates"]:
                    udate_disp = str(upd["date"]).replace("-", ".")
                    upd_label = f"↳ {udate_disp} Update" if is_en else f"↳ {udate_disp} 追记"
                    lines.append('                      <li class="stream-update-item">')
                    lines.append(f'                        <span class="stream-update-mark mono">{upd_label}</span>')
                    lines.append(f'                        <span class="stream-update-text">{format_stream_inline_html(upd["text"])}</span>')
                    lines.append("                      </li>")
                lines.append("                    </ol>")

            if e.get("promoted_to") and e["promoted_to"] in post_map:
                post_obj = post_map[e["promoted_to"]]
                post_url = post_obj[lang]["url"]
                post_title = post_obj[lang]["title"]
                promo_text = (
                    f'Expanded into No. {post_obj["issue_no"]} · {post_title}'
                    if is_en
                    else f'已展开为 No. {post_obj["issue_no"]} · {post_title}'
                )
                lines.append(
                    f'                    <a class="stream-promoted" href="{html_attr_escape(post_url)}">'
                    f'<span class="stream-promoted-arrow" aria-hidden="true">↗</span>'
                    f"<span>{html_text_escape(promo_text)}</span></a>"
                )

            # Entry footer (concepts + quiet micro-actions)
            lines.append('                    <footer class="stream-entry-foot">')
            if e_concepts:
                lines.append(
                    f'                      <ul class="concept-list stream-entry-concepts" aria-label="{"Concepts" if is_en else "关联概念"}">'
                )
                for cid in e_concepts:
                    if cid in concept_map:
                        lines.append(
                            f'                        <li><a class="concept-tag stream-concept-btn" '
                            f'href="{archive_base}?concept={html_attr_escape(cid)}" '
                            f'data-stream-concept="{html_attr_escape(cid)}">'
                            f"{html_text_escape(concept_map[cid][lang])}</a></li>"
                        )
                lines.append("                      </ul>")
            else:
                lines.append("                      <span></span>")

            copy_lbl = "Copy link" if is_en else "复制链接"
            reply_lbl = f"Echo #{eid}" if is_en else f"回应 #{eid}"
            lines.append('                      <div class="stream-entry-actions" data-stream-js hidden>')
            lines.append(
                f'                        <button type="button" class="stream-action-btn" data-stream-copy="{eid}">{copy_lbl}</button>'
            )
            lines.append(
                f'                        <button type="button" class="stream-action-btn" data-stream-reply="{eid}">{reply_lbl}</button>'
            )
            lines.append("                      </div>")
            lines.append("                    </footer>")

            lines.append("                  </div>")
            lines.append("                </article>")
            lines.append("              </li>")

        lines.append("            </ol>")
        lines.append("          </section>")

    empty_copy = (
        "No fragments match this filter combination."
        if is_en
        else "当前筛选条件下暂无匹配的思维碎片。"
    )
    reset_copy = "Reset filters" if is_en else "重置筛选"
    lines.append('          <div class="stream-empty" data-stream-empty hidden>')
    lines.append(f"            <p>{empty_copy}</p>")
    lines.append(f'            <button type="button" class="btn subtle" data-stream-reset>{reset_copy}</button>')
    lines.append("          </div>")
    lines.append("        </div>")
    lines.append("      </div>")
    lines.append("    </section>")

    return "\n".join(lines)


def build_stream_artifacts(
    catalog: dict,
    stream_data: dict,
    public_dir: Path,
) -> tuple[dict[str, str], dict[Path, str]]:
    site = catalog["site"]
    base_url = site["base_url"].rstrip("/")
    entries = sorted_stream_entries(stream_data)
    latest_iso = stream_latest_date(stream_data)
    deterministic_generated_at = f"{latest_iso}T00:00:00Z"
    concept_map = {c["id"]: c for c in catalog["concepts"]}
    post_map = {p["slug"]: p for p in catalog["posts"]}

    twins: dict[str, str] = {}
    outputs: dict[Path, str] = {}

    def register(rel_path: str, content: str) -> None:
        dest = public_dir / rel_path
        assert_contained_no_links(dest, public_dir, label=f"stream artifact '{rel_path}'")
        if dest.name.lower() in RESERVED_OUTPUT_NAMES or dest in outputs:
            raise ValueError(f"Duplicate or reserved stream artifact path: {dest}")
        outputs[dest] = content

    # 1. api/stream.json
    api_payload = {
        "site": site["name"],
        "generated_at": deterministic_generated_at,
        "count": len(entries),
        "kinds": STREAM_KINDS,
        "entries": entries,
    }
    register("api/stream.json", json.dumps(api_payload, ensure_ascii=False, indent=2) + "\n")

    # 2. Bilingual Markdown twins + dedicated Stream RSS 2.0 feeds
    for lang in ("zh", "en"):
        is_en = lang == "en"
        html_path = "/en/stream/" if is_en else "/stream/"
        md_path = "/en/stream/index.md" if is_en else "/stream/index.md"
        other_md_path = "/stream/index.md" if is_en else "/en/stream/index.md"
        rss_rel = "en/stream/rss.xml" if is_en else "stream/rss.xml"
        title_str = f"Stream | {site['name']}" if is_en else f"思维 | {site['name']}"

        frontmatter = "\n".join(
            [
                "---",
                f"title: {yaml_quote(title_str)}",
                f"publication: {yaml_quote(site['name'])}",
                f"author: {yaml_quote(site['author'])}",
                f"section: {yaml_quote('stream')}",
                f"lang: {yaml_quote('en' if is_en else 'zh-Hans')}",
                f"updated: {yaml_quote(latest_iso)}",
                f"count: {yaml_quote(str(len(entries)))}",
                f"canonical_html: {yaml_quote(base_url + html_path)}",
                f"canonical_md: {yaml_quote(base_url + md_path)}",
                f"counterpart_md: {yaml_quote(base_url + other_md_path)}",
                "---",
            ]
        )

        md_lines = [
            f"# {'Stream' if is_en else '思维'}",
            "",
            f"> {'Stray thoughts and fragments.' if is_en else '碎片思考与碎碎念。'}",
            "",
        ]

        rss_items: list[str] = []
        for e in entries:
            eid = e["id"]
            loc = e[lang]
            kind_lbl = STREAM_KINDS[e["kind"]][lang]
            stamp = f"{e['date']} {e['time']}" if e.get("time") else e["date"]
            md_lines.append(f"## #{eid} · {stamp} · {kind_lbl}")
            md_lines.append("")
            if loc.get("lead"):
                md_lines.append(f"**{loc['lead']}**")
                md_lines.append("")
            if loc.get("quote"):
                q = loc["quote"]
                md_lines.append(f"> {q['text']}")
                q_url = str(q.get("url") or "").strip()
                q_full_url = f"{base_url}{q_url}" if q_url.startswith("/") else q_url
                if q.get("source") and q_full_url:
                    md_lines.append(f"> — [{_escape_md_label(q['source'])}]({_format_md_dest(q_full_url)})")
                elif q.get("source"):
                    md_lines.append(f"> — {q['source']}")
                elif q_full_url:
                    md_lines.append(f"> — {_format_md_dest(q_full_url)}")
                md_lines.append("")
            for para in loc["body"]:
                md_lines.append(para)
                md_lines.append("")
            if loc.get("code"):
                code_lang = str(loc["code"].get("lang") or "").strip().lower()
                code_body = loc["code"]["content"]
                fence = _markdown_fence_for(code_body)
                md_lines.append(f"{fence}{code_lang}")
                md_lines.append(code_body)
                md_lines.append(fence)
                md_lines.append("")
            if loc.get("updates"):
                for upd in loc["updates"]:
                    prefix = "Update" if is_en else "追记"
                    md_lines.append(f"- *{upd['date']} {prefix}*: {upd['text']}")
                md_lines.append("")
            if e.get("promoted_to") and e["promoted_to"] in post_map:
                po = post_map[e["promoted_to"]]
                label_p = f"Expanded into No. {po['issue_no']}" if is_en else f"已展开为 No. {po['issue_no']}"
                md_lines.append(f"- ↗ {label_p}: [{po[lang]['title']}]({base_url}{po[lang]['url']})")
                md_lines.append("")
            if e.get("concepts"):
                c_names = [concept_map[c][lang] for c in e["concepts"] if c in concept_map]
                if c_names:
                    md_lines.append(f"*{'Concepts' if is_en else '关联概念'}: {', '.join(c_names)}*")
                    md_lines.append("")

            # RSS item
            hh, mm = (e.get("time") or "00:00").split(":")
            pub_dt = dt.datetime.strptime(e["date"], "%Y-%m-%d").replace(
                hour=int(hh), minute=int(mm), tzinfo=dt.timezone.utc
            )
            pub_rfc822 = email.utils.format_datetime(pub_dt)
            item_url = f"{base_url}{html_path}#t-{eid}"
            plain_lead = loc.get("lead") or loc["body"][0]
            rss_title = f"#{eid} ({kind_lbl}) — {plain_lead[:60]}{'…' if len(plain_lead) > 60 else ''}"
            desc_parts = []
            if loc.get("quote"):
                desc_parts.append(f'“{loc["quote"]["text"]}”')
            desc_parts.extend(loc["body"])
            for upd in loc.get("updates") or []:
                desc_parts.append(f"[{upd['date']}] {upd['text']}")
            rss_items.append(
                "\n".join(
                    [
                        "    <item>",
                        f"      <title>{xml_escape(rss_title)}</title>",
                        f"      <link>{xml_escape(item_url)}</link>",
                        f'      <guid isPermaLink="true">{xml_escape(item_url)}</guid>',
                        f"      <pubDate>{pub_rfc822}</pubDate>",
                        f"      <description>{xml_escape(' '.join(desc_parts))}</description>",
                        "    </item>",
                    ]
                )
            )

        full_md = f"{frontmatter}\n\n" + "\n".join(md_lines).rstrip() + "\n"
        fm_parsed, _ = parse_frontmatter_strict(full_md)
        if fm_parsed.get("section") != "stream":
            raise ValueError(f"stream frontmatter round-trip mismatch ({lang})")
        twins[lang] = full_md
        register(md_path.lstrip("/"), full_md)

        rss_xml = "\n".join(
            [
                '<?xml version="1.0" encoding="UTF-8"?>',
                '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
                "  <channel>",
                f"    <title>{xml_escape(site['name'])} — {'Stream (English)' if is_en else '思维切片（中文）'}</title>",
                f"    <link>{xml_escape(base_url + html_path)}</link>",
                f"    <description>{xml_escape('Short bilingual fragments and studio notes.' if is_en else '碎片思考、随手摘录与公开手记。')}</description>",
                f"    <language>{'en' if is_en else 'zh-Hans'}</language>",
                f'    <atom:link href="{xml_escape(base_url + "/" + rss_rel)}" rel="self" type="application/rss+xml" />',
                *rss_items,
                "  </channel>",
                "</rss>",
                "",
            ]
        )
        ET.fromstring(rss_xml)
        register(rss_rel, rss_xml)

    return twins, outputs


def build_machine_artifacts(
    catalog: dict,
    twins: dict[tuple[str, str], str],
    public_dir: Path,
    stream_data: dict | None = None,
    stream_twins: dict[str, str] | None = None,
) -> dict[Path, str]:
    site = catalog["site"]
    base_url = site["base_url"].rstrip("/")
    posts = catalog["posts"]
    concepts = catalog["concepts"]
    outputs: dict[Path, str] = {}

    def register(rel_path: str, content: str) -> None:
        dest = public_dir / rel_path
        assert_contained_no_links(dest, public_dir, label=f"machine artifact '{rel_path}'")
        if dest.name.lower() in RESERVED_OUTPUT_NAMES or dest in outputs:
            raise ValueError(f"Duplicate or reserved machine artifact path: {dest}")
        outputs[dest] = content

    latest_updated = max(p["updated"] for p in posts)
    deterministic_generated_at = f"{latest_updated}T00:00:00Z"

    # 1. api/posts.json
    posts_payload = {
        "site": site,
        "generated_at": deterministic_generated_at,
        "count": len(posts),
        "concepts": concepts,
        "posts": posts,
    }
    register("api/posts.json", json.dumps(posts_payload, ensure_ascii=False, indent=2) + "\n")

    # 2. api/graph.json
    nodes = []
    edges = []
    for p in posts:
        nodes.append(
            {
                "id": f"post:{p['slug']}",
                "type": "post",
                "issue_no": p["issue_no"],
                "tier": p["tier"],
                "zh": p["zh"]["title"],
                "en": p["en"]["title"],
                "description": {"zh": p["zh"]["summary"], "en": p["en"]["summary"]},
                "url": {"zh": p["zh"]["url"], "en": p["en"]["url"]},
                "md_url": {"zh": p["zh"]["md_url"], "en": p["en"]["md_url"]},
            }
        )
        for cid in p["concepts"]:
            edges.append({"source": f"post:{p['slug']}", "target": f"concept:{cid}", "kind": "tagged"})

    for c in concepts:
        nodes.append(
            {
                "id": f"concept:{c['id']}",
                "type": "concept",
                "zh": c["zh"],
                "en": c["en"],
                "description": c["description"],
            }
        )

    for i in range(len(posts)):
        for j in range(i + 1, len(posts)):
            shared = set(posts[i]["concepts"]) & set(posts[j]["concepts"])
            if shared:
                edges.append(
                    {
                        "source": f"post:{posts[i]['slug']}",
                        "target": f"post:{posts[j]['slug']}",
                        "kind": "shared-concepts",
                        "weight": len(shared),
                    }
                )

    graph_payload = {
        "site": site["name"],
        "nodes": nodes,
        "edges": edges,
    }
    register("api/graph.json", json.dumps(graph_payload, ensure_ascii=False, indent=2) + "\n")

    # 3. llms.txt
    llms_lines = [
        f"# {site['name']}",
        "",
        f"> {site['tagline']['en']}",
        f"> {site['tagline']['zh']}",
        "",
        "## Agent Discovery & Machine Endpoints",
        f"- Full bilingual corpus: {base_url}/llms-full.txt",
        f"- Structured catalog JSON: {base_url}/api/posts.json",
        f"- Concept topology graph JSON: {base_url}/api/graph.json",
        *(
            [
                f"- Stream (fragments) JSON: {base_url}/api/stream.json",
                f"- Stream Markdown twins: {base_url}/en/stream/index.md | {base_url}/stream/index.md",
                f"- Stream RSS feeds: {base_url}/en/stream/rss.xml | {base_url}/stream/rss.xml",
            ]
            if stream_data is not None
            else []
        ),
        f"- English RSS / JSON Feed: {base_url}/en/rss.xml | {base_url}/en/feed.json",
        f"- Chinese RSS / JSON Feed: {base_url}/rss.xml | {base_url}/feed.json",
        "",
        "## Issues (English Markdown Twins)",
    ]
    for p in posts:
        llms_lines.append(
            f"- [Issue {p['issue_no']} ({p['tier'].upper()}): {p['en']['title']}]({base_url}{p['en']['md_url']}): {p['en']['summary']}"
        )

    llms_lines.extend(["", "## 刊物目录（中文 Markdown 孪生原稿）"])
    for p in posts:
        llms_lines.append(
            f"- [第 {p['issue_no']} 期（{p['tier'].upper()}）：{p['zh']['title']}]({base_url}{p['zh']['md_url']}): {p['zh']['summary']}"
        )

    llms_lines.extend(["", "## Core Concepts"])
    for c in concepts:
        llms_lines.append(f"- **{c['en']} / {c['zh']}** (`{c['id']}`): {c['description']['en']}")

    if stream_data is not None:
        llms_lines.extend(["", "## Stream (Recent Fragments)"])
        for e in sorted_stream_entries(stream_data)[:12]:
            en_first = e["en"].get("lead") or e["en"]["body"][0]
            zh_first = e["zh"].get("lead") or e["zh"]["body"][0]
            llms_lines.append(
                f"- [#{e['id']} ({e['date']} · {e['kind'].upper()})]({base_url}/en/stream/#t-{e['id']}): {en_first} / {zh_first}"
            )

    register("llms.txt", "\n".join(llms_lines) + "\n")

    # 4. llms-full.txt
    full_chunks = [
        f"# {site['name']} — Complete Bilingual Compendium",
        f"Base URL: {base_url}",
        "",
    ]
    for p in posts:
        full_chunks.append("=" * 72)
        full_chunks.append(f"ISSUE {p['issue_no']} [EN] — {base_url}{p['en']['url']}")
        full_chunks.append("=" * 72)
        full_chunks.append(twins[(p["slug"], "en")].strip())
        full_chunks.append("")
        full_chunks.append("=" * 72)
        full_chunks.append(f"ISSUE {p['issue_no']} [ZH] — {base_url}{p['zh']['url']}")
        full_chunks.append("=" * 72)
        full_chunks.append(twins[(p["slug"], "zh")].strip())
        full_chunks.append("")

    if stream_twins:
        full_chunks.append("=" * 72)
        full_chunks.append(f"STREAM [EN] — {base_url}/en/stream/")
        full_chunks.append("=" * 72)
        full_chunks.append(stream_twins["en"].strip())
        full_chunks.append("")
        full_chunks.append("=" * 72)
        full_chunks.append(f"STREAM [ZH] — {base_url}/stream/")
        full_chunks.append("=" * 72)
        full_chunks.append(stream_twins["zh"].strip())
        full_chunks.append("")

    register("llms-full.txt", "\n".join(full_chunks) + "\n")

    # 5. RSS 2.0 & JSON Feed 1.1 (both ZH and EN)
    for lang in ("zh", "en"):
        is_en = lang == "en"
        home_url = f"{base_url}/en/" if is_en else f"{base_url}/"
        rss_rel = "en/rss.xml" if is_en else "rss.xml"
        feed_json_rel = "en/feed.json" if is_en else "feed.json"

        rss_items = []
        json_items = []
        for p in posts:
            loc = p[lang]
            pub_dt = dt.datetime.strptime(p["date"], "%Y-%m-%d").replace(tzinfo=dt.timezone.utc)
            pub_rfc822 = email.utils.format_datetime(pub_dt)
            full_url = base_url + loc["url"]
            rss_items.append(
                "\n".join(
                    [
                        "    <item>",
                        f"      <title>{xml_escape(loc['title'])}</title>",
                        f"      <link>{xml_escape(full_url)}</link>",
                        f'      <guid isPermaLink="true">{xml_escape(full_url)}</guid>',
                        f"      <pubDate>{pub_rfc822}</pubDate>",
                        f"      <description>{xml_escape(loc['summary'])}</description>",
                        "    </item>",
                    ]
                )
            )
            json_items.append(
                {
                    "id": full_url,
                    "url": full_url,
                    "title": loc["title"],
                    "summary": loc["summary"],
                    "content_text": twins[(p["slug"], lang)],
                    "date_published": pub_dt.strftime("%Y-%m-%dT%H:%M:%SZ"),
                    "tags": p["concepts"],
                    "_agent": {
                        "markdown_url": base_url + loc["md_url"],
                        "tier": p["tier"],
                        "issue": p["issue_no"],
                    },
                }
            )

        rss_xml = "\n".join(
            [
                '<?xml version="1.0" encoding="UTF-8"?>',
                '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
                "  <channel>",
                f"    <title>{xml_escape(site['name'])} ({'English' if is_en else '中文'})</title>",
                f"    <link>{xml_escape(home_url)}</link>",
                f"    <description>{xml_escape(site['description'][lang])}</description>",
                f"    <language>{'en' if is_en else 'zh-Hans'}</language>",
                f'    <atom:link href="{xml_escape(base_url + "/" + rss_rel)}" rel="self" type="application/rss+xml" />',
                *rss_items,
                "  </channel>",
                "</rss>",
                "",
            ]
        )
        ET.fromstring(rss_xml)
        register(rss_rel, rss_xml)

        feed_json = {
            "version": "https://jsonfeed.org/version/1.1",
            "title": f"{site['name']} ({'English' if is_en else '中文'})",
            "home_page_url": home_url,
            "feed_url": base_url + "/" + feed_json_rel,
            "description": site["description"][lang],
            "language": "en" if is_en else "zh-Hans",
            "authors": [{"name": site["author"], "url": home_url}],
            "items": json_items,
        }
        register(feed_json_rel, json.dumps(feed_json, ensure_ascii=False, indent=2) + "\n")

    # 6. sitemap.xml
    static_pairs = [
        ("/", "/en/"),
        ("/archive/", "/en/archive/"),
        *(
            [("/stream/", "/en/stream/")]
            if stream_data is not None
            else []
        ),
        ("/graph/", "/en/graph/"),
        ("/about/", "/en/about/"),
    ]
    url_entries = []
    for zh_u, en_u in static_pairs:
        for primary in (zh_u, en_u):
            url_entries.append(
                "\n".join(
                    [
                        "  <url>",
                        f"    <loc>{xml_escape(base_url + primary)}</loc>",
                        f'    <xhtml:link rel="alternate" hreflang="zh-Hans" href="{xml_escape(base_url + zh_u)}" />',
                        f'    <xhtml:link rel="alternate" hreflang="en" href="{xml_escape(base_url + en_u)}" />',
                        "  </url>",
                    ]
                )
            )
    for p in posts:
        zh_u, en_u = p["zh"]["url"], p["en"]["url"]
        for primary in (zh_u, en_u):
            url_entries.append(
                "\n".join(
                    [
                        "  <url>",
                        f"    <loc>{xml_escape(base_url + primary)}</loc>",
                        f"    <lastmod>{p['updated']}</lastmod>",
                        f'    <xhtml:link rel="alternate" hreflang="zh-Hans" href="{xml_escape(base_url + zh_u)}" />',
                        f'    <xhtml:link rel="alternate" hreflang="en" href="{xml_escape(base_url + en_u)}" />',
                        "  </url>",
                    ]
                )
            )

    sitemap_xml = "\n".join(
        [
            '<?xml version="1.0" encoding="UTF-8"?>',
            '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
            *url_entries,
            "</urlset>",
            "",
        ]
    )
    ET.fromstring(sitemap_xml)
    register("sitemap.xml", sitemap_xml)

    # 7. robots.txt
    robots_txt = "\n".join(
        [
            f"# {site['name']} welcomes both human search engines and AI agents.",
            f"# Agent discovery manifest: {base_url}/llms.txt",
            "User-agent: *",
            "Allow: /",
            "",
            f"Sitemap: {base_url}/sitemap.xml",
            "",
        ]
    )
    register("robots.txt", robots_txt)
    return outputs


def atomic_write_text(path: Path, content: str) -> bool:
    """Atomically write UTF-8 text with LF newlines; returns True only if raw bytes changed."""
    desired_bytes = content.encode("utf-8")
    if path.is_file():
        try:
            if path.read_bytes() == desired_bytes:
                return False
        except OSError:
            pass
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(desired_bytes)
        os.replace(tmp_name, path)
    except Exception:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise
    return True


def merged_headers_text(public_dir: Path) -> str | None:
    chunks: list[str] = []
    engine_headers = ENGINE_DIR / "_headers"
    site_headers = public_dir / "_headers"
    if engine_headers.is_file():
        chunks.append(read_utf8_exact(engine_headers).replace("\r\n", "\n").rstrip())
    if site_headers.is_file():
        chunks.append(read_utf8_exact(site_headers).replace("\r\n", "\n").rstrip())
    if not chunks:
        return None
    return "\n\n".join(chunks) + "\n"


class PageAuditor(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.html_lang: str | None = None
        self.in_title = False
        self.title = ""
        self.in_dialog = 0
        self.main_h1_count = 0
        self.has_description = False
        self.has_color_scheme = False
        self.has_md_alternate = False
        self.md_alternate_href: str | None = None
        self.canonical_href: str | None = None
        self.hreflangs: dict[str, str] = {}
        self.json_ld_blocks: list[str] = []
        self._in_json_ld = False
        self._json_ld_buf: list[str] = []
        self.ids: set[str] = set()
        self.hero_fold_count = 0
        self.has_expect_hero = False
        self.header_site_name: str | None = None
        self.header_site_author: str | None = None
        self.header_issue_order: str | None = None
        self.links: list[str] = []
        self.archive_rows: list[dict[str, str]] = []
        self._in_dispatch_title = False
        self._current_row: dict[str, str] | None = None
        self._dispatch_title_buf: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attr_map = {k.lower(): (v or "") for k, v in attrs}
        t = tag.lower()
        if attr_map.get("id"):
            self.ids.add(attr_map["id"])
            if attr_map["id"] == "hero-fold":
                self.hero_fold_count += 1

        if t == "html":
            self.html_lang = attr_map.get("lang")
        elif t == "header" and "site-header" in attr_map.get("class", "").split():
            self.header_site_name = attr_map.get("data-site-name")
            self.header_site_author = attr_map.get("data-site-author")
            self.header_issue_order = attr_map.get("data-issue-order")
        elif t == "title":
            self.in_title = True
        elif t == "dialog":
            self.in_dialog += 1
        elif t == "h1" and self.in_dialog == 0:
            self.main_h1_count += 1
        elif t == "meta":
            name = attr_map.get("name", "").lower()
            if name == "description" and attr_map.get("content", "").strip():
                self.has_description = True
            if name == "color-scheme" and "light" in attr_map.get("content", ""):
                self.has_color_scheme = True
        elif t == "link":
            rel = attr_map.get("rel", "").lower()
            href = attr_map.get("href", "")
            if rel == "canonical" and href:
                self.canonical_href = href
            if rel == "alternate" and attr_map.get("type", "").lower() == "text/markdown":
                self.has_md_alternate = True
                self.md_alternate_href = href
            if rel == "alternate" and attr_map.get("hreflang") and href:
                self.hreflangs[attr_map["hreflang"]] = href
            if rel == "expect" and href == "#hero-fold" and attr_map.get("blocking", "").lower() == "render":
                self.has_expect_hero = True
            if href and rel in ("stylesheet", "icon", "alternate", "preload"):
                self.links.append(href)
        elif t == "script":
            if attr_map.get("type", "").lower() == "application/ld+json":
                self._in_json_ld = True
                self._json_ld_buf = []
            if attr_map.get("src"):
                self.links.append(attr_map["src"])
        elif t in ("a", "img", "source"):
            ref = attr_map.get("href") or attr_map.get("src") or ""
            if ref:
                self.links.append(ref)
            if t == "a" and self._in_dispatch_title and self._current_row is not None:
                self._current_row["href"] = attr_map.get("href", "")
        elif t == "li" and attr_map.get("data-post-slug") and attr_map.get("data-tier"):
            self._current_row = {
                "slug": attr_map.get("data-post-slug", ""),
                "tier": attr_map.get("data-tier", ""),
                "concepts": attr_map.get("data-concepts", ""),
                "href": "",
                "title": "",
            }
            self.archive_rows.append(self._current_row)
        elif t == "h2" and "dispatch-title" in attr_map.get("class", "").split():
            self._in_dispatch_title = True
            self._dispatch_title_buf = []

    def handle_endtag(self, tag: str) -> None:
        t = tag.lower()
        if t == "title":
            self.in_title = False
        elif t == "dialog" and self.in_dialog > 0:
            self.in_dialog -= 1
        elif t == "script" and self._in_json_ld:
            self._in_json_ld = False
            self.json_ld_blocks.append("".join(self._json_ld_buf).strip())
            self._json_ld_buf = []
        elif t == "h2" and self._in_dispatch_title:
            self._in_dispatch_title = False
            if self._current_row is not None:
                self._current_row["title"] = "".join(self._dispatch_title_buf).strip()
        elif t == "li" and self._current_row is not None:
            self._current_row = None

    def handle_data(self, data: str) -> None:
        if self.in_title:
            self.title += data
        if self._in_json_ld:
            self._json_ld_buf.append(data)
        if self._in_dispatch_title:
            self._dispatch_title_buf.append(data)


def _match_in_root(
    root_dir: Path,
    rel_path: str,
    *,
    virtual_paths: set[Path] | None = None,
) -> Path | None:
    root_res = root_dir.resolve()
    target = (root_res / rel_path.lstrip("/")).resolve()
    try:
        target.relative_to(root_res)
    except ValueError:
        return None
    if target.is_file() or (virtual_paths is not None and target in virtual_paths):
        return target
    idx = (target / "index.html").resolve()
    if (target.is_dir() and idx.is_file()) or (virtual_paths is not None and idx in virtual_paths):
        return idx
    return None


def resolve_local_ref(
    source_file: Path,
    ref: str,
    base_url: str,
    public_dir: Path,
    *,
    virtual_paths: set[Path] | None = None,
) -> tuple[Path | None, str | None]:
    """Resolve a local or same-origin URL against site public/ (including planned virtual outputs) overlaid on engine/."""
    raw = ref.strip()
    if not raw or raw.startswith(("mailto:", "tel:", "data:", "javascript:")):
        return None, None
    if raw.startswith(base_url + "/") or raw == base_url:
        raw = raw[len(base_url) :] or "/"
    elif raw.startswith(("http://", "https://")):
        return None, None

    before_hash, _, fragment = raw.partition("#")
    clean = before_hash.split("?", 1)[0].strip()
    frag = fragment.strip() or None

    if not clean:
        return source_file, frag

    if clean.startswith("/"):
        found = _match_in_root(public_dir, clean, virtual_paths=virtual_paths)
        if found is None and ENGINE_DIR.is_dir():
            found = _match_in_root(ENGINE_DIR, clean, virtual_paths=virtual_paths)
        return found, frag

    source_res = source_file.resolve()
    pub_res = public_dir.resolve()
    eng_res = ENGINE_DIR.resolve()
    allowed_root: Path | None = None
    for candidate_root in (pub_res, eng_res):
        try:
            source_res.relative_to(candidate_root)
            allowed_root = candidate_root
            break
        except ValueError:
            continue
    if allowed_root is None:
        return None, frag

    target = (source_res.parent / clean).resolve()
    try:
        rel_inside = target.relative_to(allowed_root).as_posix()
    except ValueError:
        return None, frag

    found = _match_in_root(public_dir, "/" + rel_inside, virtual_paths=virtual_paths)
    if found is None and ENGINE_DIR.is_dir():
        found = _match_in_root(ENGINE_DIR, "/" + rel_inside, virtual_paths=virtual_paths)
    return found, frag


def check_no_links_in_tree(root_dir: Path, label: str) -> list[str]:
    errors: list[str] = []
    if is_link_or_junction(root_dir):
        return [f"{label}: root directory is a symlink or junction"]
    for dirpath, dirnames, filenames in os.walk(root_dir, followlinks=False):
        dp = Path(dirpath)
        for d in list(dirnames):
            cand = dp / d
            if is_link_or_junction(cand):
                errors.append(f"{label}: symlink/junction directory not permitted: {cand.relative_to(ROOT).as_posix()}")
                dirnames.remove(d)
        for f in filenames:
            cand = dp / f
            if is_link_or_junction(cand):
                errors.append(f"{label}: symlink/junction file not permitted: {cand.relative_to(ROOT).as_posix()}")
    return errors


def audit_site(
    site_name: str,
    catalog: dict,
    site_root: Path,
    public_dir: Path,
    expect_base_url: str | None = None,
    *,
    virtual_files: dict[Path, str] | None = None,
) -> list[str]:
    """
    Audit site invariants. When virtual_files is provided, read proposed in-memory updates
    from virtual_files before falling back to disk (enabling pre-commit validation).
    """
    errors = validate_catalog(site_name, catalog, site_root, public_dir, expect_base_url=expect_base_url)
    stream_data, stream_load_errs = load_stream_data(site_root, public_dir)
    errors.extend(stream_load_errs)
    if stream_data is not None:
        errors.extend(validate_stream(stream_data, catalog))
    if errors:
        return errors

    errors.extend(check_no_links_in_tree(ENGINE_DIR, "engine"))
    errors.extend(check_no_links_in_tree(public_dir, f"sites/{site_name}/public"))

    vmap = {p.resolve(): content for p, content in (virtual_files or {}).items()}
    vpaths = set(vmap.keys()) if vmap else None

    def read_maybe_virtual(path: Path) -> str | None:
        res = path.resolve()
        if res in vmap:
            return vmap[res]
        if not path.is_file():
            return None
        return read_utf8_exact(path)

    base_url = catalog["site"]["base_url"].rstrip("/")
    partials = load_partials()
    expected_issue_order = compute_issue_order(catalog)

    # 1. Regenerate expected derived artifacts in memory and verify exact UTF-8/LF byte parity
    try:
        twins, expected_twins = build_markdown_twins(catalog, site_root, public_dir)
        stream_twins: dict[str, str] | None = None
        expected_stream_artifacts: dict[Path, str] = {}
        if stream_data is not None:
            stream_twins, expected_stream_artifacts = build_stream_artifacts(catalog, stream_data, public_dir)
        expected_artifacts = build_machine_artifacts(
            catalog, twins, public_dir, stream_data=stream_data, stream_twins=stream_twins
        )
    except Exception as exc:
        return [f"Failed to build expected machine artifacts: {exc}"]

    expected_all: dict[Path, str] = {}
    expected_all.update(expected_twins)
    expected_all.update(expected_stream_artifacts)
    expected_all.update(expected_artifacts)

    for path, expected_content in expected_all.items():
        rel = path.relative_to(ROOT).as_posix()
        try:
            actual = read_maybe_virtual(path)
        except UnicodeDecodeError as exc:
            errors.append(f"{rel}: invalid UTF-8 ({exc})")
            continue
        if actual is None:
            errors.append(f"Missing generated artifact: {rel}")
            continue
        if path.suffix == ".json":
            try:
                json.loads(actual)
            except json.JSONDecodeError as exc:
                errors.append(f"{rel}: invalid JSON ({exc})")
        elif path.suffix == ".xml":
            try:
                ET.fromstring(actual)
            except ET.ParseError as exc:
                errors.append(f"{rel}: invalid XML ({exc})")
        elif path.suffix == ".md":
            try:
                parse_frontmatter_strict(actual)
            except Exception as exc:
                errors.append(f"{rel}: invalid Markdown frontmatter ({exc})")

        if actual != expected_content:
            hint = " (CRLF line endings detected)" if actual.replace("\r\n", "\n") == expected_content else ""
            errors.append(
                f"{rel}: out of sync with catalog/sources{hint} (run 'python tools/editorial_sync.py --site {site_name}')"
            )

    # 2. Verify required static files (shared engine assets + localized 404 pages + _headers)
    for req_engine in (
        "_headers",
        "assets/favicon.svg",
        "assets/css/tokens.css",
        "assets/css/editorial.css",
        "assets/css/motion.css",
        "assets/css/comments.css",
        "assets/css/stream.css",
        "assets/js/site.js",
        "assets/js/transitions.js",
        "assets/js/graph.js",
        "assets/js/cover-model.js",
        "assets/js/comments.js",
        "assets/js/stream.js",
    ):
        if not (ENGINE_DIR / req_engine).is_file():
            errors.append(f"Missing required shared engine artifact: engine/{req_engine}")

    for req_site in ("404.html", "en/404.html"):
        if not (public_dir / req_site).is_file():
            errors.append(f"Missing required static artifact: sites/{site_name}/public/{req_site}")

    # 3. Audit merged _headers rules using shared Cloudflare append/detach evaluator
    hdr_text = merged_headers_text(public_dir)
    if hdr_text is None:
        errors.append("Missing _headers in engine/_headers")
    else:
        rules = parse_headers_text(hdr_text)
        sample_slug = catalog["posts"][0]["slug"]
        utf8_paths = [
            f"/posts/{sample_slug}/index.md",
            f"/en/posts/{sample_slug}/index.md",
            "/stream/index.md",
            "/en/stream/index.md",
            "/llms.txt",
            "/llms-full.txt",
            "/api/posts.json",
            "/api/stream.json",
            "/api/release.json",
            "/rss.xml",
            "/en/rss.xml",
            "/stream/rss.xml",
            "/en/stream/rss.xml",
            "/feed.json",
            "/en/feed.json",
        ]
        for upath in utf8_paths:
            hdrs = evaluate_headers_map(rules, upath)
            cts = hdrs.get("content-type", [])
            if len(cts) != 1 or "charset=utf-8" not in cts[0].lower():
                errors.append(
                    f"_headers: '{upath}' must have exactly one Content-Type with charset=utf-8 (got {cts!r})"
                )
        asset_ccs = evaluate_headers_map(rules, "/assets/js/site.js").get("cache-control", [])
        if any("immutable" in cc.lower() for cc in asset_ccs):
            errors.append("_headers: unhashed '/assets/*' must not set 'immutable' Cache-Control")
        rel_ccs = evaluate_headers_map(rules, "/api/release.json").get("cache-control", [])
        if not rel_ccs or not any("max-age=0" in cc.lower() and "must-revalidate" in cc.lower() for cc in rel_ccs):
            errors.append(
                f"_headers: '/api/release.json' must revalidate on every request (got Cache-Control={rel_ccs!r})"
            )

    # 4. Verify every catalog post (and Stream editions when stream.json exists) has HTML editions
    post_by_url: dict[str, tuple[dict, str]] = {}
    for p in catalog["posts"]:
        for lang in ("zh", "en"):
            loc = p[lang]
            post_by_url[loc["url"]] = (p, lang)
            html_file = public_dir / loc["url"].lstrip("/") / "index.html"
            if not html_file.is_file():
                errors.append(f"Missing HTML edition: {html_file.relative_to(ROOT).as_posix()}")

    if stream_data is not None:
        for stream_rel in ("stream/index.html", "en/stream/index.html"):
            if not (public_dir / stream_rel).is_file():
                errors.append(f"Missing Stream HTML edition: sites/{site_name}/public/{stream_rel}")

    # 5. Parse all HTML pages (pass 1: collect IDs and structural audits)
    html_files = sorted(public_dir.rglob("*.html"))
    auditors: dict[Path, PageAuditor] = {}

    for html_file in html_files:
        raw = read_maybe_virtual(html_file)
        assert raw is not None
        rel = html_file.relative_to(ROOT).as_posix()
        url_path = rel_url_from_html(html_file, public_dir)
        lang = detect_lang(url_path, raw)
        is_post = "/posts/" in url_path
        is_stream = url_path in ("/stream/", "/en/stream/")
        is_404 = url_path in ("/404.html", "/en/404.html")

        if not HEADER_RE.search(raw):
            errors.append(f"{rel}: missing <!-- @partial:header --> markers")
        if not FOOTER_RE.search(raw):
            errors.append(f"{rel}: missing <!-- @partial:footer --> markers")
        if is_stream and stream_data is not None and not STREAM_RE.search(raw):
            errors.append(f"{rel}: missing <!-- @partial:stream --> markers")
        if HEADER_RE.search(raw) and FOOTER_RE.search(raw):
            expected_html = apply_partials_to_html(raw, url_path, partials, catalog, stream_data=stream_data)
            if expected_html != raw:
                errors.append(
                    f"{rel}: partial content out of sync (run 'python tools/editorial_sync.py --site {site_name}')"
                )

        auditor = PageAuditor()
        auditor.feed(raw)
        auditors[html_file.resolve()] = auditor

        if not auditor.html_lang:
            errors.append(f"{rel}: missing <html lang>")
        if not auditor.title.strip():
            errors.append(f"{rel}: empty <title>")
        if not auditor.has_description:
            errors.append(f'{rel}: missing <meta name="description">')
        if not auditor.has_color_scheme:
            errors.append(f'{rel}: missing <meta name="color-scheme" content="light dark">')
        if auditor.main_h1_count != 1:
            errors.append(f"{rel}: expected exactly 1 main <h1>, found {auditor.main_h1_count}")
        if not INLINE_VT_OPTIN_RE.search(raw):
            errors.append(
                f"{rel}: missing inline <style>@media (prefers-reduced-motion: no-preference){{@view-transition{{navigation:auto;}}}}</style> in <head>"
            )
        if auditor.hero_fold_count != 1:
            errors.append(f"{rel}: expected exactly 1 id='hero-fold', found {auditor.hero_fold_count}")
        if not auditor.has_expect_hero:
            errors.append(f'{rel}: missing <link rel="expect" href="#hero-fold" blocking="render">')

        if auditor.header_site_name != catalog["site"]["name"]:
            errors.append(
                f"{rel}: header data-site-name mismatch (expected {catalog['site']['name']!r}, got {auditor.header_site_name!r})"
            )
        if auditor.header_site_author != catalog["site"]["author"]:
            errors.append(
                f"{rel}: header data-site-author mismatch (expected {catalog['site']['author']!r}, got {auditor.header_site_author!r})"
            )
        try:
            parsed_order = json.loads(auditor.header_issue_order or "")
            if parsed_order != expected_issue_order:
                errors.append(f"{rel}: header data-issue-order out of sync with catalog.json")
        except Exception:
            errors.append(f"{rel}: header data-issue-order missing or invalid JSON")

        if not is_404:
            expected_canonical = base_url + url_path
            if auditor.canonical_href != expected_canonical:
                errors.append(
                    f"{rel}: canonical mismatch (expected {expected_canonical!r}, got {auditor.canonical_href!r})"
                )
            zh_u = counterpart_url(url_path, "en") if lang == "en" else url_path
            en_u = url_path if lang == "en" else counterpart_url(url_path, "zh")
            if auditor.hreflangs.get("zh-Hans") != base_url + zh_u:
                errors.append(
                    f"{rel}: hreflang='zh-Hans' mismatch (expected {base_url + zh_u!r}, got {auditor.hreflangs.get('zh-Hans')!r})"
                )
            if auditor.hreflangs.get("en") != base_url + en_u:
                errors.append(
                    f"{rel}: hreflang='en' mismatch (expected {base_url + en_u!r}, got {auditor.hreflangs.get('en')!r})"
                )

            if not auditor.json_ld_blocks:
                errors.append(f"{rel}: missing JSON-LD structured data")
            else:
                for idx, block in enumerate(auditor.json_ld_blocks):
                    try:
                        ld = json.loads(block)
                    except json.JSONDecodeError as exc:
                        errors.append(f"{rel}: invalid JSON-LD block #{idx + 1} ({exc})")
                        continue
                    if not isinstance(ld, dict) or not ld.get("@context") or not ld.get("@type"):
                        errors.append(f"{rel}: JSON-LD block #{idx + 1} missing @context or @type")
                        continue
                    if ld.get("url") != expected_canonical:
                        errors.append(
                            f"{rel}: JSON-LD url mismatch (expected {expected_canonical!r}, got {ld.get('url')!r})"
                        )
                    if is_post and url_path in post_by_url:
                        post_obj, post_lang = post_by_url[url_path]
                        if ld.get("headline") != post_obj[post_lang]["title"]:
                            errors.append(f"{rel}: JSON-LD headline does not match catalog title")
                        if ld.get("datePublished") != post_obj["date"]:
                            errors.append(f"{rel}: JSON-LD datePublished mismatch")
                        if ld.get("dateModified") != post_obj["updated"]:
                            errors.append(f"{rel}: JSON-LD dateModified mismatch")

        if (is_post or (is_stream and stream_data is not None)) and not auditor.has_md_alternate:
            errors.append(f'{rel}: missing <link rel="alternate" type="text/markdown">')

    # 6. Pass 2: verify every local link & fragment anchor across all HTML files
    for html_file in html_files:
        rel = html_file.relative_to(ROOT).as_posix()
        auditor = auditors[html_file.resolve()]
        for ref in auditor.links:
            trimmed = ref.strip()
            if not trimmed or trimmed.startswith(("mailto:", "tel:", "data:", "javascript:")):
                continue
            if trimmed.startswith(("http://", "https://")) and not (
                trimmed == base_url or trimmed.startswith(base_url + "/")
            ):
                continue
            target, frag = resolve_local_ref(html_file, trimmed, base_url, public_dir, virtual_paths=vpaths)
            if target is None:
                errors.append(f"{rel}: broken local reference '{ref}'")
                continue
            if frag and target.suffix == ".html":
                target_auditor = auditors.get(target.resolve())
                if target_auditor is not None and frag not in target_auditor.ids:
                    errors.append(f"{rel}: broken fragment '#{frag}' on '{ref}'")

    # 7. Verify Homepage & Archive curation matches catalog.json
    for lang, home_rel, arch_rel in (
        ("zh", "index.html", "archive/index.html"),
        ("en", "en/index.html", "en/archive/index.html"),
    ):
        home_path = (public_dir / home_rel).resolve()
        home_auditor = auditors.get(home_path)
        if home_auditor is not None:
            home_links = set(home_auditor.links)
            for p in catalog["posts"]:
                if p[lang]["url"] not in home_links:
                    errors.append(
                        f"sites/{site_name}/public/{home_rel}: missing link to catalog post '{p[lang]['url']}'"
                    )

        arch_path = (public_dir / arch_rel).resolve()
        arch_auditor = auditors.get(arch_path)
        if arch_auditor is not None:
            row_by_slug = {r["slug"]: r for r in arch_auditor.archive_rows}
            for p in catalog["posts"]:
                slug = p["slug"]
                if slug not in row_by_slug:
                    errors.append(f"sites/{site_name}/public/{arch_rel}: missing archive row for '{slug}'")
                    continue
                row = row_by_slug[slug]
                if row["tier"] != p["tier"]:
                    errors.append(
                        f"sites/{site_name}/public/{arch_rel}: row '{slug}' tier mismatch ({row['tier']} != {p['tier']})"
                    )
                row_concepts = [c for c in row["concepts"].split(",") if c]
                if set(row_concepts) != set(p["concepts"]):
                    errors.append(f"sites/{site_name}/public/{arch_rel}: row '{slug}' concepts mismatch")
                if row["href"] != p[lang]["url"]:
                    errors.append(
                        f"sites/{site_name}/public/{arch_rel}: row '{slug}' href mismatch ({row['href']} != {p[lang]['url']})"
                    )
                if row["title"] != p[lang]["title"]:
                    errors.append(
                        f"sites/{site_name}/public/{arch_rel}: row '{slug}' title mismatch with catalog"
                    )

    # 8. Verify static local asset references inside CSS url(...) and JS fetch('/...')
    scan_roots = [d for d in (ENGINE_DIR, public_dir) if d.is_dir()]
    for scan_root in scan_roots:
        for css_file in sorted(scan_root.rglob("*.css")):
            css_text = css_file.read_text(encoding="utf-8")
            css_rel = css_file.relative_to(ROOT).as_posix()
            for m in CSS_URL_RE.finditer(css_text):
                ref = (m.group(2) or m.group(3) or "").strip()
                if not ref or ref.startswith(("data:", "http://", "https://", "#")):
                    continue
                target, _ = resolve_local_ref(css_file, ref, base_url, public_dir, virtual_paths=vpaths)
                if target is None:
                    errors.append(f"{css_rel}: broken CSS url('{ref}')")

        for js_file in sorted(scan_root.rglob("*.js")):
            js_text = js_file.read_text(encoding="utf-8")
            js_rel = js_file.relative_to(ROOT).as_posix()
            for m in JS_FETCH_RE.finditer(js_text):
                ref = m.group(2).strip()
                if any(ref == p or ref.startswith(p + "/") for p in DYNAMIC_WORKER_API_PREFIXES):
                    continue
                target, _ = resolve_local_ref(js_file, ref, base_url, public_dir, virtual_paths=vpaths)
                if target is None:
                    errors.append(f"{js_rel}: broken JS fetch('{ref}')")

    # 9. Verify shared engine transitions.js reads DOM-injected dataset.issueOrder
    transitions_path = ENGINE_DIR / "assets" / "js" / "transitions.js"
    if transitions_path.is_file():
        t_raw = transitions_path.read_text(encoding="utf-8")
        if "dataset.issueOrder" not in t_raw:
            errors.append(
                "engine/assets/js/transitions.js: expected runtime lookup of '.site-header' dataset.issueOrder"
            )

    return errors


def sync_site_atomically(
    site_name: str,
    catalog: dict,
    site_root: Path,
    public_dir: Path,
    expect_base_url: str | None = None,
) -> tuple[int, int]:
    """Build & validate the complete proposed output in memory before committing per-file atomic writes."""
    errors = validate_catalog(site_name, catalog, site_root, public_dir, expect_base_url=expect_base_url)
    stream_data, stream_load_errs = load_stream_data(site_root, public_dir)
    errors.extend(stream_load_errs)
    if stream_data is not None:
        errors.extend(validate_stream(stream_data, catalog))
    if errors:
        raise ValueError("\n".join(errors))

    partials = load_partials()
    twins, twin_files = build_markdown_twins(catalog, site_root, public_dir)
    stream_twins: dict[str, str] | None = None
    stream_artifact_files: dict[Path, str] = {}
    if stream_data is not None:
        stream_twins, stream_artifact_files = build_stream_artifacts(catalog, stream_data, public_dir)
    artifact_files = build_machine_artifacts(
        catalog, twins, public_dir, stream_data=stream_data, stream_twins=stream_twins
    )

    html_updates: dict[Path, str] = {}
    for html_file in sorted(public_dir.rglob("*.html")):
        assert_contained_no_links(html_file, public_dir, label=f"HTML page {html_file.name}")
        raw = read_utf8_exact(html_file)
        normalized = raw.replace("\r\n", "\n")
        url_path = rel_url_from_html(html_file, public_dir)
        new_content = apply_partials_to_html(normalized, url_path, partials, catalog, stream_data=stream_data)
        if new_content != raw:
            html_updates[html_file] = new_content

    planned: dict[Path, str] = {**html_updates, **twin_files, **stream_artifact_files, **artifact_files}

    # M9: Validate the complete proposed state BEFORE modifying a single file on disk
    pre_errors = audit_site(
        site_name,
        catalog,
        site_root,
        public_dir,
        expect_base_url=expect_base_url,
        virtual_files=planned,
    )
    if pre_errors:
        raise ValueError("Pre-commit audit failed (no files modified):\n" + "\n".join(f"  - {e}" for e in pre_errors))

    written_html = 0
    written_total = 0
    try:
        for path, content in html_updates.items():
            if atomic_write_text(path, content):
                written_html += 1
                written_total += 1
        for path, content in {**twin_files, **stream_artifact_files, **artifact_files}.items():
            if atomic_write_text(path, content):
                written_total += 1
    except Exception as exc:
        raise RuntimeError(
            f"Write failed after updating {written_total} file(s); working tree may be partially updated: {exc}"
        ) from exc

    return written_html, len(twins)


def _copy_tree_strict(src_root: Path, dst_root: Path) -> None:
    """Copy directory tree strictly without following symlinks or junctions (M6)."""
    if is_link_or_junction(src_root):
        raise ValueError(f"Refusing to stage symlink/junction root: {src_root}")
    for dirpath, dirnames, filenames in os.walk(src_root, followlinks=False):
        dp = Path(dirpath)
        rel_dir = dp.relative_to(src_root)
        if any(part.startswith(".") and part != "_headers" for part in rel_dir.parts):
            dirnames[:] = []
            continue
        for d in list(dirnames):
            cand = dp / d
            if is_link_or_junction(cand):
                raise ValueError(f"Refusing to stage symlink/junction directory: {cand}")
            if d.startswith("."):
                dirnames.remove(d)
        target_dir = dst_root / rel_dir
        target_dir.mkdir(parents=True, exist_ok=True)
        for f in filenames:
            if f.startswith(".") and f != "_headers":
                continue
            src_file = dp / f
            if is_link_or_junction(src_file):
                raise ValueError(f"Refusing to stage symlink/junction file: {src_file}")
            dst_file = target_dir / f
            shutil.copy2(src_file, dst_file)


def _compute_bundle_sha256(bundle_dir: Path) -> str:
    h = hashlib.sha256()
    for path in sorted(p for p in bundle_dir.rglob("*") if p.is_file()):
        rel = path.relative_to(bundle_dir).as_posix()
        if rel == "api/release.json":
            continue
        data = path.read_bytes()
        h.update(rel.encode("utf-8"))
        h.update(b"\0")
        h.update(str(len(data)).encode("ascii"))
        h.update(b"\0")
        h.update(data)
    return h.hexdigest()


def _detect_git_sha() -> str:
    env_sha = os.environ.get("GITHUB_SHA", "").strip()
    if env_sha:
        return env_sha
    try:
        res = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=ROOT,
            capture_output=True,
            text=True,
            timeout=5,
        )
        if res.returncode == 0:
            return res.stdout.strip()
    except Exception:
        pass
    return ""


def stage_site_dist(
    site_name: str,
    catalog: dict,
    public_dir: Path,
    *,
    stage_dir: Path | None = None,
) -> Path:
    """
    Assemble a clean flat Cloudflare deployment bundle (engine/ + site public/ + api/release.json).
    Supports immutable per-invocation `--stage-dir` or lock-coordinated `.dist/<site>`.
    """
    if stage_dir is not None:
        target_dir = stage_dir.resolve()
        if target_dir.exists():
            raise ValueError(f"--stage-dir target already exists (must be a fresh path): {target_dir}")
        target_dir.parent.mkdir(parents=True, exist_ok=True)
        tmp_dir = target_dir.parent / f".{target_dir.name}.staging.{os.getpid()}"
        if tmp_dir.exists():
            shutil.rmtree(tmp_dir)
        try:
            _populate_stage(tmp_dir, site_name, catalog, public_dir)
            os.replace(tmp_dir, target_dir)
        except Exception:
            shutil.rmtree(tmp_dir, ignore_errors=True)
            raise
        return target_dir

    DIST_DIR.mkdir(parents=True, exist_ok=True)
    lock_path = DIST_DIR / f".{site_name}.lock"
    final_dir = DIST_DIR / site_name
    pid = os.getpid()
    tmp_dir = DIST_DIR / f".{site_name}.staging.{pid}"
    old_dir = DIST_DIR / f".{site_name}.old.{pid}"

    with file_lock(lock_path):
        # Recover if a previous interrupted swap left final_dir missing with an .old backup
        if not final_dir.exists():
            orphaned_olds = sorted(DIST_DIR.glob(f".{site_name}.old.*"))
            if orphaned_olds:
                os.replace(orphaned_olds[-1], final_dir)

        if tmp_dir.exists():
            shutil.rmtree(tmp_dir)
        if old_dir.exists():
            shutil.rmtree(old_dir)

        try:
            _populate_stage(tmp_dir, site_name, catalog, public_dir)
            if final_dir.exists():
                os.replace(final_dir, old_dir)
            os.replace(tmp_dir, final_dir)
        except Exception:
            shutil.rmtree(tmp_dir, ignore_errors=True)
            if old_dir.exists() and not final_dir.exists():
                os.replace(old_dir, final_dir)
            raise
        finally:
            if old_dir.exists():
                shutil.rmtree(old_dir, ignore_errors=True)

    return final_dir


def _populate_stage(dst_dir: Path, site_name: str, catalog: dict, public_dir: Path) -> None:
    dst_dir.mkdir(parents=True, exist_ok=True)
    _copy_tree_strict(ENGINE_DIR, dst_dir)
    _copy_tree_strict(public_dir, dst_dir)

    hdr_text = merged_headers_text(public_dir)
    if hdr_text is not None:
        (dst_dir / "_headers").write_bytes(hdr_text.encode("utf-8"))

    # Write deterministic release stamp for post-deploy live verification (M1)
    bundle_sha = _compute_bundle_sha256(dst_dir)
    release_meta = {
        "site": site_name,
        "name": catalog["site"]["name"],
        "base_url": catalog["site"]["base_url"].rstrip("/"),
        "post_count": len(catalog["posts"]),
        "bundle_sha256": bundle_sha,
        "git_sha": _detect_git_sha(),
    }
    release_path = dst_dir / "api" / "release.json"
    release_path.parent.mkdir(parents=True, exist_ok=True)
    release_path.write_bytes((json.dumps(release_meta, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))


def run_for_site(
    site_name: str,
    check_only: bool,
    stage: bool,
    expect_base_url: str | None,
    stage_dir: Path | None,
) -> int:
    site_root, catalog_path, public_dir = site_paths(site_name)
    if not catalog_path.is_file():
        print(f"[editorial_sync:{site_name}] FAILED: missing {catalog_path.relative_to(ROOT).as_posix()}")
        return 1

    try:
        catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    except Exception as exc:
        print(f"[editorial_sync:{site_name}] FAILED to load catalog.json: {exc}")
        return 1

    if not check_only:
        try:
            updated, twin_count = sync_site_atomically(
                site_name, catalog, site_root, public_dir, expect_base_url=expect_base_url
            )
        except Exception as exc:
            print(f"[editorial_sync:{site_name}] SYNC FAILED:\n{exc}")
            return 1
        print(
            f"[editorial_sync:{site_name}] Synced partials ({updated} HTML files updated), "
            f"{twin_count} Markdown twins, and all Agent/feed artifacts."
        )

    errors = audit_site(site_name, catalog, site_root, public_dir, expect_base_url=expect_base_url)
    if errors:
        print(f"[editorial_sync:{site_name}] AUDIT FAILED ({len(errors)} issue(s)):")
        for err in errors:
            print(f"  - {err}")
        return 1

    html_count = len(list(public_dir.rglob("*.html")))
    print(
        f"[editorial_sync:{site_name}] AUDIT PASSED — {html_count} HTML pages, "
        f"{len(catalog['posts'])} bilingual issues, base_url={catalog['site']['base_url']}, 0 errors."
    )

    if stage or stage_dir is not None:
        staged_path = stage_site_dist(site_name, catalog, public_dir, stage_dir=stage_dir)
        file_count = sum(1 for p in staged_path.rglob("*") if p.is_file())
        rel_display = (
            staged_path.relative_to(ROOT).as_posix()
            if staged_path.is_relative_to(ROOT)
            else str(staged_path)
        )
        print(
            f"[editorial_sync:{site_name}] STAGED deployment bundle -> "
            f"{rel_display} ({file_count} files)"
        )

    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Deterministic editorial sync, audit gate, and Cloudflare dist stager"
    )
    parser.add_argument("--site", help="Target site name under sites/ (e.g. demo, prod)")
    parser.add_argument("--all", action="store_true", help="Operate on all sites under sites/ (default)")
    parser.add_argument("--check", action="store_true", help="Read-only audit gate (exits non-zero on drift/error)")
    parser.add_argument("--stage", action="store_true", help="Stage flat deploy bundle in .dist/<site> after audit")
    parser.add_argument("--stage-dir", help="Stage into an immutable per-invocation directory (requires --site)")
    parser.add_argument(
        "--expect-base-url",
        help="Domain mismatch guard: require catalog site.base_url to match this URL (requires --site)",
    )
    args = parser.parse_args(argv)

    if args.site and args.all:
        print("[editorial_sync] ERROR: cannot combine --site and --all")
        return 2

    if (args.expect_base_url or args.stage_dir) and not args.site:
        print("[editorial_sync] ERROR: --expect-base-url and --stage-dir require --site <name>")
        return 2

    if args.site:
        if not SITE_NAME_RE.match(args.site):
            print(f"[editorial_sync] ERROR: invalid site name '{args.site}'")
            return 2
        targets = [args.site]
    else:
        targets = discover_sites()
        if not targets:
            print("[editorial_sync] ERROR: no sites discovered under sites/")
            return 1

    stage_dir = Path(args.stage_dir) if args.stage_dir else None
    exit_code = 0
    for target in targets:
        rc = run_for_site(
            target,
            check_only=args.check,
            stage=args.stage,
            expect_base_url=args.expect_base_url,
            stage_dir=stage_dir,
        )
        if rc != 0:
            exit_code = rc
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
