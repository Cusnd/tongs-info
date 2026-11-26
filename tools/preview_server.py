#!/usr/bin/env python3
"""
Tong's Information — Local Preview Server + Comments API Simulator (Zero Dependencies)

Mirrors Cloudflare Workers + Workers Static Assets semantics locally with zero-copy engine overlay:
- Overlay mode (`--site demo|prod`): serves sites/<site>/public/ overlaid on top of engine/
- Flat mode (`--dir .dist/demo`): serves a staged flat deployment directory verbatim
- Local `/api/comments` backend powered by Python stdlib `sqlite3` using `migrations/*.sql`,
  mirroring Origin/Sec-Fetch-Site checks, HMAC gate tokens, single-use nonces, honeypot shadow-drop,
  SHA-256 PoW, sliding-window IP-hash & image quotas (UTC-midnight safe), 1-level replies with
  parent-visibility trigger, R2-equivalent image attachments (complete container + animation budget
  validation, metadata scrubbing, atomic disk writes, private/no-cache + ETag/304, sandbox CSP),
  and Author Key verification/deletion
- Applies merged _headers rules using shared append/detach evaluator matching Cloudflare Workers
- Blocks direct access to `_headers` / `_redirects` even via percent-encoded or alternate spellings
- Rejects symlinks and Windows junctions outside publish roots
- Implements Cloudflare `auto-trailing-slash` canonical redirects and localized 404-page handling

Usage:
  python tools/preview_server.py --site demo --port 8788
  python tools/preview_server.py --site prod --port 8789
  python tools/preview_server.py --dir .dist/prod --port 8790
"""

from __future__ import annotations

import argparse
import base64
import datetime as dt
import hashlib
import hmac
import http.server
import json
import mimetypes
import os
import posixpath
import re
import secrets
import socketserver
import sqlite3
import struct
import sys
import tempfile
import threading
import time
import urllib.parse
import uuid
from email.policy import default as EMAIL_POLICY
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _headers_eval import HeaderRule, evaluate_headers, parse_headers_file

ROOT = Path(__file__).resolve().parent.parent
ENGINE_DIR = ROOT / "engine"
SITES_DIR = ROOT / "sites"
MIGRATIONS_DIR = ROOT / "migrations"
LOCAL_AUTHOR_KEYS_PATH = ROOT / ".cloudflare" / "author-keys.local.json"
PROTECTED_FILENAMES = {"_headers", "_redirects"}
LOOPBACK_HOSTS = {"127.0.0.1", "::1", "localhost"}

SLUG_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
COMMENT_ID_RE = re.compile(r"^[a-zA-Z0-9_-]{8,64}$")
IMAGE_ID_RE = re.compile(r"^img_[a-f0-9]{16,32}$")
URL_COUNT_RE = re.compile(r"(?:https?://|www\.)\S+", re.IGNORECASE)
CONTROL_AND_BIDI_RE = re.compile(r"[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]")

MAX_JSON_BYTES = 16 * 1024
MAX_MULTIPART_BYTES = 7 * 1024 * 1024
MAX_MULTIPART_PARTS = 32
MAX_IMAGES_PER_COMMENT = 3
MAX_IMAGE_BYTES = 2 * 1024 * 1024
MAX_IMAGE_DIMENSION = 4096
MAX_IMAGE_PIXELS = 16_000_000
MAX_ANIM_FRAMES = 120
MAX_ANIM_TOTAL_PIXELS = 64_000_000
MAX_ALT_LEN = 160
HOUR_IMAGE_LIMIT_NORMAL = 9
HOUR_IMAGE_LIMIT_FALLBACK = 4
ACCEPTED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"]
SAFE_IMAGE_MIMES = set(ACCEPTED_IMAGE_TYPES)
SOCKET_READ_TIMEOUT_SEC = 15.0

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
            return bool(attrs & 0x400)
        except OSError:
            return False
    return False


def safe_candidate_in_root(root: Path, rel_path: str) -> Path | None:
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


def _b64url_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _b64url_decode(text: str) -> bytes:
    pad = "=" * ((4 - (len(text) % 4)) % 4)
    return base64.urlsafe_b64decode(text + pad)


def _has_leading_zero_bits(digest: bytes, bits: int) -> bool:
    full = bits // 8
    rem = bits % 8
    for i in range(full):
        if digest[i] != 0:
            return False
    if rem > 0:
        mask = (0xFF << (8 - rem)) & 0xFF
        if (digest[full] & mask) != 0:
            return False
    return True


def _sanitize_text(raw: object, *, multiline: bool = False) -> str:
    text = str(raw if raw is not None else "").replace("\r\n", "\n").replace("\r", "\n")
    text = CONTROL_AND_BIDI_RE.sub("", text)
    if multiline:
        return re.sub(r"\n{3,}", "\n\n", text).strip()
    return re.sub(r"\s+", " ", text).strip()


def _sanitize_url(raw: object) -> str | None | dict[str, str]:
    trimmed = _sanitize_text(raw, multiline=False)
    if not trimmed:
        return None
    if len(trimmed) > 200:
        return {"error": "url_too_long"}
    parsed = urllib.parse.urlsplit(trimmed)
    if parsed.scheme not in ("http", "https") or not parsed.netloc or " " in parsed.netloc:
        return {"error": "invalid_url"}
    return trimmed


def _validate_png_and_scrub(data: bytes) -> dict[str, object]:
    n = len(data)
    if n < 33:
        return {"ok": False, "error": "invalid_image"}
    offset = 8
    width = 0
    height = 0
    has_idat = False
    has_iend = False
    has_actl = False
    actl_frames = 0
    fctl_count = 0
    anim_total_pixels = 0
    kept = [data[:8]]
    scrubbed = False
    chunks = 0
    while offset + 12 <= n and chunks < 2048:
        chunks += 1
        (length,) = struct.unpack(">I", data[offset : offset + 4])
        if length > 0x7FFFFFFF or offset + 12 + length > n:
            return {"ok": False, "error": "invalid_image"}
        ctype = data[offset + 4 : offset + 8]
        dstart = offset + 8
        nxt = offset + 12 + length
        if chunks == 1:
            if ctype != b"IHDR" or length != 13:
                return {"ok": False, "error": "invalid_image"}
            width, height = struct.unpack(">II", data[dstart : dstart + 8])
        elif ctype == b"acTL":
            if length != 8:
                return {"ok": False, "error": "invalid_image"}
            has_actl = True
            (actl_frames,) = struct.unpack(">I", data[dstart : dstart + 4])
            if actl_frames < 1 or actl_frames > MAX_ANIM_FRAMES or width * height * actl_frames > MAX_ANIM_TOTAL_PIXELS:
                return {"ok": False, "error": "image_dimensions_exceeded"}
        elif ctype == b"fcTL":
            if length != 26:
                return {"ok": False, "error": "invalid_image"}
            fw, fh, fx, fy = struct.unpack(">IIII", data[dstart + 4 : dstart + 20])
            if fw < 1 or fh < 1 or fx + fw > width or fy + fh > height:
                return {"ok": False, "error": "invalid_image"}
            fctl_count += 1
            anim_total_pixels += fw * fh
            if fctl_count > MAX_ANIM_FRAMES or anim_total_pixels > MAX_ANIM_TOTAL_PIXELS:
                return {"ok": False, "error": "image_dimensions_exceeded"}
        elif ctype == b"IDAT":
            has_idat = True
        if ctype in (b"tEXt", b"zTXt", b"iTXt", b"eXIf"):
            scrubbed = True
        else:
            kept.append(data[offset:nxt])
        offset = nxt
        if ctype == b"IEND":
            if length != 0:
                return {"ok": False, "error": "invalid_image"}
            has_iend = True
            break
    if not has_idat or not has_iend:
        return {"ok": False, "error": "invalid_image"}
    if has_actl and fctl_count != actl_frames:
        return {"ok": False, "error": "invalid_image"}
    out_bytes = b"".join(kept) if scrubbed else (data[:offset] if offset < n else data)
    return {
        "ok": True,
        "mimeType": "image/png",
        "ext": "png",
        "width": width,
        "height": height,
        "bytes": out_bytes,
    }


