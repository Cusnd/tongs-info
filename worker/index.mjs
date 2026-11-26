/**
 * Tong's Information — Edge Comments Worker (Zero-Dependency ESM)
 *
 * Routed exclusively for `/api/comments` and `/api/comments/*` via Workers Static Assets
 * `runWorkerFirst`; all static publication routes remain pure edge-cached Static Assets.
 *
 * Defense-in-depth anti-abuse layers:
 *   1. Origin & Sec-Fetch-Site same-origin enforcement + pre-body edge rate limiting
 *   2. Silent shadow-drop honeypot trap
 *   3. Cloudflare Workers Rate Limiting binding + D1 sliding-window IP-hash & image quotas (UTC-midnight safe)
 *   4. HMAC-SHA256 signed single-use challenge gate + minimum human dwell check
 *   5. Cloudflare Turnstile canonical server-side Siteverify (action + hostname checked)
 *   6. Adaptive SHA-256 Proof-of-Work (imperceptible ~12-bit normal, stronger ~17-bit fallback)
 *   7. Link density cap, control/bidi-override stripping, duplicate suppression,
 *      complete container + animation-budget verification, metadata scrubbing & durable R2 cleanup outbox
 */

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const COMMENT_ID_RE = /^[a-zA-Z0-9_-]{8,64}$/;
const IMAGE_ID_RE = /^img_[a-f0-9]{16,32}$/;
const URL_COUNT_RE = /(?:https?:\/\/|www\.)\S+/gi;
const CONTROL_AND_BIDI_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/g;

const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_MULTIPART_BYTES = 7 * 1024 * 1024;
const MAX_IMAGES_PER_COMMENT = 3;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_DIMENSION = 4096;
const MAX_IMAGE_PIXELS = 16_000_000;
const MAX_ANIM_FRAMES = 120;
const MAX_ANIM_TOTAL_PIXELS = 64_000_000;
const MAX_ALT_LEN = 160;
const MAX_NAME_LEN = 32;
const MAX_URL_LEN = 200;
const MIN_BODY_LEN = 2;
const MAX_BODY_LEN = 2000;
const MAX_COMMENTS_RETURNED = 200;

const HOUR_IMAGE_LIMIT_NORMAL = 9;
const HOUR_IMAGE_LIMIT_FALLBACK = 4;

const SAFE_IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const ACCEPTED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];

const GATE_TTL_MS = 15 * 60 * 1000;
const MIN_DWELL_NORMAL_MS = 1200;
const MIN_DWELL_FALLBACK_MS = 2200;
const BASE_POW_BITS = 12;
const FALLBACK_POW_BITS = 17;
const ELEVATED_POW_DELTA = 2;

const TURNSTILE_ACTION = "comment";
const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function jsonResponse(payload, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Vary": "Origin",
      ...extraHeaders,
    },
  });
}

function isMissingImageTableError(err) {
  return /no such table:\s*comment_image(?:s|_deletions)/i.test(String(err?.message || err || ""));
}

function isParentTriggerAbort(err) {
  return /parent_not_found/i.test(String(err?.message || err || ""));
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(str) {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (str.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

function bytesToHex(bytes) {
  let hex = "";
  for (let i = 0; i < bytes.length; i += 1) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

function randomHex(numBytes) {
  const buf = new Uint8Array(numBytes);
  crypto.getRandomValues(buf);
  return bytesToHex(buf);
}

function concatUint8Arrays(parts) {
  let total = 0;
  for (const p of parts) total += p.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
}

async function sha256Bytes(input) {
  const data = typeof input === "string" ? encoder.encode(input) : input;
  const digest = await crypto.subtle.digest("SHA-256", data);
  return new Uint8Array(digest);
}

async function sha256Hex(input) {
  return bytesToHex(await sha256Bytes(input));
}

async function hmacSign(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return new Uint8Array(sig);
}

/** Constant-time string comparison using SHA-256 fixed-length digests. */
async function timingSafeEqualStrings(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length === 0 || b.length === 0) {
    return false;
  }
  const [da, db] = await Promise.all([sha256Bytes(a), sha256Bytes(b)]);
  if (typeof crypto.subtle.timingSafeEqual === "function") {
    return crypto.subtle.timingSafeEqual(da, db);
  }
  let diff = 0;
  for (let i = 0; i < da.length; i += 1) {
    diff |= da[i] ^ db[i];
  }
  return diff === 0;
}

function hasLeadingZeroBits(bytes, bits) {
  const fullBytes = Math.floor(bits / 8);
  const remBits = bits % 8;
  for (let i = 0; i < fullBytes; i += 1) {
    if (bytes[i] !== 0) return false;
  }
  if (remBits > 0) {
    const mask = (0xff << (8 - remBits)) & 0xff;
    if ((bytes[fullBytes] & mask) !== 0) return false;
  }
  return true;
}

function parseAllowedHostnames(env) {
  const raw = String(env.TURNSTILE_HOSTNAMES || "");
  return new Set(
    raw
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean)
  );
}

function isOriginAllowed(request, env) {
  const allowed = parseAllowedHostnames(env);
  const reqHost = new URL(request.url).hostname.toLowerCase();
  if (reqHost) allowed.add(reqHost);

  const secFetchSite = (request.headers.get("Sec-Fetch-Site") || "").toLowerCase();
  if (secFetchSite && secFetchSite !== "same-origin" && secFetchSite !== "none") {
    return false;
  }

  const origin = request.headers.get("Origin");
  if (!origin) {
    const referer = request.headers.get("Referer");
    if (!referer) return true;
    try {
      return allowed.has(new URL(referer).hostname.toLowerCase());
    } catch {
      return false;
    }
  }

  try {
    const originHost = new URL(origin).hostname.toLowerCase();
    return allowed.has(originHost);
  } catch {
    return false;
  }
}

function sanitizeText(raw, { multiline = false } = {}) {
  let text = String(raw ?? "").replace(/\r\n?/g, "\n").replace(CONTROL_AND_BIDI_RE, "");
  if (multiline) {
    text = text.replace(/\n{3,}/g, "\n\n").trim();
  } else {
    text = text.replace(/\s+/g, " ").trim();
  }
  return text;
}

function sanitizeAuthorUrl(raw) {
  const trimmed = sanitizeText(raw, { multiline: false });
  if (!trimmed) return null;
  if (trimmed.length > MAX_URL_LEN) return { error: "url_too_long" };
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { error: "invalid_url" };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { error: "invalid_url" };
  }
  if (!parsed.hostname || parsed.hostname.includes(" ")) {
    return { error: "invalid_url" };
  }
  return parsed.toString();
}

function getClientIp(request) {
  const cfIp = request.headers.get("CF-Connecting-IP");
  if (cfIp) return cfIp.trim();
  const xff = request.headers.get("X-Forwarded-For");
  if (xff) return xff.split(",")[0].trim();
  return "0.0.0.0";
}

async function computeDailyIpHashes(ip, gateSecret, nowMs = Date.now()) {
  const today = new Date(nowMs).toISOString().slice(0, 10);
  const yesterday = new Date(nowMs - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const [current, previous] = await Promise.all([
    sha256Hex(`${gateSecret}:ip:${today}:${ip}`),
    sha256Hex(`${gateSecret}:ip:${yesterday}:${ip}`),
  ]);
  return { current, previous };
}

async function readBodyBytesBounded(request, maxBytes) {
  const contentLength = Number(request.headers.get("Content-Length") || 0);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    return { error: "payload_too_large", status: 413 };
  }
  if (!request.body) {
    return { error: "invalid_payload", status: 400 };
  }
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return { error: "payload_too_large", status: 413 };
      }
      chunks.push(value);
    }
  } catch {
    return { error: "invalid_payload", status: 400 };
  }
  return { bytes: concatUint8Arrays(chunks) };
}

async function readCreateCommentPayload(request) {
  const rawCt = request.headers.get("Content-Type") || "";
  const lowerCt = rawCt.toLowerCase();

  if (lowerCt.includes("multipart/form-data")) {
    const rawBody = await readBodyBytesBounded(request, MAX_MULTIPART_BYTES);
    if (rawBody.error) {
      return { error: rawBody.error, status: rawBody.status };
    }
    let formData;
    try {
      formData = await new Response(rawBody.bytes, {
        headers: { "Content-Type": rawCt },
      }).formData();
    } catch {
      return { error: "invalid_multipart", status: 400 };
    }

    let data = {};
    const payloadEntry = formData.get("payload");
    if (payloadEntry !== null) {
      if (typeof payloadEntry !== "string") {
        return { error: "invalid_json", status: 400 };
      }
      if (encoder.encode(payloadEntry).byteLength > MAX_REQUEST_BYTES) {
        return { error: "payload_too_large", status: 413 };
      }
      try {
        const parsed = JSON.parse(payloadEntry);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          return { error: "invalid_json", status: 400 };
        }
        data = parsed;
      } catch {
        return { error: "invalid_json", status: 400 };
      }
    } else {
      const scalarFields = [
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
      ];
      for (const key of scalarFields) {
        const val = formData.get(key);
        if (typeof val === "string") data[key] = val;
      }
      const fb = formData.get("fallbackMode");
      if (typeof fb === "string") {
        data.fallbackMode = fb === "true" || fb === "1";
      }
    }

    const rawImages = [...formData.getAll("images"), ...formData.getAll("image")];
    const files = [];
    for (const entry of rawImages) {
      if (typeof entry === "string" || !entry || typeof entry.arrayBuffer !== "function") {
        return { error: "invalid_image", status: 400 };
      }
      files.push(entry);
    }

    return { data, files };
  }

  if (!lowerCt || lowerCt.includes("application/json")) {
    const rawBody = await readBodyBytesBounded(request, MAX_REQUEST_BYTES);
    if (rawBody.error) {
      return {
        error: rawBody.error === "invalid_payload" ? "invalid_json" : rawBody.error,
        status: rawBody.status,
      };
    }
    try {
      const parsed = JSON.parse(decoder.decode(rawBody.bytes));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { error: "invalid_json", status: 400 };
      }
      return { data: parsed, files: [] };
    } catch {
      return { error: "invalid_json", status: 400 };
    }
  }

  return { error: "unsupported_media_type", status: 415 };
}

