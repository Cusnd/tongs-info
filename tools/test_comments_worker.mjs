#!/usr/bin/env node
/**
 * Tong's Information — Zero-Dependency Comments Worker, Migrations & Preview Isolation Contract Tests
 *
 * Runs directly on Node 24+ (using built-in `node:sqlite`, `node:assert`, `node:crypto`, `node:zlib`)
 * against the repository's actual `worker/index.mjs`, `migrations/*.sql`, and `cloudflare.config.ts`.
 * Executed automatically on every PR in `.github/workflows/ci.yml` without requiring Cloudflare credentials.
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import path from "node:path";
import zlib from "node:zlib";

import worker from "../worker/index.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const MIGRATIONS_DIR = path.join(ROOT, "migrations");
const ORIGIN = "https://www.esoren.com";

// ---------------------------------------------------------------------------
// Minimal deterministic binary image fixture builders
// ---------------------------------------------------------------------------
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i];
    for (let k = 0; k < 8; k += 1) {
      c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const t = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

function makePng(w = 4, h = 3, extraChunks = [], trailingBytes = Buffer.alloc(0)) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const rows = [];
  for (let y = 0; y < h; y += 1) {
    rows.push(Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, 0x44)]));
  }
  const idat = zlib.deflateSync(Buffer.concat(rows));
  return Buffer.concat([
    sig,
    pngChunk("IHDR", ihdr),
    ...extraChunks,
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
    trailingBytes,
  ]);
}

function makeJpeg({
  w = 8,
  h = 6,
  withExif = true,
  withComment = true,
  withInterScanCom = false,
  truncateEoi = false,
  trailingBytes = Buffer.alloc(0),
} = {}) {
  const segs = [Buffer.from([0xff, 0xd8])];
  if (withExif) {
    const payload = Buffer.from("Exif\0\0GPS_SECRET_COORD");
    const len = Buffer.alloc(2);
    len.writeUInt16BE(payload.length + 2, 0);
    segs.push(Buffer.from([0xff, 0xe1]), len, payload);
  }
  if (withComment) {
    const payload = Buffer.from("PRIVATE_COMMENT_1");
    const len = Buffer.alloc(2);
    len.writeUInt16BE(payload.length + 2, 0);
    segs.push(Buffer.from([0xff, 0xfe]), len, payload);
  }
  const sof = Buffer.alloc(11);
  sof.writeUInt16BE(11, 0);
  sof[2] = 8;
  sof.writeUInt16BE(h, 3);
  sof.writeUInt16BE(w, 5);
  sof[7] = 1;
  sof[8] = 1;
  sof[9] = 0x11;
  sof[10] = 0;
  segs.push(Buffer.from([0xff, 0xc0]), sof);
  // First SOS + stuffed 0xFF 0x00 entropy data
  segs.push(Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0x12, 0xff, 0x00, 0x7f]));
  if (withInterScanCom) {
    const payload = Buffer.from("LATER_SCAN_SECRET_COM");
    const len = Buffer.alloc(2);
    len.writeUInt16BE(payload.length + 2, 0);
    segs.push(Buffer.from([0xff, 0xfe]), len, payload);
    // Second progressive SOS scan
    segs.push(Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0x34, 0x56]));
  }
  if (!truncateEoi) {
    segs.push(Buffer.from([0xff, 0xd9]));
  }
  if (trailingBytes.length) segs.push(trailingBytes);
  return Buffer.concat(segs);
}

function makeGif({ w = 4, h = 4, frames = 2, withComment = true, withXmp = true, trailingBytes = Buffer.alloc(0) } = {}) {
  const parts = [];
  const hdr = Buffer.alloc(13);
  hdr.write("GIF89a", 0, "ascii");
  hdr.writeUInt16LE(w, 6);
  hdr.writeUInt16LE(h, 8);
  hdr[10] = 0x80;
  parts.push(hdr, Buffer.from([0, 0, 0, 255, 255, 255]));
  parts.push(
    Buffer.from([0x21, 0xff, 0x0b]),
    Buffer.from("NETSCAPE2.0", "ascii"),
    Buffer.from([0x03, 0x01, 0x00, 0x00, 0x00])
  );
  if (withComment) {
    const txt = Buffer.from("SECRET_GIF_NOTE");
    parts.push(Buffer.from([0x21, 0xfe, txt.length]), txt, Buffer.from([0x00]));
  }
  if (withXmp) {
    const xmp = Buffer.from("XMP_PAYLOAD");
    parts.push(
      Buffer.from([0x21, 0xff, 0x0b]),
      Buffer.from("XMP DataXMP", "ascii"),
      Buffer.from([xmp.length]),
      xmp,
      Buffer.from([0x00])
    );
  }
  for (let i = 0; i < frames; i += 1) {
    const desc = Buffer.alloc(10);
    desc[0] = 0x2c;
    desc.writeUInt16LE(w, 5);
    desc.writeUInt16LE(h, 7);
    parts.push(desc, Buffer.from([0x02, 0x02, 0x4c, 0x01, 0x00]));
  }
  parts.push(Buffer.from([0x3b]));
  if (trailingBytes.length) parts.push(trailingBytes);
  return Buffer.concat(parts);
}

function makeAnimatedWebp({
  w = 4,
  h = 4,
  frameW = 4,
  frameH = 4,
  codedW = null,
  codedH = null,
  frameX = 0,
  frameY = 0,
  validNestedVp8l = true,
  duplicateBitstream = false,
  withExif = true,
  withXmp = true,
} = {}) {
  const chunk = (tag, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32LE(data.length, 0);
    const pad = data.length & 1 ? Buffer.from([0]) : Buffer.alloc(0);
    return Buffer.concat([Buffer.from(tag, "ascii"), len, data, pad]);
  };
  const vp8x = Buffer.alloc(10);
  vp8x[0] = 0x02 | (withExif ? 0x08 : 0) | (withXmp ? 0x04 : 0);
  const w1 = w - 1;
  const h1 = h - 1;
  vp8x[4] = w1 & 0xff;
  vp8x[5] = (w1 >> 8) & 0xff;
  vp8x[6] = (w1 >> 16) & 0xff;
  vp8x[7] = h1 & 0xff;
  vp8x[8] = (h1 >> 8) & 0xff;
  vp8x[9] = (h1 >> 16) & 0xff;

  const chunks = [chunk("VP8X", vp8x)];
  if (withExif) chunks.push(chunk("EXIF", Buffer.from("SECRET_WEBP_EXIF")));
  if (withXmp) chunks.push(chunk("XMP ", Buffer.from("<xmp>SECRET_WEBP_XMP</xmp>")));

  const anmfHdr = Buffer.alloc(16);
  const fx2 = frameX >> 1;
  const fy2 = frameY >> 1;
  const fw1 = frameW - 1;
  const fh1 = frameH - 1;
  anmfHdr[0] = fx2 & 0xff;
  anmfHdr[1] = (fx2 >> 8) & 0xff;
  anmfHdr[2] = (fx2 >> 16) & 0xff;
  anmfHdr[3] = fy2 & 0xff;
  anmfHdr[4] = (fy2 >> 8) & 0xff;
  anmfHdr[5] = (fy2 >> 16) & 0xff;
  anmfHdr[6] = fw1 & 0xff;
  anmfHdr[7] = (fw1 >> 8) & 0xff;
  anmfHdr[8] = (fw1 >> 16) & 0xff;
  anmfHdr[9] = fh1 & 0xff;
  anmfHdr[10] = (fh1 >> 8) & 0xff;
  anmfHdr[11] = (fh1 >> 16) & 0xff;

  const bw = codedW ?? frameW;
  const bh = codedH ?? frameH;
  const vp8lData = Buffer.alloc(6);
  vp8lData[0] = validNestedVp8l ? 0x2f : 0x00;
  const bits = ((bw - 1) & 0x3fff) | (((bh - 1) & 0x3fff) << 14);
  vp8lData.writeUInt32LE(bits >>> 0, 1);
  const nestedSub = chunk("VP8L", vp8lData);
  const nestedParts = duplicateBitstream ? [anmfHdr, nestedSub, nestedSub] : [anmfHdr, nestedSub];
  chunks.push(chunk("ANMF", Buffer.concat(nestedParts)));

  const body = Buffer.concat([Buffer.from("WEBP", "ascii"), ...chunks]);
  const hdr = Buffer.alloc(8);
  hdr.write("RIFF", 0, "ascii");
  hdr.writeUInt32LE(body.length, 4);
  return Buffer.concat([hdr, body]);
}

function solvePow(gateToken, bits) {
  const full = Math.floor(bits / 8);
  const rem = bits % 8;
  const mask = rem > 0 ? (0xff << (8 - rem)) & 0xff : 0;
  for (let i = 0; i < 2_000_000; i += 1) {
    const nonce = i.toString(36);
    const dig = crypto.createHash("sha256").update(`${gateToken}:${nonce}`).digest();
    let ok = true;
    for (let j = 0; j < full; j += 1) {
      if (dig[j] !== 0) {
        ok = false;
        break;
      }
    }
    if (ok && (rem === 0 || (dig[full] & mask) === 0)) {
      return nonce;
    }
  }
  throw new Error("pow_exhausted");
}

// ---------------------------------------------------------------------------
// Real node:sqlite D1 adapter + R2 + caches.default harness
// ---------------------------------------------------------------------------
function createMockCaches() {
  const store = new Map();
  return {
    default: {
      async match(req) {
        const key = typeof req === "string" ? req : req.url;
        const val = store.get(key);
        return val ? val.clone() : undefined;
      },
      async put(req, res) {
        const key = typeof req === "string" ? req : req.url;
        const buf = await res.arrayBuffer();
        store.set(key, new Response(buf, { status: res.status, headers: res.headers }));
      },
      async delete(req) {
        const key = typeof req === "string" ? req : req.url;
        return store.delete(key);
      },
      _store: store,
    },
  };
}

function createRealSqliteHarness({ upToMigration = "9999" } = {}) {
  const db = new DatabaseSync(":memory:");
  const migrationFiles = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql") && f <= `${upToMigration}_zzzz.sql`)
    .sort();
  for (const mf of migrationFiles) {
    db.exec(readFileSync(path.join(MIGRATIONS_DIR, mf), "utf8"));
  }

  const r2 = new Map();
  const hooks = {
    rateLimitAllow: true,
    failR2Delete: false,
    failNextBatchAfterCommit: false,
    failNextReconcileRead: false,
    deleteParentBeforeNextBatch: null,
    beforeNextBatchHook: null,
    beforeNextR2PutHook: null,
  };

  function wrapStatement(sql) {
    let bound = [];
    return {
      sql,
      bind(...args) {
        bound = args.map((v) => (v === undefined ? null : v));
        return this;
      },
      _runSync() {
        const stmt = db.prepare(sql);
        const info = stmt.run(...bound);
        return { meta: { changes: Number(info.changes || 0) } };
      },
      async all() {
        const stmt = db.prepare(sql);
        return { results: stmt.all(...bound) };
      },
      async first() {
        if (hooks.failNextReconcileRead && sql.includes("SELECT id FROM comments WHERE id = ? AND site = ?")) {
          hooks.failNextReconcileRead = false;
          throw new Error("D1_ERROR: transient reconcile read outage");
        }
        const stmt = db.prepare(sql);
        const row = stmt.get(...bound);
        return row === undefined ? null : row;
      },
      async run() {
        return this._runSync();
      },
    };
  }

  const COMMENTS_DB = {
    prepare(sql) {
      return wrapStatement(sql);
    },
    async batch(stmts) {
      if (typeof hooks.beforeNextBatchHook === "function") {
        const fn = hooks.beforeNextBatchHook;
        hooks.beforeNextBatchHook = null;
        await fn();
      }
      if (hooks.deleteParentBeforeNextBatch) {
        const pid = hooks.deleteParentBeforeNextBatch;
        hooks.deleteParentBeforeNextBatch = null;
        db.prepare("UPDATE comments SET status = 'deleted' WHERE id = ?").run(pid);
      }
      db.exec("BEGIN IMMEDIATE");
      const results = [];
      try {
        for (const s of stmts) {
          results.push(s._runSync());
        }
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
      if (hooks.failNextBatchAfterCommit) {
        hooks.failNextBatchAfterCommit = false;
        throw new Error("D1_ERROR: simulated lost commit ack");
      }
      return results;
    },
  };

  const COMMENTS_IMAGES = {
    async put(key, bytes, opts = {}) {
      if (typeof hooks.beforeNextR2PutHook === "function") {
        const fn = hooks.beforeNextR2PutHook;
        hooks.beforeNextR2PutHook = null;
        await fn(key);
      }
      const buf = bytes instanceof Uint8Array ? Buffer.from(bytes) : Buffer.from(await new Response(bytes).arrayBuffer());
      r2.set(key, { buf, opts });
    },
    async get(key) {
      const entry = r2.get(key);
      if (!entry) return null;
      return { size: entry.buf.length, body: new Response(entry.buf).body };
    },
    async head(key) {
      const entry = r2.get(key);
      if (!entry) return null;
      return { size: entry.buf.length };
    },
    async delete(key) {
      if (hooks.failR2Delete) throw new Error("simulated_r2_delete_error");
      r2.delete(key);
    },
  };

  const waitUntilTasks = [];
  const ctx = {
    waitUntil(p) {
      waitUntilTasks.push(Promise.resolve(p));
    },
    async flush() {
      const batch = waitUntilTasks.splice(0, waitUntilTasks.length);
      await Promise.allSettled(batch);
    },
  };

  const env = {
    SITE_ID: "prod",
    SITE_AUTHOR: "Tong",
    TURNSTILE_HOSTNAMES: "www.esoren.com",
    COMMENT_GATE_SECRET: "ci-test-gate-secret-987654",
    COMMENT_ADMIN_TOKEN: "ci-test-author-token-987654",
    COMMENTS_DB,
    COMMENTS_IMAGES,
    COMMENT_RATE_LIMIT: {
      async limit() {
        return { success: hooks.rateLimitAllow };
      },
    },
  };

  return { db, env, ctx, hooks, r2 };
}

async function testNativePreviewConfigIsolation() {
  const cfgMod = await import(pathToFileURL(path.join(ROOT, "cloudflare.config.ts")).href);
  const configFn = cfgMod.default;
  assert.equal(typeof configFn, "function", "N1: cloudflare.config.ts must export a context callback function");

  const prevSite = process.env.CF_SITE_TARGET;
  const prevKind = process.env.CF_DEPLOY_KIND;
  const prevWorker = process.env.CF_WORKER_NAME;
  try {
    // 1. Native preview context WITHOUT CF_DEPLOY_KIND must NEVER select release Worker or release bindings
    process.env.CF_SITE_TARGET = "prod";
    delete process.env.CF_DEPLOY_KIND;
    delete process.env.CF_WORKER_NAME;
    const prevCfg = configFn({ isPreview: true, mode: undefined });
    assert.equal(prevCfg.worker.name, "tongs-info-prod-preview", "N1: native preview must select preview Worker");
    assert.equal(prevCfg.worker.entrypoint, undefined, "N1: preview without preview_d1_database_id must be assets-only");
    assert.equal(prevCfg.worker.env, undefined, "N1: preview must not bind live D1/R2 storage");

    // 2. Conflicting CF_DEPLOY_KIND='production' with isPreview=true must throw
    process.env.CF_DEPLOY_KIND = "production";
    assert.throws(
      () => configFn({ isPreview: true, mode: undefined }),
      /Conflicting preview mode/,
      "N1: must reject conflicting CF_DEPLOY_KIND vs context.isPreview"
    );

    // 3. Release context selects production Worker + release D1 + R2
    const prodCfg = configFn({ isPreview: false, mode: undefined });
    assert.equal(prodCfg.worker.name, "tongs-info-prod");
    assert.equal(prodCfg.worker.entrypoint, "./worker/index.mjs");
    assert.ok(prodCfg.worker.env?.COMMENTS_DB);
    assert.ok(prodCfg.worker.env?.COMMENTS_IMAGES);
  } finally {
    if (prevSite === undefined) delete process.env.CF_SITE_TARGET;
    else process.env.CF_SITE_TARGET = prevSite;
    if (prevKind === undefined) delete process.env.CF_DEPLOY_KIND;
    else process.env.CF_DEPLOY_KIND = prevKind;
    if (prevWorker === undefined) delete process.env.CF_WORKER_NAME;
    else process.env.CF_WORKER_NAME = prevWorker;
  }
}

async function runTests() {
  globalThis.caches = createMockCaches();

  // 0. N1: Native cloudflare.config.ts preview callback isolation
  await testNativePreviewConfigIsolation();

  // 1. N2: Pre-0003 DBs (both original 0002 AND intermediate Round-1 0002 without `reason`)
  {
    const legacy = createRealSqliteHarness({ upToMigration: "0002" });
    const legacyGet = await worker.fetch(new Request(`${ORIGIN}/api/comments?slug=legacy-post`), legacy.env, legacy.ctx);
    assert.equal(legacyGet.status, 200);
    const legacyJson = await legacyGet.json();
    assert.equal(legacyJson.config.imagesEnabled, false, "N2: pre-0003 DB must not advertise imagesEnabled=true");

    // Text-only POST WITH clientRequestId during rolling rollout before 0003 MUST succeed (201), not 500!
    const textRolloutRes = await worker.fetch(
      new Request(`${ORIGIN}/api/comments`, {
        method: "POST",
        headers: { Origin: ORIGIN, "Content-Type": "application/json", "X-Author-Key": legacy.env.COMMENT_ADMIN_TOKEN },
        body: JSON.stringify({
          slug: "legacy-post",
          lang: "en",
          body: "Rolling rollout text note before 0003",
          clientRequestId: "req_rollout_pre0003_1",
        }),
      }),
      legacy.env,
      legacy.ctx
    );
    assert.equal(textRolloutRes.status, 201, "N2: text-only POST with clientRequestId must work on pre-0003 DB");

    const fd = new FormData();
    fd.append("payload", JSON.stringify({ slug: "legacy-post", lang: "en", body: "legacy img" }));
    fd.append("images", new File([makePng()], "a.png", { type: "image/png" }));
    const legacyPost = await worker.fetch(
      new Request(`${ORIGIN}/api/comments`, {
        method: "POST",
        headers: { Origin: ORIGIN, "X-Author-Key": legacy.env.COMMENT_ADMIN_TOKEN },
        body: fd,
      }),
      legacy.env,
      legacy.ctx
    );
    assert.equal(legacyPost.status, 503, "N2: pre-0003 DB must refuse image uploads with 503");

    // Applying 0003 additively upgrades original 0002 DB cleanly!
    legacy.db.exec(readFileSync(path.join(MIGRATIONS_DIR, "0003_comment_image_hardening.sql"), "utf8"));
    const upgradedGet = await worker.fetch(new Request(`${ORIGIN}/api/comments?slug=legacy-post`), legacy.env, legacy.ctx);
    assert.equal((await upgradedGet.json()).config.imagesEnabled, true, "N2: applying 0003 must enable images cleanly");
    legacy.db.close();
  }

  // 1b. N2: Intermediate Round-1 0002 DB (outbox without `reason` + trigger already present) upgrades cleanly & preserves queued keys
  {
    const mid = createRealSqliteHarness({ upToMigration: "0002" });
    mid.db.exec(`
      CREATE TABLE comment_image_deletions (
        r2_key TEXT PRIMARY KEY,
        image_id TEXT NOT NULL,
        site TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE TRIGGER trg_comments_visible_parent
      BEFORE INSERT ON comments WHEN NEW.parent_id IS NOT NULL
      BEGIN SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM comments WHERE id = NEW.parent_id AND site = NEW.site AND slug = NEW.slug AND parent_id IS NULL AND status = 'visible') THEN RAISE(ABORT, 'parent_not_found') END; END;
      INSERT INTO comment_image_deletions (r2_key, image_id, site, attempts, created_at)
      VALUES ('prod/old/c1/img_queued.png', 'img_queued', 'prod', 2, 1000);
    `);
    const midBefore = await worker.fetch(new Request(`${ORIGIN}/api/comments?slug=mid-post`), mid.env, mid.ctx);
    assert.equal((await midBefore.json()).config.imagesEnabled, false, "N2: Round-1 0002 missing `reason` must report imagesEnabled=false");

    mid.db.exec(readFileSync(path.join(MIGRATIONS_DIR, "0003_comment_image_hardening.sql"), "utf8"));
    const preserved = mid.db.prepare("SELECT r2_key, reason, attempts FROM comment_image_deletions WHERE r2_key = ?").get("prod/old/c1/img_queued.png");
    assert.equal(preserved?.reason, "deleted", "N2: 0003 upgrade must preserve queued keys with default reason='deleted'");
    assert.equal(preserved?.attempts, 2);
    const midAfter = await worker.fetch(new Request(`${ORIGIN}/api/comments?slug=mid-post`), mid.env, mid.ctx);
    assert.equal((await midAfter.json()).config.imagesEnabled, true, "N2: upgraded Round-1 0002 must enable images cleanly");
    mid.db.close();
  }

  // Full schema (0001 + 0002 + 0003)
  const h = createRealSqliteHarness();

  // 2. GET /api/comments returns imagesEnabled: true & signed gate
  const getRes = await worker.fetch(new Request(`${ORIGIN}/api/comments?slug=test-post`), h.env, h.ctx);
  assert.equal(getRes.status, 200);
  const getJson = await getRes.json();
  assert.equal(getJson.config.imagesEnabled, true);
  assert.ok(getJson.gate.token);

  // 3. H3: Pre-body edge rate limit rejects BEFORE reading request body
  h.hooks.rateLimitAllow = false;
  let bodyPulled = false;
  const trappedStream = new ReadableStream(
    {
      pull() {
        bodyPulled = true;
        throw new Error("Body must not be pulled");
      },
    },
    { highWaterMark: 0 }
  );
  const rlReq = new Request(`${ORIGIN}/api/comments`, {
    method: "POST",
    headers: { Origin: ORIGIN, "Content-Type": "multipart/form-data; boundary=----x", "Content-Length": "100" },
    body: trappedStream,
    duplex: "half",
  });
  const rlRes = await worker.fetch(rlReq, h.env, h.ctx);
  assert.equal(rlRes.status, 429);
  assert.equal(rlReq.bodyUsed, false);
  assert.equal(bodyPulled, false);
  h.hooks.rateLimitAllow = true;

  // 4. M4 + M14: Guest PoW uniform fallback + clientRequestId idempotent retry recovery even when quota is saturated
  const realNow = Date.now;
  Date.now = () => realNow() + 5000;
  try {
    const g1 = getJson.gate;
    // Weak 12-bit PoW when TURNSTILE_SECRET is missing must be rejected even with fallbackMode=false
    const weakNonce = solvePow(g1.token, 12);
    const weakDig = crypto.createHash("sha256").update(`${g1.token}:${weakNonce}`).digest();
    if (!(weakDig[0] === 0 && weakDig[1] === 0 && (weakDig[2] & 0x80) === 0)) {
      const m4Res = await worker.fetch(
        new Request(`${ORIGIN}/api/comments`, {
          method: "POST",
          headers: { Origin: ORIGIN, "Content-Type": "application/json" },
          body: JSON.stringify({
            slug: "test-post",
            lang: "en",
            body: "Weak PoW probe",
            gateToken: g1.token,
            powNonce: weakNonce,
            fallbackMode: false,
          }),
        }),
        h.env,
        h.ctx
      );
      assert.equal(m4Res.status, 403);
      assert.equal((await m4Res.json()).error, "pow_invalid");
    }

    // Valid guest post with clientRequestId (uses fallback shortMax=1)
    const gValidRes = await worker.fetch(new Request(`${ORIGIN}/api/comments?slug=test-post`), h.env, h.ctx);
    const gValid = (await gValidRes.json()).gate;
    Date.now = () => realNow() + 10000;
    const reqId = "req_idempotent_123456";
    const strongNonce1 = solvePow(gValid.token, gValid.fallbackPowBits);
    const guestRes1 = await worker.fetch(
      new Request(`${ORIGIN}/api/comments`, {
        method: "POST",
        headers: { Origin: ORIGIN, "Content-Type": "application/json", "CF-Connecting-IP": "198.51.100.42" },
        body: JSON.stringify({
          slug: "test-post",
          lang: "en",
          body: "Idempotent guest note",
          clientRequestId: reqId,
          gateToken: gValid.token,
          powNonce: strongNonce1,
          fallbackMode: true,
        }),
      }),
      h.env,
      h.ctx
    );
    assert.equal(guestRes1.status, 201);
    const guest1 = await guestRes1.json();

    // Retry same clientRequestId with fresh gate -> recovers original comment with 200 even though shortMax=1 is full!
    const gRetry = guest1.nextGate;
    Date.now = () => realNow() + 15000;
    const strongNonce2 = solvePow(gRetry.token, gRetry.fallbackPowBits);
    const retryRes = await worker.fetch(
      new Request(`${ORIGIN}/api/comments`, {
        method: "POST",
        headers: { Origin: ORIGIN, "Content-Type": "application/json", "CF-Connecting-IP": "198.51.100.42" },
        body: JSON.stringify({
          slug: "test-post",
          lang: "en",
          body: "Idempotent guest note",
          clientRequestId: reqId,
          gateToken: gRetry.token,
          powNonce: strongNonce2,
          fallbackMode: true,
        }),
      }),
      h.env,
      h.ctx
    );
    assert.equal(retryRes.status, 200, "M14: idempotent retry must recover committed comment even when short quota is full");
    const retryJson = await retryRes.json();
    assert.equal(retryJson.idempotent, true);
    assert.equal(retryJson.comment.id, guest1.comment.id);

    // A DIFFERENT comment from the same IP within shortWindow MUST be rejected by quota (429)
    const gQuota = retryJson.nextGate;
    Date.now = () => realNow() + 20000;
    const strongNonce3 = solvePow(gQuota.token, gQuota.fallbackPowBits);
    const quotaRes = await worker.fetch(
      new Request(`${ORIGIN}/api/comments`, {
        method: "POST",
        headers: { Origin: ORIGIN, "Content-Type": "application/json", "CF-Connecting-IP": "198.51.100.42" },
        body: JSON.stringify({
          slug: "test-post",
          lang: "en",
          body: "Second note within short window",
          gateToken: gQuota.token,
          powNonce: strongNonce3,
          fallbackMode: true,
        }),
      }),
      h.env,
      h.ctx
    );
    assert.equal(quotaRes.status, 429, "M3: second note within short window must hit 429");
  } finally {
    Date.now = realNow;
  }

  // Helper for author multipart uploads
  async function postAuthorImages(payloadObj, fileTuples) {
    const fd = new FormData();
    fd.append("payload", JSON.stringify({ slug: "test-post", lang: "en", ...payloadObj }));
    for (const [name, mime, buf] of fileTuples) {
      fd.append("images", new File([buf], name, { type: mime }));
    }
    return worker.fetch(
      new Request(`${ORIGIN}/api/comments`, {
        method: "POST",
        headers: { Origin: ORIGIN, "X-Author-Key": h.env.COMMENT_ADMIN_TOKEN },
        body: fd,
      }),
      h.env,
      h.ctx
    );
  }

  // 5. M7 & M8: Reject invalid containers & scrub metadata + trailing bytes across all 4 formats
  const badActl = Buffer.alloc(8);
  badActl.writeUInt32BE(121, 0); // > 120 APNG frames
  const apngBombRes = await postAuthorImages({ body: "apng bomb" }, [
    ["a.png", "image/png", makePng(4, 4, [pngChunk("acTL", badActl)])],
  ]);
  assert.equal(apngBombRes.status, 400);
  assert.equal((await apngBombRes.json()).error, "image_dimensions_exceeded");

  // M7: APNG declaring 2 frames with 0 fcTL chunks must be rejected
  const zeroFctlActl = Buffer.alloc(8);
  zeroFctlActl.writeUInt32BE(2, 0);
  const apngZeroFctlRes = await postAuthorImages({ body: "apng zero fctl" }, [
    ["a0.png", "image/png", makePng(4, 4, [pngChunk("acTL", zeroFctlActl)])],
  ]);
  assert.equal(apngZeroFctlRes.status, 400, "M7: APNG with acTL frames > 0 and 0 fcTL chunks must be rejected");

  const badWebpRectRes = await postAuthorImages({ body: "bad webp rect" }, [
    ["w.webp", "image/webp", makeAnimatedWebp({ w: 4, h: 4, frameW: 6, frameH: 4 })],
  ]);
  assert.equal(badWebpRectRes.status, 400, "M7: WebP ANMF frame exceeding canvas must be rejected");

  const badWebpNestedRes = await postAuthorImages({ body: "bad webp nested" }, [
    ["w2.webp", "image/webp", makeAnimatedWebp({ w: 4, h: 4, validNestedVp8l: false })],
  ]);
  assert.equal(badWebpNestedRes.status, 400, "M7: WebP ANMF with invalid nested VP8L must be rejected");

  const badWebpCodedDimsRes = await postAuthorImages({ body: "bad webp coded dims" }, [
    ["w3.webp", "image/webp", makeAnimatedWebp({ w: 4, h: 4, frameW: 4, frameH: 4, codedW: 2, codedH: 2 })],
  ]);
  assert.equal(badWebpCodedDimsRes.status, 400, "M7: WebP ANMF nested coded dims != frame rect must be rejected");

  const badWebpDupStreamRes = await postAuthorImages({ body: "bad webp dup stream" }, [
    ["w4.webp", "image/webp", makeAnimatedWebp({ w: 4, h: 4, duplicateBitstream: true })],
  ]);
  assert.equal(badWebpDupStreamRes.status, 400, "M7: WebP ANMF with duplicate nested bitstreams must be rejected");

  const truncJpgRes = await postAuthorImages({ body: "trunc jpg" }, [
    ["t.jpg", "image/jpeg", makeJpeg({ truncateEoi: true })],
  ]);
  assert.equal(truncJpgRes.status, 400);

  const gifBombRes = await postAuthorImages({ body: "gif bomb" }, [
    ["g.gif", "image/gif", makeGif({ frames: 121 })],
  ]);
  assert.equal(gifBombRes.status, 400);

  // Scrubbing + trailing payload stripping test (PNG, multi-scan JPEG, GIF)
  const pngWithTrailer = makePng(
    4,
    3,
    [pngChunk("tEXt", Buffer.from("Author\0SecretPNG"))],
    Buffer.from("PNG_TRAILING_SMUGGLE")
  );
  const jpgMultiScan = makeJpeg({
    withExif: true,
    withComment: true,
    withInterScanCom: true,
    trailingBytes: Buffer.from("JPG_TRAILING_SMUGGLE"),
  });
  const gifWithTrailer = makeGif({
    frames: 2,
    withComment: true,
    withXmp: true,
    trailingBytes: Buffer.from("GIF_TRAILING_SMUGGLE"),
  });

  const scrubRes = await postAuthorImages(
    { body: "Scrub & strip check", imageAlts: ["PNG alt", "JPG alt", "GIF alt"] },
    [
      ["a.png", "image/png", pngWithTrailer],
      ["b.jpg", "image/jpeg", jpgMultiScan],
      ["c.gif", "image/gif", gifWithTrailer],
    ]
  );
  assert.equal(scrubRes.status, 201);
  const scrubJson = await scrubRes.json();
  assert.equal(scrubJson.comment.images.length, 3);

  for (const imgMeta of scrubJson.comment.images) {
    const row = h.db.prepare("SELECT r2_key FROM comment_images WHERE id = ?").get(imgMeta.id);
    const stored = h.r2.get(row.r2_key).buf.toString("latin1");
    assert.ok(!stored.includes("SecretPNG"), "M8: PNG tEXt must be stripped");
    assert.ok(!stored.includes("PNG_TRAILING_SMUGGLE"), "M8: PNG trailing bytes must be stripped");
    assert.ok(!stored.includes("GPS_SECRET_COORD"), "M8: JPEG EXIF must be stripped");
    assert.ok(!stored.includes("PRIVATE_COMMENT_1"), "M8: JPEG COM must be stripped");
    assert.ok(!stored.includes("LATER_SCAN_SECRET_COM"), "M8: JPEG inter-scan COM must be stripped");
    assert.ok(!stored.includes("JPG_TRAILING_SMUGGLE"), "M8: JPEG trailing bytes must be stripped");
    assert.ok(!stored.includes("SECRET_GIF_NOTE"), "M8: GIF comment must be stripped");
    assert.ok(!stored.includes("XMP_PAYLOAD"), "M8: GIF XMP must be stripped");
    assert.ok(!stored.includes("GIF_TRAILING_SMUGGLE"), "M8: GIF trailing bytes must be stripped");
    if (imgMeta.mimeType === "image/gif") {
      assert.ok(stored.includes("NETSCAPE2.0"), "M8: GIF NETSCAPE2.0 loop extension preserved");
    }
  }

  // Valid animated WebP scrub check
  const webpRes = await postAuthorImages({ body: "Valid animated WebP" }, [
    ["ok.webp", "image/webp", makeAnimatedWebp({ withExif: true, withXmp: true })],
  ]);
  assert.equal(webpRes.status, 201);
  const webpImgId = (await webpRes.json()).comment.images[0].id;
  const webpKey = h.db.prepare("SELECT r2_key FROM comment_images WHERE id = ?").get(webpImgId).r2_key;
  const webpStored = h.r2.get(webpKey).buf;
  assert.ok(!webpStored.toString("latin1").includes("SECRET_WEBP_EXIF"));
  assert.ok(!webpStored.toString("latin1").includes("SECRET_WEBP_XMP"));
  assert.equal(webpStored[20] & 0x0c, 0);
  assert.equal(webpStored[20] & 0x02, 0x02);

  // 6. M2 & L7: Image serving headers + conditional 304 + missing-R2 404
  const imgUrl = `${ORIGIN}/api/comments/images/${webpImgId}`;
  const serve1 = await worker.fetch(new Request(imgUrl), h.env, h.ctx);
  await h.ctx.flush();
  assert.equal(serve1.status, 200);
  assert.equal(serve1.headers.get("Cache-Control"), "private, no-cache");
  assert.equal(serve1.headers.get("Cross-Origin-Resource-Policy"), "same-origin");
  const etag = serve1.headers.get("ETag");
  assert.equal(
    (await worker.fetch(new Request(imgUrl, { headers: { "If-None-Match": etag } }), h.env, h.ctx)).status,
    304
  );
  globalThis.caches.default._store.delete(imgUrl);
  const savedWebp = h.r2.get(webpKey);
  h.r2.delete(webpKey);
  assert.equal(
    (await worker.fetch(new Request(imgUrl, { headers: { "If-None-Match": etag } }), h.env, h.ctx)).status,
    404,
    "L7: conditional GET must return 404 when R2 object is absent"
  );
  h.r2.set(webpKey, savedWebp);

  // 7. N3 + M1: Failed reconciliation read preserves committed R2 object, AND sweeper-vs-uploader ownership lease prevents broken attachments!
  const parentId = scrubJson.comment.id;
  h.hooks.failNextBatchAfterCommit = true;
  h.hooks.failNextReconcileRead = true;
  const n3Res = await postAuthorImages(
    { parentId, body: "Ambiguous commit + failed reconcile", clientRequestId: "req_aged_retry_check_1" },
    [["n3.png", "image/png", makePng(3, 3)]]
  );
  assert.equal(n3Res.status, 500);
  const n3ImgRow = h.db
    .prepare("SELECT id, r2_key, comment_id FROM comment_images WHERE comment_id = (SELECT id FROM comments WHERE body = ?)")
    .get("Ambiguous commit + failed reconcile");
  assert.ok(n3ImgRow, "N3: commit had actually succeeded in D1");
  assert.ok(h.r2.has(n3ImgRow.r2_key), "N3 CRITICAL: failed reconcile read must NEVER delete committed R2 object!");

  // 7b. M14: Age that committed row to 20 minutes ago (> 15 min) and retry SAME clientRequestId -> must STILL recover cleanly with 200 (never 500)!
  h.db.prepare("UPDATE comments SET created_at = ? WHERE id = ?").run(Date.now() - 20 * 60 * 1000, n3ImgRow.comment_id);
  const agedRetryRes = await postAuthorImages(
    { parentId, body: "Ambiguous commit + failed reconcile", clientRequestId: "req_aged_retry_check_1" },
    []
  );
  assert.equal(agedRetryRes.status, 200, "M14: >15m aged clientRequestId retry must recover cleanly instead of 500");
  assert.equal((await agedRetryRes.json()).comment.id, n3ImgRow.comment_id);

  // 7c. M1: Explicitly insert a lingering stale 'inflight' row for that committed R2 key, assert it exists,
  //     and verify sweeper sees the live comment_images row, PRESERVES R2 bytes, and clears the stale 'inflight' row!
  h.db
    .prepare(
      "INSERT OR REPLACE INTO comment_image_deletions (r2_key, image_id, site, reason, attempts, created_at) VALUES (?, ?, 'prod', 'inflight', 0, ?)"
    )
    .run(n3ImgRow.r2_key, n3ImgRow.id, Date.now() - 300_000);
  assert.equal(
    h.db.prepare("SELECT COUNT(*) AS c FROM comment_image_deletions WHERE r2_key = ? AND reason = 'inflight'").get(n3ImgRow.r2_key).c,
    1,
    "M1: test fixture must contain an actual pending inflight row before sweep"
  );
  await worker.fetch(new Request(`${ORIGIN}/api/comments?slug=test-post`), h.env, h.ctx);
  await h.ctx.flush();
  assert.ok(h.r2.has(n3ImgRow.r2_key), "M1/N3: outbox sweep must preserve R2 object when visible row exists");
  assert.equal(
    h.db.prepare("SELECT COUNT(*) AS c FROM comment_image_deletions WHERE r2_key = ?").get(n3ImgRow.r2_key).c,
    0,
    "M1: stale inflight entry for committed row must be cleared"
  );

  // 7d. M1 CRITICAL RACE: Sweeper claims stale 'inflight' -> 'reaping' & deletes R2 BEFORE active upload's D1.batch commits!
  //     Because commit requires reason = 'inflight', late commit MUST publish 0 rows (never a broken visible attachment!).
  h.hooks.beforeNextBatchHook = async () => {
    // Age the newly inserted 'inflight' intent past 120s and run a concurrent GET sweeper BEFORE D1.batch runs!
    const inflightRow = h.db
      .prepare("SELECT r2_key FROM comment_image_deletions WHERE site = 'prod' AND reason = 'inflight' LIMIT 1")
      .get();
    assert.ok(inflightRow, "M1 race test: uploader must have inserted an inflight intent before batch");
    h.db.prepare("UPDATE comment_image_deletions SET created_at = ? WHERE r2_key = ?").run(
      Date.now() - 300_000,
      inflightRow.r2_key
    );
    await worker.fetch(new Request(`${ORIGIN}/api/comments?slug=test-post`), h.env, h.ctx);
    await h.ctx.flush();
    assert.equal(h.r2.has(inflightRow.r2_key), false, "M1 race test: sweeper must have reaped the stale R2 blob");
  };
  const reapedRaceRes = await postAuthorImages(
    { body: "Late upload raced by sweeper" },
    [["reaped.png", "image/png", makePng(2, 2)]]
  );
  assert.equal(reapedRaceRes.status, 500, "M1 race test: late upload after lease reap must fail cleanly instead of publishing broken image");
  assert.equal(
    h.db.prepare("SELECT COUNT(*) AS c FROM comments WHERE body = ?").get("Late upload raced by sweeper").c,
    0,
    "M1 race test: late upload MUST NOT publish a visible comment after its R2 blob was reaped"
  );

  // 7e. M1 OVERLAPPING SWEEP + DELAYED R2 PUT RACE:
  //     Sweeper claims 'inflight' -> 'reaping', runs R2.delete (before PUT writes), and PAUSES in cache.delete().
  //     Meanwhile delayed R2.put completes, D1.batch fails leaseLost, and uploader's transient R2.delete failure
  //     promotes the queue entry to 'rollback' (attempts=1). THEN the paused earlier sweeper finishes cache.delete()
  //     and executes its CAS DELETE -> MUST NOT erase the new 'rollback' entry! Subsequent healthy sweep deletes R2!
  let delayedPutKey = "";
  let releasePausedSweep = null;
  let sweepPausedPromise = null;
  const origCacheDelete = globalThis.caches.default.delete.bind(globalThis.caches.default);

  h.hooks.beforeNextR2PutHook = async (key) => {
    delayedPutKey = key;
    h.db.prepare("UPDATE comment_image_deletions SET created_at = ? WHERE r2_key = ?").run(
      Date.now() - 300_000,
      key
    );
    let signalPaused;
    sweepPausedPromise = new Promise((r) => {
      signalPaused = r;
    });
    const waitRelease = new Promise((r) => {
      releasePausedSweep = r;
    });
    globalThis.caches.default.delete = async (req) => {
      globalThis.caches.default.delete = origCacheDelete;
      signalPaused();
      await waitRelease;
      return origCacheDelete(req);
    };
    // Kick off overlapping sweeper via GET /api/comments without flushing yet; wait until it pauses inside cache.delete()
    await worker.fetch(new Request(`${ORIGIN}/api/comments?slug=test-post`), h.env, h.ctx);
    await sweepPausedPromise;
    // Now delayed R2.put writes bytes while earlier sweeper is still paused right before its outbox DELETE!
    // Simulate transient R2 delete error during uploader's rollback so it writes reason='rollback'!
    h.hooks.failR2Delete = true;
  };
  const delayedPutRes = await postAuthorImages(
    { body: "Delayed R2 PUT overlapped with sweeper" },
    [["delayed.png", "image/png", makePng(2, 2)]]
  );
  assert.equal(delayedPutRes.status, 500, "M1 overlap test: rejected upload must fail cleanly");
  assert.ok(delayedPutKey, "M1 overlap test: captured delayed key");
  assert.equal(
    h.db.prepare("SELECT COUNT(*) AS c FROM comments WHERE body = ?").get("Delayed R2 PUT overlapped with sweeper").c,
    0
  );
  // Now let the earlier paused sweeper finish cache.delete() and run its CAS DELETE!
  releasePausedSweep();
  await h.ctx.flush();
  // CAS delete MUST have preserved the uploader's newer 'rollback' row!
  const rollbackRow = h.db
    .prepare("SELECT reason, attempts FROM comment_image_deletions WHERE r2_key = ?")
    .get(delayedPutKey);
  assert.equal(
    rollbackRow?.reason,
    "rollback",
    "M1 overlap test: earlier sweeper MUST NOT erase the uploader's newer 'rollback' queue entry"
  );
  assert.ok(h.r2.has(delayedPutKey), "M1 overlap test: late-written blob still awaits healthy sweep");
  // Recover R2 and run healthy GET sweep -> late blob MUST be deleted and outbox emptied!
  h.hooks.failR2Delete = false;
  await worker.fetch(new Request(`${ORIGIN}/api/comments?slug=test-post`), h.env, h.ctx);
  await h.ctx.flush();
  assert.equal(h.r2.has(delayedPutKey), false, "M1 overlap test: late PUT blob must be deleted once R2 recovers");
  assert.equal(h.db.prepare("SELECT COUNT(*) AS c FROM comment_image_deletions WHERE r2_key = ?").get(delayedPutKey).c, 0);

  // 8. H2: Real SQLite trigger aborts concurrent reply when parent is deleted mid-flight -> 404 + R2 rollback
  const r2BeforeRace = h.r2.size;
  // Create a fresh parent for race test so we keep parentId alive for cascade delete test
  const raceParentRes = await postAuthorImages({ body: "Parent doomed mid-flight" }, []);
  assert.equal(raceParentRes.status, 201);
  const raceParentId = (await raceParentRes.json()).comment.id;
  h.hooks.deleteParentBeforeNextBatch = raceParentId;
  const raceReplyRes = await postAuthorImages(
    { parentId: raceParentId, body: "Racing reply with image" },
    [["race.png", "image/png", makePng(2, 2)]]
  );
  assert.equal(raceReplyRes.status, 404, "H2: SQLite trigger abort must return 404 parent_not_found");
  assert.equal((await raceReplyRes.json()).error, "parent_not_found");
  assert.equal(h.r2.size, r2BeforeRace, "H2: uploaded R2 blob must be rolled back immediately on trigger abort");

  // 9. H2 + M1: DELETE parent while R2 delete fails -> immediate 404 on parent + reply images, durable outbox drains on GET once R2 recovers
  h.hooks.failR2Delete = true;
  const delRes = await worker.fetch(
    new Request(`${ORIGIN}/api/comments/${parentId}`, {
      method: "DELETE",
      headers: { Origin: ORIGIN, "X-Author-Key": h.env.COMMENT_ADMIN_TOKEN },
    }),
    h.env,
    h.ctx
  );
  await h.ctx.flush();
  assert.equal(delRes.status, 200);
  assert.equal(
    (await worker.fetch(new Request(`${ORIGIN}/api/comments/images/${scrubJson.comment.images[0].id}`), h.env, h.ctx)).status,
    404
  );
  assert.equal(
    (await worker.fetch(new Request(`${ORIGIN}/api/comments/images/${n3ImgRow.id}`), h.env, h.ctx)).status,
    404
  );
  assert.equal(
    h.db.prepare("SELECT COUNT(*) AS c FROM comment_image_deletions").get().c,
    4,
    "M1: failed R2 deletions must persist in durable outbox"
  );

  // Recover R2 -> ordinary GET /api/comments autonomously drains the outbox!
  h.hooks.failR2Delete = false;
  await worker.fetch(new Request(`${ORIGIN}/api/comments?slug=test-post`), h.env, h.ctx);
  await h.ctx.flush();
  assert.equal(h.db.prepare("SELECT COUNT(*) AS c FROM comment_image_deletions").get().c, 0, "M1: GET must drain pending outbox");
  assert.equal(h.r2.has(n3ImgRow.r2_key), false, "M1: drained R2 blob must be deleted");

  h.db.close();
  console.log("[test_comments_worker] ALL CONTRACT TESTS PASSED (N1, N2, N3, H2, H3, M1-M4, M7-M9, M14, L7)");
}

runTests().catch((err) => {
  console.error("[test_comments_worker] FAILED:", err);
  process.exit(1);
});