def _validate_gif_and_scrub(data: bytes) -> dict[str, object]:
    n = len(data)
    if n < 14:
        return {"ok": False, "error": "invalid_image"}
    width, height = struct.unpack("<HH", data[6:10])
    packed = data[10]
    offset = 13
    if packed & 0x80:
        offset += 3 * (1 << ((packed & 0x07) + 1))
        if offset > n:
            return {"ok": False, "error": "invalid_image"}

    kept = [data[:offset]]
    scrubbed = False
    frames = 0
    total_pixels = 0
    has_trailer = False

    def skip_sub_blocks(start: int) -> int:
        p = start
        steps = 0
        while p < n and steps < 65536:
            steps += 1
            sub_len = data[p]
            p += 1
            if sub_len == 0:
                return p
            p += sub_len
            if p > n:
                return -1
        return -1

    while offset < n:
        intro = data[offset]
        if intro == 0x3B:
            kept.append(data[offset : offset + 1])
            offset += 1
            has_trailer = True
            break
        if intro == 0x2C:
            if offset + 10 > n:
                return {"ok": False, "error": "invalid_image"}
            fw, fh = struct.unpack("<HH", data[offset + 5 : offset + 9])
            if fw < 1 or fh < 1 or fw > MAX_IMAGE_DIMENSION or fh > MAX_IMAGE_DIMENSION:
                return {"ok": False, "error": "image_dimensions_exceeded"}
            frames += 1
            total_pixels += fw * fh
            if frames > MAX_ANIM_FRAMES or total_pixels > MAX_ANIM_TOTAL_PIXELS:
                return {"ok": False, "error": "image_dimensions_exceeded"}
            lct_packed = data[offset + 9]
            p = offset + 10
            if lct_packed & 0x80:
                p += 3 * (1 << ((lct_packed & 0x07) + 1))
            if p >= n:
                return {"ok": False, "error": "invalid_image"}
            p += 1
            end = skip_sub_blocks(p)
            if end == -1:
                return {"ok": False, "error": "invalid_image"}
            kept.append(data[offset:end])
            offset = end
            continue
        if intro == 0x21:
            if offset + 2 >= n:
                return {"ok": False, "error": "invalid_image"}
            label = data[offset + 1]
            end = skip_sub_blocks(offset + 2)
            if end == -1:
                return {"ok": False, "error": "invalid_image"}
            keep_ext = False
            if label == 0xF9:
                keep_ext = True
            elif label == 0xFF and offset + 14 <= end and data[offset + 2] == 11:
                app_id = data[offset + 3 : offset + 14]
                if app_id in (b"NETSCAPE2.0", b"ANIMEXTS1.0"):
                    keep_ext = True
            if keep_ext:
                kept.append(data[offset:end])
            else:
                scrubbed = True
            offset = end
            continue
        return {"ok": False, "error": "invalid_image"}

    if not has_trailer or frames < 1:
        return {"ok": False, "error": "invalid_image"}
    out_bytes = b"".join(kept) if scrubbed else (data[:offset] if offset < n else data)
    return {
        "ok": True,
        "mimeType": "image/gif",
        "ext": "gif",
        "width": width,
        "height": height,
        "bytes": out_bytes,
    }


def _validate_webp_and_scrub(data: bytes) -> dict[str, object]:
    n = len(data)
    if n < 20:
        return {"ok": False, "error": "invalid_image"}
    (riff_size,) = struct.unpack("<I", data[4:8])
    if riff_size < 12 or 8 + riff_size > n:
        return {"ok": False, "error": "invalid_image"}
    riff_end = 8 + riff_size
    offset = 12
    width = 0
    height = 0
    has_vp8x = False
    has_payload = False
    frames = 0
    total_pixels = 0
    scrubbed = False
    kept_chunks: list[bytes] = []
    vp8x_idx = -1
    chunks = 0

    while offset + 8 <= riff_end and chunks < 2048:
        chunks += 1
        tag = data[offset : offset + 4]
        (chunk_size,) = struct.unpack("<I", data[offset + 4 : offset + 8])
        padded = chunk_size + (chunk_size & 1)
        dstart = offset + 8
        dend = dstart + chunk_size
        nxt = dstart + padded
        if dend > riff_end or nxt > n:
            return {"ok": False, "error": "invalid_image"}

        if tag == b"VP8 ":
            if chunk_size < 10 or data[dstart + 3 : dstart + 6] != b"\x9d\x01\x2a":
                return {"ok": False, "error": "invalid_image"}
            if not width or not height:
                w_raw, h_raw = struct.unpack("<HH", data[dstart + 6 : dstart + 10])
                width, height = w_raw & 0x3FFF, h_raw & 0x3FFF
            has_payload = True
        elif tag == b"VP8L":
            if chunk_size < 5 or data[dstart] != 0x2F:
                return {"ok": False, "error": "invalid_image"}
            if not width or not height:
                (bits,) = struct.unpack("<I", data[dstart + 1 : dstart + 5])
                width = (bits & 0x3FFF) + 1
                height = ((bits >> 14) & 0x3FFF) + 1
            has_payload = True
        elif tag == b"VP8X":
            if chunk_size != 10 or chunks != 1:
                return {"ok": False, "error": "invalid_image"}
            has_vp8x = True
            width = 1 + (data[dstart + 4] | (data[dstart + 5] << 8) | (data[dstart + 6] << 16))
            height = 1 + (data[dstart + 7] | (data[dstart + 8] << 8) | (data[dstart + 9] << 16))
            vp8x_idx = len(kept_chunks)
        elif tag == b"ANMF":
            if not has_vp8x or chunk_size < 24:
                return {"ok": False, "error": "invalid_image"}
            fx = 2 * (data[dstart] | (data[dstart + 1] << 8) | (data[dstart + 2] << 16))
            fy = 2 * (data[dstart + 3] | (data[dstart + 4] << 8) | (data[dstart + 5] << 16))
            fw = 1 + (data[dstart + 6] | (data[dstart + 7] << 8) | (data[dstart + 8] << 16))
            fh = 1 + (data[dstart + 9] | (data[dstart + 10] << 8) | (data[dstart + 11] << 16))
            if fw > MAX_IMAGE_DIMENSION or fh > MAX_IMAGE_DIMENSION:
                return {"ok": False, "error": "image_dimensions_exceeded"}
            if fx + fw > width or fy + fh > height:
                return {"ok": False, "error": "invalid_image"}
            sub_pos = dstart + 16
            sub_frame_cnt = 0
            sub_alph_cnt = 0
            sub_cnt = 0
            while sub_pos + 8 <= dend and sub_cnt < 8:
                sub_cnt += 1
                sub_tag = data[sub_pos : sub_pos + 4]
                (sub_len,) = struct.unpack("<I", data[sub_pos + 4 : sub_pos + 8])
                sub_dstart = sub_pos + 8
                sub_dend = sub_dstart + sub_len
                sub_nxt = sub_dstart + sub_len + (sub_len & 1)
                if sub_dend > dend:
                    return {"ok": False, "error": "invalid_image"}
                if sub_tag == b"VP8 ":
                    if sub_len < 10 or data[sub_dstart + 3 : sub_dstart + 6] != b"\x9d\x01\x2a":
                        return {"ok": False, "error": "invalid_image"}
                    bw_raw, bh_raw = struct.unpack("<HH", data[sub_dstart + 6 : sub_dstart + 10])
                    if (bw_raw & 0x3FFF) != fw or (bh_raw & 0x3FFF) != fh:
                        return {"ok": False, "error": "invalid_image"}
                    sub_frame_cnt += 1
                elif sub_tag == b"VP8L":
                    if sub_len < 5 or data[sub_dstart] != 0x2F:
                        return {"ok": False, "error": "invalid_image"}
                    (bits,) = struct.unpack("<I", data[sub_dstart + 1 : sub_dstart + 5])
                    if ((bits & 0x3FFF) + 1) != fw or (((bits >> 14) & 0x3FFF) + 1) != fh:
                        return {"ok": False, "error": "invalid_image"}
                    sub_frame_cnt += 1
                elif sub_tag == b"ALPH":
                    if sub_frame_cnt > 0 or sub_alph_cnt > 0:
                        return {"ok": False, "error": "invalid_image"}
                    sub_alph_cnt += 1
                else:
                    return {"ok": False, "error": "invalid_image"}
                sub_pos = min(sub_nxt, dend)
            if sub_frame_cnt != 1 or sub_pos < dend:
                return {"ok": False, "error": "invalid_image"}
            frames += 1
            total_pixels += fw * fh
            if frames > MAX_ANIM_FRAMES or total_pixels > MAX_ANIM_TOTAL_PIXELS:
                return {"ok": False, "error": "image_dimensions_exceeded"}
            has_payload = True

        if tag in (b"EXIF", b"XMP "):
            scrubbed = True
        else:
            kept_chunks.append(data[offset : min(nxt, riff_end)])
        offset = nxt

    if not has_payload or offset < riff_end:
        return {"ok": False, "error": "invalid_image"}

    out_bytes = data
    if scrubbed or riff_end < n:
        rebuilt: list[bytes] = []
        for idx, ch in enumerate(kept_chunks):
            buf = bytearray(ch)
            if idx == vp8x_idx and len(buf) >= 18:
                buf[8] &= ~(0x08 | 0x04)
            if len(buf) & 1:
                buf.append(0)
            rebuilt.append(bytes(buf))
        payload_len = 4 + sum(len(c) for c in rebuilt)
        out_bytes = b"RIFF" + struct.pack("<I", payload_len) + b"WEBP" + b"".join(rebuilt)

    return {
        "ok": True,
        "mimeType": "image/webp",
        "ext": "webp",
        "width": width,
        "height": height,
        "bytes": out_bytes,
    }