function validatePngAndScrub(bytes, view) {
  if (bytes.byteLength < 33) return { ok: false, error: "invalid_image" };
  let offset = 8;
  let width = 0;
  let height = 0;
  let hasIdat = false;
  let hasIend = false;
  let hasActl = false;
  let actlFrames = 0;
  let fctlCount = 0;
  let animTotalPixels = 0;
  const kept = [bytes.subarray(0, 8)];
  let scrubbed = false;
  let chunks = 0;

  while (offset + 12 <= bytes.byteLength && chunks < 2048) {
    chunks += 1;
    const len = view.getUint32(offset, false);
    if (len > 0x7fffffff || offset + 12 + len > bytes.byteLength) {
      return { ok: false, error: "invalid_image" };
    }
    const type = String.fromCharCode(
      bytes[offset + 4],
      bytes[offset + 5],
      bytes[offset + 6],
      bytes[offset + 7]
    );
    const dataStart = offset + 8;
    const next = offset + 12 + len;

    if (chunks === 1) {
      if (type !== "IHDR" || len !== 13) return { ok: false, error: "invalid_image" };
      width = view.getUint32(dataStart, false);
      height = view.getUint32(dataStart + 4, false);
    } else if (type === "acTL") {
      if (len !== 8) return { ok: false, error: "invalid_image" };
      hasActl = true;
      actlFrames = view.getUint32(dataStart, false);
      if (actlFrames < 1 || actlFrames > MAX_ANIM_FRAMES) {
        return { ok: false, error: "image_dimensions_exceeded" };
      }
      if (width * height * actlFrames > MAX_ANIM_TOTAL_PIXELS) {
        return { ok: false, error: "image_dimensions_exceeded" };
      }
    } else if (type === "fcTL") {
      if (len !== 26) return { ok: false, error: "invalid_image" };
      const fw = view.getUint32(dataStart + 4, false);
      const fh = view.getUint32(dataStart + 8, false);
      const fx = view.getUint32(dataStart + 12, false);
      const fy = view.getUint32(dataStart + 16, false);
      if (fw < 1 || fh < 1 || fx + fw > width || fy + fh > height) {
        return { ok: false, error: "invalid_image" };
      }
      fctlCount += 1;
      animTotalPixels += fw * fh;
      if (fctlCount > MAX_ANIM_FRAMES || animTotalPixels > MAX_ANIM_TOTAL_PIXELS) {
        return { ok: false, error: "image_dimensions_exceeded" };
      }
    } else if (type === "IDAT") {
      hasIdat = true;
    }

    if (type === "tEXt" || type === "zTXt" || type === "iTXt" || type === "eXIf") {
      scrubbed = true;
    } else {
      kept.push(bytes.subarray(offset, next));
    }
    offset = next;
    if (type === "IEND") {
      if (len !== 0) return { ok: false, error: "invalid_image" };
      hasIend = true;
      break;
    }
  }

  if (!hasIdat || !hasIend) return { ok: false, error: "invalid_image" };
  if (hasActl && fctlCount !== actlFrames) {
    return { ok: false, error: "invalid_image" };
  }
  const hasTrailing = offset < bytes.byteLength;
  return {
    ok: true,
    mimeType: "image/png",
    ext: "png",
    width,
    height,
    bytes: scrubbed ? concatUint8Arrays(kept) : hasTrailing ? bytes.subarray(0, offset) : bytes,
  };
}

function validateGifAndScrub(bytes, view) {
  if (bytes.byteLength < 14) return { ok: false, error: "invalid_image" };
  const width = view.getUint16(6, true);
  const height = view.getUint16(8, true);
  const packed = bytes[10];
  let offset = 13;
  if ((packed & 0x80) !== 0) {
    const gctSize = 3 * (1 << ((packed & 0x07) + 1));
    offset += gctSize;
    if (offset > bytes.byteLength) return { ok: false, error: "invalid_image" };
  }

  const kept = [bytes.subarray(0, offset)];
  let scrubbed = false;
  let frames = 0;
  let totalPixels = 0;
  let hasTrailer = false;

  const skipSubBlocks = (start) => {
    let p = start;
    let steps = 0;
    while (p < bytes.byteLength && steps < 65536) {
      steps += 1;
      const subLen = bytes[p];
      p += 1;
      if (subLen === 0) return p;
      p += subLen;
      if (p > bytes.byteLength) return -1;
    }
    return -1;
  };

  while (offset < bytes.byteLength) {
    const intro = bytes[offset];
    if (intro === 0x3b) {
      kept.push(bytes.subarray(offset, offset + 1));
      offset += 1;
      hasTrailer = true;
      break;
    }
    if (intro === 0x2c) {
      if (offset + 10 > bytes.byteLength) return { ok: false, error: "invalid_image" };
      const fw = view.getUint16(offset + 5, true);
      const fh = view.getUint16(offset + 7, true);
      if (fw < 1 || fh < 1 || fw > MAX_IMAGE_DIMENSION || fh > MAX_IMAGE_DIMENSION) {
        return { ok: false, error: "image_dimensions_exceeded" };
      }
      frames += 1;
      totalPixels += fw * fh;
      if (frames > MAX_ANIM_FRAMES || totalPixels > MAX_ANIM_TOTAL_PIXELS) {
        return { ok: false, error: "image_dimensions_exceeded" };
      }
      const lctPacked = bytes[offset + 9];
      let p = offset + 10;
      if ((lctPacked & 0x80) !== 0) {
        p += 3 * (1 << ((lctPacked & 0x07) + 1));
      }
      if (p >= bytes.byteLength) return { ok: false, error: "invalid_image" };
      p += 1; // LZW minimum code size
      const end = skipSubBlocks(p);
      if (end === -1) return { ok: false, error: "invalid_image" };
      kept.push(bytes.subarray(offset, end));
      offset = end;
      continue;
    }
    if (intro === 0x21) {
      if (offset + 2 >= bytes.byteLength) return { ok: false, error: "invalid_image" };
      const label = bytes[offset + 1];
      const end = skipSubBlocks(offset + 2);
      if (end === -1) return { ok: false, error: "invalid_image" };
      let keepExt = false;
      if (label === 0xf9) {
        keepExt = true; // Graphic Control Extension (frame delay / transparency)
      } else if (label === 0xff && offset + 14 <= end && bytes[offset + 2] === 11) {
        const appId = String.fromCharCode(...bytes.subarray(offset + 3, offset + 14));
        if (appId === "NETSCAPE2.0" || appId === "ANIMEXTS1.0") {
          keepExt = true;
        }
      }
      if (keepExt) {
        kept.push(bytes.subarray(offset, end));
      } else {
        scrubbed = true;
      }
      offset = end;
      continue;
    }
    return { ok: false, error: "invalid_image" };
  }

  if (!hasTrailer || frames < 1) return { ok: false, error: "invalid_image" };
  const hasTrailing = offset < bytes.byteLength;
  return {
    ok: true,
    mimeType: "image/gif",
    ext: "gif",
    width,
    height,
    bytes: scrubbed ? concatUint8Arrays(kept) : hasTrailing ? bytes.subarray(0, offset) : bytes,
  };
}

