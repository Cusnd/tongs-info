#!/usr/bin/env python3
"""
Tong's Information — Local Preview Server (Zero Dependencies)

Mirrors Cloudflare Workers Static Assets semantics locally with zero-copy engine overlay:
- Overlay mode (`--site demo|prod`): serves sites/<site>/public/ overlaid on top of engine/
- Flat mode (`--dir .dist/demo`): serves a staged flat deployment directory verbatim
- Applies merged _headers rules using shared append/detach evaluator matching Cloudflare Workers
- Blocks direct access to `_headers` / `_redirects` even via percent-encoded or alternate spellings
- Rejects symlinks and Windows junctions outside publish roots
- Implements Cloudflare `auto-trailing-slash` canonical redirects (307 for `/about` -> `/about/`
  and `/about/index.html` -> `/about/`) and localized 404-page handling (/en/404.html & /404.html)

Usage:
  python tools/preview_server.py --site demo --port 8788
  python tools/preview_server.py --site prod --port 8789
  python tools/preview_server.py --dir .dist/prod --port 8790
"""

from __future__ import annotations

import argparse
import http.server
import mimetypes
import os
import posixpath
import socketserver
import sys
import urllib.parse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _headers_eval import HeaderRule, evaluate_headers, parse_headers_file

ROOT = Path(__file__).resolve().parent.parent
ENGINE_DIR = ROOT / "engine"
SITES_DIR = ROOT / "sites"
PROTECTED_FILENAMES = {"_headers", "_redirects"}

UTF8_MEDIA_TYPES: dict[str, str] = {
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".xml": "application/xml; charset=utf-8",
    ".svg": "image/svg+xml",
}


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
            return bool(attrs & 0x400)  # FILE_ATTRIBUTE_REPARSE_POINT
        except OSError:
            return False
    return False


def safe_candidate_in_root(root: Path, rel_path: str) -> Path | None:
    """Resolve rel_path strictly inside root, rejecting path traversal, links, and protected files."""
    if is_link_or_junction(root):
        return None
    root_res = root.resolve()
    cur = root
    parts = [p for p in rel_path.split("/") if p]
    for part in parts:
        if part in (".", ".."):
            return None
        cur = cur / part
        if is_link_or_junction(cur):
            return None
    candidate = cur.resolve()
    try:
        candidate.relative_to(root_res)
    except ValueError:
        return None
    if candidate.name.lower() in PROTECTED_FILENAMES:
        return None
    return candidate