def _validate_jpeg_and_scrub(data: bytes) -> dict[str, object]:
    n = len(data)
    if n < 12:
        return {"ok": False, "error": "invalid_image"}
    offset = 2
    width = 0
    height = 0
    found_sof = False
    found_sos = False
    found_eoi = False
    kept = [data[:2]]
    scrubbed = False
    seg_count = 0

    while offset + 1 < n and seg_count < 4096:
        seg_count += 1
        if data[offset] != 0xFF:
            return {"ok": False, "error": "invalid_image"}
        seg_start = offset
        while offset < n and data[offset] == 0xFF:
            offset += 1
        if offset >= n:
            return {"ok": False, "error": "invalid_image"}
        marker = data[offset]
        offset += 1
        if marker == 0xD9:
            if not found_sos:
                return {"ok": False, "error": "invalid_image"}
            kept.append(data[seg_start:offset])
            found_eoi = True
            break
        if marker == 0x01 or (0xD0 <= marker <= 0xD8):
            kept.append(data[seg_start:offset])
            continue
        if offset + 1 >= n:
            return {"ok": False, "error": "invalid_image"}
        (seg_len,) = struct.unpack(">H", data[offset : offset + 2])
        if seg_len < 2 or offset + seg_len > n:
            return {"ok": False, "error": "invalid_image"}
        seg_end = offset + seg_len
        if marker == 0xDA:
            if not found_sof or seg_len < 6:
                return {"ok": False, "error": "invalid_image"}
            found_sos = True
            p = seg_end
            next_marker_pos = -1
            while p < n:
                if data[p] != 0xFF:
                    p += 1
                    continue
                run_start = p
                while p < n and data[p] == 0xFF:
                    p += 1
                if p >= n:
                    return {"ok": False, "error": "invalid_image"}
                m = data[p]
                if m == 0x00 or (0xD0 <= m <= 0xD7):
                    p += 1
                    continue
                next_marker_pos = run_start
                break
            if next_marker_pos == -1:
                return {"ok": False, "error": "invalid_image"}
            kept.append(data[seg_start:next_marker_pos])
            offset = next_marker_pos
            continue
        is_sof = (
            (0xC0 <= marker <= 0xC3)
            or (0xC5 <= marker <= 0xC7)
            or (0xC9 <= marker <= 0xCB)
            or (0xCD <= marker <= 0xCF)
        )
        if is_sof and not found_sof:
            if seg_len < 7:
                return {"ok": False, "error": "invalid_image"}
            height, width = struct.unpack(">HH", data[offset + 3 : offset + 7])
            found_sof = True
        if marker in (0xE1, 0xED, 0xFE):
            scrubbed = True
        else:
            kept.append(data[seg_start:seg_end])
        offset = seg_end

    if not found_sof or not found_sos or not found_eoi:
        return {"ok": False, "error": "invalid_image"}
    out_bytes = b"".join(kept) if scrubbed else (data[:offset] if offset < n else data)
    return {
        "ok": True,
        "mimeType": "image/jpeg",
        "ext": "jpg",
        "width": width,
        "height": height,
        "bytes": out_bytes,
    }


def _inspect_and_sanitize_image(data: bytes) -> dict[str, object]:
    """Mirror worker/index.mjs complete container inspection, decode budgets & metadata scrubbing."""
    n = len(data)
    if n < 12:
        return {"ok": False, "error": "invalid_image"}

    if n >= 24 and data[:8] == b"\x89PNG\r\n\x1a\n":
        res = _validate_png_and_scrub(data)
    elif data[:6] in (b"GIF87a", b"GIF89a"):
        res = _validate_gif_and_scrub(data)
    elif n >= 20 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        res = _validate_webp_and_scrub(data)
    elif data[:3] == b"\xff\xd8\xff":
        res = _validate_jpeg_and_scrub(data)
    else:
        return {"ok": False, "error": "invalid_image"}

    if not res.get("ok"):
        return res
    width = int(res["width"])
    height = int(res["height"])
    if width < 1 or height < 1:
        return {"ok": False, "error": "invalid_image"}
    if width > MAX_IMAGE_DIMENSION or height > MAX_IMAGE_DIMENSION or width * height > MAX_IMAGE_PIXELS:
        return {"ok": False, "error": "image_dimensions_exceeded"}
    return res


def _matches_if_none_match(header_val: str | None, etag: str) -> bool:
    if not header_val:
        return False
    trimmed = header_val.strip()
    if trimmed == "*":
        return True
    target = re.sub(r"^W/", "", etag, flags=re.IGNORECASE).strip()
    for part in trimmed.split(","):
        cand = re.sub(r"^W/", "", part.strip(), flags=re.IGNORECASE)
        if cand == target:
            return True
    return False


def _parse_content_disposition(value: str) -> tuple[str | None, bool]:
    """Parse RFC 6266 / RFC 7578 Content-Disposition supporting quoted & unquoted parameter tokens."""
    try:
        hdr = EMAIL_POLICY.header_factory("Content-Disposition", value)
        params = getattr(hdr, "params", None)
    except Exception:
        return None, False
    if not params:
        return None, False
    name = params.get("name")
    has_filename = "filename" in params or "filename*" in params
    return (str(name) if name is not None else None), has_filename


def _parse_multipart_form_data(content_type: str, raw: bytes) -> tuple[dict[str, list[str]], list[bytes]] | None:
    """Binary-exact RFC 7578 / RFC 2046 multipart/form-data parser with closing delimiter & part-count enforcement."""
    m = re.search(r'boundary=(?:"([^"]+)"|([^\s;]+))', content_type, re.IGNORECASE)
    if not m:
        return None
    boundary = (m.group(1) or m.group(2) or "").encode("latin-1")
    if not boundary or len(boundary) > 70:
        return None
    delim = b"--" + boundary
    if not raw.startswith(delim):
        idx = raw.find(b"\r\n" + delim)
        if idx != -1:
            raw = raw[idx + 2 :]
        else:
            idx = raw.find(b"\n" + delim)
            if idx == -1:
                return None
            raw = raw[idx + 1 :]

    fields: dict[str, list[str]] = {}
    plural_files: list[bytes] = []
    singular_files: list[bytes] = []

    pos = len(delim)
    parts_seen = 0
    saw_closing = False

    while pos < len(raw):
        if raw[pos : pos + 2] == b"--":
            close_pos = pos + 2
            while close_pos < len(raw) and raw[close_pos : close_pos + 1] in (b" ", b"\t"):
                close_pos += 1
            if close_pos < len(raw) and raw[close_pos : close_pos + 2] == b"\r\n":
                close_pos += 2
            elif close_pos < len(raw) and raw[close_pos : close_pos + 1] == b"\n":
                close_pos += 1
            elif close_pos < len(raw):
                return None
            saw_closing = True
            break
        # RFC 2046 §5.1.1 permits optional linear transport whitespace before CRLF/LF
        while pos < len(raw) and raw[pos : pos + 1] in (b" ", b"\t"):
            pos += 1
        if raw[pos : pos + 2] == b"\r\n":
            pos += 2
        elif raw[pos : pos + 1] == b"\n":
            pos += 1
        else:
            return None

        parts_seen += 1
        if parts_seen > MAX_MULTIPART_PARTS:
            return None

        sep_idx = raw.find(b"\r\n\r\n", pos)
        sep_len = 4
        if sep_idx == -1:
            sep_idx = raw.find(b"\n\n", pos)
            sep_len = 2
        if sep_idx == -1:
            return None

        header_bytes = raw[pos:sep_idx]
        body_start = sep_idx + sep_len

        next_delim = raw.find(b"\r\n" + delim, body_start)
        strip_len = 2
        if next_delim == -1:
            next_delim = raw.find(b"\n" + delim, body_start)
            strip_len = 1
        if next_delim == -1:
            return None

        part_body = raw[body_start:next_delim]
        pos = next_delim + strip_len + len(delim)

        disp_line = ""
        for line in header_bytes.decode("latin-1", errors="replace").splitlines():
            if line.lower().startswith("content-disposition:"):
                disp_line = line.split(":", 1)[1].strip()
                break
        if not disp_line:
            continue
        field_name, has_filename = _parse_content_disposition(disp_line)
        if not field_name:
            continue

        if field_name == "images":
            if not has_filename:
                return None
            plural_files.append(part_body)
        elif field_name == "image":
            if not has_filename:
                return None
            singular_files.append(part_body)
        elif field_name == "payload":
            if has_filename:
                return None
            fields.setdefault(field_name, []).append(part_body.decode("utf-8", errors="replace"))
        else:
            if has_filename:
                # Ignore unrelated uploaded file parts just like Worker FormData handling
                continue
            fields.setdefault(field_name, []).append(part_body.decode("utf-8", errors="replace"))

    if not saw_closing:
        return None
    # Match worker/index.mjs ordering: [...formData.getAll("images"), ...formData.getAll("image")]
    return fields, plural_files + singular_files