function validateWebpAndScrub(bytes, view) {
  if (bytes.byteLength < 20) return { ok: false, error: "invalid_image" };
  const riffSize = view.getUint32(4, true);
  if (riffSize < 12 || 8 + riffSize > bytes.byteLength) {
    return { ok: false, error: "invalid_image" };
  }
  const riffEnd = 8 + riffSize;
  let offset = 12;
  let width = 0;
  let height = 0;
  let hasVp8x = false;
  let hasImagePayload = false;
  let frames = 0;
  let totalPixels = 0;
  let scrubbed = false;
  const keptChunks = [];
  let vp8xChunkIdx = -1;

  let chunks = 0;
  while (offset + 8 <= riffEnd && chunks < 2048) {
    chunks += 1;
    const tag = String.fromCharCode(
      bytes[offset],
      bytes[offset + 1],
      bytes[offset + 2],
      bytes[offset + 3]
    );
    const chunkSize = view.getUint32(offset + 4, true);
    const paddedSize = chunkSize + (chunkSize & 1);
    const dataStart = offset + 8;
    const dataEnd = dataStart + chunkSize;
    const next = dataStart + paddedSize;
    if (dataEnd > riffEnd || next > bytes.byteLength) {
      return { ok: false, error: "invalid_image" };
    }

    if (tag === "VP8 ") {
      if (chunkSize < 10 || bytes[dataStart + 3] !== 0x9d || bytes[dataStart + 4] !== 0x01 || bytes[dataStart + 5] !== 0x2a) {
        return { ok: false, error: "invalid_image" };
      }
      if (!width || !height) {
        width = view.getUint16(dataStart + 6, true) & 0x3fff;
        height = view.getUint16(dataStart + 8, true) & 0x3fff;
      }
      hasImagePayload = true;
    } else if (tag === "VP8L") {
      if (chunkSize < 5 || bytes[dataStart] !== 0x2f) {
        return { ok: false, error: "invalid_image" };
      }
      if (!width || !height) {
        const bits = view.getUint32(dataStart + 1, true);
        width = (bits & 0x3fff) + 1;
        height = ((bits >>> 14) & 0x3fff) + 1;
      }
      hasImagePayload = true;
    } else if (tag === "VP8X") {
      if (chunkSize !== 10 || chunks !== 1) {
        return { ok: false, error: "invalid_image" };
      }
      hasVp8x = true;
      width = 1 + (bytes[dataStart + 4] | (bytes[dataStart + 5] << 8) | (bytes[dataStart + 6] << 16));
      height = 1 + (bytes[dataStart + 7] | (bytes[dataStart + 8] << 8) | (bytes[dataStart + 9] << 16));
      vp8xChunkIdx = keptChunks.length;
    } else if (tag === "ANMF") {
      if (!hasVp8x || chunkSize < 24) return { ok: false, error: "invalid_image" };
      const fx = 2 * (bytes[dataStart] | (bytes[dataStart + 1] << 8) | (bytes[dataStart + 2] << 16));
      const fy = 2 * (bytes[dataStart + 3] | (bytes[dataStart + 4] << 8) | (bytes[dataStart + 5] << 16));
      const fw = 1 + (bytes[dataStart + 6] | (bytes[dataStart + 7] << 8) | (bytes[dataStart + 8] << 16));
      const fh = 1 + (bytes[dataStart + 9] | (bytes[dataStart + 10] << 8) | (bytes[dataStart + 11] << 16));
      if (fw > MAX_IMAGE_DIMENSION || fh > MAX_IMAGE_DIMENSION) {
        return { ok: false, error: "image_dimensions_exceeded" };
      }
      if (fx + fw > width || fy + fh > height) {
        return { ok: false, error: "invalid_image" };
      }
      // Validate nested frame sub-chunks inside ANMF: optional single ALPH before exactly ONE VP8 or VP8L bitstream matching (fw, fh)
      let subPos = dataStart + 16;
      let subFrameCount = 0;
      let subAlphCount = 0;
      let subCount = 0;
      while (subPos + 8 <= dataEnd && subCount < 8) {
        subCount += 1;
        const subTag = String.fromCharCode(
          bytes[subPos],
          bytes[subPos + 1],
          bytes[subPos + 2],
          bytes[subPos + 3]
        );
        const subLen = view.getUint32(subPos + 4, true);
        const subDataStart = subPos + 8;
        const subDataEnd = subDataStart + subLen;
        const subNext = subDataStart + subLen + (subLen & 1);
        if (subDataEnd > dataEnd) {
          return { ok: false, error: "invalid_image" };
        }
        if (subTag === "VP8 ") {
          if (subLen < 10 || bytes[subDataStart + 3] !== 0x9d || bytes[subDataStart + 4] !== 0x01 || bytes[subDataStart + 5] !== 0x2a) {
            return { ok: false, error: "invalid_image" };
          }
          const bw = view.getUint16(subDataStart + 6, true) & 0x3fff;
          const bh = view.getUint16(subDataStart + 8, true) & 0x3fff;
          if (bw !== fw || bh !== fh) {
            return { ok: false, error: "invalid_image" };
          }
          subFrameCount += 1;
        } else if (subTag === "VP8L") {
          if (subLen < 5 || bytes[subDataStart] !== 0x2f) {
            return { ok: false, error: "invalid_image" };
          }
          const bits = view.getUint32(subDataStart + 1, true);
          const bw = (bits & 0x3fff) + 1;
          const bh = ((bits >>> 14) & 0x3fff) + 1;
          if (bw !== fw || bh !== fh) {
            return { ok: false, error: "invalid_image" };
          }
          subFrameCount += 1;
        } else if (subTag === "ALPH") {
          if (subFrameCount > 0 || subAlphCount > 0) {
            return { ok: false, error: "invalid_image" };
          }
          subAlphCount += 1;
        } else {
          return { ok: false, error: "invalid_image" };
        }
        subPos = Math.min(subNext, dataEnd);
      }
      if (subFrameCount !== 1 || subPos < dataEnd) {
        return { ok: false, error: "invalid_image" };
      }
      frames += 1;
      totalPixels += fw * fh;
      if (frames > MAX_ANIM_FRAMES || totalPixels > MAX_ANIM_TOTAL_PIXELS) {
        return { ok: false, error: "image_dimensions_exceeded" };
      }
      hasImagePayload = true;
    }

    if (tag === "EXIF" || tag === "XMP ") {
      scrubbed = true;
    } else {
      keptChunks.push(bytes.subarray(offset, Math.min(next, riffEnd)));
    }
    offset = next;
  }

  if (!hasImagePayload || offset < riffEnd) {
    return { ok: false, error: "invalid_image" };
  }

  let outBytes = bytes;
  if (scrubbed || riffEnd < bytes.byteLength) {
    const bodyChunks = keptChunks.map((c, idx) => {
      let copy = c;
      if (idx === vp8xChunkIdx && copy.byteLength >= 18) {
        copy = new Uint8Array(copy);
        copy[8] &= ~(0x08 | 0x04); // Clear EXIF (bit 3) and XMP (bit 2) flags in VP8X
      }
      if ((copy.byteLength & 1) === 1) {
        const padded = new Uint8Array(copy.byteLength + 1);
        padded.set(copy);
        return padded;
      }
      return copy;
    });
    let payloadLen = 4; // "WEBP"
    for (const c of bodyChunks) payloadLen += c.byteLength;
    const header = new Uint8Array(12);
    header.set([0x52, 0x49, 0x46, 0x46], 0);
    new DataView(header.buffer).setUint32(4, payloadLen, true);
    header.set([0x57, 0x45, 0x42, 0x50], 8);
    outBytes = concatUint8Arrays([header, ...bodyChunks]);
  }

  return {
    ok: true,
    mimeType: "image/webp",
    ext: "webp",
    width,
    height,
    bytes: outBytes,
  };
}

function validateJpegAndScrub(bytes, view) {
  if (bytes.byteLength < 12) return { ok: false, error: "invalid_image" };
  let offset = 2;
  let width = 0;
  let height = 0;
  let foundSof = false;
  let foundSos = false;
  let foundEoi = false;
  const kept = [bytes.subarray(0, 2)];
  let scrubbed = false;
  let segCount = 0;

  // Complete multi-scan JPEG marker & entropy walk up to EOI (scrubs metadata even between progressive scans)
  while (offset + 1 < bytes.byteLength && segCount < 4096) {
    segCount += 1;
    if (bytes[offset] !== 0xff) {
      return { ok: false, error: "invalid_image" };
    }
    const segStart = offset;
    while (offset < bytes.byteLength && bytes[offset] === 0xff) {
      offset += 1;
    }
    if (offset >= bytes.byteLength) {
      return { ok: false, error: "invalid_image" };
    }
    const marker = bytes[offset];
    offset += 1;

    if (marker === 0xd9) {
      if (!foundSos) return { ok: false, error: "invalid_image" };
      kept.push(bytes.subarray(segStart, offset));
      foundEoi = true;
      break;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      kept.push(bytes.subarray(segStart, offset));
      continue;
    }
    if (offset + 1 >= bytes.byteLength) {
      return { ok: false, error: "invalid_image" };
    }
    const segLen = view.getUint16(offset, false);
    if (segLen < 2 || offset + segLen > bytes.byteLength) {
      return { ok: false, error: "invalid_image" };
    }
    const segEnd = offset + segLen;

    if (marker === 0xda) {
      if (!foundSof || segLen < 6) return { ok: false, error: "invalid_image" };
      foundSos = true;
      // Walk entropy-coded scan until next non-stuffed, non-RST 0xFF marker
      let p = segEnd;
      let nextMarkerPos = -1;
      while (p < bytes.byteLength) {
        if (bytes[p] !== 0xff) {
          p += 1;
          continue;
        }
        const runStart = p;
        while (p < bytes.byteLength && bytes[p] === 0xff) {
          p += 1;
        }
        if (p >= bytes.byteLength) {
          return { ok: false, error: "invalid_image" };
        }
        const m = bytes[p];
        if (m === 0x00 || (m >= 0xd0 && m <= 0xd7)) {
          p += 1;
          continue;
        }
        nextMarkerPos = runStart;
        break;
      }
      if (nextMarkerPos === -1) {
        return { ok: false, error: "invalid_image" };
      }
      kept.push(bytes.subarray(segStart, nextMarkerPos));
      offset = nextMarkerPos;
      continue;
    }

    const isSof =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (isSof && !foundSof) {
      if (segLen < 7) return { ok: false, error: "invalid_image" };
      height = view.getUint16(offset + 3, false);
      width = view.getUint16(offset + 5, false);
      foundSof = true;
    }

    // Strip EXIF/XMP (APP1), IPTC (APP13), and COM segments across all scans
    if (marker === 0xe1 || marker === 0xed || marker === 0xfe) {
      scrubbed = true;
    } else {
      kept.push(bytes.subarray(segStart, segEnd));
    }
    offset = segEnd;
  }

  if (!foundSof || !foundSos || !foundEoi) return { ok: false, error: "invalid_image" };
  const hasTrailing = offset < bytes.byteLength;
  return {
    ok: true,
    mimeType: "image/jpeg",
    ext: "jpg",
    width,
    height,
    bytes: scrubbed ? concatUint8Arrays(kept) : hasTrailing ? bytes.subarray(0, offset) : bytes,
  };
}

/**
 * Validate complete image containers, enforce dimensions & animation decode budgets,
 * and strip embedded metadata (EXIF/XMP/IPTC/comments) across PNG, GIF, WebP, and JPEG.
 */
function inspectAndSanitizeImage(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 12) {
    return { ok: false, error: "invalid_image" };
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let res;

  if (
    bytes.byteLength >= 24 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    res = validatePngAndScrub(bytes, view);
  } else if (
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    res = validateGifAndScrub(bytes, view);
  } else if (
    bytes.byteLength >= 20 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    res = validateWebpAndScrub(bytes, view);
  } else if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    res = validateJpegAndScrub(bytes, view);
  } else {
    return { ok: false, error: "invalid_image" };
  }

  if (!res.ok) return res;
  const { width, height } = res;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    return { ok: false, error: "invalid_image" };
  }
  if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION || width * height > MAX_IMAGE_PIXELS) {
    return { ok: false, error: "image_dimensions_exceeded" };
  }
  return res;
}

function serializeImage(row) {
  return {
    id: row.id,
    url: `/api/comments/images/${encodeURIComponent(row.id)}`,
    mimeType: row.mime_type,
    width: Number(row.width || 0),
    height: Number(row.height || 0),
    sizeBytes: Number(row.size_bytes || 0),
    alt: row.alt || "",
  };
}