class PreviewRequestHandler(http.server.BaseHTTPRequestHandler):
    roots: list[Path] = []
    header_rules: list[HeaderRule] = []
    quiet: bool = False

    def log_message(self, format: str, *args: object) -> None:
        if not self.quiet:
            super().log_message(format, *args)

    def _normalize_req_path(self, raw_path: str) -> str:
        decoded = urllib.parse.unquote(raw_path)
        norm = posixpath.normpath(decoded)
        if not norm.startswith("/"):
            norm = "/" + norm
        if decoded.endswith("/") and not norm.endswith("/"):
            norm += "/"
        return norm

    def _safe_candidates(self, norm_path: str) -> list[Path]:
        rel = norm_path.lstrip("/")
        resolved: list[Path] = []
        for root in self.roots:
            cand = safe_candidate_in_root(root, rel)
            if cand is not None:
                resolved.append(cand)
        return resolved

    def _guess_content_type(self, file_path: Path) -> str:
        ext = file_path.suffix.lower()
        if ext in UTF8_MEDIA_TYPES:
            return UTF8_MEDIA_TYPES[ext]
        ctype, _ = mimetypes.guess_type(str(file_path))
        if not ctype:
            return "application/octet-stream"
        if ctype.startswith("text/") and "charset=" not in ctype.lower():
            return f"{ctype}; charset=utf-8"
        return ctype

    def _send_redirect(self, location: str) -> None:
        self.send_response(307)
        self.send_header("Location", location)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _send_file(self, status: int, file_path: Path, req_path: str, head_only: bool) -> None:
        if is_link_or_junction(file_path) or file_path.name.lower() in PROTECTED_FILENAMES:
            self._send_404(req_path, head_only)
            return
        body = file_path.read_bytes()
        header_pairs = evaluate_headers(self.header_rules, req_path)
        has_ct = any(k.lower() == "content-type" for k, _ in header_pairs)
        if not has_ct:
            header_pairs.append(("Content-Type", self._guess_content_type(file_path)))

        self.send_response(status)
        for name, val in header_pairs:
            self.send_header(name, val)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if not head_only:
            self.wfile.write(body)

    def _send_404(self, req_path: str, head_only: bool) -> None:
        is_en_path = req_path == "/en" or req_path.startswith("/en/")
        rel_candidates = ["en/404.html", "404.html"] if is_en_path else ["404.html"]
        for rel in rel_candidates:
            for root in self.roots:
                page = safe_candidate_in_root(root, rel)
                if page is not None and page.is_file():
                    self._send_file(404, page, req_path, head_only)
                    return
        body = b"404 Not Found\n"
        self.send_response(404)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if not head_only:
            self.wfile.write(body)

    def _handle(self, head_only: bool) -> None:
        parsed = urllib.parse.urlsplit(self.path)
        norm_path = self._normalize_req_path(parsed.path or "/")
        query = f"?{parsed.query}" if parsed.query else ""

        # Block protected metadata files after full URL decoding & normalization
        last_segment = norm_path.rstrip("/").rsplit("/", 1)[-1].lower()
        if last_segment in PROTECTED_FILENAMES:
            self._send_404(norm_path, head_only)
            return

        # Mirror Cloudflare `auto-trailing-slash`: canonicalize explicit `/index.html` -> `/`
        if norm_path == "/index.html" or norm_path.endswith("/index.html"):
            canonical_dir = norm_path[: -len("index.html")] or "/"
            dir_cands = self._safe_candidates(canonical_dir)
            if any(c.is_dir() and (c / "index.html").is_file() for c in dir_cands):
                self._send_redirect(f"{canonical_dir}{query}")
                return

        # Mirror Cloudflare `auto-trailing-slash`: canonicalize standalone `*.html` -> extensionless URL (M7)
        if norm_path.endswith(".html") and not norm_path.endswith("/index.html"):
            exact_html_cands = self._safe_candidates(norm_path)
            if any(c.is_file() for c in exact_html_cands):
                clean_url = norm_path[: -len(".html")] or "/"
                self._send_redirect(f"{clean_url}{query}")
                return

        candidates = self._safe_candidates(norm_path)
        if not candidates:
            self._send_404(norm_path, head_only)
            return

        # 1. Exact file match wins across overlay roots
        for target in candidates:
            if target.is_file():
                self._send_file(200, target, norm_path, head_only)
                return

        # 2. Directory with auto-trailing-slash & index.html resolution
        dir_matches = [c for c in candidates if c.is_dir()]
        if dir_matches:
            if not norm_path.endswith("/"):
                self._send_redirect(f"{norm_path}/{query}")
                return
            for d in dir_matches:
                index_file = safe_candidate_in_root(d, "index.html")
                if index_file is not None and index_file.is_file():
                    self._send_file(200, index_file, norm_path, head_only)
                    return
            self._send_404(norm_path, head_only)
            return

        # 3. Clean URL fallback ONLY when the final segment has no file extension (M7)
        if last_segment and "." not in last_segment:
            clean_rel = norm_path.strip("/")
            for root in self.roots:
                html_alt = safe_candidate_in_root(root, clean_rel + ".html")
                if html_alt is not None and html_alt.is_file():
                    if norm_path.endswith("/"):
                        self._send_redirect(f"/{clean_rel}{query}")
                        return
                    self._send_file(200, html_alt, norm_path, head_only)
                    return

        self._send_404(norm_path, head_only)

    def do_GET(self) -> None:
        self._handle(head_only=False)

    def do_HEAD(self) -> None:
        self._handle(head_only=True)


class ReusableThreadingHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    allow_reuse_address = True
    daemon_threads = True


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Tong's Information local preview server")
    parser.add_argument("--host", default="127.0.0.1", help="Bind host (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8788, help="Bind port (default: 8788)")
    parser.add_argument("--site", help="Site name under sites/ (overlays sites/<site>/public on engine/)")
    parser.add_argument("--dir", help="Serve a flat static directory directly (e.g. .dist/demo)")
    parser.add_argument("--quiet", action="store_true", help="Suppress per-request access logs")
    args = parser.parse_args(argv)

    if args.dir and args.site:
        raise SystemExit("[preview_server] ERROR: specify either --site or --dir, not both.")

    if args.dir:
        flat_dir = Path(args.dir).resolve()
        if not flat_dir.is_dir():
            raise SystemExit(f"[preview_server] ERROR: directory not found: {flat_dir}")
        roots = [flat_dir]
        rules = parse_headers_file(flat_dir / "_headers")
        mode_desc = f"flat dir {flat_dir}"
    else:
        site_name = args.site or "demo"
        site_public = (SITES_DIR / site_name / "public").resolve()
        if not site_public.is_dir():
            raise SystemExit(f"[preview_server] ERROR: site public directory not found: {site_public}")
        roots = [site_public]
        if ENGINE_DIR.is_dir():
            roots.append(ENGINE_DIR.resolve())
        rules = parse_headers_file(ENGINE_DIR / "_headers") + parse_headers_file(site_public / "_headers")
        mode_desc = f"site '{site_name}' ({site_public} + engine/)"

    handler_cls = type(
        "ConfiguredPreviewHandler",
        (PreviewRequestHandler,),
        {"roots": roots, "header_rules": rules, "quiet": args.quiet},
    )
    server = ReusableThreadingHTTPServer((args.host, args.port), handler_cls)
    print(
        f"[preview_server] Serving {mode_desc} at http://{args.host}:{args.port}/ "
        f"({len(rules)} _headers rules)",
        flush=True,
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[preview_server] Stopped.")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
