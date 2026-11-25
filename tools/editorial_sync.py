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
INLINE_VT_OPTIN_RE = re.compile(
    r"<head\b[^>]*>.*?<style[^>]*>[^<]*@media\s*\(\s*prefers-reduced-motion\s*:\s*no-preference\s*\)\s*\{\s*@view-transition\s*\{\s*navigation\s*:\s*auto\s*;?\s*\}\s*\}[^<]*</style>.*?</head>",
    re.DOTALL | re.IGNORECASE,
)
SITE_NAME_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
CONCEPT_ID_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
SLUG_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
ISO_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
CSS_URL_RE = re.compile(r"""url\(\s*(?:(['"])(.*?)\1|([^)"'\s]+))\s*\)""")
JS_FETCH_RE = re.compile(r"""\bfetch\(\s*(['"])(/[^'"?#]+)[^'"]*\1""")
RESERVED_OUTPUT_NAMES = {"_headers", "_redirects"}


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
) -> str:
    lang = detect_lang(url_path, raw)
    header_html = render_partial(partials[("header", lang)], url_path, lang, catalog)
    footer_html = render_partial(partials[("footer", lang)], url_path, lang, catalog)
    new_content = HEADER_RE.sub(
        lambda m: f"{m.group(1)}\n{header_html}\n  {m.group(3)}",
        raw,
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
        reg_base = str(registry[site_name].get("base_url", "")).strip().rstrip("/")
        if reg_base and base_url.rstrip("/") != reg_base:
            errors.append(
                f"Registry mismatch: sites/sites.json declares base_url='{reg_base}' for '{site_name}', "
                f"but catalog.json has '{base_url.rstrip('/')}'"
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


def build_machine_artifacts(
    catalog: dict,
    twins: dict[tuple[str, str], str],
    public_dir: Path,
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
        expected_artifacts = build_machine_artifacts(catalog, twins, public_dir)
    except Exception as exc:
        return [f"Failed to build expected machine artifacts: {exc}"]

    expected_all: dict[Path, str] = {}
    expected_all.update(expected_twins)
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
        "assets/js/site.js",
        "assets/js/transitions.js",
        "assets/js/graph.js",
        "assets/js/cover-model.js",
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
            "/llms.txt",
            "/llms-full.txt",
            "/api/posts.json",
            "/api/release.json",
            "/rss.xml",
            "/en/rss.xml",
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

    # 4. Verify every catalog post has HTML editions
    post_by_url: dict[str, tuple[dict, str]] = {}
    for p in catalog["posts"]:
        for lang in ("zh", "en"):
            loc = p[lang]
            post_by_url[loc["url"]] = (p, lang)
            html_file = public_dir / loc["url"].lstrip("/") / "index.html"
            if not html_file.is_file():
                errors.append(f"Missing HTML edition: {html_file.relative_to(ROOT).as_posix()}")

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
        is_404 = url_path in ("/404.html", "/en/404.html")

        if not HEADER_RE.search(raw):
            errors.append(f"{rel}: missing <!-- @partial:header --> markers")
        if not FOOTER_RE.search(raw):
            errors.append(f"{rel}: missing <!-- @partial:footer --> markers")
        if HEADER_RE.search(raw) and FOOTER_RE.search(raw):
            expected_html = apply_partials_to_html(raw, url_path, partials, catalog)
            if expected_html != raw:
                errors.append(
                    f"{rel}: header/footer partial out of sync (run 'python tools/editorial_sync.py --site {site_name}')"
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

        if is_post and not auditor.has_md_alternate:
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
    if errors:
        raise ValueError("\n".join(errors))

    partials = load_partials()
    twins, twin_files = build_markdown_twins(catalog, site_root, public_dir)
    artifact_files = build_machine_artifacts(catalog, twins, public_dir)

    html_updates: dict[Path, str] = {}
    for html_file in sorted(public_dir.rglob("*.html")):
        assert_contained_no_links(html_file, public_dir, label=f"HTML page {html_file.name}")
        raw = read_utf8_exact(html_file)
        normalized = raw.replace("\r\n", "\n")
        url_path = rel_url_from_html(html_file, public_dir)
        new_content = apply_partials_to_html(normalized, url_path, partials, catalog)
        if new_content != raw:
            html_updates[html_file] = new_content

    planned: dict[Path, str] = {**html_updates, **twin_files, **artifact_files}

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
        for path, content in {**twin_files, **artifact_files}.items():
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