function matchesIfNoneMatch(headerVal, etag) {
  if (!headerVal) return false;
  const trimmed = headerVal.trim();
  if (trimmed === "*") return true;
  const target = etag.replace(/^W\//i, "").trim();
  return trimmed
    .split(",")
    .map((part) => part.trim().replace(/^W\//i, ""))
    .some((candidate) => candidate === target);
}

async function computeAdaptiveDifficulty(db, site) {
  const fiveMinAgo = Date.now() - 5 * 60 * 1000;
  const row = await db
    .prepare("SELECT COUNT(*) AS cnt FROM comments WHERE site = ? AND created_at > ?")
    .bind(site, fiveMinAgo)
    .first();
  const recentCount = Number(row?.cnt || 0);
  const bump = recentCount >= 12 ? ELEVATED_POW_DELTA : 0;
  return {
    powBits: BASE_POW_BITS + bump,
    fallbackPowBits: FALLBACK_POW_BITS + bump,
  };
}

async function issueGateToken(env, site, slug) {
  const secret = env.COMMENT_GATE_SECRET;
  if (!secret) return null;
  const now = Date.now();
  const { powBits, fallbackPowBits } = await computeAdaptiveDifficulty(env.COMMENTS_DB, site);
  const payload = {
    v: 1,
    site,
    slug,
    n: randomHex(12),
    iat: now,
    exp: now + GATE_TTL_MS,
    d: powBits,
    fd: fallbackPowBits,
  };
  const payloadB64 = bytesToBase64Url(encoder.encode(JSON.stringify(payload)));
  const sig = bytesToBase64Url(await hmacSign(secret, payloadB64));
  return {
    token: `${payloadB64}.${sig}`,
    issuedAt: now,
    expiresAt: payload.exp,
    powBits,
    fallbackPowBits,
    minDwellMs: MIN_DWELL_NORMAL_MS,
    fallbackMinDwellMs: MIN_DWELL_FALLBACK_MS,
  };
}

async function verifyGateToken(env, token, expectedSite, expectedSlug) {
  if (typeof token !== "string" || token.length < 20 || token.length > 1024) {
    return { ok: false, reason: "invalid_gate" };
  }
  const secret = env.COMMENT_GATE_SECRET;
  if (!secret) {
    return { ok: false, reason: "server_unconfigured" };
  }
  const dotIdx = token.indexOf(".");
  if (dotIdx <= 0 || dotIdx !== token.lastIndexOf(".")) {
    return { ok: false, reason: "invalid_gate" };
  }
  const payloadB64 = token.slice(0, dotIdx);
  const sigB64 = token.slice(dotIdx + 1);
  const expectedSig = bytesToBase64Url(await hmacSign(secret, payloadB64));
  const sigMatch = await timingSafeEqualStrings(sigB64, expectedSig);
  if (!sigMatch) {
    return { ok: false, reason: "invalid_gate" };
  }
  let payload;
  try {
    payload = JSON.parse(decoder.decode(base64UrlToBytes(payloadB64)));
  } catch {
    return { ok: false, reason: "invalid_gate" };
  }
  const now = Date.now();
  if (
    payload.v !== 1 ||
    payload.site !== expectedSite ||
    payload.slug !== expectedSlug ||
    typeof payload.n !== "string" ||
    payload.n.length < 16 ||
    typeof payload.iat !== "number" ||
    typeof payload.exp !== "number"
  ) {
    return { ok: false, reason: "invalid_gate" };
  }
  if (now > payload.exp) {
    return { ok: false, reason: "gate_expired" };
  }
  return { ok: true, payload, now };
}

async function verifyAuthorHeader(request, env) {
  const token = (request.headers.get("X-Author-Key") || "").trim();
  const configured = (env.COMMENT_ADMIN_TOKEN || "").trim();
  if (!token || !configured) return false;
  return timingSafeEqualStrings(token, configured);
}

async function verifyTurnstileToken(env, token, clientIp) {
  const secret = (env.TURNSTILE_SECRET || "").trim();
  const expectedHostnames = parseAllowedHostnames(env);
  if (
    !secret ||
    expectedHostnames.size === 0 ||
    typeof token !== "string" ||
    token.length === 0 ||
    token.length > 2048
  ) {
    return { ok: false, reason: "turnstile_invalid" };
  }

  let result;
  try {
    const res = await fetch(TURNSTILE_VERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      signal: AbortSignal.timeout(10_000),
      body: new URLSearchParams({
        secret,
        response: token,
        remoteip: clientIp,
      }),
    });
    if (!res.ok) {
      return { ok: false, reason: "turnstile_upstream" };
    }
    result = await res.json();
  } catch {
    return { ok: false, reason: "turnstile_upstream" };
  }

  if (
    result?.success !== true ||
    result?.action !== TURNSTILE_ACTION ||
    typeof result?.hostname !== "string" ||
    !expectedHostnames.has(result.hostname.toLowerCase())
  ) {
    return { ok: false, reason: "turnstile_failed" };
  }

  return { ok: true };
}

function serializeComment(row, images = []) {
  return {
    id: row.id,
    slug: row.slug,
    parentId: row.parent_id || null,
    authorName: row.author_name || "",
    authorUrl: row.author_url || null,
    isAuthor: Boolean(row.is_author),
    lang: row.lang || "zh",
    body: row.body,
    images,
    createdAt: Number(row.created_at),
  };
}

async function checkEdgeRateLimit(env, key) {
  if (!env.COMMENT_RATE_LIMIT || typeof env.COMMENT_RATE_LIMIT.limit !== "function") {
    return true;
  }
  try {
    const { success } = await env.COMMENT_RATE_LIMIT.limit({ key });
    return Boolean(success);
  } catch {
    return true;
  }
}

async function checkImageSchemaReady(env) {
  if (!env.COMMENTS_DB || !env.COMMENTS_IMAGES) return false;
  try {
    const [objRes, delColsRes, cmtColsRes] = await Promise.all([
      env.COMMENTS_DB.prepare(
        `SELECT type, name
           FROM sqlite_master
          WHERE (type = 'table' AND name IN ('comment_images', 'comment_image_deletions'))
             OR (type = 'trigger' AND name = 'trg_comments_visible_parent')`
      ).all(),
      env.COMMENTS_DB.prepare("PRAGMA table_info(comment_image_deletions)").all(),
      env.COMMENTS_DB.prepare("PRAGMA table_info(comments)").all(),
    ]);
    const found = new Set((objRes?.results || []).map((r) => `${r.type}:${r.name}`));
    const delCols = new Set((delColsRes?.results || []).map((r) => String(r.name || "")));
    const cmtCols = new Set((cmtColsRes?.results || []).map((r) => String(r.name || "")));
    return (
      found.has("table:comment_images") &&
      found.has("table:comment_image_deletions") &&
      found.has("trigger:trg_comments_visible_parent") &&
      delCols.has("reason") &&
      cmtCols.has("client_request_id")
    );
  } catch {
    return false;
  }
}

async function drainImageDeletionOutbox(env, site, origin) {
  if (!env.COMMENTS_DB || !env.COMMENTS_IMAGES) return;
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const MAX_DRAIN_ROUNDS = 5;
  const INFLIGHT_GRACE_MS = 120_000;

  for (let round = 0; round < MAX_DRAIN_ROUNDS; round += 1) {
    let pending = [];
    const inflightCutoff = Date.now() - INFLIGHT_GRACE_MS;
    try {
      const res = await env.COMMENTS_DB.prepare(
        `SELECT r2_key, image_id, reason, attempts, created_at
           FROM comment_image_deletions
          WHERE site = ?
            AND (reason != 'inflight' OR created_at < ?)
          ORDER BY created_at ASC
          LIMIT 50`
      )
        .bind(site, inflightCutoff)
        .all();
      pending = res?.results || [];
    } catch (err) {
      if (isMissingImageTableError(err)) return;
      return;
    }
    if (pending.length === 0) return;

    let progressed = false;
    for (const item of pending) {
      const itemAttempts = Number(item.attempts || 0);
      const itemCreatedAt = Number(item.created_at || 0);
      let expectedReason = String(item.reason || "deleted");
      try {
        // Atomic lease handoff for stale 'inflight' rows:
        // Claim ownership by transitioning 'inflight' -> 'reaping' ONLY if no visible comment_images row exists.
        // Because comment commit requires reason = 'inflight', once this UPDATE wins, late commits CANNOT publish this key!
        if (item.reason === "inflight") {
          const claimRes = await env.COMMENTS_DB.prepare(
            `UPDATE comment_image_deletions
                SET reason = 'reaping'
              WHERE r2_key = ?
                AND site = ?
                AND reason = 'inflight'
                AND attempts = ?
                AND created_at = ?
                AND created_at < ?
                AND NOT EXISTS (
                  SELECT 1 FROM comment_images ci
                   WHERE ci.site = ? AND ci.r2_key = ? AND ci.status = 'visible'
                )`
          )
            .bind(item.r2_key, site, itemAttempts, itemCreatedAt, inflightCutoff, site, item.r2_key)
            .run();
          if (!claimRes?.meta?.changes) {
            // Either already committed (visible row exists) or claimed/removed concurrently.
            const liveRow = await env.COMMENTS_DB.prepare(
              "SELECT id FROM comment_images WHERE site = ? AND r2_key = ? AND status = 'visible' LIMIT 1"
            )
              .bind(site, item.r2_key)
              .first();
            if (liveRow) {
              await env.COMMENTS_DB.prepare(
                "DELETE FROM comment_image_deletions WHERE r2_key = ? AND reason = 'inflight' AND attempts = ? AND created_at = ?"
              )
                .bind(item.r2_key, itemAttempts, itemCreatedAt)
                .run()
                .catch(() => {});
              progressed = true;
            }
            continue;
          }
          expectedReason = "reaping";
        }
        await env.COMMENTS_IMAGES.delete(item.r2_key);
        if (cache && origin && item.image_id) {
          await cache
            .delete(new Request(`${origin}/api/comments/images/${encodeURIComponent(item.image_id)}`))
            .catch(() => {});
        }
        // Version-guarded CAS delete: remove ONLY the exact (reason, attempts, created_at) entry this sweep processed,
        // so an overlapping uploader's newly written 'rollback' entry can NEVER be erased by a stale sweep!
        await env.COMMENTS_DB.prepare(
          `DELETE FROM comment_image_deletions
            WHERE r2_key = ?
              AND reason = ?
              AND attempts = ?
              AND created_at = ?`
        )
          .bind(item.r2_key, expectedReason, itemAttempts, itemCreatedAt)
          .run()
          .catch(() => {});
        progressed = true;
      } catch {
        await env.COMMENTS_DB.prepare(
          "UPDATE comment_image_deletions SET attempts = attempts + 1 WHERE r2_key = ? AND reason = ? AND attempts = ?"
        )
          .bind(item.r2_key, expectedReason, itemAttempts)
          .run()
          .catch(() => {});
      }
    }
    if (pending.length < 50 || !progressed) break;
  }
}

async function handleGetComments(request, env, ctx) {
  const url = new URL(request.url);
  const slug = (url.searchParams.get("slug") || "").trim().toLowerCase();
  if (!slug || slug.length > 120 || !SLUG_RE.test(slug)) {
    return jsonResponse({ ok: false, error: "invalid_slug" }, 400);
  }
  if (!env.COMMENTS_DB) {
    return jsonResponse({ ok: false, error: "storage_unconfigured" }, 503);
  }

  const site = String(env.SITE_ID || "prod");
  const isAuthor = await verifyAuthorHeader(request, env);

  const imagesQuery = env.COMMENTS_DB.prepare(
    `SELECT id, comment_id, mime_type, width, height, size_bytes, alt, sort_order
       FROM comment_images
      WHERE site = ?
        AND status = 'visible'
        AND comment_id IN (
          SELECT id
            FROM comments
           WHERE site = ? AND slug = ? AND status = 'visible'
           ORDER BY created_at ASC, id ASC
           LIMIT ?
        )
      ORDER BY comment_id ASC, sort_order ASC, created_at ASC`
  )
    .bind(site, site, slug, MAX_COMMENTS_RETURNED)
    .all()
    .then((res) => ({ ready: true, results: res?.results || [] }))
    .catch((err) => {
      if (isMissingImageTableError(err)) {
        return { ready: false, results: [] };
      }
      throw err;
    });

  const [{ results }, imageFetch, schemaReady, gate] = await Promise.all([
    env.COMMENTS_DB.prepare(
      `SELECT id, slug, parent_id, author_name, author_url, is_author, lang, body, created_at
         FROM comments
        WHERE site = ? AND slug = ? AND status = 'visible'
        ORDER BY created_at ASC, id ASC
        LIMIT ?`
    )
      .bind(site, slug, MAX_COMMENTS_RETURNED)
      .all(),
    imagesQuery,
    checkImageSchemaReady(env),
    issueGateToken(env, site, slug),
  ]);

  const imagesByComment = new Map();
  for (const imgRow of imageFetch.results) {
    const arr = imagesByComment.get(imgRow.comment_id) || [];
    arr.push(serializeImage(imgRow));
    imagesByComment.set(imgRow.comment_id, arr);
  }

  const imagesEnabled = Boolean(env.COMMENTS_IMAGES && imageFetch.ready && schemaReady);
  if (imagesEnabled && ctx?.waitUntil) {
    const origin = url.origin;
    ctx.waitUntil(drainImageDeletionOutbox(env, site, origin).catch(() => {}));
  }

  return jsonResponse({
    ok: true,
    site,
    slug,
    comments: (results || []).map((row) => serializeComment(row, imagesByComment.get(row.id) || [])),
    gate,
    config: {
      turnstileSitekey: String(env.TURNSTILE_SITEKEY || ""),
      turnstileAction: TURNSTILE_ACTION,
      allowPowFallback: true,
      maxNameLength: MAX_NAME_LEN,
      maxBodyLength: MAX_BODY_LEN,
      minBodyLength: MIN_BODY_LEN,
      imagesEnabled,
      maxImages: MAX_IMAGES_PER_COMMENT,
      maxImageBytes: MAX_IMAGE_BYTES,
      acceptedImageTypes: ACCEPTED_IMAGE_TYPES,
      authorMode: isAuthor,
    },
  });
}

async function handleGetCommentImage(request, env, imageId, ctx) {
  if (!IMAGE_ID_RE.test(imageId)) {
    return jsonResponse({ ok: false, error: "invalid_image_id" }, 400);
  }
  if (!env.COMMENTS_DB || !env.COMMENTS_IMAGES) {
    return jsonResponse({ ok: false, error: "images_unconfigured" }, 503);
  }

  const isHead = request.method === "HEAD";
  const site = String(env.SITE_ID || "prod");

  let row;
  try {
    row = await env.COMMENTS_DB.prepare(
      `SELECT ci.id, ci.r2_key, ci.mime_type, ci.size_bytes, ci.sha256
         FROM comment_images ci
         JOIN comments c ON c.id = ci.comment_id AND c.site = ci.site
         LEFT JOIN comments p ON p.id = c.parent_id AND p.site = c.site
        WHERE ci.id = ?
          AND ci.site = ?
          AND ci.status = 'visible'
          AND c.status = 'visible'
          AND (c.parent_id IS NULL OR p.status = 'visible')
        LIMIT 1`
    )
      .bind(imageId, site)
      .first();
  } catch (err) {
    if (isMissingImageTableError(err)) {
      return new Response("Not Found", {
        status: 404,
        headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
      });
    }
    throw err;
  }

  if (!row || !SAFE_IMAGE_MIMES.has(row.mime_type)) {
    return new Response("Not Found", {
      status: 404,
      headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
    });
  }

  const etag = `"${row.sha256}"`;
  const clientHeaders = {
    "Content-Type": row.mime_type,
    "Cache-Control": "private, no-cache",
    "ETag": etag,
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Content-Disposition": "inline",
    "Referrer-Policy": "no-referrer",
  };

  const cache = typeof caches !== "undefined" ? caches.default : null;
  const cacheUrl = new URL(request.url);
  cacheUrl.search = "";
  const cacheReq = new Request(cacheUrl.toString(), { method: "GET" });
  const cached = cache ? await cache.match(cacheReq) : null;
  const hasValidCached = Boolean(cached && cached.headers.get("ETag") === etag);
  const discardCachedBody = () => {
    try {
      cached?.body?.cancel?.().catch(() => {});
    } catch {
      /* ignore */
    }
  };
  if (cached && !hasValidCached) {
    discardCachedBody();
  }

  if (matchesIfNoneMatch(request.headers.get("If-None-Match"), etag)) {
    discardCachedBody();
    if (!hasValidCached) {
      const headObj = await env.COMMENTS_IMAGES.head(row.r2_key);
      if (!headObj) {
        return new Response("Not Found", {
          status: 404,
          headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
        });
      }
    }
    return new Response(null, { status: 304, headers: clientHeaders });
  }

  if (isHead) {
    discardCachedBody();
    let size = hasValidCached ? cached.headers.get("Content-Length") : null;
    if (!size) {
      const headObj = await env.COMMENTS_IMAGES.head(row.r2_key);
      if (!headObj) {
        return new Response("Not Found", {
          status: 404,
          headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
        });
      }
      size = String(headObj.size ?? row.size_bytes);
    }
    return new Response(null, {
      status: 200,
      headers: {
        ...clientHeaders,
        "Content-Length": size,
      },
    });
  }

  if (hasValidCached) {
    const outHeaders = new Headers(clientHeaders);
    const cachedLen = cached.headers.get("Content-Length");
    if (cachedLen) outHeaders.set("Content-Length", cachedLen);
    return new Response(cached.body, { status: 200, headers: outHeaders });
  }

  const obj = await env.COMMENTS_IMAGES.get(row.r2_key);
  if (!obj) {
    return new Response("Not Found", {
      status: 404,
      headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
    });
  }

  const contentLength = String(obj.size ?? row.size_bytes);
  const response = new Response(obj.body, {
    status: 200,
    headers: {
      ...clientHeaders,
      "Content-Length": contentLength,
    },
  });

  if (cache && ctx?.waitUntil) {
    const cacheableHeaders = new Headers(clientHeaders);
    cacheableHeaders.set("Cache-Control", "public, max-age=3600");
    cacheableHeaders.set("Content-Length", contentLength);
    const cacheClone = new Response(response.clone().body, {
      status: 200,
      headers: cacheableHeaders,
    });
    ctx.waitUntil(cache.put(cacheReq, cacheClone).catch(() => {}));
  }
  return response;
}

async function handleAuthorVerify(request, env) {
  if (!isOriginAllowed(request, env)) {
    return jsonResponse({ ok: false, error: "forbidden_origin" }, 403);
  }
  const clientIp = getClientIp(request);
  const rateKey = `author:${await sha256Hex(clientIp)}`;
  const allowed = await checkEdgeRateLimit(env, rateKey);
  if (!allowed) {
    return jsonResponse({ ok: false, error: "rate_limited", retryAfterSec: 60 }, 429);
  }
  const isAuthor = await verifyAuthorHeader(request, env);
  if (!isAuthor) {
    return jsonResponse({ ok: false, error: "invalid_author_key" }, 401);
  }
  return jsonResponse({ ok: true, author: true });
}

async function handleCreateComment(request, env, ctx) {
  if (!isOriginAllowed(request, env)) {
    return jsonResponse({ ok: false, error: "forbidden_origin" }, 403);
  }
  if (!env.COMMENTS_DB || !env.COMMENT_GATE_SECRET) {
    return jsonResponse({ ok: false, error: "storage_unconfigured" }, 503);
  }

  const site = String(env.SITE_ID || "prod");
  const isAuthor = await verifyAuthorHeader(request, env);
  const clientIp = getClientIp(request);
  const ipHashes = await computeDailyIpHashes(clientIp, env.COMMENT_GATE_SECRET);
  const ipHash = ipHashes.current;

  // 1. Pre-body edge rate-limit admission check (prevents buffering/hashing abusive floods)
  if (!isAuthor) {
    const edgeAllowed = await checkEdgeRateLimit(env, `post:${site}:${ipHash}`);
    if (!edgeAllowed) {
      return jsonResponse({ ok: false, error: "rate_limited", retryAfterSec: 45 }, 429);
    }
  }

  const parsedPayload = await readCreateCommentPayload(request);
  if (parsedPayload.error) {
    return jsonResponse({ ok: false, error: parsedPayload.error }, parsedPayload.status || 400);
  }
  const input = parsedPayload.data;
  const uploadedFiles = parsedPayload.files || [];

  if (uploadedFiles.length > MAX_IMAGES_PER_COMMENT) {
    return jsonResponse({ ok: false, error: "too_many_images" }, 400);
  }
  if (uploadedFiles.length > 0) {
    const schemaReady = await checkImageSchemaReady(env);
    if (!schemaReady) {
      return jsonResponse({ ok: false, error: "images_unconfigured" }, 503);
    }
  }
  for (const file of uploadedFiles) {
    if (!file || typeof file.arrayBuffer !== "function" || Number(file.size) <= 0) {
      return jsonResponse({ ok: false, error: "invalid_image" }, 400);
    }
    if (Number(file.size) > MAX_IMAGE_BYTES) {
      return jsonResponse({ ok: false, error: "image_too_large" }, 413);
    }
  }

  const slug = sanitizeText(input.slug, { multiline: false }).toLowerCase();
  if (!slug || slug.length > 120 || !SLUG_RE.test(slug)) {
    return jsonResponse({ ok: false, error: "invalid_slug" }, 400);
  }

  const rawClientReqId = typeof input.clientRequestId === "string" ? input.clientRequestId.trim() : "";
  const clientRequestId = rawClientReqId && COMMENT_ID_RE.test(rawClientReqId) ? rawClientReqId : null;

  const lang = input.lang === "en" ? "en" : "zh";
  const authorName = sanitizeText(input.authorName, { multiline: false });
  if (authorName.length > MAX_NAME_LEN) {
    return jsonResponse({ ok: false, error: "name_too_long" }, 400);
  }

  const urlResult = sanitizeAuthorUrl(input.authorUrl);
  if (urlResult && typeof urlResult === "object" && urlResult.error) {
    return jsonResponse({ ok: false, error: urlResult.error }, 400);
  }
  const authorUrl = typeof urlResult === "string" ? urlResult : null;

  const body = sanitizeText(input.body, { multiline: true });
  if (uploadedFiles.length === 0 && body.length < MIN_BODY_LEN) {
    return jsonResponse({ ok: false, error: "body_too_short" }, 400);
  }
  if (body.length > MAX_BODY_LEN) {
    return jsonResponse({ ok: false, error: "body_too_long" }, 400);
  }

  // Silent honeypot shadow-drop: bots filling the hidden trap field receive a convincing 201 without touching D1 or R2.
  const honeypot = sanitizeText(input.websiteHp, { multiline: false });
  if (!isAuthor && honeypot.length > 0) {
    return jsonResponse(
      {
        ok: true,
        comment: {
          id: `c_${randomHex(8)}`,
          slug,
          parentId: null,
          authorName,
          authorUrl,
          isAuthor: false,
          lang,
          body,
          images: [],
          createdAt: Date.now(),
        },
        nextGate: await issueGateToken(env, site, slug).catch(() => null),
      },
      201
    );
  }

  let verificationMode = "author";
  let pendingGateConsume = null;
  let shortWindowMs = 60 * 1000;
  let shortMax = 3;
  let hourMax = 12;
  let hourImageLimit = HOUR_IMAGE_LIMIT_NORMAL;
  let verifyNow = Date.now();

  if (!isAuthor) {
    // 2. Verify signed gate token BEFORE copying/hashing image binaries
    const gateCheck = await verifyGateToken(env, input.gateToken, site, slug);
    if (!gateCheck.ok) {
      return jsonResponse(
        {
          ok: false,
          error: gateCheck.reason,
          nextGate: await issueGateToken(env, site, slug).catch(() => null),
        },
        403
      );
    }
    const { payload: gatePayload, now } = gateCheck;
    verifyNow = now;

    const turnstileToken = typeof input.turnstileToken === "string" ? input.turnstileToken.trim() : "";
    const hasTurnstileConfigured = Boolean((env.TURNSTILE_SECRET || "").trim());
    const fallbackRequested = input.fallbackMode === true && !turnstileToken;
    // Compute effective fallback mode ONCE so dwell, quotas, PoW bits, links, and mode stay strictly consistent.
    const effectiveFallback = fallbackRequested || !hasTurnstileConfigured;

    // 3. Enforce human dwell pacing
    const minDwell = effectiveFallback ? MIN_DWELL_FALLBACK_MS : MIN_DWELL_NORMAL_MS;
    if (now - gatePayload.iat < minDwell) {
      const waitSec = Math.max(1, Math.ceil((minDwell - (now - gatePayload.iat)) / 1000));
      return jsonResponse({ ok: false, error: "too_fast", retryAfterSec: waitSec }, 429);
    }

    // 4. Proof-of-Work verification
    const requiredBits = effectiveFallback
      ? Number(gatePayload.fd || FALLBACK_POW_BITS)
      : Number(gatePayload.d || BASE_POW_BITS);

    const powNonce = typeof input.powNonce === "string" ? input.powNonce.trim() : "";
    if (!powNonce || powNonce.length > 64) {
      return jsonResponse(
        {
          ok: false,
          error: "pow_required",
          nextGate: await issueGateToken(env, site, slug).catch(() => null),
        },
        403
      );
    }
    const powDigest = await sha256Bytes(`${input.gateToken}:${powNonce}`);
    if (!hasLeadingZeroBits(powDigest, requiredBits)) {
      return jsonResponse(
        {
          ok: false,
          error: "pow_invalid",
          nextGate: await issueGateToken(env, site, slug).catch(() => null),
        },
        403
      );
    }

    // 5. Primary Turnstile verification (when not in effective fallback)
    if (!effectiveFallback) {
      const tsCheck = await verifyTurnstileToken(env, turnstileToken, clientIp);
      if (!tsCheck.ok) {
        return jsonResponse(
          {
            ok: false,
            error: tsCheck.reason,
            nextGate: await issueGateToken(env, site, slug).catch(() => null),
          },
          403
        );
      }
      verificationMode = "turnstile+pow";
    } else {
      verificationMode = "pow-fallback";
    }

    // 6. Link-spam heuristic
    const urlMatches = body.match(URL_COUNT_RE) || [];
    const maxUrls = effectiveFallback ? 1 : 2;
    if (urlMatches.length > maxUrls) {
      return jsonResponse({ ok: false, error: "too_many_links" }, 400);
    }

    shortWindowMs = effectiveFallback ? 45 * 1000 : 60 * 1000;
    shortMax = effectiveFallback ? 1 : 3;
    hourMax = effectiveFallback ? 5 : 12;
    hourImageLimit = effectiveFallback ? HOUR_IMAGE_LIMIT_FALLBACK : HOUR_IMAGE_LIMIT_NORMAL;
    pendingGateConsume = { nonce: gatePayload.n, exp: gatePayload.exp, now };
  }

  // 7. Idempotent retry recovery (lifetime aligned with permanent UNIQUE(site, slug, client_request_id) index)
  if (clientRequestId) {
    try {
      const existingRow = await env.COMMENTS_DB.prepare(
        `SELECT id, slug, parent_id, author_name, author_url, is_author, lang, body, ip_hash, status, created_at
           FROM comments
          WHERE site = ?
            AND slug = ?
            AND client_request_id = ?
          LIMIT 1`
      )
        .bind(site, slug, clientRequestId)
        .first();
      if (existingRow) {
        const sameOwner =
          isAuthor || existingRow.ip_hash === ipHashes.current || existingRow.ip_hash === ipHashes.previous;
        if (existingRow.status === "visible" && sameOwner) {
          let existingImages = [];
          try {
            const imgRes = await env.COMMENTS_DB.prepare(
              `SELECT id, mime_type, width, height, size_bytes, alt
                 FROM comment_images
                WHERE site = ? AND comment_id = ? AND status = 'visible'
                ORDER BY sort_order ASC, created_at ASC`
            )
              .bind(site, existingRow.id)
              .all();
            existingImages = (imgRes?.results || []).map(serializeImage);
          } catch (err) {
            if (!isMissingImageTableError(err)) throw err;
          }
          if (pendingGateConsume) {
            await env.COMMENTS_DB.prepare("INSERT OR IGNORE INTO comment_nonces (nonce, expires_at) VALUES (?, ?)")
              .bind(pendingGateConsume.nonce, pendingGateConsume.exp)
              .run()
              .catch(() => {});
          }
          return jsonResponse(
            {
              ok: true,
              idempotent: true,
              comment: serializeComment(existingRow, existingImages),
              verificationMode,
              nextGate: await issueGateToken(env, site, slug).catch(() => null),
            },
            200
          );
        }
        return jsonResponse(
          {
            ok: false,
            error: "duplicate_comment",
            nextGate: await issueGateToken(env, site, slug).catch(() => null),
          },
          409
        );
      }
    } catch (err) {
      if (
        !/(?:no such column:\s*client_request_id|table comments has no column named client_request_id)/i.test(
          String(err?.message || err || "")
        )
      ) {
        throw err;
      }
    }
  }

  // 7b. Fast pre-check sliding-window IP-hash & image quotas BEFORE scrubbing/uploading R2 objects
  //     (also re-enforced atomically inside the D1 commit transaction below to prevent concurrent races!)
  if (!isAuthor) {
    const rateRow = await env.COMMENTS_DB.prepare(
      `SELECT
         SUM(CASE WHEN created_at > ? THEN 1 ELSE 0 END) AS short_cnt,
         COUNT(*) AS hour_cnt,
         MAX(created_at) AS last_at
       FROM comments
       WHERE site = ? AND ip_hash IN (?, ?) AND created_at > ?`
    )
      .bind(verifyNow - shortWindowMs, site, ipHashes.current, ipHashes.previous, verifyNow - 60 * 60 * 1000)
      .first();

    const shortCnt = Number(rateRow?.short_cnt || 0);
    const hourCnt = Number(rateRow?.hour_cnt || 0);
    if (shortCnt >= shortMax) {
      const lastAt = Number(rateRow?.last_at || verifyNow);
      const retryAfterSec = Math.max(5, Math.ceil((shortWindowMs - (verifyNow - lastAt)) / 1000));
      return jsonResponse({ ok: false, error: "rate_limited", retryAfterSec }, 429);
    }
    if (hourCnt >= hourMax) {
      return jsonResponse({ ok: false, error: "rate_limited", retryAfterSec: 300 }, 429);
    }

    if (uploadedFiles.length > 0) {
      try {
        const imgRateRow = await env.COMMENTS_DB.prepare(
          `SELECT COUNT(*) AS img_cnt
             FROM comment_images ci
             JOIN comments c ON c.id = ci.comment_id AND c.site = ci.site
            WHERE ci.site = ? AND c.ip_hash IN (?, ?) AND ci.created_at > ?`
        )
          .bind(site, ipHashes.current, ipHashes.previous, verifyNow - 60 * 60 * 1000)
          .first();
        if (Number(imgRateRow?.img_cnt || 0) + uploadedFiles.length > hourImageLimit) {
          return jsonResponse({ ok: false, error: "rate_limited", retryAfterSec: 300 }, 429);
        }
      } catch (err) {
        if (isMissingImageTableError(err)) {
          return jsonResponse({ ok: false, error: "images_unconfigured" }, 503);
        }
        throw err;
      }
    }
  }

  // 8. Validate complete image containers, enforce decode budgets & scrub metadata AFTER human verification
  const rawAlts = Array.isArray(input.imageAlts) ? input.imageAlts : [];
  const preparedImages = [];
  for (let idx = 0; idx < uploadedFiles.length; idx += 1) {
    const file = uploadedFiles[idx];
    let rawBytes;
    try {
      rawBytes = new Uint8Array(await file.arrayBuffer());
    } catch {
      return jsonResponse(
        { ok: false, error: "invalid_image", nextGate: await issueGateToken(env, site, slug).catch(() => null) },
        400
      );
    }
    if (rawBytes.byteLength === 0) {
      return jsonResponse(
        { ok: false, error: "invalid_image", nextGate: await issueGateToken(env, site, slug).catch(() => null) },
        400
      );
    }
    if (rawBytes.byteLength > MAX_IMAGE_BYTES) {
      return jsonResponse(
        { ok: false, error: "image_too_large", nextGate: await issueGateToken(env, site, slug).catch(() => null) },
        413
      );
    }
    const inspected = inspectAndSanitizeImage(rawBytes);
    if (!inspected.ok) {
      return jsonResponse(
        { ok: false, error: inspected.error, nextGate: await issueGateToken(env, site, slug).catch(() => null) },
        400
      );
    }
    const cleanBytes = inspected.bytes;
    const sha256 = await sha256Hex(cleanBytes);
    const alt = sanitizeText(rawAlts[idx] ?? "", { multiline: false }).slice(0, MAX_ALT_LEN);
    preparedImages.push({
      id: `img_${randomHex(12)}`,
      bytes: cleanBytes,
      mimeType: inspected.mimeType,
      ext: inspected.ext,
      width: inspected.width,
      height: inspected.height,
      sizeBytes: cleanBytes.byteLength,
      sha256,
      alt,
      sortOrder: idx,
    });
  }

  // 9. Duplicate content guard within 10 minutes (includes sorted sanitized image SHA-256 hashes; also enforced atomically at commit)
  const normalizedForHash = body.toLowerCase().replace(/\s+/g, " ");
  const imageHashPart = preparedImages.length > 0
    ? `:img:${preparedImages.map((img) => img.sha256).sort().join(",")}`
    : "";
  const bodyHash = await sha256Hex(`${site}:${slug}:${normalizedForHash}${imageHashPart}`);
  const dupRow = await env.COMMENTS_DB.prepare(
    "SELECT id FROM comments WHERE site = ? AND slug = ? AND body_hash = ? AND status = 'visible' AND created_at > ? LIMIT 1"
  )
    .bind(site, slug, bodyHash, Date.now() - 10 * 60 * 1000)
    .first();
  if (dupRow) {
    return jsonResponse(
      {
        ok: false,
        error: "duplicate_comment",
        nextGate: await issueGateToken(env, site, slug).catch(() => null),
      },
      409
    );
  }

  // 10. Resolve optional parentId (strictly 1-level threading; re-enforced atomically by D1 trigger on commit)
  let resolvedParentId = null;
  if (typeof input.parentId === "string" && input.parentId.trim()) {
    const candidateParent = input.parentId.trim();
    if (!COMMENT_ID_RE.test(candidateParent)) {
      return jsonResponse({ ok: false, error: "invalid_parent" }, 400);
    }
    const parentRow = await env.COMMENTS_DB.prepare(
      "SELECT id, parent_id FROM comments WHERE id = ? AND site = ? AND slug = ? AND status = 'visible' LIMIT 1"
    )
      .bind(candidateParent, site, slug)
      .first();
    if (!parentRow) {
      return jsonResponse({ ok: false, error: "parent_not_found" }, 404);
    }
    resolvedParentId = parentRow.parent_id || parentRow.id;
  }

  // 11. Consume single-use gate nonce atomically right before R2/D1 writes
  if (pendingGateConsume) {
    const consumeRes = await env.COMMENTS_DB.prepare(
      "INSERT OR IGNORE INTO comment_nonces (nonce, expires_at) VALUES (?, ?)"
    )
      .bind(pendingGateConsume.nonce, pendingGateConsume.exp)
      .run();
    if (!consumeRes?.meta?.changes) {
      return jsonResponse(
        {
          ok: false,
          error: "gate_replayed",
          nextGate: await issueGateToken(env, site, slug).catch(() => null),
        },
        409
      );
    }

    ctx.waitUntil(
      env.COMMENTS_DB.prepare("DELETE FROM comment_nonces WHERE expires_at < ?")
        .bind(pendingGateConsume.now)
        .run()
        .catch(() => {})
    );
  }

  const id = `c_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const createdAt = Date.now();
  const storedName = isAuthor && !authorName ? String(env.SITE_AUTHOR || "Author") : authorName;
  const origin = new URL(request.url).origin;

  const cleanupConfirmedAbsentUploads = async (records) => {
    if (!records.length || !env.COMMENTS_IMAGES) return;
    for (const img of records) {
      try {
        await env.COMMENTS_IMAGES.delete(img.r2Key);
        await env.COMMENTS_DB.prepare("DELETE FROM comment_image_deletions WHERE r2_key = ?")
          .bind(img.r2Key)
          .run()
          .catch(() => {});
      } catch {
        // Promote inflight row to immediate 'rollback' retry in durable outbox
        await env.COMMENTS_DB.prepare(
          `INSERT INTO comment_image_deletions (r2_key, image_id, site, reason, attempts, created_at)
           VALUES (?, ?, ?, 'rollback', 1, ?)
           ON CONFLICT(r2_key) DO UPDATE SET reason = 'rollback', attempts = attempts + 1`
        )
          .bind(img.r2Key, img.id, site, Date.now())
          .run()
          .catch(() => {});
      }
    }
  };

  // 12. Record durable 'inflight' intent BEFORE R2 put, then atomically enforce quota/dedupe & commit in D1
  const uploadedRecords = [];
  let commitSucceeded = false;
  try {
    for (const img of preparedImages) {
      const r2Key = `${site}/${slug}/${id}/${img.id}.${img.ext}`;
      // Persist durable inflight intent BEFORE writing bytes so a Worker crash before D1 commit can never leak R2 blobs
      await env.COMMENTS_DB.prepare(
        "INSERT OR IGNORE INTO comment_image_deletions (r2_key, image_id, site, reason, attempts, created_at) VALUES (?, ?, ?, 'inflight', 0, ?)"
      )
        .bind(r2Key, img.id, site, createdAt)
        .run();
      await env.COMMENTS_IMAGES.put(r2Key, img.bytes, {
        httpMetadata: {
          contentType: img.mimeType,
          cacheControl: "private, no-cache",
        },
        customMetadata: {
          site,
          slug,
          commentId: id,
          sha256: img.sha256,
        },
      });
      uploadedRecords.push({ ...img, r2Key });
    }

    const dupCutoff = createdAt - 10 * 60 * 1000;
    const shortCutoff = createdAt - shortWindowMs;
    const hourCutoff = createdAt - 60 * 60 * 1000;
    const isAuthorFlag = isAuthor ? 1 : 0;
    const imgCount = uploadedRecords.length;

    const buildAtomicInsertComment = (includeClientReqId) => {
      const cols = includeClientReqId
        ? "(id, site, slug, parent_id, author_name, author_url, is_author, lang, body, body_hash, ip_hash, verification_mode, status, created_at, client_request_id)"
        : "(id, site, slug, parent_id, author_name, author_url, is_author, lang, body, body_hash, ip_hash, verification_mode, status, created_at)";
      const selVals = includeClientReqId
        ? "?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'visible', ?, ?"
        : "?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'visible', ?";
      const imgQuotaClause =
        imgCount > 0
          ? ` AND (
                SELECT COUNT(*) FROM comment_images ci
                JOIN comments c ON c.id = ci.comment_id AND c.site = ci.site
                WHERE ci.site = ? AND c.ip_hash IN (?, ?) AND ci.created_at > ?
              ) + ? <= ?`
          : "";
      // Atomic lease check: publication is allowed ONLY while the uploader still owns EVERY 'inflight' intent row
      // (prevents a late commit from publishing after drainImageDeletionOutbox claims 'reaping' and deletes R2 bytes!).
      const inflightPlaceholders = uploadedRecords.map(() => "?").join(", ");
      const leaseClause =
        imgCount > 0
          ? ` AND (
                SELECT COUNT(*) FROM comment_image_deletions
                 WHERE site = ? AND reason = 'inflight' AND r2_key IN (${inflightPlaceholders})
              ) = ?`
          : "";
      const sql = `INSERT INTO comments ${cols}
        SELECT ${selVals}
         WHERE NOT EXISTS (
                 SELECT 1 FROM comments
                  WHERE site = ? AND slug = ? AND body_hash = ? AND status = 'visible' AND created_at > ?
               )
           AND (? = 1 OR (
                 (SELECT COUNT(*) FROM comments WHERE site = ? AND ip_hash IN (?, ?) AND created_at > ?) < ?
                 AND (SELECT COUNT(*) FROM comments WHERE site = ? AND ip_hash IN (?, ?) AND created_at > ?) < ?${imgQuotaClause}
               ))${leaseClause}`;
      const baseArgs = [
        id,
        site,
        slug,
        resolvedParentId,
        storedName,
        authorUrl,
        isAuthorFlag,
        lang,
        body,
        bodyHash,
        ipHash,
        verificationMode,
        createdAt,
      ];
      if (includeClientReqId) baseArgs.push(clientRequestId);
      const guardArgs = [
        site,
        slug,
        bodyHash,
        dupCutoff,
        isAuthorFlag,
        site,
        ipHashes.current,
        ipHashes.previous,
        shortCutoff,
        shortMax,
        site,
        ipHashes.current,
        ipHashes.previous,
        hourCutoff,
        hourMax,
      ];
      if (imgCount > 0) {
        guardArgs.push(site, ipHashes.current, ipHashes.previous, hourCutoff, imgCount, hourImageLimit);
        guardArgs.push(site, ...uploadedRecords.map((r) => r.r2Key), imgCount);
      }
      return env.COMMENTS_DB.prepare(sql).bind(...baseArgs, ...guardArgs);
    };

    const runCommitBatch = async (includeClientReqId) => {
      const statements = [buildAtomicInsertComment(includeClientReqId)];
      for (const img of uploadedRecords) {
        statements.push(
          env.COMMENTS_DB.prepare(
            `INSERT INTO comment_images
              (id, site, slug, comment_id, r2_key, mime_type, width, height, size_bytes, sha256, alt, sort_order, status, created_at)
             SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'visible', ?
              WHERE EXISTS (SELECT 1 FROM comments WHERE id = ? AND site = ?)`
          ).bind(
            img.id,
            site,
            slug,
            id,
            img.r2Key,
            img.mimeType,
            img.width,
            img.height,
            img.sizeBytes,
            img.sha256,
            img.alt,
            img.sortOrder,
            createdAt,
            id,
            site
          )
        );
        statements.push(
          env.COMMENTS_DB.prepare(
            `DELETE FROM comment_image_deletions
              WHERE r2_key = ?
                AND reason = 'inflight'
                AND EXISTS (SELECT 1 FROM comments WHERE id = ? AND site = ?)`
          ).bind(img.r2Key, id, site)
        );
      }
      if (statements.length === 1) {
        const res = await statements[0].run();
        return Number(res?.meta?.changes || 0);
      }
      const batchRes = await env.COMMENTS_DB.batch(statements);
      return Number(batchRes?.[0]?.meta?.changes || 0);
    };

    let insertedChanges = 0;
    try {
      insertedChanges = await runCommitBatch(Boolean(clientRequestId));
    } catch (insertErr) {
      if (
        clientRequestId &&
        uploadedRecords.length === 0 &&
        /(?:no such column:\s*client_request_id|table comments has no column named client_request_id)/i.test(
          String(insertErr?.message || insertErr || "")
        )
      ) {
        insertedChanges = await runCommitBatch(false);
      } else {
        throw insertErr;
      }
    }

    if (insertedChanges === 0) {
      // Check whether the upload lease was reaped concurrently before classifying as duplicate/quota
      let leaseLost = false;
      if (uploadedRecords.length > 0) {
        const leaseCheck = await env.COMMENTS_DB.prepare(
          `SELECT COUNT(*) AS cnt FROM comment_image_deletions
            WHERE site = ? AND reason = 'inflight' AND r2_key IN (${uploadedRecords.map(() => "?").join(", ")})`
        )
          .bind(site, ...uploadedRecords.map((r) => r.r2Key))
          .first()
          .catch(() => null);
        if (Number(leaseCheck?.cnt || 0) < uploadedRecords.length) {
          leaseLost = true;
        }
      }
      // Always clean up our request's freshly-generated R2 keys when insertedChanges === 0,
      // even if leaseLost === true: a slow R2.put may have completed AFTER the sweeper deleted its outbox row!
      // Deleting an already-deleted key in R2 is idempotent, and transient failures re-enqueue a durable 'rollback' row.
      await cleanupConfirmedAbsentUploads(uploadedRecords);
      const replacementGate = await issueGateToken(env, site, slug).catch(() => null);
      if (leaseLost) {
        return jsonResponse({ ok: false, error: "storage_write_failed", nextGate: replacementGate }, 500);
      }
      const raceDup = await env.COMMENTS_DB.prepare(
        "SELECT id FROM comments WHERE site = ? AND slug = ? AND body_hash = ? AND status = 'visible' AND created_at > ? LIMIT 1"
      )
        .bind(site, slug, bodyHash, dupCutoff)
        .first()
        .catch(() => null);
      if (raceDup) {
        return jsonResponse({ ok: false, error: "duplicate_comment", nextGate: replacementGate }, 409);
      }
      return jsonResponse({ ok: false, error: "rate_limited", retryAfterSec: 45, nextGate: replacementGate }, 429);
    }

    commitSucceeded = true;
  } catch (err) {
    // Three-state reconciliation: NEVER destroy R2 bytes unless absence is POSITIVELY confirmed!
    let reconcileState = "unknown";
    try {
      const committedRow = await env.COMMENTS_DB.prepare("SELECT id FROM comments WHERE id = ? AND site = ? LIMIT 1")
        .bind(id, site)
        .first();
      reconcileState = committedRow ? "committed" : "confirmed_absent";
    } catch {
      reconcileState = "unknown";
    }

    if (reconcileState === "committed") {
      commitSucceeded = true;
      for (const img of uploadedRecords) {
        await env.COMMENTS_DB.prepare("DELETE FROM comment_image_deletions WHERE r2_key = ? AND reason = 'inflight'")
          .bind(img.r2Key)
          .run()
          .catch(() => {});
      }
    } else {
      if (reconcileState === "confirmed_absent") {
        await cleanupConfirmedAbsentUploads(uploadedRecords);
      }
      // When reconcileState === "unknown", leave 'inflight' intent rows intact so drainImageDeletionOutbox
      // positively verifies absence after D1 recovers instead of risking live-byte deletion!
      const replacementGate = await issueGateToken(env, site, slug).catch(() => null);
      if (isParentTriggerAbort(err)) {
        return jsonResponse({ ok: false, error: "parent_not_found", nextGate: replacementGate }, 404);
      }
      if (/unique constraint failed.*client_request_id/i.test(String(err?.message || err || ""))) {
        return jsonResponse({ ok: false, error: "duplicate_comment", nextGate: replacementGate }, 409);
      }
      if (isMissingImageTableError(err)) {
        return jsonResponse({ ok: false, error: "images_unconfigured", nextGate: replacementGate }, 503);
      }
      return jsonResponse({ ok: false, error: "storage_write_failed", nextGate: replacementGate }, 500);
    }
  }

  if (!commitSucceeded) {
    return jsonResponse(
      { ok: false, error: "storage_write_failed", nextGate: await issueGateToken(env, site, slug).catch(() => null) },
      500
    );
  }

  // Opportunistically drain any pending R2 cleanup outbox items in background
  if (ctx?.waitUntil) {
    ctx.waitUntil(drainImageDeletionOutbox(env, site, origin).catch(() => {}));
  }

  const serializedImages = uploadedRecords.map((img) => ({
    id: img.id,
    url: `/api/comments/images/${encodeURIComponent(img.id)}`,
    mimeType: img.mimeType,
    width: img.width,
    height: img.height,
    sizeBytes: img.sizeBytes,
    alt: img.alt,
  }));

  const nextGate = await issueGateToken(env, site, slug).catch(() => null);
  return jsonResponse(
    {
      ok: true,
      comment: {
        id,
        slug,
        parentId: resolvedParentId,
        authorName: storedName,
        authorUrl,
        isAuthor,
        lang,
        body,
        images: serializedImages,
        createdAt,
      },
      verificationMode,
      nextGate,
    },
    201
  );
}

async function handleDeleteComment(request, env, commentId, ctx) {
  if (!isOriginAllowed(request, env)) {
    return jsonResponse({ ok: false, error: "forbidden_origin" }, 403);
  }
  if (!env.COMMENTS_DB) {
    return jsonResponse({ ok: false, error: "storage_unconfigured" }, 503);
  }
  const clientIp = getClientIp(request);
  const allowed = await checkEdgeRateLimit(env, `delete:${await sha256Hex(clientIp)}`);
  if (!allowed) {
    return jsonResponse({ ok: false, error: "rate_limited", retryAfterSec: 60 }, 429);
  }

  const isAuthor = await verifyAuthorHeader(request, env);
  if (!isAuthor) {
    return jsonResponse({ ok: false, error: "unauthorized" }, 401);
  }
  if (!COMMENT_ID_RE.test(commentId)) {
    return jsonResponse({ ok: false, error: "invalid_id" }, 400);
  }

  const site = String(env.SITE_ID || "prod");
  const now = Date.now();
  let changed = 0;

  // Atomically enqueue every tombstoned image key into the durable deletion outbox inside the SAME D1 batch.
  try {
    const batchRes = await env.COMMENTS_DB.batch([
      env.COMMENTS_DB.prepare(
        `INSERT INTO comment_image_deletions (r2_key, image_id, site, reason, attempts, created_at)
         SELECT ci.r2_key, ci.id, ci.site, 'deleted', 0, ?
           FROM comment_images ci
           JOIN comments c ON c.id = ci.comment_id AND c.site = ci.site
          WHERE ci.site = ?
            AND (c.id = ? OR c.parent_id = ?)
            AND c.status = 'visible'
            AND ci.status = 'visible'
         ON CONFLICT(r2_key) DO UPDATE SET reason = 'deleted'`
      ).bind(now, site, commentId, commentId),
      env.COMMENTS_DB.prepare(
        `UPDATE comment_images
            SET status = 'deleted'
          WHERE site = ?
            AND comment_id IN (
              SELECT id FROM comments WHERE site = ? AND (id = ? OR parent_id = ?) AND status = 'visible'
            )
            AND status = 'visible'`
      ).bind(site, site, commentId, commentId),
      env.COMMENTS_DB.prepare(
        "UPDATE comments SET status = 'deleted' WHERE site = ? AND (id = ? OR parent_id = ?) AND status = 'visible'"
      ).bind(site, commentId, commentId),
    ]);
    changed = Number(batchRes?.[2]?.meta?.changes || 0);
  } catch (err) {
    if (isMissingImageTableError(err)) {
      const res = await env.COMMENTS_DB.prepare(
        "UPDATE comments SET status = 'deleted' WHERE site = ? AND (id = ? OR parent_id = ?) AND status = 'visible'"
      )
        .bind(site, commentId, commentId)
        .run();
      changed = Number(res?.meta?.changes || 0);
    } else {
      throw err;
    }
  }

  if (!changed) {
    return jsonResponse({ ok: false, error: "not_found" }, 404);
  }

  const origin = new URL(request.url).origin;
  const drainTask = drainImageDeletionOutbox(env, site, origin);
  if (ctx?.waitUntil) {
    ctx.waitUntil(drainTask.catch(() => {}));
  } else {
    await drainTask.catch(() => {});
  }

  return jsonResponse({ ok: true, id: commentId });
}

function safeDecodePathParam(raw) {
  try {
    return decodeURIComponent(raw).replace(/\/+$/, "");
  } catch {
    return null;
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/api/comments" || path === "/api/comments/") {
      if (request.method === "GET") {
        return handleGetComments(request, env, ctx);
      }
      if (request.method === "POST") {
        return handleCreateComment(request, env, ctx);
      }
      return jsonResponse({ ok: false, error: "method_not_allowed" }, 405, { Allow: "GET, POST" });
    }

    if (path === "/api/comments/author/verify") {
      if (request.method === "POST") {
        return handleAuthorVerify(request, env);
      }
      return jsonResponse({ ok: false, error: "method_not_allowed" }, 405, { Allow: "POST" });
    }

    if (path.startsWith("/api/comments/images/")) {
      const imageId = safeDecodePathParam(path.slice("/api/comments/images/".length));
      if (imageId === null) {
        return jsonResponse({ ok: false, error: "invalid_image_id" }, 400);
      }
      if (request.method === "GET" || request.method === "HEAD") {
        return handleGetCommentImage(request, env, imageId, ctx);
      }
      return jsonResponse({ ok: false, error: "method_not_allowed" }, 405, { Allow: "GET, HEAD" });
    }

    if (path.startsWith("/api/comments/")) {
      const id = safeDecodePathParam(path.slice("/api/comments/".length));
      if (id === null) {
        return jsonResponse({ ok: false, error: "invalid_id" }, 400);
      }
      if (request.method === "DELETE") {
        return handleDeleteComment(request, env, id, ctx);
      }
      return jsonResponse({ ok: false, error: "method_not_allowed" }, 405, { Allow: "DELETE" });
    }

    if (env.ASSETS && typeof env.ASSETS.fetch === "function") {
      return env.ASSETS.fetch(request);
    }
    return new Response("Not Found", { status: 404 });
  },
};