class LocalCommentsStore:
    """Thread-safe local SQLite + blob comments backend mirroring worker/index.mjs."""

    def __init__(
        self,
        *,
        site: str,
        site_author: str,
        db_path: str,
        images_dir: Path | None,
        author_key: str,
        turnstile_sitekey: str = "",
        min_dwell_ms: int = 800,
        pow_bits: int = 12,
        fallback_pow_bits: int = 14,
        enforce_quotas: bool = False,
    ) -> None:
        self.site = site
        self.site_author = site_author
        self.author_key = author_key
        self.gate_secret = secrets.token_hex(32)
        self.turnstile_sitekey = turnstile_sitekey
        self.min_dwell_ms = min_dwell_ms
        self.pow_bits = pow_bits
        self.fallback_pow_bits = fallback_pow_bits
        self.enforce_quotas = enforce_quotas
        self._images_dir = images_dir
        self._mem_images: dict[str, bytes] = {}
        if self._images_dir is not None:
            self._images_dir.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(db_path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._apply_migrations()
        self.gate_secret = self._load_or_create_db_secret()

    def _load_or_create_db_secret(self) -> str:
        """Persist a DB-scoped secret so restarts and shared-DB connections hash guest IPs identically."""
        self._conn.execute("BEGIN IMMEDIATE")
        try:
            self._conn.execute(
                """CREATE TABLE IF NOT EXISTS _local_preview_meta (
                     key TEXT PRIMARY KEY,
                     value TEXT NOT NULL
                   )"""
            )
            self._conn.execute(
                "INSERT OR IGNORE INTO _local_preview_meta (key, value) VALUES ('gate_secret', ?)",
                (secrets.token_hex(32),),
            )
            row = self._conn.execute(
                "SELECT value FROM _local_preview_meta WHERE key = 'gate_secret' LIMIT 1"
            ).fetchone()
            self._conn.commit()
            return str(row["value"]) if row else secrets.token_hex(32)
        except Exception:
            self._conn.rollback()
            raise

    def _split_sql_statements(self, sql_text: str) -> list[str]:
        """Split SQLite migration text into complete statements without breaking BEGIN...END trigger bodies."""
        statements: list[str] = []
        buf: list[str] = []
        for raw_line in sql_text.splitlines():
            stripped = raw_line.strip()
            if not buf and (not stripped or stripped.startswith("--")):
                continue
            buf.append(raw_line)
            candidate = "\n".join(buf).strip()
            if candidate and sqlite3.complete_statement(candidate):
                statements.append(candidate)
                buf = []
        tail = "\n".join(buf).strip()
        if tail and not all(ln.strip() == "" or ln.strip().startswith("--") for ln in buf):
            statements.append(tail)
        return statements

    def _table_columns(self, table_name: str) -> set[str]:
        rows = self._conn.execute(f"PRAGMA table_info({table_name})").fetchall()
        return {str(r["name"]) for r in rows}

    def _apply_migrations(self) -> None:
        self._conn.execute(
            """CREATE TABLE IF NOT EXISTS d1_migrations (
                 name TEXT PRIMARY KEY,
                 applied_at INTEGER NOT NULL
               )"""
        )
        self._conn.commit()
        applied = {
            str(r["name"])
            for r in self._conn.execute("SELECT name FROM d1_migrations").fetchall()
        }
        alter_col_re = re.compile(
            r"^\s*ALTER\s+TABLE\s+([A-Za-z_][A-Za-z0-9_]*)\s+ADD\s+COLUMN\s+([A-Za-z_][A-Za-z0-9_]*)\b",
            re.IGNORECASE,
        )
        if MIGRATIONS_DIR.is_dir():
            for sql_file in sorted(MIGRATIONS_DIR.glob("*.sql")):
                if sql_file.name in applied:
                    continue
                sql_text = sql_file.read_text(encoding="utf-8")
                statements = self._split_sql_statements(sql_text)
                self._conn.execute("BEGIN IMMEDIATE")
                try:
                    for stmt in statements:
                        m = alter_col_re.match(stmt)
                        if m:
                            tbl, col = m.group(1), m.group(2)
                            if col in self._table_columns(tbl):
                                continue
                        self._conn.execute(stmt)
                    self._conn.execute(
                        "INSERT OR IGNORE INTO d1_migrations (name, applied_at) VALUES (?, ?)",
                        (sql_file.name, int(time.time() * 1000)),
                    )
                    self._conn.commit()
                except Exception:
                    self._conn.rollback()
                    raise

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    def _put_blob(self, key: str, data: bytes) -> None:
        if self._images_dir is None:
            self._mem_images[key] = data
            return
        safe_name = hashlib.sha256(key.encode("utf-8")).hexdigest()
        dest = self._images_dir / safe_name
        fd, tmp_path = tempfile.mkstemp(prefix=".img-", dir=str(self._images_dir))
        try:
            with os.fdopen(fd, "wb") as fh:
                fh.write(data)
                fh.flush()
            os.replace(tmp_path, dest)
        except Exception:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
            raise

    def _blob_size(self, key: str) -> int | None:
        if self._images_dir is None:
            blob = self._mem_images.get(key)
            return len(blob) if blob is not None else None
        safe_name = hashlib.sha256(key.encode("utf-8")).hexdigest()
        p = self._images_dir / safe_name
        try:
            return p.stat().st_size if p.is_file() else None
        except OSError:
            return None

    def _get_blob(self, key: str) -> bytes | None:
        if self._images_dir is None:
            return self._mem_images.get(key)
        safe_name = hashlib.sha256(key.encode("utf-8")).hexdigest()
        p = self._images_dir / safe_name
        return p.read_bytes() if p.is_file() else None

    def _delete_blob(self, key: str) -> bool:
        if self._images_dir is None:
            self._mem_images.pop(key, None)
            return True
        safe_name = hashlib.sha256(key.encode("utf-8")).hexdigest()
        p = self._images_dir / safe_name
        try:
            p.unlink(missing_ok=True)
            return True
        except OSError:
            return False

    def verify_author(self, provided: str) -> bool:
        if not provided or not self.author_key:
            return False
        return hmac.compare_digest(provided.strip(), self.author_key)

    def _sign_gate(self, slug: str) -> dict[str, object]:
        now_ms = int(time.time() * 1000)
        payload = {
            "v": 1,
            "site": self.site,
            "slug": slug,
            "n": secrets.token_hex(12),
            "iat": now_ms,
            "exp": now_ms + 15 * 60 * 1000,
            "d": self.pow_bits,
            "fd": self.fallback_pow_bits,
        }
        b64 = _b64url_encode(json.dumps(payload, separators=(",", ":")).encode("utf-8"))
        sig = _b64url_encode(
            hmac.new(self.gate_secret.encode("utf-8"), b64.encode("utf-8"), hashlib.sha256).digest()
        )
        return {
            "token": f"{b64}.{sig}",
            "issuedAt": now_ms,
            "expiresAt": payload["exp"],
            "powBits": self.pow_bits,
            "fallbackPowBits": self.fallback_pow_bits,
            "minDwellMs": self.min_dwell_ms,
            "fallbackMinDwellMs": self.min_dwell_ms,
        }

    def _verify_gate(self, token: str, slug: str) -> tuple[bool, dict | str]:
        if not isinstance(token, str) or "." not in token or len(token) > 1024:
            return False, "invalid_gate"
        parts = token.split(".")
        if len(parts) != 2:
            return False, "invalid_gate"
        b64, sig = parts
        exp_sig = _b64url_encode(
            hmac.new(self.gate_secret.encode("utf-8"), b64.encode("utf-8"), hashlib.sha256).digest()
        )
        if not hmac.compare_digest(sig, exp_sig):
            return False, "invalid_gate"
        try:
            payload = json.loads(_b64url_decode(b64).decode("utf-8"))
        except Exception:
            return False, "invalid_gate"
        if payload.get("site") != self.site or payload.get("slug") != slug:
            return False, "invalid_gate"
        if int(time.time() * 1000) > int(payload.get("exp", 0)):
            return False, "gate_expired"
        return True, payload

    def list_comments(self, slug: str, author_header: str) -> tuple[int, dict[str, object]]:
        if not slug or len(slug) > 120 or not SLUG_RE.match(slug):
            return 400, {"ok": False, "error": "invalid_slug"}
        with self._lock:
            rows = self._conn.execute(
                """SELECT id, slug, parent_id, author_name, author_url, is_author, lang, body, created_at
                     FROM comments
                    WHERE site = ? AND slug = ? AND status = 'visible'
                    ORDER BY created_at ASC, id ASC
                    LIMIT 200""",
                (self.site, slug),
            ).fetchall()
            img_rows = self._conn.execute(
                """SELECT id, comment_id, mime_type, width, height, size_bytes, alt, sort_order
                     FROM comment_images
                    WHERE site = ?
                      AND status = 'visible'
                      AND comment_id IN (
                        SELECT id
                          FROM comments
                         WHERE site = ? AND slug = ? AND status = 'visible'
                         ORDER BY created_at ASC, id ASC
                         LIMIT 200
                      )
                    ORDER BY comment_id ASC, sort_order ASC, created_at ASC""",
                (self.site, self.site, slug),
            ).fetchall()

        images_by_comment: dict[str, list[dict[str, object]]] = {}
        for ir in img_rows:
            images_by_comment.setdefault(ir["comment_id"], []).append(
                {
                    "id": ir["id"],
                    "url": f"/api/comments/images/{urllib.parse.quote(ir['id'], safe='')}",
                    "mimeType": ir["mime_type"],
                    "width": int(ir["width"]),
                    "height": int(ir["height"]),
                    "sizeBytes": int(ir["size_bytes"]),
                    "alt": ir["alt"] or "",
                }
            )

        comments = [
            {
                "id": r["id"],
                "slug": r["slug"],
                "parentId": r["parent_id"],
                "authorName": r["author_name"],
                "authorUrl": r["author_url"],
                "isAuthor": bool(r["is_author"]),
                "lang": r["lang"],
                "body": r["body"],
                "images": images_by_comment.get(r["id"], []),
                "createdAt": int(r["created_at"]),
            }
            for r in rows
        ]
        return 200, {
            "ok": True,
            "site": self.site,
            "slug": slug,
            "comments": comments,
            "gate": self._sign_gate(slug),
            "config": {
                "turnstileSitekey": self.turnstile_sitekey,
                "turnstileAction": "comment",
                "allowPowFallback": True,
                "maxNameLength": 32,
                "maxBodyLength": 2000,
                "minBodyLength": 2,
                "imagesEnabled": True,
                "maxImages": MAX_IMAGES_PER_COMMENT,
                "maxImageBytes": MAX_IMAGE_BYTES,
                "acceptedImageTypes": ACCEPTED_IMAGE_TYPES,
                "authorMode": self.verify_author(author_header),
            },
        }

    def get_image(
        self,
        image_id: str,
        if_none_match: str | None = None,
        *,
        head_only: bool = False,
    ) -> tuple[int, dict[str, str], bytes]:
        if not IMAGE_ID_RE.match(image_id):
            return 400, {"Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store"}, json.dumps(
                {"ok": False, "error": "invalid_image_id"}
            ).encode("utf-8")

        with self._lock:
            row = self._conn.execute(
                """SELECT ci.id, ci.r2_key, ci.mime_type, ci.size_bytes, ci.sha256
                     FROM comment_images ci
                     JOIN comments c ON c.id = ci.comment_id AND c.site = ci.site
                     LEFT JOIN comments p ON p.id = c.parent_id AND p.site = c.site
                    WHERE ci.id = ?
                      AND ci.site = ?
                      AND ci.status = 'visible'
                      AND c.status = 'visible'
                      AND (c.parent_id IS NULL OR p.status = 'visible')
                    LIMIT 1""",
                (image_id, self.site),
            ).fetchone()

        if not row or row["mime_type"] not in SAFE_IMAGE_MIMES:
            return 404, {"Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"}, b"Not Found"

        blob_size = self._blob_size(row["r2_key"])
        if blob_size is None:
            return 404, {"Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"}, b"Not Found"

        etag = f'"{row["sha256"]}"'
        headers = {
            "Content-Type": row["mime_type"],
            "Cache-Control": "private, no-cache",
            "ETag": etag,
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'; sandbox",
            "Cross-Origin-Resource-Policy": "same-origin",
            "Content-Disposition": "inline",
            "Referrer-Policy": "no-referrer",
        }
        if _matches_if_none_match(if_none_match, etag):
            return 304, headers, b""
        if head_only:
            headers["Content-Length"] = str(blob_size)
            return 200, headers, b""

        blob = self._get_blob(row["r2_key"])
        if blob is None:
            return 404, {"Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"}, b"Not Found"
        return 200, headers, blob

    def create_comment(
        self,
        data: dict,
        client_ip: str,
        author_header: str,
        raw_files: list[bytes] | None = None,
    ) -> tuple[int, dict[str, object]]:
        files = raw_files or []
        if len(files) > MAX_IMAGES_PER_COMMENT:
            return 400, {"ok": False, "error": "too_many_images"}
        for fbytes in files:
            if not fbytes:
                return 400, {"ok": False, "error": "invalid_image"}
            if len(fbytes) > MAX_IMAGE_BYTES:
                return 413, {"ok": False, "error": "image_too_large"}

        slug = _sanitize_text(data.get("slug", "")).lower()
        if not slug or len(slug) > 120 or not SLUG_RE.match(slug):
            return 400, {"ok": False, "error": "invalid_slug"}
        lang = "en" if data.get("lang") == "en" else "zh"
        author_name = _sanitize_text(data.get("authorName", ""))
        if len(author_name) > 32:
            return 400, {"ok": False, "error": "name_too_long"}
        url_res = _sanitize_url(data.get("authorUrl", ""))
        if isinstance(url_res, dict):
            return 400, {"ok": False, "error": url_res["error"]}
        author_url = url_res
        body = _sanitize_text(data.get("body", ""), multiline=True)
        if len(files) == 0 and len(body) < 2:
            return 400, {"ok": False, "error": "body_too_short"}
        if len(body) > 2000:
            return 400, {"ok": False, "error": "body_too_long"}

        is_author = self.verify_author(author_header)
        now_ms = int(time.time() * 1000)

        # Silent shadow-drop honeypot
        if not is_author and _sanitize_text(data.get("websiteHp", "")):
            return 201, {
                "ok": True,
                "comment": {
                    "id": f"c_{secrets.token_hex(8)}",
                    "slug": slug,
                    "parentId": None,
                    "authorName": author_name,
                    "authorUrl": author_url,
                    "isAuthor": False,
                    "lang": lang,
                    "body": body,
                    "images": [],
                    "createdAt": now_ms,
                },
                "nextGate": self._sign_gate(slug),
            }

        now_utc = dt.datetime.now(dt.timezone.utc)
        day_today = now_utc.strftime("%Y-%m-%d")
        day_prev = (now_utc - dt.timedelta(days=1)).strftime("%Y-%m-%d")
        ip_hash = hashlib.sha256(f"{self.gate_secret}:ip:{day_today}:{client_ip}".encode("utf-8")).hexdigest()
        ip_hash_prev = hashlib.sha256(f"{self.gate_secret}:ip:{day_prev}:{client_ip}".encode("utf-8")).hexdigest()

        verification_mode = "author"
        pending_nonce: tuple[str, int] | None = None
        effective_fallback = False

        if not is_author:
            gate_token = str(data.get("gateToken", ""))
            ok_gate, gate_res = self._verify_gate(gate_token, slug)
            if not ok_gate:
                return 403, {"ok": False, "error": gate_res, "nextGate": self._sign_gate(slug)}
            assert isinstance(gate_res, dict)

            if now_ms - int(gate_res["iat"]) < self.min_dwell_ms:
                return 429, {"ok": False, "error": "too_fast", "retryAfterSec": 2}

            effective_fallback = bool(data.get("fallbackMode")) or not bool(data.get("turnstileToken"))
            required_bits = int(gate_res["fd"] if effective_fallback else gate_res["d"])
            pow_nonce = str(data.get("powNonce", "")).strip()
            if not pow_nonce or len(pow_nonce) > 64:
                return 403, {"ok": False, "error": "pow_required", "nextGate": self._sign_gate(slug)}
            digest = hashlib.sha256(f"{gate_token}:{pow_nonce}".encode("utf-8")).digest()
            if not _has_leading_zero_bits(digest, required_bits):
                return 403, {"ok": False, "error": "pow_invalid", "nextGate": self._sign_gate(slug)}

            max_urls = 1 if effective_fallback else 2
            if len(URL_COUNT_RE.findall(body)) > max_urls:
                return 400, {"ok": False, "error": "too_many_links"}

            pending_nonce = (str(gate_res["n"]), int(gate_res["exp"]))
            verification_mode = "local-turnstile-sim" if not effective_fallback else "pow-fallback"

        raw_alts = data.get("imageAlts") if isinstance(data.get("imageAlts"), list) else []
        prepared_images: list[dict[str, object]] = []
        for idx, img_bytes in enumerate(files):
            inspected = _inspect_and_sanitize_image(img_bytes)
            if not inspected.get("ok"):
                return 400, {"ok": False, "error": str(inspected.get("error", "invalid_image")), "nextGate": self._sign_gate(slug)}
            clean_bytes = inspected["bytes"]
            assert isinstance(clean_bytes, bytes)
            alt_text = _sanitize_text(raw_alts[idx] if idx < len(raw_alts) else "")[:MAX_ALT_LEN]
            prepared_images.append(
                {
                    "id": f"img_{secrets.token_hex(12)}",
                    "bytes": clean_bytes,
                    "mimeType": str(inspected["mimeType"]),
                    "ext": str(inspected["ext"]),
                    "width": int(inspected["width"]),
                    "height": int(inspected["height"]),
                    "sizeBytes": len(clean_bytes),
                    "sha256": hashlib.sha256(clean_bytes).hexdigest(),
                    "alt": alt_text,
                    "sortOrder": idx,
                }
            )

        norm_body = re.sub(r"\s+", " ", body.lower())
        img_hash_part = (
            ":img:" + ",".join(sorted(str(x["sha256"]) for x in prepared_images))
            if prepared_images
            else ""
        )
        body_hash = hashlib.sha256(f"{self.site}:{slug}:{norm_body}{img_hash_part}".encode("utf-8")).hexdigest()

        cid = f"c_{uuid.uuid4().hex[:16]}"
        stored_name = self.site_author if (is_author and not author_name) else author_name
        raw_client_req_id = str(data.get("clientRequestId") or "").strip()
        client_request_id = raw_client_req_id if (raw_client_req_id and COMMENT_ID_RE.match(raw_client_req_id)) else None
        written_keys: list[str] = []

        # Hold single lock across idempotency, quota checks, dedupe, parent check, nonce consume, and commit
        with self._lock:
            if client_request_id:
                existing = self._conn.execute(
                    """SELECT id, slug, parent_id, author_name, author_url, is_author, lang, body, ip_hash, status, created_at
                         FROM comments
                        WHERE site = ?
                          AND slug = ?
                          AND client_request_id = ?
                        LIMIT 1""",
                    (self.site, slug, client_request_id),
                ).fetchone()
                if existing:
                    same_owner = is_author or existing["ip_hash"] in (ip_hash, ip_hash_prev)
                    if existing["status"] == "visible" and same_owner:
                        img_rows = self._conn.execute(
                            """SELECT id, mime_type, width, height, size_bytes, alt
                                 FROM comment_images
                                WHERE site = ? AND comment_id = ? AND status = 'visible'
                                ORDER BY sort_order ASC, created_at ASC""",
                            (self.site, existing["id"]),
                        ).fetchall()
                        if pending_nonce is not None:
                            self._conn.execute(
                                "INSERT OR IGNORE INTO comment_nonces (nonce, expires_at) VALUES (?, ?)",
                                pending_nonce,
                            )
                            self._conn.commit()
                        return 200, {
                            "ok": True,
                            "idempotent": True,
                            "comment": {
                                "id": existing["id"],
                                "slug": existing["slug"],
                                "parentId": existing["parent_id"],
                                "authorName": existing["author_name"] or "",
                                "authorUrl": existing["author_url"],
                                "isAuthor": bool(existing["is_author"]),
                                "lang": existing["lang"] or "zh",
                                "body": existing["body"],
                                "images": [
                                    {
                                        "id": r["id"],
                                        "url": f"/api/comments/images/{urllib.parse.quote(str(r['id']), safe='')}",
                                        "mimeType": r["mime_type"],
                                        "width": int(r["width"] or 0),
                                        "height": int(r["height"] or 0),
                                        "sizeBytes": int(r["size_bytes"] or 0),
                                        "alt": r["alt"] or "",
                                    }
                                    for r in img_rows
                                ],
                                "createdAt": int(existing["created_at"]),
                            },
                            "verificationMode": verification_mode,
                            "nextGate": self._sign_gate(slug),
                        }
                    return 409, {
                        "ok": False,
                        "error": "duplicate_comment",
                        "nextGate": self._sign_gate(slug),
                    }

            if not is_author:
                if self.enforce_quotas:
                    short_window_ms = 45 * 1000 if effective_fallback else 60 * 1000
                    short_max = 1 if effective_fallback else 3
                    hour_max = 5 if effective_fallback else 12
                    rate_row = self._conn.execute(
                        """SELECT
                             SUM(CASE WHEN created_at > ? THEN 1 ELSE 0 END) AS short_cnt,
                             COUNT(*) AS hour_cnt,
                             MAX(created_at) AS last_at
                           FROM comments
                          WHERE site = ? AND ip_hash IN (?, ?) AND created_at > ?""",
                        (now_ms - short_window_ms, self.site, ip_hash, ip_hash_prev, now_ms - 60 * 60 * 1000),
                    ).fetchone()
                    if int(rate_row["short_cnt"] or 0) >= short_max:
                        last_at = int(rate_row["last_at"] or now_ms)
                        retry_sec = max(5, int((short_window_ms - (now_ms - last_at) + 999) // 1000))
                        return 429, {"ok": False, "error": "rate_limited", "retryAfterSec": retry_sec}
                    if int(rate_row["hour_cnt"] or 0) >= hour_max:
                        return 429, {"ok": False, "error": "rate_limited", "retryAfterSec": 300}

                if prepared_images:
                    hour_img_limit = HOUR_IMAGE_LIMIT_FALLBACK if effective_fallback else HOUR_IMAGE_LIMIT_NORMAL
                    row_cnt = self._conn.execute(
                        """SELECT COUNT(*) AS cnt
                             FROM comment_images ci
                             JOIN comments c ON c.id = ci.comment_id AND c.site = ci.site
                            WHERE ci.site = ? AND c.ip_hash IN (?, ?) AND ci.created_at > ?""",
                        (self.site, ip_hash, ip_hash_prev, now_ms - 60 * 60 * 1000),
                    ).fetchone()
                    if int(row_cnt["cnt"] if row_cnt else 0) + len(prepared_images) > hour_img_limit:
                        return 429, {"ok": False, "error": "rate_limited", "retryAfterSec": 300}

            dup = self._conn.execute(
                "SELECT id FROM comments WHERE site = ? AND slug = ? AND body_hash = ? AND status = 'visible' AND created_at > ? LIMIT 1",
                (self.site, slug, body_hash, now_ms - 10 * 60 * 1000),
            ).fetchone()
            if dup:
                return 409, {"ok": False, "error": "duplicate_comment", "nextGate": self._sign_gate(slug)}

            resolved_parent = None
            raw_parent = data.get("parentId")
            if isinstance(raw_parent, str) and raw_parent.strip():
                cand = raw_parent.strip()
                if not COMMENT_ID_RE.match(cand):
                    return 400, {"ok": False, "error": "invalid_parent"}
                prow = self._conn.execute(
                    "SELECT id, parent_id FROM comments WHERE id = ? AND site = ? AND slug = ? AND status = 'visible' LIMIT 1",
                    (cand, self.site, slug),
                ).fetchone()
                if not prow:
                    return 404, {"ok": False, "error": "parent_not_found"}
                resolved_parent = prow["parent_id"] or prow["id"]

            if pending_nonce is not None:
                cur = self._conn.execute(
                    "INSERT OR IGNORE INTO comment_nonces (nonce, expires_at) VALUES (?, ?)",
                    pending_nonce,
                )
                if cur.rowcount == 0:
                    self._conn.commit()
                    return 409, {"ok": False, "error": "gate_replayed", "nextGate": self._sign_gate(slug)}

            try:
                for img in prepared_images:
                    r2_key = f"{self.site}/{slug}/{cid}/{img['id']}.{img['ext']}"
                    img["r2Key"] = r2_key
                    self._put_blob(r2_key, img["bytes"])  # type: ignore[arg-type]
                    written_keys.append(r2_key)

                self._conn.execute(
                    """INSERT INTO comments
                         (id, site, slug, parent_id, author_name, author_url, is_author, lang, body, body_hash, ip_hash, verification_mode, status, created_at, client_request_id)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'visible', ?, ?)""",
                    (
                        cid,
                        self.site,
                        slug,
                        resolved_parent,
                        stored_name,
                        author_url,
                        1 if is_author else 0,
                        lang,
                        body,
                        body_hash,
                        ip_hash,
                        verification_mode,
                        now_ms,
                        client_request_id,
                    ),
                )
                for img in prepared_images:
                    self._conn.execute(
                        """INSERT INTO comment_images
                             (id, site, slug, comment_id, r2_key, mime_type, width, height, size_bytes, sha256, alt, sort_order, status, created_at)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'visible', ?)""",
                        (
                            img["id"],
                            self.site,
                            slug,
                            cid,
                            img["r2Key"],
                            img["mimeType"],
                            img["width"],
                            img["height"],
                            img["sizeBytes"],
                            img["sha256"],
                            img["alt"],
                            img["sortOrder"],
                            now_ms,
                        ),
                    )
                self._conn.commit()
            except sqlite3.IntegrityError as exc:
                self._conn.rollback()
                for key in written_keys:
                    self._delete_blob(key)
                err_msg = str(exc)
                if "parent_not_found" in err_msg:
                    return 404, {"ok": False, "error": "parent_not_found", "nextGate": self._sign_gate(slug)}
                if client_request_id and ("client_request_id" in err_msg.lower() or "unique constraint failed" in err_msg.lower()):
                    existing = self._conn.execute(
                        """SELECT id, slug, parent_id, author_name, author_url, is_author, lang, body, ip_hash, status, created_at
                             FROM comments
                            WHERE site = ?
                              AND slug = ?
                              AND client_request_id = ?
                            LIMIT 1""",
                        (self.site, slug, client_request_id),
                    ).fetchone()
                    if existing:
                        same_owner = is_author or existing["ip_hash"] in (ip_hash, ip_hash_prev)
                        if existing["status"] == "visible" and same_owner:
                            img_rows = self._conn.execute(
                                """SELECT id, mime_type, width, height, size_bytes, alt
                                     FROM comment_images
                                    WHERE site = ? AND comment_id = ? AND status = 'visible'
                                    ORDER BY sort_order ASC, created_at ASC""",
                                (self.site, existing["id"]),
                            ).fetchall()
                            return 200, {
                                "ok": True,
                                "idempotent": True,
                                "comment": {
                                    "id": existing["id"],
                                    "slug": existing["slug"],
                                    "parentId": existing["parent_id"],
                                    "authorName": existing["author_name"] or "",
                                    "authorUrl": existing["author_url"],
                                    "isAuthor": bool(existing["is_author"]),
                                    "lang": existing["lang"] or "zh",
                                    "body": existing["body"],
                                    "images": [
                                        {
                                            "id": r["id"],
                                            "url": f"/api/comments/images/{urllib.parse.quote(str(r['id']), safe='')}",
                                            "mimeType": r["mime_type"],
                                            "width": int(r["width"] or 0),
                                            "height": int(r["height"] or 0),
                                            "sizeBytes": int(r["size_bytes"] or 0),
                                            "alt": r["alt"] or "",
                                        }
                                        for r in img_rows
                                    ],
                                    "createdAt": int(existing["created_at"]),
                                },
                                "verificationMode": verification_mode,
                                "nextGate": self._sign_gate(slug),
                            }
                    return 409, {"ok": False, "error": "duplicate_comment", "nextGate": self._sign_gate(slug)}
                return 500, {"ok": False, "error": "storage_write_failed", "nextGate": self._sign_gate(slug)}
            except Exception:
                self._conn.rollback()
                for key in written_keys:
                    self._delete_blob(key)
                return 500, {"ok": False, "error": "storage_write_failed", "nextGate": self._sign_gate(slug)}

        serialized_images = [
            {
                "id": img["id"],
                "url": f"/api/comments/images/{urllib.parse.quote(str(img['id']), safe='')}",
                "mimeType": img["mimeType"],
                "width": img["width"],
                "height": img["height"],
                "sizeBytes": img["sizeBytes"],
                "alt": img["alt"],
            }
            for img in prepared_images
        ]

        return 201, {
            "ok": True,
            "comment": {
                "id": cid,
                "slug": slug,
                "parentId": resolved_parent,
                "authorName": stored_name,
                "authorUrl": author_url,
                "isAuthor": is_author,
                "lang": lang,
                "body": body,
                "images": serialized_images,
                "createdAt": now_ms,
            },
            "verificationMode": verification_mode,
            "nextGate": self._sign_gate(slug),
        }

    def delete_comment(self, comment_id: str, author_header: str) -> tuple[int, dict[str, object]]:
        if not self.verify_author(author_header):
            return 401, {"ok": False, "error": "unauthorized"}
        if not COMMENT_ID_RE.match(comment_id):
            return 400, {"ok": False, "error": "invalid_id"}
        doomed_keys: list[str] = []
        now_ms = int(time.time() * 1000)
        with self._lock:
            self._conn.execute(
                """INSERT OR IGNORE INTO comment_image_deletions (r2_key, image_id, site, attempts, created_at)
                   SELECT ci.r2_key, ci.id, ci.site, 0, ?
                     FROM comment_images ci
                     JOIN comments c ON c.id = ci.comment_id AND c.site = ci.site
                    WHERE ci.site = ? AND (c.id = ? OR c.parent_id = ?) AND c.status = 'visible' AND ci.status = 'visible'""",
                (now_ms, self.site, comment_id, comment_id),
            )
            self._conn.execute(
                """UPDATE comment_images
                      SET status = 'deleted'
                    WHERE site = ?
                      AND comment_id IN (
                        SELECT id FROM comments WHERE site = ? AND (id = ? OR parent_id = ?) AND status = 'visible'
                      )
                      AND status = 'visible'""",
                (self.site, self.site, comment_id, comment_id),
            )
            cur = self._conn.execute(
                "UPDATE comments SET status = 'deleted' WHERE site = ? AND (id = ? OR parent_id = ?) AND status = 'visible'",
                (self.site, comment_id, comment_id),
            )
            pending_rows = self._conn.execute(
                "SELECT r2_key FROM comment_image_deletions WHERE site = ? ORDER BY created_at ASC LIMIT 50",
                (self.site,),
            ).fetchall()
            doomed_keys = [str(r["r2_key"]) for r in pending_rows]
            self._conn.commit()
            if cur.rowcount == 0:
                return 404, {"ok": False, "error": "not_found"}

        for key in doomed_keys:
            if self._delete_blob(key):
                with self._lock:
                    self._conn.execute("DELETE FROM comment_image_deletions WHERE r2_key = ?", (key,))
                    self._conn.commit()
            else:
                with self._lock:
                    self._conn.execute(
                        "UPDATE comment_image_deletions SET attempts = attempts + 1 WHERE r2_key = ?",
                        (key,),
                    )
                    self._conn.commit()
        return 200, {"ok": True, "id": comment_id}


class PreviewRequestHandler(http.server.BaseHTTPRequestHandler):
    roots: list[Path] = []
    header_rules: list[HeaderRule] = []
    comments_store: LocalCommentsStore | None = None
    quiet: bool = False

    def setup(self) -> None:
        super().setup()
        try:
            self.connection.settimeout(SOCKET_READ_TIMEOUT_SEC)
        except OSError:
            pass

    def log_message(self, format: str, *args: object) -> None:
        if not self.quiet:
            super().log_message(format, *args)

    def _is_origin_allowed(self) -> bool:
        sec_fetch = (self.headers.get("Sec-Fetch-Site") or "").strip().lower()
        if sec_fetch and sec_fetch not in ("same-origin", "none"):
            return False
        host_hdr = (self.headers.get("Host") or "").strip().lower()
        allowed_hosts = {"127.0.0.1", "localhost", "::1"}
        if host_hdr:
            parsed_host = urllib.parse.urlsplit(f"http://{host_hdr}").hostname
            if parsed_host:
                allowed_hosts.add(parsed_host.lower())

        origin = (self.headers.get("Origin") or "").strip()
        if not origin:
            referer = (self.headers.get("Referer") or "").strip()
            if not referer:
                return True
            try:
                ref_host = (urllib.parse.urlsplit(referer).hostname or "").lower()
                return ref_host in allowed_hosts
            except Exception:
                return False
        try:
            origin_host = (urllib.parse.urlsplit(origin).hostname or "").lower()
            return origin_host in allowed_hosts
        except Exception:
            return False

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

    def _send_json(self, status: int, payload: dict[str, object], *, head_only: bool = False) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if not head_only:
            self.wfile.write(body)

    def _send_raw(self, status: int, headers: dict[str, str], body: bytes, *, head_only: bool = False) -> None:
        self.send_response(status)
        has_len = any(k.lower() == "content-length" for k in headers)
        for name, val in headers.items():
            self.send_header(name, val)
        if status != 304 and not has_len:
            self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if not head_only and status != 304 and body:
            self.wfile.write(body)

    def _read_exact_bounded(self, length: int, max_bytes: int) -> tuple[bytes | None, int, str]:
        if length <= 0:
            return None, 400, "invalid_payload"
        if length > max_bytes:
            return None, 413, "payload_too_large"
        chunks: list[bytes] = []
        remaining = length
        deadline = time.monotonic() + SOCKET_READ_TIMEOUT_SEC
        try:
            while remaining > 0:
                left = deadline - time.monotonic()
                if left <= 0:
                    return None, 408, "request_timeout"
                try:
                    self.connection.settimeout(max(0.05, left))
                except OSError:
                    pass
                chunk = self.rfile.read1(min(65536, remaining))
                if not chunk:
                    return None, 400, "invalid_payload"
                chunks.append(chunk)
                remaining -= len(chunk)
            if time.monotonic() > deadline:
                return None, 408, "request_timeout"
        except OSError:
            return None, 408, "request_timeout"
        finally:
            try:
                self.connection.settimeout(SOCKET_READ_TIMEOUT_SEC)
            except OSError:
                pass
        return b"".join(chunks), 200, ""

    def _read_create_payload(self) -> tuple[dict | None, list[bytes], int, str]:
        raw_ct = self.headers.get("Content-Type") or ""
        lower_ct = raw_ct.lower()
        try:
            length = int(self.headers.get("Content-Length") or "0")
        except ValueError:
            return None, [], 400, "invalid_payload"

        if "multipart/form-data" in lower_ct:
            raw, st, err = self._read_exact_bounded(length, MAX_MULTIPART_BYTES)
            if raw is None:
                return None, [], st, "invalid_multipart" if err == "invalid_payload" else err
            parsed = _parse_multipart_form_data(raw_ct, raw)
            if parsed is None:
                return None, [], 400, "invalid_multipart"
            fields, files = parsed
            if "payload" in fields:
                payload_str = fields["payload"][0]
                if len(payload_str.encode("utf-8")) > MAX_JSON_BYTES:
                    return None, [], 413, "payload_too_large"
                try:
                    obj = json.loads(payload_str)
                    if not isinstance(obj, dict):
                        return None, [], 400, "invalid_json"
                    return obj, files, 200, ""
                except Exception:
                    return None, [], 400, "invalid_json"
            data: dict[str, object] = {}
            for key in (
                "slug",
                "lang",
                "parentId",
                "authorName",
                "authorUrl",
                "body",
                "websiteHp",
                "gateToken",
                "powNonce",
                "turnstileToken",
            ):
                if key in fields:
                    data[key] = fields[key][0]
            if "fallbackMode" in fields:
                data["fallbackMode"] = fields["fallbackMode"][0] in ("true", "1")
            return data, files, 200, ""

        if not lower_ct or "application/json" in lower_ct:
            raw, st, err = self._read_exact_bounded(length, MAX_JSON_BYTES)
            if raw is None:
                return None, [], st, "invalid_json" if err == "invalid_payload" else err
            try:
                obj = json.loads(raw.decode("utf-8"))
                if not isinstance(obj, dict):
                    return None, [], 400, "invalid_json"
                return obj, [], 200, ""
            except Exception:
                return None, [], 400, "invalid_json"

        return None, [], 415, "unsupported_media_type"

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

    def _handle_comments_api(self, method: str, norm_path: str, query_str: str, *, head_only: bool = False) -> bool:
        if self.comments_store is None:
            return False
        if not (norm_path == "/api/comments" or norm_path.startswith("/api/comments/")):
            return False

        author_hdr = self.headers.get("X-Author-Key", "")
        if norm_path in ("/api/comments", "/api/comments/"):
            if method == "GET":
                qs = urllib.parse.parse_qs(query_str)
                slug = (qs.get("slug", [""])[0] or "").strip().lower()
                status, payload = self.comments_store.list_comments(slug, author_hdr)
                self._send_json(status, payload, head_only=head_only)
                return True
            if method == "POST":
                if not self._is_origin_allowed():
                    self._send_json(403, {"ok": False, "error": "forbidden_origin"})
                    return True
                body, files, err_status, err_code = self._read_create_payload()
                if body is None:
                    self._send_json(err_status, {"ok": False, "error": err_code})
                    return True
                status, payload = self.comments_store.create_comment(
                    body,
                    self.client_address[0],
                    author_hdr,
                    raw_files=files,
                )
                self._send_json(status, payload)
                return True
            self._send_json(405, {"ok": False, "error": "method_not_allowed"})
            return True

        if norm_path == "/api/comments/author/verify":
            if method == "POST":
                if not self._is_origin_allowed():
                    self._send_json(403, {"ok": False, "error": "forbidden_origin"})
                    return True
                if self.comments_store.verify_author(author_hdr):
                    self._send_json(200, {"ok": True, "author": True})
                else:
                    self._send_json(401, {"ok": False, "error": "invalid_author_key"})
                return True
            self._send_json(405, {"ok": False, "error": "method_not_allowed"})
            return True

        if norm_path.startswith("/api/comments/images/"):
            img_id = norm_path[len("/api/comments/images/") :].strip("/")
            if method == "GET":
                status, hdrs, raw_body = self.comments_store.get_image(
                    img_id,
                    self.headers.get("If-None-Match"),
                    head_only=head_only,
                )
                self._send_raw(status, hdrs, raw_body, head_only=head_only)
                return True
            self._send_json(405, {"ok": False, "error": "method_not_allowed"})
            return True

        cid = norm_path[len("/api/comments/") :].strip("/")
        if method == "DELETE":
            if not self._is_origin_allowed():
                self._send_json(403, {"ok": False, "error": "forbidden_origin"})
                return True
            status, payload = self.comments_store.delete_comment(cid, author_hdr)
            self._send_json(status, payload)
            return True
        self._send_json(405, {"ok": False, "error": "method_not_allowed"})
        return True

    def _handle(self, head_only: bool) -> None:
        parsed = urllib.parse.urlsplit(self.path)
        norm_path = self._normalize_req_path(parsed.path or "/")
        query = f"?{parsed.query}" if parsed.query else ""

        if self._handle_comments_api("GET", norm_path, parsed.query, head_only=head_only):
            return

        last_segment = norm_path.rstrip("/").rsplit("/", 1)[-1].lower()
        if last_segment in PROTECTED_FILENAMES:
            self._send_404(norm_path, head_only)
            return

        if norm_path == "/index.html" or norm_path.endswith("/index.html"):
            canonical_dir = norm_path[: -len("index.html")] or "/"
            dir_cands = self._safe_candidates(canonical_dir)
            if any(c.is_dir() and (c / "index.html").is_file() for c in dir_cands):
                self._send_redirect(f"{canonical_dir}{query}")
                return

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

        for target in candidates:
            if target.is_file():
                self._send_file(200, target, norm_path, head_only)
                return

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

    def do_POST(self) -> None:
        parsed = urllib.parse.urlsplit(self.path)
        norm_path = self._normalize_req_path(parsed.path or "/")
        if not self._handle_comments_api("POST", norm_path, parsed.query):
            self._send_json(405, {"ok": False, "error": "method_not_allowed"})

    def do_DELETE(self) -> None:
        parsed = urllib.parse.urlsplit(self.path)
        norm_path = self._normalize_req_path(parsed.path or "/")
        if not self._handle_comments_api("DELETE", norm_path, parsed.query):
            self._send_json(405, {"ok": False, "error": "method_not_allowed"})


class ReusableThreadingHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    allow_reuse_address = True
    daemon_threads = True


def _resolve_local_author_key(site_name: str, bind_host: str) -> str:
    env_key = os.environ.get("TI_LOCAL_AUTHOR_KEY", "").strip()
    if env_key:
        return env_key
    if LOCAL_AUTHOR_KEYS_PATH.is_file():
        try:
            data = json.loads(LOCAL_AUTHOR_KEYS_PATH.read_text(encoding="utf-8"))
            val = str((data.get(site_name) or {}).get("author_key", "")).strip()
            if val:
                return val
        except Exception:
            pass
    # Never expose a hardcoded default author key on non-loopback network binds
    if bind_host.strip().lower() not in LOOPBACK_HOSTS:
        return ""
    return "local-author-dev-key"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Tong's Information local preview server")
    parser.add_argument("--host", default="127.0.0.1", help="Bind host (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8788, help="Bind port (default: 8788)")
    parser.add_argument("--site", help="Site name under sites/ (overlays sites/<site>/public on engine/)")
    parser.add_argument("--dir", help="Serve a flat static directory directly (e.g. .dist/demo)")
    parser.add_argument("--ephemeral-db", action="store_true", help="Use in-memory SQLite DB for local comments API")
    parser.add_argument("--turnstile-sitekey", default="", help="Optional Turnstile sitekey for local widget testing")
    parser.add_argument("--min-dwell-ms", type=int, default=800, help="Local minimum dwell gate in ms (default: 800)")
    parser.add_argument("--enforce-quotas", action="store_true", help="Enforce Worker short/hour sliding-window comment quotas locally")
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
        site_name = "demo"
        rel_json = flat_dir / "api" / "release.json"
        if rel_json.is_file():
            try:
                site_name = str(json.loads(rel_json.read_text(encoding="utf-8")).get("site") or "demo")
            except Exception:
                pass
        use_mem_db = True
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
        use_mem_db = args.ephemeral_db

    site_author = "Author"
    cat_path = SITES_DIR / site_name / "catalog.json"
    if cat_path.is_file():
        try:
            site_author = str(json.loads(cat_path.read_text(encoding="utf-8")).get("site", {}).get("author") or "Author")
        except Exception:
            pass

    if use_mem_db:
        db_path = ":memory:"
        images_dir = None
    else:
        cf_dir = ROOT / ".cloudflare"
        cf_dir.mkdir(exist_ok=True)
        db_path = str(cf_dir / f"local-comments-{site_name}.sqlite3")
        images_dir = cf_dir / f"local-comment-images-{site_name}"

    comments_store = LocalCommentsStore(
        site=site_name,
        site_author=site_author,
        db_path=db_path,
        images_dir=images_dir,
        author_key=_resolve_local_author_key(site_name, args.host),
        turnstile_sitekey=args.turnstile_sitekey,
        min_dwell_ms=max(0, args.min_dwell_ms),
        enforce_quotas=args.enforce_quotas,
    )

    handler_cls = type(
        "ConfiguredPreviewHandler",
        (PreviewRequestHandler,),
        {
            "roots": roots,
            "header_rules": rules,
            "comments_store": comments_store,
            "quiet": args.quiet,
        },
    )
    server = ReusableThreadingHTTPServer((args.host, args.port), handler_cls)
    print(
        f"[preview_server] Serving {mode_desc} at http://{args.host}:{args.port}/ "
        f"({len(rules)} _headers rules, comments_db={db_path})",
        flush=True,
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[preview_server] Stopped.")
    finally:
        server.server_close()
        comments_store.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
