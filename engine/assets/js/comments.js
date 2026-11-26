/* Tong's Information — <ti-comments> Native Web Component (Zero Dependencies)
 *
 * Drop-in Light DOM custom element for any standalone HTML page:
 *   <ti-comments slug="your-slug"></ti-comments>
 *   <script type="module" src="/assets/js/comments.js"></script>
 *
 * Features:
 *   - Collapsed button by default: zero network requests until reader clicks to open
 *   - Pass boolean attribute `open` if a page explicitly wants pre-expanded loading
 *   - Zero-login guest comments + optional 1-level replies
 *   - Shared bilingual threads per slug across ZH/EN editions
 *   - Invisible multi-layer anti-abuse:
 *       1) Cloudflare Turnstile (`appearance: "interaction-only"`) pre-warmed on focus
 *       2) Adaptive SHA-256 Proof-of-Work fallback if Turnstile is blocked/unreachable
 *       3) Signed single-use gate token + honeypot + dwell pacing + rate-limit countdown
 *   - Swiss precision ink-sweep & registration-mark micro-animation masking verification
 *   - Smooth editorial "Postmark Seal" drawer ONLY if Turnstile escalates to interactive tap
 *   - Animated Oldest/Newest sort toggle with gliding cobalt indicator & directional thread glide
 */

const COMMENTS_CSS_HREF = "/assets/css/comments.css";
const TURNSTILE_SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
const STORAGE_NAME_KEY = "ti-comments-name";
const STORAGE_URL_KEY = "ti-comments-url";
const MAX_RAW_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_OPTIMIZED_IMAGE_EDGE = 1600;
const MAX_SOURCE_STATIC_EDGE = 10000;
const MAX_SOURCE_STATIC_PIXELS = 50_000_000;
const MAX_PASSTHROUGH_EDGE = 4096;
const MAX_PASSTHROUGH_PIXELS = 16_000_000;
const MAX_ALT_LEN = 160;
const DEFAULT_MAX_IMAGES = 3;
const DEFAULT_MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const ACCEPTED_IMAGE_ACCEPT = "image/jpeg,image/png,image/webp,image/gif";

const reducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
const encoder = new TextEncoder();

let instanceSeq = 0;
let attachmentSeq = 0;
let turnstileLoadPromise = null;
let cachedDisplaySupport;

const COPY = {
  zh: {
    heading: "读者来信",
    toggleHint: "点击加载评论与讨论",
    expandLabel: "展开",
    collapseLabel: "收起",
    countZero: "0 则",
    countOne: "1 则",
    countMany: (n) => `${n} 则`,
    threadSummary: (total, threads) => (total > threads ? `${total} 则来信 · ${threads} 组讨论` : `${total} 则来信`),
    sortOldest: "最早",
    sortNewest: "最新",
    loading: "正在翻阅来信…",
    empty: "这一页还留着白。留下第一则旁注吧，无需登录。",
    loadError: "暂时无法读取评论，稍后重试。",
    retry: "重试",
    bodyLabel: "写一则旁注",
    bodyPlaceholder: "写下你的想法、质疑或补充…",
    bodyError: "请至少写下 2 个字再投递。",
    bodyOrImageError: "请至少写下 2 个字，或附带图片再投递。",
    nameLabel: "称呼 · 选填",
    namePlaceholder: "匿名读者",
    urlLabel: "主页 · 选填",
    urlPlaceholder: "https://",
    urlError: "请输入以 https:// 或 http:// 开头的有效网址。",
    submit: "落印投递",
    submitSub: "投递中",
    anonymous: "匿名读者",
    authorBadge: "作者",
    reply: "回复",
    replyingTo: (name) => `正在回复 ${name}`,
    cancelReply: "取消",
    justNow: "刚刚",
    statusReady: "无需登录 · Ctrl/⌘ + Enter 投递",
    statusReadyImages: "无需登录 · 支持粘贴或拖入图片 · Ctrl/⌘ + Enter",
    statusReadyAuthor: "作者模式 · 免核验直发 · Ctrl/⌘ + Enter",
    statusReadyAuthorImages: "作者模式 · 支持粘贴或拖入图片 · Ctrl/⌘ + Enter",
    authorModeBanner: (name) => (name ? `作者模式 · 将以「${name}」身份发布` : "作者模式 · 将附带作者认证标识"),
    authorSignOut: "退出",
    authorSignInDone: (name) => (name ? `已验证作者身份（${name}）。` : "已验证作者身份。"),
    authorSignOutDone: "已退出作者模式。",
    authDialogTitle: "作者身份验证",
    authDialogDesc: "输入管理员密码，以作者权限发表评论或管理当前讨论。",
    authDialogActiveDesc: (name) =>
      name
        ? `当前已处于作者模式（${name}）。发言将自动附带「作者」标识，并可管理留言。`
        : "当前已处于作者模式。发言将自动附带「作者」标识，并可管理留言。",
    authPasswordLabel: "管理员密码",
    authPasswordPlaceholder: "请输入管理员密码",
    authShowPassword: "显示密码",
    authHidePassword: "隐藏密码",
    authShowWarning: "注意：这将在屏幕上明文显示密码。",
    authCancel: "取消",
    authSubmit: "验证身份",
    authSubmitting: "验证中…",
    authSignOutBtn: "退出作者模式",
    authErrEmpty: "请输入管理员密码。",
    authErrInvalid: "密码不正确，请检查后重试。",
    authErrRateLimited: "尝试过于频繁，请稍后再试。",
    authErrUnconfigured: "当前站点尚未配置作者鉴权密钥。",
    authErrNetwork: "网络暂时中断，无法完成验证。",
    errAuthorExpired: "作者登录状态已过期，请重新输入密码验证。",
    delete: "删除",
    deleteConfirm: "确认删除",
    deleting: "删除中…",
    deleteDone: "已删除该条来信。",
    deleteFailed: "删除失败，请稍后重试。",
    statusInking: "校准墨迹…",
    statusVerifying: "核验来信印记…",
    statusSealing: "静默签章中…",
    statusInteractive: "需要一次轻触落印…",
    statusOptimizing: "正在处理图片…",
    statusUploading: "正在投递图文…",
    statusStamped: "已落印归档 ✓",
    statusCooldown: (s) => `投递稍密，请 ${s}s 后再试`,
    interactiveCopy: "当前网络环境需要一次人工落印，轻触下方即可自动完成投递。",
    attachBtn: "附图",
    attachBtnCount: (n, max) => `附图 ${n}/${max}`,
    attachAria: (n, max) => `添加图片（已选 ${n} / ${max} 张）`,
    dropHint: "松开以附带图片",
    removeImage: (idx) => `移除第 ${idx} 张图片`,
    previewImage: (idx) => `预览第 ${idx} 张待发送图片`,
    altBtn: "ALT",
    altBtnFilled: "ALT ✓",
    altToggleAria: (idx) => `编辑第 ${idx} 张图片的说明（选填）`,
    altTag: (idx, total) => (total > 1 ? `图 ${idx} 说明` : "图片说明"),
    altDone: "完成",
    altPlaceholder: "图片说明 · 选填",
    altAria: (idx) => `第 ${idx} 张图片的说明（选填）`,
    viewImage: (idx, total) => (total > 1 ? `查看大图（${idx}/${total}）` : "查看大图"),
    imageAltFallback: (idx) => `读者附图 ${idx}`,
    imageAdded: (n) => `已添加 ${n} 张图片。`,
    imageRemoved: "已移除图片。",
    errImageType: "仅支持 JPG、PNG、WebP、GIF 格式图片。",
    errImageTooLarge: "单张图片处理后不能超过 2 MB。",
    errImageRawTooLarge: "原始图片文件不能超过 12 MB。",
    errImageDimensions: "图片尺寸或动画帧数超出限制（单边最大 4096px）。",
    errImageSourceDimensions: "原始图片像素尺寸过大，请缩小后再试。",
    errImageCount: (max) => `单条来信最多附带 ${max} 张图片。`,
    errImageProcess: "图片读取失败，请更换一张重试。",
    errImagesUnconfigured: "当前站点尚未启用图片附件。",
    errPayloadTooLarge: "附带图片总大小超出限制，请减少数量后重试。",
    lightboxTitle: "图片预览",
    lightboxClose: "关闭",
    lightboxPrev: "上一张",
    lightboxNext: "下一张",
    lightboxOpenOriginal: "原图 ↗",
    errDuplicate: "刚刚已经收到过相同内容的来信。",
    errTooManyLinks: "单条留言包含的链接过多，请精简后再试。",
    errTooFast: "落笔太快，稍停片刻即可投递。",
    errRateLimited: (s) => `投递过于频繁，请 ${s} 秒后再试。`,
    errVerifyFailed: "核验未通过，已刷新印记，请再试一次。",
    errNetwork: "网络暂时中断，你的内容仍保留在输入框中。",
    otherLangTag: "EN",
  },
  en: {
    heading: "Reader Notes",
    toggleHint: "Load discussion & leave a note",
    expandLabel: "Open",
    collapseLabel: "Hide",
    countZero: "0 notes",
    countOne: "1 note",
    countMany: (n) => `${n} notes`,
    threadSummary: (total, threads) => (total > threads ? `${total} notes · ${threads} threads` : `${total} notes`),
    sortOldest: "Oldest",
    sortNewest: "Newest",
    loading: "Reading margin notes…",
    empty: "The margin is still open. Leave the first note — no login required.",
    loadError: "Could not load notes right now.",
    retry: "Retry",
    bodyLabel: "Leave a note",
    bodyPlaceholder: "Share a thought, critique, or footnote…",
    bodyError: "Please write at least 2 characters before posting.",
    bodyOrImageError: "Please write at least 2 characters or attach an image.",
    nameLabel: "Name · optional",
    namePlaceholder: "Anonymous",
    urlLabel: "Website · optional",
    urlPlaceholder: "https://",
    urlError: "Enter a valid URL starting with https:// or http://.",
    submit: "Post Note",
    submitSub: "Stamping",
    anonymous: "Anonymous",
    authorBadge: "Author",
    reply: "Reply",
    replyingTo: (name) => `Replying to ${name}`,
    cancelReply: "Cancel",
    justNow: "just now",
    statusReady: "No login · Ctrl/⌘ + Enter to post",
    statusReadyImages: "No login · Paste or drop images · Ctrl/⌘ + Enter",
    statusReadyAuthor: "Author Mode · Instant post · Ctrl/⌘ + Enter",
    statusReadyAuthorImages: "Author Mode · Paste or drop images · Ctrl/⌘ + Enter",
    authorModeBanner: (name) => (name ? `Author Mode · Posting as ${name}` : "Author Mode · Verified author badge enabled"),
    authorSignOut: "Sign out",
    authorSignInDone: (name) => (name ? `Signed in as author (${name}).` : "Author Mode enabled."),
    authorSignOutDone: "Signed out of Author Mode.",
    authDialogTitle: "Author Verification",
    authDialogDesc: "Enter the admin password to post with the verified Author badge and moderate notes.",
    authDialogActiveDesc: (name) =>
      name
        ? `Author Mode is active (${name}). Your notes will carry the verified Author badge.`
        : "Author Mode is active. Your notes will carry the verified Author badge.",
    authPasswordLabel: "Admin password",
    authPasswordPlaceholder: "Enter admin password",
    authShowPassword: "Show password",
    authHidePassword: "Hide password",
    authShowWarning: "Warning: this will display your password on the screen.",
    authCancel: "Cancel",
    authSubmit: "Verify",
    authSubmitting: "Verifying…",
    authSignOutBtn: "Sign out",
    authErrEmpty: "Please enter the admin password.",
    authErrInvalid: "Incorrect password. Please try again.",
    authErrRateLimited: "Too many attempts. Please wait a moment and try again.",
    authErrUnconfigured: "Author authentication is not configured for this site.",
    authErrNetwork: "Network error — could not verify password.",
    errAuthorExpired: "Your author session expired. Please verify again.",
    delete: "Delete",
    deleteConfirm: "Confirm delete",
    deleting: "Deleting…",
    deleteDone: "Note deleted.",
    deleteFailed: "Could not delete note right now.",
    statusInking: "Inking…",
    statusVerifying: "Verifying postmark…",
    statusSealing: "Sealing postmark…",
    statusInteractive: "Awaiting quick postmark tap…",
    statusOptimizing: "Optimizing image…",
    statusUploading: "Uploading note & images…",
    statusStamped: "Stamped ✓",
    statusCooldown: (s) => `Cooling down · ${s}s`,
    interactiveCopy: "This network asks for a quick human postmark — tap once below and your note will send automatically.",
    attachBtn: "Image",
    attachBtnCount: (n, max) => `Image ${n}/${max}`,
    attachAria: (n, max) => `Attach images (${n} of ${max} selected)`,
    dropHint: "Drop images to attach",
    removeImage: (idx) => `Remove image ${idx}`,
    previewImage: (idx) => `Preview staged image ${idx}`,
    altBtn: "ALT",
    altBtnFilled: "ALT ✓",
    altToggleAria: (idx) => `Edit optional alt text for image ${idx}`,
    altTag: (idx, total) => (total > 1 ? `Image ${idx} alt` : "Alt text"),
    altDone: "Done",
    altPlaceholder: "Alt text · optional",
    altAria: (idx) => `Optional alt text for image ${idx}`,
    viewImage: (idx, total) => (total > 1 ? `View full image (${idx} of ${total})` : "View full image"),
    imageAltFallback: (idx) => `Reader attachment ${idx}`,
    imageAdded: (n) => (n === 1 ? "Attached 1 image." : `Attached ${n} images.`),
    imageRemoved: "Image removed.",
    errImageType: "Only JPG, PNG, WebP, and GIF images are supported.",
    errImageTooLarge: "Each image must be under 2 MB after optimization.",
    errImageRawTooLarge: "Source image file must be under 12 MB.",
    errImageDimensions: "Image dimensions or animation frames exceed the 4096px limit.",
    errImageSourceDimensions: "Source image dimensions are too large. Please resize and try again.",
    errImageCount: (max) => `Up to ${max} images per note.`,
    errImageProcess: "Could not read that image. Please try another file.",
    errImagesUnconfigured: "Image attachments are currently unavailable.",
    errPayloadTooLarge: "Total attachment size exceeds the limit. Try fewer or smaller images.",
    lightboxTitle: "Image preview",
    lightboxClose: "Close",
    lightboxPrev: "Previous",
    lightboxNext: "Next",
    lightboxOpenOriginal: "Original ↗",
    errDuplicate: "An identical note was already posted just now.",
    errTooManyLinks: "Please keep links to a minimum in a single note.",
    errTooFast: "Pause a brief moment before posting.",
    errRateLimited: (s) => `Too many notes in a short window — please wait ${s}s.`,
    errVerifyFailed: "Verification expired; refreshed postmark — please try once more.",
    errNetwork: "Network hiccup — your draft is safely preserved.",
    otherLangTag: "中文",
  },
};

const MAX_CLIENT_ANIM_FRAMES = 120;
const MAX_CLIENT_ANIM_TOTAL_PIXELS = 64_000_000;

function supportsTopLayerExit() {
  return Boolean(window.CSS?.supports?.("overlay", "auto") && canTransitionDisplay());
}

function scrollIntoViewAsync(element, options) {
  if (!element || typeof element.scrollIntoView !== "function") {
    return Promise.resolve();
  }
  const result = element.scrollIntoView(options);
  if (result instanceof Promise) {
    return result;
  }
  if (options?.behavior === "auto" || options?.behavior === "instant") {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let idleTimer = 0;
    let maxTimer = 0;
    const finish = () => {
      window.clearTimeout(idleTimer);
      window.clearTimeout(maxTimer);
      window.removeEventListener("scrollend", finish);
      window.removeEventListener("scroll", onScroll);
      resolve();
    };
    const onScroll = () => {
      window.clearTimeout(idleTimer);
      idleTimer = window.setTimeout(finish, 100);
    };
    window.addEventListener("scrollend", finish, { once: true });
    window.addEventListener("scroll", onScroll, { passive: true });
    idleTimer = window.setTimeout(finish, 100);
    maxTimer = window.setTimeout(finish, 1200);
  });
}

function sniffClientImageBytes(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 12) return null;
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return { mime: "image/png", animated: false };
  }
  if (
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return { mime: "image/gif", animated: true };
  }
  if (
    bytes.byteLength >= 21 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    const isVp8x =
      bytes[12] === 0x56 &&
      bytes[13] === 0x50 &&
      bytes[14] === 0x38 &&
      bytes[15] === 0x58;
    const isAnimated = isVp8x && (bytes[20] & 0x02) !== 0;
    return { mime: "image/webp", animated: isAnimated };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mime: "image/jpeg", animated: false };
  }
  return null;
}

function readClientU16BE(bytes, off) {
  return ((bytes[off] << 8) | bytes[off + 1]) >>> 0;
}

function readClientU16LE(bytes, off) {
  return (bytes[off] | (bytes[off + 1] << 8)) >>> 0;
}

function readClientU32BE(bytes, off) {
  return (
    ((bytes[off] << 24) | (bytes[off + 1] << 16) | (bytes[off + 2] << 8) | bytes[off + 3]) >>> 0
  );
}

function readClientU32LE(bytes, off) {
  return (
    (bytes[off] | (bytes[off + 1] << 8) | (bytes[off + 2] << 16) | (bytes[off + 3] << 24)) >>> 0
  );
}

function writeClientU32LE(bytes, off, value) {
  bytes[off] = value & 0xff;
  bytes[off + 1] = (value >>> 8) & 0xff;
  bytes[off + 2] = (value >>> 16) & 0xff;
  bytes[off + 3] = (value >>> 24) & 0xff;
}

function concatClientChunks(chunks) {
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

async function readClientImageDimensions(file, mime) {
  if (mime === "image/jpeg") {
    // Bounded header marker walk jumping directly past arbitrarily large EXIF/ICC/XMP APP segments
    let filePos = 2;
    for (let hop = 0; hop < 256 && filePos + 4 <= file.size; hop += 1) {
      const sliceEnd = Math.min(file.size, filePos + 64 * 1024);
      const buf = new Uint8Array(await file.slice(filePos, sliceEnd).arrayBuffer());
      let pos = 0;
      let jumped = false;
      while (pos + 1 < buf.byteLength) {
        if (buf[pos] !== 0xff) return null;
        while (pos < buf.byteLength && buf[pos] === 0xff) pos += 1;
        if (pos >= buf.byteLength) {
          filePos += pos - 1;
          jumped = true;
          break;
        }
        const marker = buf[pos];
        pos += 1;
        if (marker === 0xd9 || marker === 0xda) return null;
        if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
        if (pos + 2 > buf.byteLength) {
          filePos += pos - 2;
          jumped = true;
          break;
        }
        const segLen = readClientU16BE(buf, pos);
        if (segLen < 2) return null;
        const isSof =
          (marker >= 0xc0 && marker <= 0xc3) ||
          (marker >= 0xc5 && marker <= 0xc7) ||
          (marker >= 0xc9 && marker <= 0xcb) ||
          (marker >= 0xcd && marker <= 0xcf);
        if (isSof) {
          if (segLen < 7) return null;
          if (pos + 7 > buf.byteLength) {
            const sofBuf = new Uint8Array(await file.slice(filePos + pos, filePos + pos + 7).arrayBuffer());
            if (sofBuf.byteLength < 7) return null;
            return { height: readClientU16BE(sofBuf, 3), width: readClientU16BE(sofBuf, 5) };
          }
          return { height: readClientU16BE(buf, pos + 3), width: readClientU16BE(buf, pos + 5) };
        }
        if (pos + segLen > buf.byteLength) {
          filePos += pos + segLen;
          jumped = true;
          break;
        }
        pos += segLen;
      }
      if (!jumped) {
        if (pos === 0 || filePos + pos >= file.size) return null;
        filePos += pos;
      }
    }
    return null;
  }

  const probeSize = Math.min(file.size, 64);
  const bytes = new Uint8Array(await file.slice(0, probeSize).arrayBuffer());
  if (mime === "image/png") {
    if (
      bytes.byteLength >= 24 &&
      bytes[12] === 0x49 &&
      bytes[13] === 0x48 &&
      bytes[14] === 0x44 &&
      bytes[15] === 0x52
    ) {
      return { width: readClientU32BE(bytes, 16), height: readClientU32BE(bytes, 20) };
    }
    return null;
  }
  if (mime === "image/gif") {
    if (bytes.byteLength >= 10) {
      return { width: readClientU16LE(bytes, 6), height: readClientU16LE(bytes, 8) };
    }
    return null;
  }
  if (mime === "image/webp") {
    if (bytes.byteLength < 30) return null;
    const tag = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
    if (tag === "VP8X") {
      const width = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16));
      const height = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16));
      return { width, height };
    }
    if (tag === "VP8L" && bytes[20] === 0x2f) {
      const bits = readClientU32LE(bytes, 21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    if (tag === "VP8 " && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
      return {
        width: readClientU16LE(bytes, 26) & 0x3fff,
        height: readClientU16LE(bytes, 28) & 0x3fff,
      };
    }
    return null;
  }
  return null;
}

function scrubClientGif(bytes) {
  if (bytes.byteLength < 14) return null;
  const width = readClientU16LE(bytes, 6);
  const height = readClientU16LE(bytes, 8);
  if (width <= 0 || height <= 0) return null;
  if (
    width > MAX_PASSTHROUGH_EDGE ||
    height > MAX_PASSTHROUGH_EDGE ||
    width * height > MAX_PASSTHROUGH_PIXELS
  ) {
    throw Object.assign(new Error("errImageDimensions"), { code: "errImageDimensions" });
  }
  const packed = bytes[10];
  let pos = 13;
  if (packed & 0x80) {
    const gctSize = 3 * (1 << ((packed & 0x07) + 1));
    if (pos + gctSize > bytes.byteLength) return null;
    pos += gctSize;
  }
  const kept = [bytes.subarray(0, pos)];
  let frames = 0;
  let sawTrailer = false;

  const skipSubBlocks = (start) => {
    let p = start;
    while (p < bytes.byteLength) {
      const sz = bytes[p];
      p += 1;
      if (sz === 0) return p;
      if (p + sz > bytes.byteLength) return -1;
      p += sz;
    }
    return -1;
  };

  while (pos < bytes.byteLength) {
    const intro = bytes[pos];
    if (intro === 0x3b) {
      kept.push(bytes.subarray(pos, pos + 1));
      sawTrailer = true;
      break;
    }
    if (intro === 0x2c) {
      if (pos + 10 > bytes.byteLength) return null;
      const start = pos;
      const fw = readClientU16LE(bytes, pos + 5);
      const fh = readClientU16LE(bytes, pos + 7);
      if (fw <= 0 || fh <= 0 || fw > MAX_PASSTHROUGH_EDGE || fh > MAX_PASSTHROUGH_EDGE) {
        throw Object.assign(new Error("errImageDimensions"), { code: "errImageDimensions" });
      }
      const lctFlag = bytes[pos + 9];
      pos += 10;
      if (lctFlag & 0x80) {
        const lctSize = 3 * (1 << ((lctFlag & 0x07) + 1));
        if (pos + lctSize > bytes.byteLength) return null;
        pos += lctSize;
      }
      if (pos >= bytes.byteLength) return null;
      pos += 1; // LZW min code size
      const nextPos = skipSubBlocks(pos);
      if (nextPos < 0) return null;
      pos = nextPos;
      frames += 1;
      if (
        frames > MAX_CLIENT_ANIM_FRAMES ||
        width * height * frames > MAX_CLIENT_ANIM_TOTAL_PIXELS
      ) {
        throw Object.assign(new Error("errImageDimensions"), { code: "errImageDimensions" });
      }
      kept.push(bytes.subarray(start, pos));
      continue;
    }
    if (intro === 0x21) {
      if (pos + 2 > bytes.byteLength) return null;
      const start = pos;
      const label = bytes[pos + 1];
      if (label === 0xf9) {
        if (pos + 8 > bytes.byteLength || bytes[pos + 2] !== 4 || bytes[pos + 7] !== 0) return null;
        pos += 8;
        kept.push(bytes.subarray(start, pos));
      } else if (label === 0xff) {
        if (pos + 3 > bytes.byteLength) return null;
        const appLen = bytes[pos + 2];
        if (pos + 3 + appLen > bytes.byteLength) return null;
        const appId = String.fromCharCode(...bytes.subarray(pos + 3, pos + 3 + appLen));
        const nextPos = skipSubBlocks(pos + 3 + appLen);
        if (nextPos < 0) return null;
        pos = nextPos;
        if (appId === "NETSCAPE2.0" || appId === "ANIMEXTS1.0") {
          kept.push(bytes.subarray(start, pos));
        }
      } else {
        const nextPos = skipSubBlocks(pos + 2);
        if (nextPos < 0) return null;
        pos = nextPos;
        if (label !== 0xfe && label !== 0x01) {
          kept.push(bytes.subarray(start, pos));
        }
      }
      continue;
    }
    return null;
  }

  if (!sawTrailer || frames < 1) return null;
  return { bytes: concatClientChunks(kept), width, height };
}

function scrubClientWebp(bytes) {
  if (bytes.byteLength < 30) return null;
  const riffSize = readClientU32LE(bytes, 4);
  if (riffSize + 8 > bytes.byteLength || riffSize < 12) return null;
  const riffEnd = riffSize + 8;

  let width = 0;
  let height = 0;
  let frames = 0;
  let hasImagePayload = false;
  const keptChunks = [];
  let vp8xCopy = null;

  let pos = 12;
  while (pos + 8 <= riffEnd) {
    const tag = String.fromCharCode(bytes[pos], bytes[pos + 1], bytes[pos + 2], bytes[pos + 3]);
    const chunkSize = readClientU32LE(bytes, pos + 4);
    const paddedSize = chunkSize + (chunkSize & 1);
    const nextPos = pos + 8 + paddedSize;
    if (nextPos > riffEnd) return null;

    if (tag === "EXIF" || tag === "XMP ") {
      pos = nextPos;
      continue;
    }
    if (tag === "VP8X") {
      if (chunkSize !== 10) return null;
      width = 1 + (bytes[pos + 12] | (bytes[pos + 13] << 8) | (bytes[pos + 14] << 16));
      height = 1 + (bytes[pos + 15] | (bytes[pos + 16] << 8) | (bytes[pos + 17] << 16));
      vp8xCopy = bytes.slice(pos, nextPos);
      vp8xCopy[8] &= ~0x0c; // clear EXIF (0x08) and XMP (0x04) flags
      keptChunks.push(vp8xCopy);
    } else {
      if (tag === "ANMF") {
        frames += 1;
        hasImagePayload = true;
      } else if (tag === "VP8 " || tag === "VP8L") {
        hasImagePayload = true;
      }
      keptChunks.push(bytes.subarray(pos, nextPos));
    }
    pos = nextPos;
  }

  if (pos !== riffEnd || !hasImagePayload || width <= 0 || height <= 0) return null;
  if (
    width > MAX_PASSTHROUGH_EDGE ||
    height > MAX_PASSTHROUGH_EDGE ||
    width * height > MAX_PASSTHROUGH_PIXELS ||
    frames > MAX_CLIENT_ANIM_FRAMES ||
    width * height * Math.max(1, frames) > MAX_CLIENT_ANIM_TOTAL_PIXELS
  ) {
    throw Object.assign(new Error("errImageDimensions"), { code: "errImageDimensions" });
  }

  let bodySize = 4; // "WEBP"
  for (const c of keptChunks) bodySize += c.byteLength;
  const header = new Uint8Array(12);
  header.set([0x52, 0x49, 0x46, 0x46], 0);
  writeClientU32LE(header, 4, bodySize);
  header.set([0x57, 0x45, 0x42, 0x50], 8);
  return { bytes: concatClientChunks([header, ...keptChunks]), width, height };
}

function buildSafeImageFilename(origName, mimeType) {
  const extMap = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
  };
  const ext = extMap[mimeType] || "img";
  const stem = String(origName || "image")
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-z0-9_-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || "image";
  return `${stem}.${ext}`;
}

function canvasToBlob(canvas, mimeType, quality) {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((blob) => resolve(blob || null), mimeType, quality);
    } catch {
      resolve(null);
    }
  });
}

async function decodeImageSource(blob) {
  if (typeof window.createImageBitmap === "function") {
    try {
      const bitmap = await window.createImageBitmap(blob);
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        cleanup: () => bitmap.close?.(),
      };
    } catch {
      /* fallback to HTMLImageElement */
    }
  }

  const tmpUrl = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = "async";
    await new Promise((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("img_decode_failed"));
      img.src = tmpUrl;
    });
    return {
      source: img,
      width: img.naturalWidth || img.width,
      height: img.naturalHeight || img.height,
      cleanup: () => URL.revokeObjectURL(tmpUrl),
    };
  } catch (err) {
    URL.revokeObjectURL(tmpUrl);
    throw err;
  }
}

async function prepareImageAttachment(file, maxBytes = DEFAULT_MAX_IMAGE_BYTES, options = {}) {
  if (!file || typeof file.size !== "number" || file.size <= 0) {
    throw Object.assign(new Error("errImageProcess"), { code: "errImageProcess" });
  }
  if (file.size > MAX_RAW_IMAGE_BYTES) {
    throw Object.assign(new Error("errImageRawTooLarge"), { code: "errImageRawTooLarge" });
  }

  let headerBytes;
  try {
    headerBytes = new Uint8Array(await file.slice(0, 64).arrayBuffer());
  } catch {
    throw Object.assign(new Error("errImageProcess"), { code: "errImageProcess" });
  }
  const sniffed = sniffClientImageBytes(headerBytes);
  if (!sniffed) {
    throw Object.assign(new Error("errImageType"), { code: "errImageType" });
  }

  // Binary header dimension preflight BEFORE full decode (prevents memory bombs)
  let headerDims = null;
  try {
    headerDims = await readClientImageDimensions(file, sniffed.mime);
  } catch {
    headerDims = null;
  }

  // Keep animated GIF / animated WebP intact while scrubbing EXIF/XMP/Comment metadata
  if (sniffed.animated) {
    if (
      headerDims &&
      (headerDims.width > MAX_PASSTHROUGH_EDGE ||
        headerDims.height > MAX_PASSTHROUGH_EDGE ||
        headerDims.width * headerDims.height > MAX_PASSTHROUGH_PIXELS)
    ) {
      throw Object.assign(new Error("errImageDimensions"), { code: "errImageDimensions" });
    }
    let rawBytes;
    try {
      rawBytes = new Uint8Array(await file.arrayBuffer());
    } catch {
      throw Object.assign(new Error("errImageProcess"), { code: "errImageProcess" });
    }
    const scrubbed =
      sniffed.mime === "image/gif" ? scrubClientGif(rawBytes) : scrubClientWebp(rawBytes);
    if (!scrubbed) {
      throw Object.assign(new Error("errImageProcess"), { code: "errImageProcess" });
    }
    if (scrubbed.bytes.byteLength > maxBytes) {
      throw Object.assign(new Error("errImageTooLarge"), { code: "errImageTooLarge" });
    }
    const cleanBlob = new Blob([scrubbed.bytes], { type: sniffed.mime });
    let width = scrubbed.width;
    let height = scrubbed.height;
    try {
      const decoded = await decodeImageSource(cleanBlob);
      width = decoded.width || width;
      height = decoded.height || height;
      decoded.cleanup();
    } catch {
      throw Object.assign(new Error("errImageProcess"), { code: "errImageProcess" });
    }
    if (
      width > MAX_PASSTHROUGH_EDGE ||
      height > MAX_PASSTHROUGH_EDGE ||
      width * height > MAX_PASSTHROUGH_PIXELS
    ) {
      throw Object.assign(new Error("errImageDimensions"), { code: "errImageDimensions" });
    }
    return {
      uid: `att-${++attachmentSeq}`,
      blob: cleanBlob,
      previewUrl: URL.createObjectURL(cleanBlob),
      mimeType: sniffed.mime,
      width,
      height,
      sizeBytes: cleanBlob.size,
      filename: buildSafeImageFilename(file.name, sniffed.mime),
      alt: "",
    };
  }

  if (!headerDims || !headerDims.width || !headerDims.height) {
    throw Object.assign(new Error("errImageProcess"), { code: "errImageProcess" });
  }
  if (
    headerDims.width > MAX_SOURCE_STATIC_EDGE ||
    headerDims.height > MAX_SOURCE_STATIC_EDGE ||
    headerDims.width * headerDims.height > MAX_SOURCE_STATIC_PIXELS
  ) {
    throw Object.assign(new Error("errImageSourceDimensions"), { code: "errImageSourceDimensions" });
  }

  // Decode static JPEG/PNG/WebP and redraw through Canvas (strips EXIF/GPS & bakes orientation upright)
  let decoded;
  try {
    decoded = await decodeImageSource(file);
  } catch {
    throw Object.assign(new Error("errImageProcess"), { code: "errImageProcess" });
  }

  try {
    const natW = decoded.width;
    const natH = decoded.height;
    if (!natW || !natH) {
      throw Object.assign(new Error("errImageProcess"), { code: "errImageProcess" });
    }
    if (
      natW > MAX_SOURCE_STATIC_EDGE ||
      natH > MAX_SOURCE_STATIC_EDGE ||
      natW * natH > MAX_SOURCE_STATIC_PIXELS
    ) {
      throw Object.assign(new Error("errImageSourceDimensions"), { code: "errImageSourceDimensions" });
    }

    const encodeAt = async (maxEdge, targetMime, quality) => {
      const scale = Math.min(1, maxEdge / Math.max(natW, natH));
      const w = Math.max(1, Math.round(natW * scale));
      const h = Math.max(1, Math.round(natH * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      if (targetMime === "image/jpeg") {
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, w, h);
      }
      ctx.drawImage(decoded.source, 0, 0, w, h);
      const out = await canvasToBlob(canvas, targetMime, quality);
      if (!out || out.type !== targetMime) return null;
      return { blob: out, width: w, height: h };
    };

    const edgeLimit =
      Number.isFinite(options.maxEdge) && options.maxEdge > 0
        ? Math.max(320, Math.min(MAX_OPTIMIZED_IMAGE_EDGE, Math.round(options.maxEdge)))
        : MAX_OPTIMIZED_IMAGE_EDGE;
    const targetBytes =
      Number.isFinite(options.targetBytes) && options.targetBytes > 0
        ? Math.min(maxBytes, Math.round(options.targetBytes))
        : maxBytes;
    const customQ =
      Number.isFinite(options.quality) && options.quality > 0
        ? Math.max(0.5, Math.min(0.95, options.quality))
        : null;
    const fallbackEdge = Math.min(edgeLimit, 1200);
    const compactEdge = Math.min(edgeLimit, 960);

    const attempts =
      sniffed.mime === "image/png"
        ? [
            [edgeLimit, "image/webp", customQ ?? 0.9],
            [edgeLimit, "image/png", undefined],
            [edgeLimit, "image/webp", customQ ? Math.max(0.55, customQ - 0.1) : 0.78],
            [customQ ? compactEdge : fallbackEdge, "image/webp", customQ ? Math.max(0.5, customQ - 0.14) : 0.74],
            [edgeLimit, "image/jpeg", customQ ?? 0.84],
            [customQ ? compactEdge : fallbackEdge, "image/jpeg", 0.72],
          ]
        : [
            [edgeLimit, "image/webp", customQ ?? 0.84],
            [edgeLimit, "image/jpeg", customQ ?? 0.84],
            [edgeLimit, "image/webp", customQ ? Math.max(0.55, customQ - 0.12) : 0.72],
            [customQ ? compactEdge : fallbackEdge, "image/webp", 0.68],
            [customQ ? compactEdge : fallbackEdge, "image/jpeg", 0.72],
          ];

    let chosen = null;
    let smallestWithinMax = null;
    for (const [edge, mime, qual] of attempts) {
      const candidate = await encodeAt(edge, mime, qual);
      if (!candidate || candidate.blob.size <= 0) continue;
      if (candidate.blob.size <= targetBytes) {
        chosen = candidate;
        break;
      }
      if (
        candidate.blob.size <= maxBytes &&
        (!smallestWithinMax || candidate.blob.size < smallestWithinMax.blob.size)
      ) {
        smallestWithinMax = candidate;
      }
    }
    chosen = chosen || smallestWithinMax;

    if (!chosen) {
      throw Object.assign(new Error("errImageTooLarge"), { code: "errImageTooLarge" });
    }

    return {
      uid: `att-${++attachmentSeq}`,
      blob: chosen.blob,
      previewUrl: URL.createObjectURL(chosen.blob),
      mimeType: chosen.blob.type,
      width: chosen.width,
      height: chosen.height,
      sizeBytes: chosen.blob.size,
      filename: buildSafeImageFilename(file.name, chosen.blob.type),
      alt: "",
    };
  } finally {
    decoded.cleanup();
  }
}

function normalizeSafeAttachmentUrl(raw) {
  const str = String(raw || "").trim();
  if (!str || !str.startsWith("/") || str.startsWith("//") || str.includes("\\")) {
    return "";
  }
  try {
    const parsed = new URL(str, window.location.origin);
    if (
      parsed.origin !== window.location.origin ||
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      !parsed.pathname.startsWith("/") ||
      parsed.pathname.startsWith("//")
    ) {
      return "";
    }
    return parsed.href;
  } catch {
    return "";
  }
}

function canTransitionDisplay() {
  if (cachedDisplaySupport !== undefined) return cachedDisplaySupport;
  if (!window.CSS?.supports?.("transition-behavior", "allow-discrete") || !document.body) {
    return false;
  }
  const probe = document.createElement("div");
  probe.style.cssText = "transition: display 1s allow-discrete !important; display: block;";
  document.body.appendChild(probe);
  getComputedStyle(probe).display;
  probe.style.display = "none";
  cachedDisplaySupport = getComputedStyle(probe).display === "block";
  probe.remove();
  return cachedDisplaySupport;
}

function ensureCoreStylesheet() {
  if (document.querySelector('style[data-ti-comments-core="true"]')) return;
  const style = document.createElement("style");
  style.dataset.tiCommentsCore = "true";
  style.textContent =
    'ti-comments :is([data-part="lightbox"],[data-part="auth-dialog"]):modal{overscroll-behavior:contain;}' +
    'ti-comments :is([data-part="lightbox"],[data-part="auth-dialog"])::backdrop{overflow:hidden;overscroll-behavior:contain;}' +
    'ti-comments [data-part="sr-only"]{position:absolute;inline-size:1px;block-size:1px;margin:-1px;padding:0;overflow:hidden;clip-path:inset(50%);border:0;white-space:nowrap;}';
  document.head.appendChild(style);
}

function ensureDefaultStylesheet() {
  const existing = document.querySelector('link[rel="stylesheet"][href*="comments.css"]');
  if (existing) return existing;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = COMMENTS_CSS_HREF;
  document.head.appendChild(link);
  return link;
}

function getEffectiveColorScheme(host) {
  const attr = host.getAttribute("data-theme");
  if (attr === "light" || attr === "dark") return attr;
  const metaVal = document.querySelector('meta[name="color-scheme"]')?.content?.trim();
  if (metaVal === "light" || metaVal === "dark") return metaVal;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function loadTurnstileApi(timeoutMs = 4500) {
  if (window.turnstile && typeof window.turnstile.render === "function") {
    return Promise.resolve(window.turnstile);
  }
  if (turnstileLoadPromise) return turnstileLoadPromise;

  turnstileLoadPromise = new Promise((resolve, reject) => {
    let settled = false;
    const finish = (ok, val) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      if (ok) resolve(val);
      else {
        turnstileLoadPromise = null;
        reject(val);
      }
    };

    const timer = window.setTimeout(() => finish(false, new Error("turnstile_timeout")), timeoutMs);

    const existing = document.querySelector('script[data-ti-turnstile="true"]');
    if (existing) {
      existing.addEventListener("load", () => {
        if (window.turnstile) finish(true, window.turnstile);
        else finish(false, new Error("turnstile_missing"));
      }, { once: true });
      existing.addEventListener("error", () => finish(false, new Error("turnstile_blocked")), { once: true });
      return;
    }

    const script = document.createElement("script");
    script.src = TURNSTILE_SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.dataset.tiTurnstile = "true";
    script.onload = () => {
      if (window.turnstile && typeof window.turnstile.render === "function") {
        finish(true, window.turnstile);
      } else {
        finish(false, new Error("turnstile_missing"));
      }
    };
    script.onerror = () => finish(false, new Error("turnstile_blocked"));
    document.head.appendChild(script);
  });

  return turnstileLoadPromise;
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

async function solveProofOfWork(gateToken, bits, { signal, onProgress } = {}) {
  const targetAttempts = Math.pow(2, bits);
  const batchSize = bits >= 16 ? 256 : 128;
  let counter = 0;

  while (counter < 4_000_000) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    for (let i = 0; i < batchSize; i += 1) {
      const candidate = counter.toString(36);
      const digest = new Uint8Array(
        await crypto.subtle.digest("SHA-256", encoder.encode(`${gateToken}:${candidate}`))
      );
      if (hasLeadingZeroBits(digest, bits)) {
        onProgress?.(1);
        return candidate;
      }
      counter += 1;
    }
    if (onProgress) {
      const approx = 1 - Math.exp(-counter / Math.max(1, targetAttempts));
      onProgress(Math.min(0.92, approx));
    }
    await new Promise((r) => window.setTimeout(r, 0));
  }
  throw new Error("pow_exhausted");
}

function announcePolite(message) {
  const region = document.getElementById("live-announcer");
  if (!region || !message) return;
  region.textContent = "";
  window.setTimeout(() => {
    region.textContent = message;
  }, 40);
}

function formatTimestamp(ms, lang) {
  const locale = lang === "en" ? "en" : "zh-Hans";
  const diffSec = Math.round((ms - Date.now()) / 1000);
  const abs = Math.abs(diffSec);
  const copy = COPY[lang];

  if (abs < 45) return copy.justNow;
  if (typeof Intl !== "undefined" && typeof Intl.RelativeTimeFormat === "function") {
    const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "short" });
    if (abs < 3600) return rtf.format(Math.round(diffSec / 60), "minute");
    if (abs < 86400) return rtf.format(Math.round(diffSec / 3600), "hour");
    if (abs < 86400 * 14) return rtf.format(Math.round(diffSec / 86400), "day");
  }
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}.${m}.${day}`;
}

function safeStorageGet(key) {
  try {
    return localStorage.getItem(key) || "";
  } catch {
    return "";
  }
}

function safeStorageSet(key, value) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    /* ignore restricted storage */
  }
}

function isSafeHttpUrl(raw) {
  const str = String(raw || "").trim();
  if (!str) return false;
  try {
    const parsed = new URL(str);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && Boolean(parsed.hostname);
  } catch {
    return false;
  }
}

function readTranslateY(transformStr) {
  if (!transformStr || transformStr === "none") return 0;
  const m3d = transformStr.match(/^matrix3d\(([^)]+)\)$/);
  if (m3d) {
    const vals = m3d[1].split(",").map(Number);
    return Number.isFinite(vals[13]) ? vals[13] : 0;
  }
  const m2d = transformStr.match(/^matrix\(([^)]+)\)$/);
  if (m2d) {
    const vals = m2d[1].split(",").map(Number);
    return Number.isFinite(vals[5]) ? vals[5] : 0;
  }
  return 0;
}

function readLocalHeight(el) {
  if (!el) return 0;
  const cs = getComputedStyle(el);
  const h = Number.parseFloat(cs.height);
  if (Number.isFinite(h)) return h;
  return el.offsetHeight;
}

function layoutLeftIn(el, ancestor) {
  let x = 0;
  let cur = el;
  while (cur && cur !== ancestor && cur instanceof HTMLElement) {
    x += cur.offsetLeft;
    cur = cur.offsetParent;
  }
  return cur === ancestor ? x : null;
}

function readLocalBoxSize(el) {
  if (!el) return { width: 0, height: 0 };
  const cs = getComputedStyle(el);
  let w = Number.parseFloat(cs.width);
  let h = Number.parseFloat(cs.height);
  if (!Number.isFinite(w) || !Number.isFinite(h)) {
    return { width: el.offsetWidth, height: el.offsetHeight };
  }
  if (cs.boxSizing !== "border-box") {
    w +=
      (Number.parseFloat(cs.paddingLeft) || 0) +
      (Number.parseFloat(cs.paddingRight) || 0) +
      (Number.parseFloat(cs.borderLeftWidth) || 0) +
      (Number.parseFloat(cs.borderRightWidth) || 0);
    h +=
      (Number.parseFloat(cs.paddingTop) || 0) +
      (Number.parseFloat(cs.paddingBottom) || 0) +
      (Number.parseFloat(cs.borderTopWidth) || 0) +
      (Number.parseFloat(cs.borderBottomWidth) || 0);
  }
  return { width: w, height: h };
}

function splitTopLevelTokens(input, sep = " ") {
  const out = [];
  let depth = 0;
  let buf = "";
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    const isSep = depth === 0 && (sep === " " ? /\s/.test(ch) : ch === sep);
    if (isSep) {
      if (buf.trim()) out.push(buf.trim());
      buf = "";
    } else {
      buf += ch;
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

function evalCssLengthPct(expr, basis) {
  const s = String(expr || "").trim();
  if (!s) return 0;

  let pos = 0;
  const skipWs = () => {
    while (pos < s.length && /\s/.test(s[pos])) pos += 1;
  };

  const parseExpr = () => {
    let left = parseTerm();
    while (true) {
      skipWs();
      const ch = s[pos];
      if (ch !== "+" && ch !== "-") break;
      pos += 1;
      const right = parseTerm();
      left = ch === "+" ? left + right : left - right;
    }
    return left;
  };

  const parseTerm = () => {
    let left = parseUnary();
    while (true) {
      skipWs();
      const ch = s[pos];
      if (ch !== "*" && ch !== "/") break;
      pos += 1;
      const right = parseUnary();
      if (ch === "*") left *= right;
      else left = right === 0 ? 0 : left / right;
    }
    return left;
  };

  const parseUnary = () => {
    skipWs();
    if (s[pos] === "+") {
      pos += 1;
      return parseUnary();
    }
    if (s[pos] === "-") {
      pos += 1;
      return -parseUnary();
    }
    return parsePrimary();
  };

  const parsePrimary = () => {
    skipWs();
    if (s[pos] === "(") {
      pos += 1;
      const val = parseExpr();
      skipWs();
      if (s[pos] === ")") pos += 1;
      return val;
    }
    const fnMatch = s.slice(pos).match(/^([a-z-]+)\s*\(/i);
    if (fnMatch) {
      const fn = fnMatch[1].toLowerCase();
      pos += fnMatch[0].length;
      const start = pos;
      let depth = 1;
      while (pos < s.length && depth > 0) {
        if (s[pos] === "(") depth += 1;
        else if (s[pos] === ")") depth -= 1;
        pos += 1;
      }
      const inner = s.slice(start, depth === 0 ? pos - 1 : pos);
      const args = splitTopLevelTokens(inner, ",").map((arg) => evalCssLengthPct(arg, basis));
      if (fn === "calc") return args[0] ?? 0;
      if (fn === "min") return args.length ? Math.min(...args) : 0;
      if (fn === "max") return args.length ? Math.max(...args) : 0;
      if (fn === "clamp" && args.length >= 3) return Math.max(args[0], Math.min(args[1], args[2]));
      return 0;
    }
    const numMatch = s.slice(pos).match(/^(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/i);
    if (!numMatch) return 0;
    pos += numMatch[0].length;
    const num = Number.parseFloat(numMatch[0]);
    if (!Number.isFinite(num)) return 0;
    if (s[pos] === "%") {
      pos += 1;
      return (num / 100) * basis;
    }
    const unitMatch = s.slice(pos).match(/^[a-z]+/i);
    if (unitMatch) {
      pos += unitMatch[0].length;
      if (unitMatch[0].toLowerCase() !== "px") return 0;
    }
    return num;
  };

  const result = parseExpr();
  return Number.isFinite(result) ? result : 0;
}

function parseCornerRadius(value, width, height) {
  const parts = splitTopLevelTokens(String(value || "0px").trim(), " ");
  const rx = evalCssLengthPct(parts[0], width);
  const ry = evalCssLengthPct(parts[1] ?? parts[0], height);
  if (rx <= 0 || ry <= 0) return [0, 0];
  return [rx, ry];
}

class TiCommentsElement extends HTMLElement {
  static observedAttributes = [
    "slug",
    "lang",
    "endpoint",
    "heading",
    "placeholder",
    "data-theme",
    "open",
    "unstyled",
    "style",
    "class",
  ];

  #internals = null;
  #uid = `tic${++instanceSeq}`;
  #initialized = false;
  #expanded = false;
  #syncingOpenAttr = false;
  #loaded = false;
  #loading = false;
  #loadFailed = false;
  #threadGen = 0;
  #fetchSeq = 0;
  #fetchPromise = null;
  #fetchAbort = null;
  #panelOp = 0;
  #drawerOp = 0;
  #panelAnims = [];
  #panelAnimatingMode = null;
  #panelAnimDeadline = 0;
  #lastObservedBodyHeight = 0;
  #lastToggleMeasureWidth = -1;
  #lastEdgeGeomKey = "";
  #threadAnim = null;
  #comments = [];
  #gate = null;
  #config = {
    turnstileSitekey: "",
    turnstileAction: "comment",
    allowPowFallback: true,
    maxNameLength: 32,
    maxBodyLength: 2000,
    minBodyLength: 2,
    imagesEnabled: false,
    maxImages: DEFAULT_MAX_IMAGES,
    maxImageBytes: DEFAULT_MAX_IMAGE_BYTES,
    acceptedImageTypes: ["image/jpeg", "image/png", "image/webp", "image/gif"],
  };
  #attachments = [];
  #attachmentsRev = 0;
  #editingAltUid = "";
  #mediaOp = 0;
  #mediaAnim = null;
  #mediaAnimatingMode = null;
  #mediaListHeight = 0;
  #altDrawerOp = 0;
  #suppressAltSubmitUntil = 0;
  #explicitSubmit = false;
  #exitingPreviewUrls = new Set();
  #processingImages = false;
  #pendingFileQueue = [];
  #activeImageBatch = null;
  #freshAttachmentUids = new Set();
  #imageOpSeq = 0;
  #scrollOp = 0;
  #dragDepth = 0;
  #lightboxItems = [];
  #lightboxIndex = 0;
  #lightboxOp = 0;
  #authorMode = false;
  #authorName = "";
  #authOp = 0;
  #authSubmitting = false;
  #authErrorKey = "";
  #authReturnFocusToComposer = false;
  #onAuthorChange = null;
  #deleteConfirmTimers = new Map();
  #replyTarget = null;
  #replySeq = 0;
  #sortOrder = "oldest";
  #indicatorAnimated = false;
  #phase = "idle";
  #statusKey = "statusReady";
  #submitting = false;
  #submitSeq = 0;
  #activeSubmitId = 0;
  #draftRequestId = "";
  #draftFingerprint = "";
  #cooldownTimer = 0;
  #cooldownUntil = 0;
  #cooldownDurationSec = 15;
  #statusResetTimer = 0;

  // Background Turnstile + PoW state
  #turnstileWidgetId = null;
  #turnstileToken = "";
  #turnstileUnavailable = false;
  #turnstileInteractive = false;
  #turnstilePendingResolve = null;
  #turnstilePendingReject = null;
  #turnstileWaitSeq = 0;
  #turnstileWaitTimer = 0;
  #precomputedPow = null; // { gateToken, bits, nonce }
  #powAbort = null;
  #ro = null;
  #schemeObserver = null;

  // Cached DOM references
  #els = {};

  constructor() {
    super();
    if (typeof this.attachInternals === "function") {
      try {
        this.#internals = this.attachInternals();
      } catch {
        this.#internals = null;
      }
    }
  }

  get slug() {
    const explicit = (this.getAttribute("slug") || "").trim();
    if (explicit) return explicit.toLowerCase();
    const bodySlug = (document.body?.dataset?.postSlug || "").trim();
    if (bodySlug) return bodySlug.toLowerCase();
    const parts = window.location.pathname.split("/").filter(Boolean);
    return (parts[parts.length - 1] || "index").toLowerCase().replace(/[^a-z0-9-]/g, "-");
  }

  set slug(val) {
    if (val) this.setAttribute("slug", String(val));
    else this.removeAttribute("slug");
  }

  get lang() {
    const explicit = (this.getAttribute("lang") || "").trim().toLowerCase();
    if (explicit.startsWith("en")) return "en";
    if (explicit.startsWith("zh")) return "zh";
    return document.documentElement.lang.toLowerCase().startsWith("en") ? "en" : "zh";
  }

  set lang(val) {
    if (val) this.setAttribute("lang", String(val));
    else this.removeAttribute("lang");
  }

  get endpoint() {
    return (this.getAttribute("endpoint") || "/api/comments").replace(/\/+$/, "");
  }

  set endpoint(val) {
    if (val) this.setAttribute("endpoint", String(val));
    else this.removeAttribute("endpoint");
  }

  get open() {
    return this.#initialized ? this.#expanded : this.hasAttribute("open");
  }

  set open(val) {
    const wantOpen = Boolean(val);
    if (!this.#initialized) {
      this.#syncOpenAttribute(wantOpen);
      return;
    }
    if (wantOpen) this.expand({ animate: this.isConnected });
    else this.collapse({ animate: this.isConnected });
  }

  get #copy() {
    return COPY[this.lang];
  }

  #upgradeProperty(prop) {
    if (Object.prototype.hasOwnProperty.call(this, prop)) {
      const value = this[prop];
      delete this[prop];
      this[prop] = value;
    }
  }

  connectedCallback() {
    if (!this.#initialized) {
      this.#upgradeProperty("slug");
      this.#upgradeProperty("lang");
      this.#upgradeProperty("endpoint");
      this.#upgradeProperty("open");
      this.#buildShell();
      this.#initialized = true;
    }
    this.#syncSkinState();
    this.#restoreAttachmentPreviewUrls();
    this.#observeColorScheme();
    this.#observeLayout();
    this.#bindAuthorSync();
    this.#settlePanelVisualState();
    this.#syncCooldownOnConnect();
    this.#syncHintFit({ force: true });
    this.#syncToggleEdgeGeometry();
    window.requestAnimationFrame(() => {
      if (!this.isConnected) return;
      this.#syncHintFit({ force: true });
      this.#syncToggleEdgeGeometry();
    });
    if (this.hasAttribute("open") && !this.#expanded) {
      this.expand({ animate: false });
    } else if (this.#expanded && !this.#loaded && !this.#loading && !this.#loadFailed) {
      this.#fetchThread();
    } else if (this.#expanded && this.#loaded) {
      window.requestAnimationFrame(() => this.#syncSortIndicator(false));
    }
  }

  disconnectedCallback() {
    this.#settlePanelVisualState();
    this.#scrollOp += 1;
    this.#mediaOp += 1;
    this.#altDrawerOp += 1;
    this.#mediaAnim?.cancel();
    this.#mediaAnim = null;
    this.#mediaAnimatingMode = null;
    if (this.#els.composerMedia) {
      this.#els.composerMedia.style.height = "";
      this.#els.composerMedia.style.overflow = "";
      this.#els.composerMedia.style.opacity = "";
    }
    this.#els.stagedList?.querySelectorAll('[data-part="staged-item"][data-closing="true"]').forEach((n) => n.remove());
    if (this.#els.altDrawer) {
      this.#els.altDrawer.dataset.open = "false";
      this.#els.altDrawer.hidden = true;
      this.#els.altDrawer.inert = true;
    }
    this.#editingAltUid = "";
    this.#revokeExitingPreviewUrls();
    this.#abortPendingImageQueue();
    this.#freshAttachmentUids.clear();
    this.#dragDepth = 0;
    if (this.#els.form) {
      delete this.#els.form.dataset.dragover;
    }
    if (this.#els.dropCue) {
      this.#els.dropCue.hidden = true;
    }
    if (this.#els.lightbox?.open) {
      this.#els.lightbox.removeAttribute("data-closing");
      this.#els.lightbox.close();
    } else if (this.#els.lightboxImg) {
      this.#els.lightboxImg.removeAttribute("src");
    }
    if (this.#els.authDialog?.open) {
      this.#els.authDialog.removeAttribute("data-closing");
      this.#els.authDialog.close();
    }
    this.#resetAuthDialogInputs();
    this.#unbindAuthorSync();
    this.#clearDeleteConfirmTimers();
    this.#revokeAttachmentPreviewUrls();
    this.#fetchSeq += 1;
    this.#fetchAbort?.abort();
    this.#fetchAbort = null;
    this.#fetchPromise = null;
    this.#loading = false;
    this.#ro?.disconnect();
    this.#ro = null;
    this.#schemeObserver?.disconnect();
    this.#schemeObserver = null;
    this.#powAbort?.abort();
    this.#powAbort = null;
    window.clearInterval(this.#cooldownTimer);
    this.#cooldownTimer = 0;
    window.clearTimeout(this.#statusResetTimer);
    this.#activeSubmitId = 0;
    this.#submitting = false;
    this.#cancelTurnstileWait();
    this.#setInteractiveDrawer(false);
    this.#syncComposerReadyState({ resetPhase: true });
    this.#syncAttachmentUi();
    if (this.#turnstileWidgetId !== null && window.turnstile?.remove) {
      try {
        window.turnstile.remove(this.#turnstileWidgetId);
      } catch {
        /* ignore */
      }
      this.#turnstileWidgetId = null;
    }
  }

  #syncSkinState() {
    ensureCoreStylesheet();
    const isUnstyled = this.hasAttribute("unstyled");
    if (!isUnstyled) {
      const link = ensureDefaultStylesheet();
      if (link && !link.sheet) {
        link.addEventListener(
          "load",
          () => {
            if (!this.isConnected) return;
            this.#syncHintFit({ force: true });
            this.#syncToggleEdgeGeometry();
          },
          { once: true }
        );
      }
    }
    if (this.#els.edges) {
      for (const edge of this.#els.edges) {
        edge.hidden = isUnstyled;
      }
    }
    this.#lastToggleMeasureWidth = -1;
    this.#syncHintFit({ force: true });
    this.#syncToggleEdgeGeometry();
  }

  #syncHintFit({ force = false } = {}) {
    const { toggle, toggleHint } = this.#els;
    if (!toggle || !toggleHint) return;
    if (this.hasAttribute("unstyled") || this.#expanded || this.#loaded) {
      delete toggle.dataset.hintWrapped;
      return;
    }
    const { width } = readLocalBoxSize(toggle);
    if (width <= 0) return;
    if (!force && Math.abs(width - this.#lastToggleMeasureWidth) <= 0.5) return;
    this.#lastToggleMeasureWidth = width;

    delete toggle.dataset.hintWrapped;
    if (getComputedStyle(toggleHint).display === "none") return;
    const withHintHeight = readLocalHeight(toggle);
    const withHintOverflow = toggle.scrollWidth > toggle.clientWidth + 1;
    toggle.dataset.hintWrapped = "true";
    const withoutHintHeight = readLocalHeight(toggle);
    if (!withHintOverflow && withHintHeight - withoutHintHeight <= 1) {
      delete toggle.dataset.hintWrapped;
    }
  }

  #syncToggleEdgeGeometry() {
    const toggle = this.#els.toggle;
    if (!toggle) return;
    const clearProps = () => {
      if (this.#lastEdgeGeomKey === "0") return;
      this.#lastEdgeGeomKey = "0";
      for (const prop of [
        "--ti-rtl-x",
        "--ti-rtl-y",
        "--ti-rtr-x",
        "--ti-rtr-y",
        "--ti-rbr-x",
        "--ti-rbr-y",
        "--ti-rbl-x",
        "--ti-rbl-y",
      ]) {
        toggle.style.removeProperty(prop);
      }
    };

    if (this.hasAttribute("unstyled")) {
      clearProps();
      return;
    }
    const { width: w, height: h } = readLocalBoxSize(toggle);
    if (w <= 0 || h <= 0) return;

    const cs = getComputedStyle(toggle);
    const tl = parseCornerRadius(cs.borderTopLeftRadius, w, h);
    const tr = parseCornerRadius(cs.borderTopRightRadius, w, h);
    const br = parseCornerRadius(cs.borderBottomRightRadius, w, h);
    const bl = parseCornerRadius(cs.borderBottomLeftRadius, w, h);

    if (
      tl[0] === 0 && tl[1] === 0 &&
      tr[0] === 0 && tr[1] === 0 &&
      br[0] === 0 && br[1] === 0 &&
      bl[0] === 0 && bl[1] === 0
    ) {
      clearProps();
      return;
    }

    const ratios = [1];
    if (tl[0] + tr[0] > 0) ratios.push(w / (tl[0] + tr[0]));
    if (bl[0] + br[0] > 0) ratios.push(w / (bl[0] + br[0]));
    if (tl[1] + bl[1] > 0) ratios.push(h / (tl[1] + bl[1]));
    if (tr[1] + br[1] > 0) ratios.push(h / (tr[1] + br[1]));
    const f = Math.min(...ratios);
    const fmt = (v) => `${Math.max(0, v * f).toFixed(2)}px`;
    const values = [
      fmt(tl[0]), fmt(tl[1]),
      fmt(tr[0]), fmt(tr[1]),
      fmt(br[0]), fmt(br[1]),
      fmt(bl[0]), fmt(bl[1]),
    ];
    const key = values.join("|");
    if (key === this.#lastEdgeGeomKey) return;
    this.#lastEdgeGeomKey = key;

    toggle.style.setProperty("--ti-rtl-x", values[0]);
    toggle.style.setProperty("--ti-rtl-y", values[1]);
    toggle.style.setProperty("--ti-rtr-x", values[2]);
    toggle.style.setProperty("--ti-rtr-y", values[3]);
    toggle.style.setProperty("--ti-rbr-x", values[4]);
    toggle.style.setProperty("--ti-rbr-y", values[5]);
    toggle.style.setProperty("--ti-rbl-x", values[6]);
    toggle.style.setProperty("--ti-rbl-y", values[7]);
  }

  #syncOpenAttribute(open) {
    if (open === this.hasAttribute("open")) return;
    this.#syncingOpenAttr = true;
    try {
      if (open) this.setAttribute("open", "");
      else this.removeAttribute("open");
    } finally {
      this.#syncingOpenAttr = false;
    }
  }

  #readPanelBodyMotion(wasHidden) {
    if (wasHidden) {
      return { opacity: 0, y: 10, transform: "translateY(10px)" };
    }
    const cs = getComputedStyle(this.#els.panelBody);
    const parsedOpacity = Number.parseFloat(cs.opacity);
    const opacity = Number.isFinite(parsedOpacity) ? parsedOpacity : 1;
    const y = readTranslateY(cs.transform);
    return { opacity, y, transform: `translateY(${y}px)` };
  }

  #settlePanelVisualState() {
    if (!this.#initialized) return;
    this.#panelOp += 1;
    this.#cancelPanelAnimations();
    this.#threadAnim?.cancel();
    this.#threadAnim = null;
    const { panel, panelBody, threadShell, toggle, toggleLabelOpen, toggleLabelClose } = this.#els;
    panel.hidden = !this.#expanded;
    panel.inert = !this.#expanded;
    panel.style.height = "";
    panel.style.overflow = "";
    panelBody.style.opacity = "";
    panelBody.style.transform = "";
    threadShell.style.height = "";
    threadShell.style.overflow = "";
    this.dataset.open = this.#expanded ? "true" : "false";
    this.#setCustomState("open", this.#expanded);
    toggle.setAttribute("aria-expanded", this.#expanded ? "true" : "false");
    if (this.#expanded) {
      toggleLabelOpen.setAttribute("aria-hidden", "true");
      toggleLabelClose.removeAttribute("aria-hidden");
    } else {
      toggleLabelOpen.removeAttribute("aria-hidden");
      toggleLabelClose.setAttribute("aria-hidden", "true");
    }
  }

  #syncCooldownOnConnect() {
    if (!this.#initialized || this.#cooldownUntil <= 0) return;
    if (Date.now() < this.#cooldownUntil) {
      this.#runCooldownTimer();
    } else {
      this.#cooldownUntil = 0;
      window.clearInterval(this.#cooldownTimer);
      this.#cooldownTimer = 0;
      this.#syncComposerReadyState({ resetPhase: true });
    }
  }

  #invalidateFetchState({ clearReply = false } = {}) {
    this.#threadGen += 1;
    this.#fetchSeq += 1;
    this.#fetchAbort?.abort();
    this.#fetchAbort = null;
    this.#fetchPromise = null;
    this.#loading = false;
    this.#loaded = false;
    this.#loadFailed = false;
    this.#gate = null;
    this.#comments = [];
    delete this.dataset.loaded;
    if (clearReply) {
      this.#clearReplyTarget();
      this.#clearAttachments();
    }
    this.#activeSubmitId = 0;
    this.#submitting = false;
    window.clearTimeout(this.#statusResetTimer);
    this.#resetAntiAbuseState();
    this.#syncComposerReadyState({ resetPhase: true });
    this.#els.threadBar.hidden = true;
    this.#els.list.replaceChildren();
    delete this.#els.stateNote.dataset.state;
    this.#els.stateNote.dataset.part = "loading";
    this.#els.stateNote.textContent = this.#copy.loading;
    this.#els.stateNote.hidden = false;
    this.#syncCount();
    this.#lastToggleMeasureWidth = -1;
    this.#syncHintFit({ force: true });
    this.#syncToggleEdgeGeometry();
  }

  attributeChangedCallback(name, oldVal, newVal) {
    if (oldVal === newVal || !this.#initialized) return;
    if (name === "slug" || name === "endpoint") {
      this.#invalidateFetchState({ clearReply: true });
      if (this.#expanded) {
        this.#fetchThread();
      }
    } else if (name === "heading" || name === "placeholder" || name === "lang") {
      this.#syncStaticLabels();
      if (this.#loaded) {
        this.#renderThread();
        this.#syncSortIndicator(false);
      }
    } else if (name === "data-theme") {
      this.#remountTurnstileForTheme();
      this.#syncToggleEdgeGeometry();
    } else if (name === "unstyled") {
      this.#syncSkinState();
    } else if (name === "style" || name === "class") {
      this.#syncToggleEdgeGeometry();
    } else if (name === "open") {
      if (this.#syncingOpenAttr) return;
      const wantOpen = this.hasAttribute("open");
      if (wantOpen && !this.#expanded) this.expand({ animate: this.isConnected });
      else if (!wantOpen && this.#expanded) this.collapse({ animate: this.isConnected });
    }
  }

  #cancelPanelAnimations() {
    for (const anim of this.#panelAnims) {
      try {
        anim.cancel();
      } catch {
        /* ignore */
      }
    }
    this.#panelAnims = [];
    this.#panelAnimatingMode = null;
    this.#panelAnimDeadline = 0;
    this.#lastObservedBodyHeight = 0;
  }

  #animatePanelExpand({
    startHeight,
    startBody,
    wasHidden = false,
    heightDuration = 400,
    bodyDuration = 360,
  }) {
    const { panel, panelBody } = this.#els;
    const op = ++this.#panelOp;
    this.#cancelPanelAnimations();
    panel.style.height = "";
    panel.style.overflow = "";

    const targetHeight = readLocalHeight(panel);
    const needsHeightAnim = Math.abs(targetHeight - startHeight) > 2;
    const needsBodyAnim = wasHidden || startBody.opacity < 0.99 || Math.abs(startBody.y) > 0.25;

    if (!needsHeightAnim && !needsBodyAnim) {
      panelBody.style.opacity = "";
      panelBody.style.transform = "";
      return;
    }

    const anims = [];
    let bodyDelay = 0;
    if (needsHeightAnim) {
      panel.style.overflow = "clip";
      const heightAnim = panel.animate(
        [{ height: `${startHeight}px` }, { height: `${targetHeight}px` }],
        {
          duration: heightDuration,
          easing: "cubic-bezier(0.22, 1, 0.36, 1)",
          fill: "forwards",
        }
      );
      anims.push(heightAnim);
    }

    if (needsBodyAnim) {
      bodyDelay = wasHidden ? 30 : 0;
      const bodyAnim = panelBody.animate(
        [
          { opacity: startBody.opacity, transform: startBody.transform },
          { opacity: 1, transform: "translateY(0px)" },
        ],
        {
          duration: bodyDuration,
          delay: bodyDelay,
          easing: "cubic-bezier(0.16, 1, 0.3, 1)",
          fill: wasHidden ? "both" : "forwards",
        }
      );
      anims.push(bodyAnim);
    }

    this.#panelAnims = anims;
    this.#panelAnimatingMode = "expand";
    const totalMs = Math.max(needsHeightAnim ? heightDuration : 0, needsBodyAnim ? bodyDelay + bodyDuration : 0);
    this.#panelAnimDeadline = performance.now() + totalMs;
    this.#lastObservedBodyHeight = readLocalHeight(panelBody);
    const primaryAnim = anims[0];

    Promise.race([
      Promise.allSettled(anims.map((anim) => anim.finished)),
      new Promise((r) => window.setTimeout(r, totalMs + 120)),
    ]).then(() => {
      if (op !== this.#panelOp || !this.#expanded || this.#panelAnims[0] !== primaryAnim) return;
      this.#cancelPanelAnimations();
      panel.style.height = "";
      panel.style.overflow = "";
      panelBody.style.opacity = "";
      panelBody.style.transform = "";
      if (this.#loaded) {
        this.#syncSortIndicator(false);
      }
    });
  }

  #handlePanelBodyResize() {
    if (this.#panelAnimatingMode !== "expand" || !this.#expanded || this.#panelAnims.length === 0) return;
    const { panel, panelBody } = this.#els;
    if (!panel || panel.hidden || typeof panel.animate !== "function") return;
    const curBodyHeight = readLocalHeight(panelBody);
    if (curBodyHeight <= 0 || Math.abs(curBodyHeight - this.#lastObservedBodyHeight) <= 2) return;

    const curHeight = readLocalHeight(panel);
    const curBody = this.#readPanelBodyMotion(false);
    const rem = Math.max(180, Math.min(360, Math.round(this.#panelAnimDeadline - performance.now())));
    this.#animatePanelExpand({
      startHeight: curHeight,
      startBody: curBody,
      wasHidden: false,
      heightDuration: rem,
      bodyDuration: Math.min(260, rem),
    });
  }

  expand({ animate = true } = {}) {
    if (!this.#initialized) {
      this.#syncOpenAttribute(true);
      return;
    }
    const { panel, panelBody, toggle, toggleLabelOpen, toggleLabelClose } = this.#els;
    const prevKey = this.#lastEdgeGeomKey;
    this.#syncToggleEdgeGeometry();
    if (prevKey !== this.#lastEdgeGeomKey) {
      void toggle.offsetWidth;
    }

    const wasHidden = panel.hidden;
    const startHeight = wasHidden ? 0 : readLocalHeight(panel);
    const startBody = this.#readPanelBodyMotion(wasHidden);

    this.#panelOp += 1;
    this.#cancelPanelAnimations();
    this.#expanded = true;
    this.#syncOpenAttribute(true);
    this.dataset.open = "true";
    this.#setCustomState("open", true);
    toggle.setAttribute("aria-expanded", "true");
    toggleLabelOpen.setAttribute("aria-hidden", "true");
    toggleLabelClose.removeAttribute("aria-hidden");

    panel.hidden = false;
    panel.inert = false;
    panel.style.height = "";
    panel.style.overflow = "";

    const needsFetch = this.isConnected && !this.#loaded && !this.#loading;
    if (!animate || reducedMotionQuery.matches || typeof panel.animate !== "function") {
      panelBody.style.opacity = "";
      panelBody.style.transform = "";
      if (needsFetch) {
        this.#fetchThread();
      } else if (this.#loaded) {
        window.requestAnimationFrame(() => this.#syncSortIndicator(false));
      }
      return;
    }

    this.#animatePanelExpand({
      startHeight,
      startBody,
      wasHidden,
      heightDuration: 400,
      bodyDuration: 360,
    });

    if (needsFetch) {
      this.#fetchThread();
    } else if (this.#loaded) {
      window.requestAnimationFrame(() => this.#syncSortIndicator(false));
    }
  }

  collapse({ resetLoaded = false, animate = true } = {}) {
    if (!this.#initialized) {
      this.#syncOpenAttribute(false);
      return;
    }
    const { panel, panelBody, toggle, toggleLabelOpen, toggleLabelClose } = this.#els;
    const prevKey = this.#lastEdgeGeomKey;
    this.#syncToggleEdgeGeometry();
    if (prevKey !== this.#lastEdgeGeomKey) {
      void toggle.offsetWidth;
    }

    const op = ++this.#panelOp;
    const wasHidden = panel.hidden;
    const currentHeight = wasHidden ? 0 : readLocalHeight(panel);
    const startBody = this.#readPanelBodyMotion(wasHidden);

    this.#cancelPanelAnimations();
    this.#threadAnim?.cancel();
    this.#threadAnim = null;
    this.#els.threadShell.style.height = "";
    this.#els.threadShell.style.overflow = "";

    const activeEl = document.activeElement;
    const focusInsidePanel = activeEl instanceof Node && panel.contains(activeEl);
    panel.inert = true;
    if (focusInsidePanel && toggle.isConnected) {
      toggle.focus({ preventScroll: true });
    }

    this.#expanded = false;
    this.#syncOpenAttribute(false);
    this.dataset.open = "false";
    this.#setCustomState("open", false);
    toggle.setAttribute("aria-expanded", "false");
    toggleLabelOpen.removeAttribute("aria-hidden");
    toggleLabelClose.setAttribute("aria-hidden", "true");

    if (resetLoaded) {
      this.#invalidateFetchState({ clearReply: true });
    }

    const finishHide = () => {
      if (op !== this.#panelOp || this.#expanded) return;
      this.#cancelPanelAnimations();
      panel.hidden = true;
      panel.inert = true;
      panel.style.height = "";
      panel.style.overflow = "";
      panelBody.style.opacity = "";
      panelBody.style.transform = "";
    };

    if (wasHidden || !animate || reducedMotionQuery.matches || typeof panel.animate !== "function") {
      finishHide();
      return;
    }

    panel.style.overflow = "clip";
    const heightAnim = panel.animate(
      [{ height: `${currentHeight}px` }, { height: "0px" }],
      {
        duration: 320,
        easing: "cubic-bezier(0.32, 0, 0.15, 1)",
        fill: "forwards",
      }
    );
    const bodyAnim = panelBody.animate(
      [
        { opacity: startBody.opacity, transform: startBody.transform },
        { opacity: 0, transform: "translateY(-6px)" },
      ],
      {
        duration: 220,
        easing: "cubic-bezier(0.4, 0, 1, 1)",
        fill: "forwards",
      }
    );
    this.#panelAnims = [heightAnim, bodyAnim];
    this.#panelAnimatingMode = "collapse";

    Promise.race([
      Promise.allSettled([heightAnim.finished, bodyAnim.finished]),
      new Promise((r) => window.setTimeout(r, 440)),
    ]).then(() => {
      if (op !== this.#panelOp || this.#panelAnims[0] !== heightAnim) return;
      finishHide();
    });
  }

  reload() {
    if (!this.#initialized) return;
    this.#invalidateFetchState({ clearReply: true });
    if (this.#expanded) {
      this.#fetchThread();
    }
  }

  #setCustomState(stateName, active) {
    if (!this.#internals?.states) return;
    try {
      if (active) this.#internals.states.add(stateName);
      else this.#internals.states.delete(stateName);
    } catch {
      /* ignore unsupported CustomStateSet */
    }
  }

  #resolveStatusCopy(keyOrText) {
    if (!keyOrText) return "";
    const c = this.#copy;
    if (keyOrText === "statusReady") {
      if (this.#authorMode) {
        return this.#config.imagesEnabled ? c.statusReadyAuthorImages : c.statusReadyAuthor;
      }
      if (this.#config.imagesEnabled) {
        return c.statusReadyImages;
      }
    }
    if (keyOrText === "statusCooldown") {
      const rem = Math.max(1, Math.ceil((this.#cooldownUntil - Date.now()) / 1000));
      return c.statusCooldown(rem);
    }
    if (keyOrText === "errImageCount") {
      return c.errImageCount(Math.max(1, Number(this.#config.maxImages || DEFAULT_MAX_IMAGES)));
    }
    const val = c[keyOrText];
    return typeof val === "string" ? val : keyOrText;
  }

  #setPhase(phase, statusKeyOrText = "") {
    this.#phase = phase;
    this.dataset.phase = phase;
    const busy = phase === "inking" || phase === "verifying";
    this.#setCustomState("busy", busy);
    this.#setCustomState("verifying", phase === "verifying");
    this.#setCustomState("interactive", phase === "interactive");
    if (this.#internals) {
      try {
        this.#internals.ariaBusy = busy ? "true" : "false";
      } catch {
        /* ignore */
      }
    }
    if (statusKeyOrText) {
      this.#statusKey = statusKeyOrText;
      if (this.#els.statusLine) {
        this.#els.statusLine.textContent = this.#resolveStatusCopy(statusKeyOrText);
      }
    }
  }

  #setSealProgress(value) {
    this.style.setProperty("--ti-seal-progress", String(Math.max(0, Math.min(1, value))));
  }

  #observeColorScheme() {
    this.#schemeObserver?.disconnect();
    const meta = document.querySelector('meta[name="color-scheme"]');
    if (!meta || typeof MutationObserver === "undefined") return;
    let lastScheme = getEffectiveColorScheme(this);
    this.#schemeObserver = new MutationObserver(() => {
      const next = getEffectiveColorScheme(this);
      if (next !== lastScheme) {
        lastScheme = next;
        this.#remountTurnstileForTheme();
      }
    });
    this.#schemeObserver.observe(meta, { attributes: true, attributeFilter: ["content"] });
  }

  #observeLayout() {
    this.#ro?.disconnect();
    if (typeof ResizeObserver === "undefined") return;
    const { sortGroup, toggle, panelBody, composerMedia } = this.#els;
    this.#ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.target === sortGroup) {
          this.#syncSortIndicator(false);
        } else if (entry.target === toggle) {
          this.#syncHintFit();
          this.#syncToggleEdgeGeometry();
        } else if (entry.target === panelBody) {
          this.#handlePanelBodyResize();
        } else if (entry.target === composerMedia && this.#editingAltUid) {
          this.#syncAltCaret(false);
        }
      }
    });
    if (sortGroup) this.#ro.observe(sortGroup);
    if (toggle) this.#ro.observe(toggle);
    if (panelBody) this.#ro.observe(panelBody);
    if (composerMedia) this.#ro.observe(composerMedia);
    document.fonts?.ready?.then(() => {
      if (!this.isConnected) return;
      this.#syncSortIndicator(false);
      this.#syncHintFit({ force: true });
      this.#syncToggleEdgeGeometry();
    });
  }

  #syncSortIndicator(allowTransition = true) {
    const group = this.#els.sortGroup;
    if (!group || group.hidden) return;
    const activeBtn = group.querySelector('[data-part="sort-btn"][aria-pressed="true"]');
    if (!activeBtn) {
      group.style.setProperty("--sort-visible", "0");
      return;
    }
    const gr = group.getBoundingClientRect();
    const br = activeBtn.getBoundingClientRect();
    if (gr.width <= 0 || br.width <= 0) {
      group.style.setProperty("--sort-visible", "0");
      return;
    }

    group.dataset.indicatorReady = "true";
    if (!allowTransition) {
      delete group.dataset.indicatorAnimated;
    } else if (this.#indicatorAnimated) {
      group.dataset.indicatorAnimated = "true";
    }

    group.style.setProperty("--sort-x", `${(br.left - gr.left).toFixed(2)}px`);
    group.style.setProperty("--sort-w", `${br.width.toFixed(2)}px`);
    group.style.setProperty("--sort-visible", "1");

    if (!this.#indicatorAnimated) {
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          this.#indicatorAnimated = true;
          group.dataset.indicatorAnimated = "true";
        });
      });
    } else if (!allowTransition) {
      void group.offsetWidth;
      group.dataset.indicatorAnimated = "true";
    }
  }

  #buildShell() {
    const c = this.#copy;
    const id = (suffix) => `${this.#uid}-${suffix}`;
    const svgNS = "http://www.w3.org/2000/svg";

    const root = document.createElement("section");
    root.dataset.part = "root";
    root.setAttribute("aria-labelledby", id("title"));

    // 1. Unified Click-to-Load Toggle Heading (valid WAI-ARIA Accordion pattern: <button> inside <h2>)
    const heading = document.createElement("h2");
    heading.id = id("title");
    heading.dataset.part = "heading";

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.dataset.part = "toggle";
    toggle.setAttribute("aria-expanded", "false");
    toggle.setAttribute("aria-controls", id("panel"));

    const headingGroup = document.createElement("span");
    headingGroup.dataset.part = "heading-group";

    const title = document.createElement("span");
    title.dataset.part = "title";

    const count = document.createElement("span");
    count.dataset.part = "count";

    const toggleHint = document.createElement("span");
    toggleHint.dataset.part = "toggle-hint";

    const toggleMeta = document.createElement("span");
    toggleMeta.dataset.part = "toggle-meta";
    toggleMeta.append(count, toggleHint);

    headingGroup.append(title, toggleMeta);

    const toggleAction = document.createElement("span");
    toggleAction.dataset.part = "toggle-action";

    const toggleLabels = document.createElement("span");
    toggleLabels.dataset.part = "toggle-labels";

    const toggleLabelOpen = document.createElement("span");
    toggleLabelOpen.dataset.part = "toggle-label-open";

    const toggleLabelClose = document.createElement("span");
    toggleLabelClose.dataset.part = "toggle-label-close";
    toggleLabelClose.setAttribute("aria-hidden", "true");

    toggleLabels.append(toggleLabelOpen, toggleLabelClose);

    const arrowSvg = document.createElementNS(svgNS, "svg");
    arrowSvg.setAttribute("viewBox", "0 0 14 14");
    arrowSvg.setAttribute("aria-hidden", "true");
    arrowSvg.dataset.part = "toggle-arrow";
    const arrowPath = document.createElementNS(svgNS, "path");
    arrowPath.setAttribute("d", "M2.75 5.25L7 9.5l4.25-4.25");
    arrowPath.setAttribute("fill", "none");
    arrowPath.setAttribute("stroke", "currentColor");
    arrowPath.setAttribute("stroke-width", "1.4");
    arrowPath.setAttribute("stroke-linecap", "square");
    arrowSvg.append(arrowPath);

    toggleAction.append(toggleLabels, arrowSvg);

    const isUnstyled = this.hasAttribute("unstyled");
    const edges = ["top", "right", "bottom", "left"].map((side) => {
      const edge = document.createElement("span");
      edge.dataset.part = "edge";
      edge.dataset.edge = side;
      edge.setAttribute("aria-hidden", "true");
      edge.hidden = isUnstyled;
      return edge;
    });

    toggle.append(...edges, headingGroup, toggleAction);
    heading.append(toggle);

    // 2. Collapsible Body Panel (hidden & inert until clicked)
    const panel = document.createElement("div");
    panel.id = id("panel");
    panel.dataset.part = "panel";
    panel.hidden = true;
    panel.inert = true;

    const panelBody = document.createElement("div");
    panelBody.dataset.part = "panel-body";

    // 3. Composer Form
    const form = document.createElement("form");
    form.dataset.part = "composer";
    form.setAttribute("aria-labelledby", id("title"));
    form.noValidate = true;

    // Author mode banner (visible only when authenticated as Author)
    const authorBanner = document.createElement("div");
    authorBanner.dataset.part = "author-banner";
    authorBanner.hidden = true;

    const authorBannerLead = document.createElement("div");
    authorBannerLead.dataset.part = "author-banner-lead";

    const authorBannerBadge = document.createElement("span");
    authorBannerBadge.dataset.part = "author-badge";

    const authorBannerText = document.createElement("span");
    authorBannerText.dataset.part = "author-banner-text";

    authorBannerLead.append(authorBannerBadge, authorBannerText);

    const authorSignOutBtn = document.createElement("button");
    authorSignOutBtn.type = "button";
    authorSignOutBtn.dataset.part = "action-btn";

    authorBanner.append(authorBannerLead, authorSignOutBtn);

    // Reply context banner
    const replyBanner = document.createElement("div");
    replyBanner.dataset.part = "reply-banner";
    replyBanner.hidden = true;

    const replyLabel = document.createElement("span");
    replyLabel.dataset.part = "reply-label";

    const cancelReplyBtn = document.createElement("button");
    cancelReplyBtn.type = "button";
    cancelReplyBtn.dataset.part = "action-btn";

    replyBanner.append(replyLabel, cancelReplyBtn);

    // Hidden Honeypot field (native hidden keeps it concealed even in standalone unstyled mode)
    const hpWrap = document.createElement("div");
    hpWrap.dataset.part = "honeypot";
    hpWrap.hidden = true;
    hpWrap.setAttribute("aria-hidden", "true");
    const hpInput = document.createElement("input");
    hpInput.type = "text";
    hpInput.name = "company_website";
    hpInput.tabIndex = -1;
    hpInput.autocomplete = "off";
    hpWrap.append(hpInput);

    // Body textarea field
    const bodyField = document.createElement("div");
    bodyField.dataset.part = "field";
    bodyField.dataset.field = "body";

    const bodyLabel = document.createElement("label");
    bodyLabel.htmlFor = id("body");
    bodyLabel.dataset.part = "label";

    const bodyLabelText = document.createElement("span");
    const charCount = document.createElement("span");
    charCount.dataset.part = "char-count";
    charCount.textContent = "0 / 2000";
    bodyLabel.append(bodyLabelText, charCount);

    const textarea = document.createElement("textarea");
    textarea.id = id("body");
    textarea.name = "body";
    textarea.required = true;
    textarea.minLength = 2;
    textarea.maxLength = 2000;
    textarea.rows = 3;
    textarea.dataset.part = "textarea";
    textarea.setAttribute("aria-invalid", "false");

    const composerMedia = document.createElement("div");
    composerMedia.dataset.part = "composer-media";
    composerMedia.hidden = true;

    const stagedList = document.createElement("div");
    stagedList.dataset.part = "staged-list";
    stagedList.setAttribute("role", "list");

    const altDrawer = document.createElement("div");
    altDrawer.id = id("staged-alt-drawer");
    altDrawer.dataset.part = "staged-alt-drawer";
    altDrawer.dataset.open = "false";
    altDrawer.hidden = true;
    altDrawer.inert = true;

    const altDrawerInner = document.createElement("div");
    altDrawerInner.dataset.part = "staged-alt-drawer-inner";

    const altBar = document.createElement("div");
    altBar.dataset.part = "staged-alt-bar";

    const altCaret = document.createElement("span");
    altCaret.dataset.part = "staged-alt-caret";
    altCaret.setAttribute("aria-hidden", "true");

    const altTag = document.createElement("span");
    altTag.dataset.part = "staged-alt-tag";

    const altInput = document.createElement("input");
    altInput.type = "text";
    altInput.setAttribute("form", id("staged-alt-detached"));
    altInput.dataset.part = "staged-alt";
    altInput.maxLength = MAX_ALT_LEN;
    altInput.enterKeyHint = "done";

    const altDoneBtn = document.createElement("button");
    altDoneBtn.type = "button";
    altDoneBtn.dataset.part = "staged-alt-done";

    altBar.append(altCaret, altTag, altInput, altDoneBtn);
    altDrawerInner.append(altBar);
    altDrawer.append(altDrawerInner);
    composerMedia.append(stagedList, altDrawer);

    const dropCue = document.createElement("div");
    dropCue.dataset.part = "drop-cue";
    dropCue.setAttribute("aria-hidden", "true");
    dropCue.hidden = true;

    const sealBar = document.createElement("div");
    sealBar.dataset.part = "seal-bar";
    sealBar.setAttribute("aria-hidden", "true");
    const sealFill = document.createElement("div");
    sealFill.dataset.part = "seal-fill";
    sealBar.append(sealFill);

    const bodyError = document.createElement("span");
    bodyError.id = id("body-err");
    bodyError.dataset.part = "field-error";
    bodyError.hidden = true;
    textarea.dataset.error = bodyError.id;

    const mediaError = document.createElement("span");
    mediaError.id = id("media-err");
    mediaError.dataset.part = "media-error";
    mediaError.setAttribute("role", "alert");
    mediaError.hidden = true;

    bodyField.append(bodyLabel, textarea, composerMedia, dropCue, sealBar, bodyError, mediaError);

    // Optional Nickname & Website row
    const metaRow = document.createElement("div");
    metaRow.dataset.part = "meta-row";

    const nameField = document.createElement("div");
    nameField.dataset.part = "field";
    const nameLabel = document.createElement("label");
    nameLabel.htmlFor = id("name");
    nameLabel.dataset.part = "label";
    const nameInput = document.createElement("input");
    nameInput.id = id("name");
    nameInput.name = "authorName";
    nameInput.type = "text";
    nameInput.maxLength = 32;
    nameInput.autocomplete = "nickname";
    nameInput.enterKeyHint = "next";
    nameInput.dataset.part = "input";
    nameInput.setAttribute("aria-invalid", "false");
    nameInput.value = safeStorageGet(STORAGE_NAME_KEY);
    nameField.append(nameLabel, nameInput);

    const urlField = document.createElement("div");
    urlField.dataset.part = "field";
    const urlLabel = document.createElement("label");
    urlLabel.htmlFor = id("url");
    urlLabel.dataset.part = "label";
    const urlInput = document.createElement("input");
    urlInput.id = id("url");
    urlInput.name = "authorUrl";
    urlInput.type = "url";
    urlInput.maxLength = 200;
    urlInput.autocomplete = "url";
    urlInput.setAttribute("autocorrect", "off");
    urlInput.setAttribute("autocapitalize", "none");
    urlInput.spellcheck = false;
    urlInput.enterKeyHint = "done";
    urlInput.dataset.part = "input";
    urlInput.setAttribute("aria-invalid", "false");
    urlInput.value = safeStorageGet(STORAGE_URL_KEY);

    const urlError = document.createElement("span");
    urlError.id = id("url-err");
    urlError.dataset.part = "field-error";
    urlError.hidden = true;
    urlInput.dataset.error = urlError.id;

    urlField.append(urlLabel, urlInput, urlError);
    metaRow.append(nameField, urlField);

    // Rare Turnstile Interactive Escalation Drawer
    const sealDrawer = document.createElement("div");
    sealDrawer.dataset.part = "seal-drawer";
    sealDrawer.dataset.open = "false";
    sealDrawer.hidden = true;

    const sealDrawerInner = document.createElement("div");
    sealDrawerInner.dataset.part = "seal-drawer-inner";

    const sealDrawerBody = document.createElement("div");
    sealDrawerBody.dataset.part = "seal-drawer-body";

    const sealDrawerCopy = document.createElement("div");
    sealDrawerCopy.dataset.part = "seal-drawer-copy";

    const sealPulse = document.createElement("span");
    sealPulse.dataset.part = "seal-pulse";
    sealPulse.setAttribute("aria-hidden", "true");

    const sealDrawerText = document.createElement("span");
    sealDrawerCopy.append(sealPulse, sealDrawerText);

    const turnstileMount = document.createElement("div");
    turnstileMount.id = id("turnstile");
    turnstileMount.dataset.part = "turnstile-mount";

    sealDrawerBody.append(sealDrawerCopy, turnstileMount);
    sealDrawerInner.append(sealDrawerBody);
    sealDrawer.append(sealDrawerInner);

    // Composer Footer
    const composerFoot = document.createElement("div");
    composerFoot.dataset.part = "composer-foot";

    const composerFootMeta = document.createElement("div");
    composerFootMeta.dataset.part = "composer-foot-meta";

    const fileInput = document.createElement("input");
    fileInput.id = id("files");
    fileInput.type = "file";
    fileInput.accept = ACCEPTED_IMAGE_ACCEPT;
    fileInput.multiple = true;
    fileInput.tabIndex = -1;
    fileInput.dataset.part = "file-input";
    fileInput.setAttribute("aria-hidden", "true");

    const attachBtn = document.createElement("button");
    attachBtn.type = "button";
    attachBtn.dataset.part = "attach-btn";
    attachBtn.hidden = true;

    const attachIcon = document.createElementNS(svgNS, "svg");
    attachIcon.setAttribute("viewBox", "0 0 16 16");
    attachIcon.setAttribute("aria-hidden", "true");
    attachIcon.dataset.part = "attach-icon";
    const imgRect = document.createElementNS(svgNS, "rect");
    imgRect.setAttribute("x", "1.75");
    imgRect.setAttribute("y", "2.75");
    imgRect.setAttribute("width", "12.5");
    imgRect.setAttribute("height", "10.5");
    imgRect.setAttribute("fill", "none");
    imgRect.setAttribute("stroke", "currentColor");
    imgRect.setAttribute("stroke-width", "1.2");
    const imgDot = document.createElementNS(svgNS, "circle");
    imgDot.setAttribute("cx", "5.5");
    imgDot.setAttribute("cy", "6.2");
    imgDot.setAttribute("r", "1.1");
    imgDot.setAttribute("fill", "currentColor");
    const imgMount = document.createElementNS(svgNS, "path");
    imgMount.setAttribute("d", "M2.3 12.2l3.4-3.5 2.4 2.3 2.1-2.1 3.5 3.3");
    imgMount.setAttribute("fill", "none");
    imgMount.setAttribute("stroke", "currentColor");
    imgMount.setAttribute("stroke-width", "1.15");
    imgMount.setAttribute("stroke-linejoin", "miter");
    attachIcon.append(imgRect, imgDot, imgMount);

    const attachBtnLabel = document.createElement("span");
    attachBtn.append(attachIcon, attachBtnLabel);

    const statusLine = document.createElement("div");
    statusLine.dataset.part = "status-line";
    statusLine.setAttribute("role", "status");
    statusLine.setAttribute("aria-live", "polite");

    composerFootMeta.append(fileInput, attachBtn, statusLine);

    const submitBtn = document.createElement("button");
    submitBtn.type = "submit";
    submitBtn.dataset.part = "submit";

    // Swiss Registration Crosshair SVG
    const glyph = document.createElementNS(svgNS, "svg");
    glyph.setAttribute("viewBox", "0 0 18 18");
    glyph.setAttribute("aria-hidden", "true");
    glyph.dataset.part = "seal-glyph";
    const outerRing = document.createElementNS(svgNS, "circle");
    outerRing.setAttribute("cx", "9");
    outerRing.setAttribute("cy", "9");
    outerRing.setAttribute("r", "6.5");
    outerRing.setAttribute("fill", "none");
    outerRing.setAttribute("stroke", "currentColor");
    outerRing.setAttribute("stroke-width", "1.1");
    const crossH = document.createElementNS(svgNS, "line");
    crossH.setAttribute("x1", "1");
    crossH.setAttribute("y1", "9");
    crossH.setAttribute("x2", "17");
    crossH.setAttribute("y2", "9");
    crossH.setAttribute("stroke", "currentColor");
    crossH.setAttribute("stroke-width", "0.9");
    crossH.setAttribute("stroke-opacity", "0.45");
    const crossV = document.createElementNS(svgNS, "line");
    crossV.setAttribute("x1", "9");
    crossV.setAttribute("y1", "1");
    crossV.setAttribute("x2", "9");
    crossV.setAttribute("y2", "17");
    crossV.setAttribute("stroke", "currentColor");
    crossV.setAttribute("stroke-width", "0.9");
    crossV.setAttribute("stroke-opacity", "0.45");
    const sealDot = document.createElementNS(svgNS, "circle");
    sealDot.setAttribute("cx", "9");
    sealDot.setAttribute("cy", "9");
    sealDot.setAttribute("r", "2.4");
    sealDot.dataset.part = "seal-dot";
    glyph.append(outerRing, crossH, crossV, sealDot);

    const submitText = document.createElement("span");
    submitBtn.append(glyph, submitText);

    composerFoot.append(composerFootMeta, submitBtn);

    form.append(authorBanner, replyBanner, hpWrap, bodyField, metaRow, sealDrawer, composerFoot);

    // 4. Thread sub-header & list container
    const threadBar = document.createElement("div");
    threadBar.dataset.part = "thread-bar";
    threadBar.hidden = true;

    const threadSummary = document.createElement("span");
    threadSummary.dataset.part = "thread-summary";

    const sortGroup = document.createElement("div");
    sortGroup.dataset.part = "sort-group";
    sortGroup.setAttribute("role", "group");
    sortGroup.hidden = true;

    const sortIndicator = document.createElement("span");
    sortIndicator.dataset.part = "sort-indicator";
    sortIndicator.setAttribute("aria-hidden", "true");

    const sortOldestBtn = document.createElement("button");
    sortOldestBtn.type = "button";
    sortOldestBtn.dataset.part = "sort-btn";
    sortOldestBtn.dataset.sort = "oldest";
    sortOldestBtn.setAttribute("aria-pressed", "true");

    const sortNewestBtn = document.createElement("button");
    sortNewestBtn.type = "button";
    sortNewestBtn.dataset.part = "sort-btn";
    sortNewestBtn.dataset.sort = "newest";
    sortNewestBtn.setAttribute("aria-pressed", "false");

    sortGroup.append(sortOldestBtn, sortNewestBtn, sortIndicator);
    threadBar.append(threadSummary, sortGroup);

    const stateNote = document.createElement("p");
    stateNote.dataset.part = "loading";
    stateNote.textContent = c.loading;

    const list = document.createElement("ol");
    list.dataset.part = "list";
    list.setAttribute("aria-label", c.heading);

    const threadShell = document.createElement("div");
    threadShell.dataset.part = "thread-shell";
    threadShell.append(threadBar, stateNote, list);

    panelBody.append(form, threadShell);
    panel.append(panelBody);

    // 5. Native Modal Image Lightbox (<dialog closedby="any">)
    const lightbox = document.createElement("dialog");
    lightbox.dataset.part = "lightbox";
    lightbox.setAttribute("closedby", "any");
    lightbox.setAttribute("aria-labelledby", id("lightbox-title"));

    const lightboxHead = document.createElement("div");
    lightboxHead.dataset.part = "lightbox-head";

    const lightboxTitle = document.createElement("h2");
    lightboxTitle.id = id("lightbox-title");
    lightboxTitle.dataset.part = "lightbox-title";

    const lightboxTools = document.createElement("div");
    lightboxTools.dataset.part = "lightbox-tools";

    const lightboxOrigin = document.createElement("a");
    lightboxOrigin.dataset.part = "lightbox-origin";
    lightboxOrigin.target = "_blank";
    lightboxOrigin.rel = "noopener noreferrer";
    lightboxOrigin.hidden = true;

    const lightboxCloseForm = document.createElement("form");
    lightboxCloseForm.method = "dialog";
    const lightboxCloseBtn = document.createElement("button");
    lightboxCloseBtn.type = "submit";
    lightboxCloseBtn.dataset.part = "lightbox-close";
    lightboxCloseBtn.autofocus = true;
    lightboxCloseForm.append(lightboxCloseBtn);

    lightboxTools.append(lightboxOrigin, lightboxCloseForm);
    lightboxHead.append(lightboxTitle, lightboxTools);

    const lightboxStage = document.createElement("div");
    lightboxStage.dataset.part = "lightbox-stage";

    const lightboxPrevBtn = document.createElement("button");
    lightboxPrevBtn.type = "button";
    lightboxPrevBtn.dataset.part = "lightbox-nav";
    lightboxPrevBtn.dataset.dir = "prev";
    lightboxPrevBtn.textContent = "←";
    lightboxPrevBtn.hidden = true;

    const lightboxFigure = document.createElement("figure");
    lightboxFigure.dataset.part = "lightbox-figure";

    const lightboxImg = document.createElement("img");
    lightboxImg.dataset.part = "lightbox-img";
    lightboxImg.alt = "";

    const lightboxMeta = document.createElement("figcaption");
    lightboxMeta.dataset.part = "lightbox-meta";

    lightboxFigure.append(lightboxImg, lightboxMeta);

    const lightboxNextBtn = document.createElement("button");
    lightboxNextBtn.type = "button";
    lightboxNextBtn.dataset.part = "lightbox-nav";
    lightboxNextBtn.dataset.dir = "next";
    lightboxNextBtn.textContent = "→";
    lightboxNextBtn.hidden = true;

    lightboxStage.append(lightboxPrevBtn, lightboxFigure, lightboxNextBtn);
    lightbox.append(lightboxHead, lightboxStage);

    // 6. Native Modal Author Auth Dialog (<dialog closedby="any">)
    const authDialog = document.createElement("dialog");
    authDialog.dataset.part = "auth-dialog";
    authDialog.setAttribute("closedby", "any");
    authDialog.setAttribute("aria-labelledby", id("auth-title"));

    const authHead = document.createElement("div");
    authHead.dataset.part = "auth-head";

    const authHeadingWrap = document.createElement("div");
    authHeadingWrap.dataset.part = "auth-heading-wrap";

    const authBadge = document.createElement("span");
    authBadge.dataset.part = "author-badge";

    const authTitle = document.createElement("h2");
    authTitle.id = id("auth-title");
    authTitle.dataset.part = "auth-title";

    authHeadingWrap.append(authBadge, authTitle);

    const authCloseForm = document.createElement("form");
    authCloseForm.method = "dialog";
    const authCloseBtn = document.createElement("button");
    authCloseBtn.type = "submit";
    authCloseBtn.dataset.part = "auth-close";
    authCloseForm.append(authCloseBtn);

    authHead.append(authHeadingWrap, authCloseForm);

    const authForm = document.createElement("form");
    authForm.dataset.part = "auth-form";
    authForm.method = "post";
    authForm.noValidate = true;

    const authDesc = document.createElement("p");
    authDesc.id = id("auth-desc");
    authDesc.dataset.part = "auth-desc";

    const authField = document.createElement("div");
    authField.dataset.part = "auth-field";

    const authLabel = document.createElement("label");
    authLabel.htmlFor = id("auth-password");
    authLabel.dataset.part = "label";

    const authInputWrap = document.createElement("div");
    authInputWrap.dataset.part = "auth-input-wrap";

    const authInput = document.createElement("input");
    authInput.id = id("auth-password");
    authInput.name = "password";
    authInput.type = "password";
    authInput.required = true;
    authInput.autofocus = true;
    authInput.autocomplete = "current-password";
    authInput.setAttribute("autocorrect", "off");
    authInput.setAttribute("autocapitalize", "none");
    authInput.spellcheck = false;
    authInput.enterKeyHint = "done";
    authInput.dataset.part = "auth-input";
    authInput.setAttribute("aria-invalid", "false");
    authInput.setAttribute("aria-describedby", id("auth-desc"));

    const authRevealBtn = document.createElement("button");
    authRevealBtn.type = "button";
    authRevealBtn.dataset.part = "auth-reveal";
    authRevealBtn.setAttribute("aria-pressed", "false");
    authRevealBtn.setAttribute("aria-describedby", id("auth-reveal-warn"));

    const eyeSvg = document.createElementNS(svgNS, "svg");
    eyeSvg.setAttribute("viewBox", "0 0 18 18");
    eyeSvg.setAttribute("aria-hidden", "true");
    eyeSvg.dataset.part = "auth-reveal-icon";
    eyeSvg.dataset.state = "show";
    const eyePath = document.createElementNS(svgNS, "path");
    eyePath.setAttribute("d", "M1.75 9s2.75-4.75 7.25-4.75S16.25 9 16.25 9s-2.75 4.75-7.25 4.75S1.75 9 1.75 9Z");
    eyePath.setAttribute("fill", "none");
    eyePath.setAttribute("stroke", "currentColor");
    eyePath.setAttribute("stroke-width", "1.3");
    const eyePupil = document.createElementNS(svgNS, "circle");
    eyePupil.setAttribute("cx", "9");
    eyePupil.setAttribute("cy", "9");
    eyePupil.setAttribute("r", "2.1");
    eyePupil.setAttribute("fill", "none");
    eyePupil.setAttribute("stroke", "currentColor");
    eyePupil.setAttribute("stroke-width", "1.3");
    eyeSvg.append(eyePath, eyePupil);

    const eyeOffSvg = document.createElementNS(svgNS, "svg");
    eyeOffSvg.setAttribute("viewBox", "0 0 18 18");
    eyeOffSvg.setAttribute("aria-hidden", "true");
    eyeOffSvg.dataset.part = "auth-reveal-icon";
    eyeOffSvg.dataset.state = "hide";
    const eyeOffArc = document.createElementNS(svgNS, "path");
    eyeOffArc.setAttribute("d", "M3.2 5.9C2.25 7.15 1.75 9 1.75 9s2.75 4.75 7.25 4.75c1.38 0 2.6-.44 3.63-1.08M6.38 4.65A7.6 7.6 0 0 1 9 4.25c4.5 0 7.25 4.75 7.25 4.75a12.3 12.3 0 0 1-1.58 2.1");
    eyeOffArc.setAttribute("fill", "none");
    eyeOffArc.setAttribute("stroke", "currentColor");
    eyeOffArc.setAttribute("stroke-width", "1.3");
    eyeOffArc.setAttribute("stroke-linecap", "square");
    const eyeSlash = document.createElementNS(svgNS, "line");
    eyeSlash.setAttribute("x1", "2.5");
    eyeSlash.setAttribute("y1", "2.5");
    eyeSlash.setAttribute("x2", "15.5");
    eyeSlash.setAttribute("y2", "15.5");
    eyeSlash.setAttribute("stroke", "currentColor");
    eyeSlash.setAttribute("stroke-width", "1.3");
    eyeSlash.setAttribute("stroke-linecap", "square");
    eyeOffSvg.append(eyeOffArc, eyeSlash);

    authRevealBtn.append(eyeSvg, eyeOffSvg);

    const authRevealWarn = document.createElement("span");
    authRevealWarn.id = id("auth-reveal-warn");
    authRevealWarn.dataset.part = "sr-only";

    authInputWrap.append(authInput, authRevealBtn, authRevealWarn);

    const authError = document.createElement("p");
    authError.id = id("auth-error");
    authError.dataset.part = "auth-error";
    authError.setAttribute("role", "alert");
    authError.setAttribute("aria-live", "polite");
    authError.hidden = true;

    authField.append(authLabel, authInputWrap, authError);

    const authActions = document.createElement("div");
    authActions.dataset.part = "auth-actions";

    const authCancelBtn = document.createElement("button");
    authCancelBtn.type = "button";
    authCancelBtn.dataset.part = "auth-cancel";

    const authSubmitBtn = document.createElement("button");
    authSubmitBtn.type = "submit";
    authSubmitBtn.dataset.part = "auth-submit";

    authActions.append(authCancelBtn, authSubmitBtn);
    authForm.append(authDesc, authField, authActions);
    authDialog.append(authHead, authForm);

    root.append(heading, panel, lightbox, authDialog);
    this.replaceChildren(root);

    this.#els = {
      root,
      edges,
      toggle,
      title,
      count,
      toggleHint,
      toggleLabelOpen,
      toggleLabelClose,
      panel,
      panelBody,
      threadShell,
      form,
      authorBanner,
      authorBannerBadge,
      authorBannerText,
      authorSignOutBtn,
      replyBanner,
      replyLabel,
      cancelReplyBtn,
      hpInput,
      bodyLabelText,
      charCount,
      textarea,
      composerMedia,
      stagedList,
      altDrawer,
      altBar,
      altCaret,
      altTag,
      altInput,
      altDoneBtn,
      dropCue,
      bodyError,
      mediaError,
      nameLabel,
      nameInput,
      urlLabel,
      urlInput,
      urlError,
      sealDrawer,
      sealDrawerText,
      turnstileMount,
      fileInput,
      attachBtn,
      attachBtnLabel,
      statusLine,
      submitBtn,
      submitText,
      threadBar,
      threadSummary,
      sortGroup,
      sortOldestBtn,
      sortNewestBtn,
      stateNote,
      list,
      lightbox,
      lightboxTitle,
      lightboxOrigin,
      lightboxCloseForm,
      lightboxCloseBtn,
      lightboxPrevBtn,
      lightboxNextBtn,
      lightboxImg,
      lightboxMeta,
      authDialog,
      authBadge,
      authTitle,
      authCloseForm,
      authCloseBtn,
      authForm,
      authDesc,
      authField,
      authLabel,
      authInput,
      authRevealBtn,
      authRevealWarn,
      authError,
      authCancelBtn,
      authSubmitBtn,
    };

    this.#syncStaticLabels();
    this.#bindEvents();
  }

  #syncStaticLabels() {
    const c = this.#copy;
    this.#els.title.textContent = this.getAttribute("heading") || c.heading;
    this.#els.toggleHint.textContent = c.toggleHint;
    this.#els.toggleLabelOpen.textContent = c.expandLabel;
    this.#els.toggleLabelClose.textContent = c.collapseLabel;
    this.#els.list.setAttribute("aria-label", this.#els.title.textContent);
    this.#els.bodyLabelText.textContent = c.bodyLabel;
    this.#els.textarea.placeholder = this.getAttribute("placeholder") || c.bodyPlaceholder;
    this.#els.bodyError.textContent = this.#config.imagesEnabled ? c.bodyOrImageError : c.bodyError;
    this.#els.dropCue.textContent = c.dropHint;
    this.#els.nameLabel.textContent = c.nameLabel;
    this.#els.nameInput.placeholder = this.#authorMode && this.#authorName ? this.#authorName : c.namePlaceholder;
    this.#els.urlLabel.textContent = c.urlLabel;
    this.#els.urlInput.placeholder = c.urlPlaceholder;
    this.#els.urlError.textContent = c.urlError;
    this.#els.sealDrawerText.textContent = c.interactiveCopy;
    this.#els.cancelReplyBtn.textContent = c.cancelReply;
    this.#els.authorBannerBadge.textContent = c.authorBadge;
    this.#els.authorBannerText.textContent = c.authorModeBanner(this.#authorName);
    this.#els.authorSignOutBtn.textContent = c.authorSignOut;
    this.#els.authBadge.textContent = c.authorBadge;
    this.#els.authTitle.textContent = c.authDialogTitle;
    this.#els.authCloseBtn.textContent = c.lightboxClose;
    this.#els.authLabel.textContent = c.authPasswordLabel;
    this.#els.authInput.placeholder = c.authPasswordPlaceholder;
    this.#els.authRevealWarn.textContent = c.authShowWarning;
    const isRevealed = this.#els.authInput.type === "text";
    this.#els.authRevealBtn.setAttribute("aria-label", isRevealed ? c.authHidePassword : c.authShowPassword);
    this.#els.authCancelBtn.textContent = c.authCancel;
    this.#syncAuthDialogMode();
    if (this.#authErrorKey) {
      this.#setAuthError(this.#authErrorKey);
    }
    this.#els.sortOldestBtn.textContent = c.sortOldest;
    this.#els.sortNewestBtn.textContent = c.sortNewest;
    this.#els.lightboxCloseBtn.textContent = c.lightboxClose;
    this.#els.lightboxOrigin.textContent = c.lightboxOpenOriginal;
    this.#els.lightboxPrevBtn.setAttribute("aria-label", c.lightboxPrev);
    this.#els.lightboxNextBtn.setAttribute("aria-label", c.lightboxNext);
    if (this.#els.lightbox?.open) {
      this.#renderLightboxSlide();
    }
    this.#syncAttachmentUi();
    if (this.#submitting) {
      this.#els.submitText.textContent = c.submitSub;
    } else if (Date.now() >= this.#cooldownUntil) {
      this.#els.submitText.textContent = c.submit;
    }
    if (this.#els.statusLine && this.#statusKey) {
      this.#els.statusLine.textContent = this.#resolveStatusCopy(this.#statusKey);
    }
    if (this.#replyTarget) {
      this.#els.replyLabel.textContent = c.replyingTo(this.#replyDisplayName(this.#replyTarget));
    }
    if (this.#loadFailed) {
      this.#renderLoadError();
    } else if (!this.#loaded) {
      this.#els.stateNote.textContent = c.loading;
    }
    this.#syncCount();
    this.#lastToggleMeasureWidth = -1;
    this.#syncHintFit({ force: true });
    this.#syncToggleEdgeGeometry();
  }

  #replyDisplayName(target) {
    return target?.rawName || this.#copy.anonymous;
  }

  #renderLoadError() {
    this.#els.threadBar.hidden = true;
    this.#els.list.replaceChildren();
    this.#els.stateNote.dataset.part = "empty";
    this.#els.stateNote.dataset.state = "error";
    this.#els.stateNote.hidden = false;
    const msgSpan = document.createElement("span");
    msgSpan.textContent = this.#copy.loadError;
    const retryBtn = document.createElement("button");
    retryBtn.type = "button";
    retryBtn.dataset.part = "action-btn";
    retryBtn.textContent = this.#copy.retry;
    retryBtn.addEventListener("click", () => {
      this.#loadFailed = false;
      delete this.#els.stateNote.dataset.state;
      this.#els.stateNote.dataset.part = "loading";
      this.#els.stateNote.textContent = this.#copy.loading;
      this.#fetchThread();
    });
    this.#els.stateNote.replaceChildren(msgSpan, retryBtn);
  }

  #syncCount() {
    const c = this.#copy;
    const total = this.#comments.length;
    this.#setCustomState("empty", this.#loaded && total === 0);
    if (!this.#loaded) {
      this.#els.count.textContent = "";
      return;
    }
    if (total === 0) this.#els.count.textContent = c.countZero;
    else if (total === 1) this.#els.count.textContent = c.countOne;
    else this.#els.count.textContent = c.countMany(total);
  }

  #syncFieldAria(el, showError = false) {
    const errorId = el.dataset.error;
    const errNode = errorId ? document.getElementById(errorId) : null;
    const trimmed = el.value.trim();
    let invalid = false;
    if (el === this.#els.textarea) {
      const hasImages = this.#attachments.length > 0;
      invalid =
        trimmed.length > this.#config.maxBodyLength ||
        (!hasImages && trimmed.length < this.#config.minBodyLength);
    } else if (el === this.#els.urlInput) {
      invalid = trimmed.length > 0 && (!el.validity.valid || !isSafeHttpUrl(trimmed));
    }
    const markInvalid = showError && invalid;
    el.setAttribute("aria-invalid", markInvalid ? "true" : "false");
    el.classList.toggle("user-invalid-fallback", markInvalid);
    if (errNode) {
      errNode.hidden = !markInvalid;
      errNode.dataset.visible = markInvalid ? "true" : "false";
    }
    if (errorId) {
      const ids = (el.getAttribute("aria-describedby") || "")
        .split(/\s+/)
        .filter((x) => x && x !== errorId);
      if (markInvalid) ids.push(errorId);
      if (ids.length) el.setAttribute("aria-describedby", ids.join(" "));
      else el.removeAttribute("aria-describedby");
    }
    return !invalid;
  }

  async #hideDiscrete(el) {
    if (!el || el.hidden) return;
    if (canTransitionDisplay()) {
      el.hidden = true;
      return;
    }
    el.setAttribute("data-closing", "");
    const anims = el.getAnimations();
    if (anims.length > 0) {
      await Promise.race([
        Promise.allSettled(anims.map((a) => a.finished)),
        new Promise((r) => window.setTimeout(r, 400)),
      ]);
    }
    if (el.hasAttribute("data-closing")) {
      el.removeAttribute("data-closing");
      el.hidden = true;
    }
  }

  #showDiscrete(el) {
    if (!el) return;
    el.removeAttribute("data-closing");
    el.hidden = false;
  }

  #bindEvents() {
    const {
      toggle,
      textarea,
      nameInput,
      urlInput,
      form,
      cancelReplyBtn,
      sortOldestBtn,
      sortNewestBtn,
      fileInput,
      attachBtn,
      lightbox,
      lightboxCloseForm,
      lightboxPrevBtn,
      lightboxNextBtn,
      authorSignOutBtn,
      authDialog,
      authCloseForm,
      authForm,
      authInput,
      authRevealBtn,
      authCancelBtn,
    } = this.#els;

    // Click-to-expand & load
    toggle.addEventListener("click", () => {
      if (this.#expanded) this.collapse();
      else this.expand();
    });

    // Silent background warmup when the reader starts interacting with the composer
    const triggerWarmup = () => {
      if (!this.#loaded && !this.#loading) this.#fetchThread();
      if (!this.#authorMode) this.#warmupAntiAbuse();
    };
    textarea.addEventListener("focus", triggerWarmup);
    nameInput.addEventListener("focus", triggerWarmup);

    // Character counter + /author slash command + clear validation errors on input
    textarea.addEventListener("input", (event) => {
      if (!event.isComposing && this.#isAuthorSlashCommand(textarea.value)) {
        this.#consumeAuthorCommand();
        return;
      }
      const len = textarea.value.trim().length;
      this.#els.charCount.textContent = `${len} / ${this.#config.maxBodyLength}`;
      if (textarea.getAttribute("aria-invalid") === "true") {
        this.#syncFieldAria(textarea, true);
      }
      if (len >= 2 && !this.#authorMode) this.#warmupAntiAbuse();
    });

    textarea.addEventListener("compositionend", () => {
      if (this.#isAuthorSlashCommand(textarea.value)) {
        this.#consumeAuthorCommand();
      }
    });

    textarea.addEventListener("blur", () => {
      if (textarea.value.length > 0) {
        this.#syncFieldAria(textarea, true);
      }
    });

    // Paste image files from clipboard into composer
    form.addEventListener("paste", (event) => {
      if (!this.#config.imagesEnabled || this.#submitting) return;
      const items = [...(event.clipboardData?.items || [])];
      const imageFiles = items
        .filter((it) => it.kind === "file" && it.type.startsWith("image/"))
        .map((it) => it.getAsFile())
        .filter(Boolean);
      if (imageFiles.length === 0) return;
      event.preventDefault();
      triggerWarmup();
      this.#addImageFiles(imageFiles);
    });

    // Drag & drop image files onto composer frame
    const hasDraggedFiles = (event) => {
      const types = event.dataTransfer?.types;
      return Boolean(types && [...types].includes("Files"));
    };
    const clearDragVisual = () => {
      this.#dragDepth = 0;
      delete form.dataset.dragover;
      this.#els.dropCue.hidden = true;
    };
    form.addEventListener("dragenter", (event) => {
      if (!this.#config.imagesEnabled || this.#submitting || !hasDraggedFiles(event)) return;
      event.preventDefault();
      this.#dragDepth += 1;
      form.dataset.dragover = "true";
      this.#els.dropCue.hidden = false;
    });
    form.addEventListener("dragover", (event) => {
      if (!this.#config.imagesEnabled || this.#submitting || !hasDraggedFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    });
    form.addEventListener("dragleave", (event) => {
      if (!hasDraggedFiles(event)) return;
      this.#dragDepth = Math.max(0, this.#dragDepth - 1);
      if (this.#dragDepth === 0) clearDragVisual();
    });
    form.addEventListener("drop", (event) => {
      if (!hasDraggedFiles(event)) return;
      event.preventDefault();
      clearDragVisual();
      if (!this.#config.imagesEnabled || this.#submitting) return;
      const dropped = [...(event.dataTransfer?.files || [])];
      if (dropped.length > 0) {
        triggerWarmup();
        this.#addImageFiles(dropped);
      }
    });

    // File picker trigger
    attachBtn.addEventListener("click", () => {
      if (!this.#config.imagesEnabled || this.#submitting || this.#processingImages) return;
      triggerWarmup();
      fileInput.value = "";
      fileInput.click();
    });

    fileInput.addEventListener("change", () => {
      const picked = [...(fileInput.files || [])];
      fileInput.value = "";
      if (picked.length > 0) {
        this.#addImageFiles(picked);
      }
    });

    urlInput.addEventListener("input", () => {
      if (urlInput.getAttribute("aria-invalid") === "true") {
        this.#syncFieldAria(urlInput, true);
      }
    });
    urlInput.addEventListener("blur", () => {
      if (urlInput.value.trim().length > 0) {
        this.#syncFieldAria(urlInput, true);
      }
    });

    // IME-safe Ctrl/Cmd + Enter submission shortcut in textarea
    textarea.addEventListener("keydown", (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        if (event.isComposing || event.keyCode === 229) return;
        event.preventDefault();
        this.#suppressAltSubmitUntil = 0;
        this.#explicitSubmit = true;
        try {
          form.requestSubmit();
        } finally {
          this.#explicitSubmit = false;
        }
      }
    });

    // IME-safe Enter guard on single-line inputs
    for (const field of [nameInput, urlInput]) {
      field.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && (event.isComposing || event.keyCode === 229)) {
          event.preventDefault();
        }
      });
    }

    const getActiveEl = () => {
      const root = form.getRootNode?.();
      return root && "activeElement" in root ? root.activeElement : document.activeElement;
    };

    let explicitSubmitTimer = 0;
    this.#els.submitBtn?.addEventListener("click", (event) => {
      // Distinguish explicit activations (pointer, keyboard on submitBtn, programmatic .click())
      // from Chromium's trusted detail===0 synthetic click emitted during implicit <input> Enter submit.
      if (!event.isTrusted || event.detail > 0 || getActiveEl() === this.#els.submitBtn) {
        this.#suppressAltSubmitUntil = 0;
        this.#explicitSubmit = true;
        window.clearTimeout(explicitSubmitTimer);
        explicitSubmitTimer = window.setTimeout(() => {
          this.#explicitSubmit = false;
        }, 0);
      }
    });

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      window.clearTimeout(explicitSubmitTimer);
      const explicit = this.#explicitSubmit;
      this.#explicitSubmit = false;
      if (explicit) {
        this.#suppressAltSubmitUntil = 0;
        this.#handleSubmit();
        return;
      }
      const activeEl = getActiveEl();
      if (this.#els.altDrawer?.contains(activeEl) && activeEl !== this.#els.submitBtn) {
        this.#closeAltEditor({ restoreFocus: true });
        return;
      }
      if (
        this.#suppressAltSubmitUntil > performance.now() &&
        activeEl !== this.#els.submitBtn &&
        activeEl !== this.#els.textarea &&
        activeEl !== this.#els.nameInput &&
        activeEl !== this.#els.urlInput
      ) {
        this.#suppressAltSubmitUntil = 0;
        return;
      }
      this.#suppressAltSubmitUntil = 0;
      this.#handleSubmit();
    });

    cancelReplyBtn.addEventListener("click", () => {
      this.#clearReplyTarget();
    });

    // Animated Oldest / Newest sort switcher
    for (const btn of [sortOldestBtn, sortNewestBtn]) {
      btn.addEventListener("click", () => {
        const nextOrder = btn.dataset.sort === "newest" ? "newest" : "oldest";
        if (nextOrder === this.#sortOrder) return;
        const direction = nextOrder === "newest" ? 1 : -1;
        this.#sortOrder = nextOrder;
        this.#renderThread("", { sortDirection: direction });
        this.#syncSortIndicator(true);
      });
    }

    // Native modal lightbox interactions (Esc, Safari light-dismiss, top-layer exit, arrow nav)
    lightbox.addEventListener("cancel", (event) => {
      if (!supportsTopLayerExit()) {
        event.preventDefault();
        this.#closeLightbox();
      }
    });

    lightboxCloseForm.addEventListener("submit", (event) => {
      if (!supportsTopLayerExit()) {
        event.preventDefault();
        this.#closeLightbox();
      }
    });

    lightbox.addEventListener("close", () => {
      const closeOp = ++this.#lightboxOp;
      lightbox.removeAttribute("data-closing");
      lightbox.returnValue = "";
      const clearSrc = () => {
        if (closeOp === this.#lightboxOp && !lightbox.open) {
          this.#els.lightboxImg.removeAttribute("src");
        }
      };
      const anims =
        typeof lightbox.getAnimations === "function"
          ? lightbox.getAnimations({ subtree: true })
          : [];
      if (anims.length > 0) {
        Promise.race([
          Promise.allSettled(anims.map((a) => a.finished)),
          new Promise((r) => window.setTimeout(r, 450)),
        ]).then(clearSrc);
      } else {
        clearSrc();
      }
    });

    if (!("closedBy" in HTMLDialogElement.prototype)) {
      const isOutside = (e) => {
        const r = lightbox.getBoundingClientRect();
        return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
      };
      let pressedOutside = false;
      lightbox.addEventListener("pointerdown", (e) => {
        pressedOutside = isOutside(e);
      });
      lightbox.addEventListener("pointerup", (e) => {
        if (pressedOutside && isOutside(e)) {
          this.#closeLightbox();
        }
        pressedOutside = false;
      });
    }

    lightbox.addEventListener("keydown", (event) => {
      if (this.#lightboxItems.length <= 1) return;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        this.#stepLightbox(-1);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        this.#stepLightbox(1);
      }
    });

    lightboxPrevBtn.addEventListener("click", () => this.#stepLightbox(-1));
    lightboxNextBtn.addEventListener("click", () => this.#stepLightbox(1));

    // Staged image alt-text drawer interactions
    const { altInput, altDoneBtn } = this.#els;
    altInput.addEventListener("input", () => {
      const uid = this.#editingAltUid;
      if (!uid) return;
      const att = this.#attachments.find((a) => a.uid === uid);
      if (!att) return;
      att.alt = altInput.value;
      const btn = this.#els.stagedList?.querySelector(
        `[data-part="staged-alt-btn"][data-uid="${CSS.escape(uid)}"]`
      );
      if (btn) {
        const filled = Boolean(att.alt.trim());
        if (filled) btn.dataset.hasAlt = "true";
        else delete btn.dataset.hasAlt;
        btn.textContent = filled ? this.#copy.altBtnFilled : this.#copy.altBtn;
      }
    });
    altInput.addEventListener("keydown", (event) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === "Enter" || event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (event.key === "Enter") {
          this.#suppressAltSubmitUntil = performance.now() + 250;
        }
        this.#closeAltEditor({ restoreFocus: true });
      }
    });
    altDoneBtn.addEventListener("click", () => {
      this.#closeAltEditor({ restoreFocus: true });
    });

    // Author mode banner & native modal auth dialog interactions
    authorSignOutBtn.addEventListener("click", () => {
      this.#handleAuthorLogout({ fromDialog: false });
    });

    authInput.addEventListener("input", () => {
      if (this.#authErrorKey) {
        this.#setAuthError("");
      }
    });

    authInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.isComposing || event.keyCode === 229)) {
        event.preventDefault();
      }
    });

    authRevealBtn.addEventListener("click", () => {
      const reveal = authInput.type === "password";
      authInput.type = reveal ? "text" : "password";
      authRevealBtn.setAttribute("aria-pressed", reveal ? "true" : "false");
      authRevealBtn.setAttribute("aria-label", reveal ? this.#copy.authHidePassword : this.#copy.authShowPassword);
      if (reveal) authRevealBtn.dataset.revealed = "true";
      else delete authRevealBtn.dataset.revealed;
      authInput.focus({ preventScroll: true });
    });

    authCancelBtn.addEventListener("click", () => {
      this.#closeAuthDialog();
    });

    authForm.addEventListener("submit", (event) => {
      event.preventDefault();
      if (this.#authorMode) {
        this.#handleAuthorLogout({ fromDialog: true });
      } else {
        this.#handleAuthVerify();
      }
    });

    authDialog.addEventListener("cancel", (event) => {
      if (!supportsTopLayerExit()) {
        event.preventDefault();
        this.#closeAuthDialog();
      }
    });

    authCloseForm.addEventListener("submit", (event) => {
      if (!supportsTopLayerExit()) {
        event.preventDefault();
        this.#closeAuthDialog();
      }
    });

    authDialog.addEventListener("close", () => {
      ++this.#authOp;
      authDialog.removeAttribute("data-closing");
      authDialog.returnValue = "";
      this.#resetAuthDialogInputs();
      if (this.#authReturnFocusToComposer) {
        this.#authReturnFocusToComposer = false;
        if (this.#els.textarea?.isConnected && !this.#els.panel?.hidden) {
          this.#els.textarea.focus({ preventScroll: true });
        }
      }
    });

    if (!("closedBy" in HTMLDialogElement.prototype)) {
      const isOutsideAuth = (e) => {
        const r = authDialog.getBoundingClientRect();
        return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
      };
      let pressedOutsideAuth = false;
      authDialog.addEventListener("pointerdown", (e) => {
        pressedOutsideAuth = isOutsideAuth(e);
      });
      authDialog.addEventListener("pointerup", (e) => {
        if (pressedOutsideAuth && isOutsideAuth(e)) {
          this.#closeAuthDialog();
        }
        pressedOutsideAuth = false;
      });
    }
  }

  #scheduleStatusReset(delayMs = 2600) {
    window.clearTimeout(this.#statusResetTimer);
    this.#statusResetTimer = window.setTimeout(() => {
      if (!this.#submitting && Date.now() >= this.#cooldownUntil && !this.#turnstileInteractive) {
        this.#setSealProgress(0);
        this.#setPhase("idle", "statusReady");
      }
    }, delayMs);
  }

  #isGateExpired() {
    if (!this.#gate?.token) return true;
    const exp = Number(this.#gate.expiresAt || 0);
    return exp > 0 && Date.now() >= exp - 5000;
  }

  #fetchThread({ refreshGateOnly = false } = {}) {
    if (this.#fetchPromise) {
      return this.#fetchPromise;
    }
    const seq = ++this.#fetchSeq;
    const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    this.#fetchAbort = ctrl;
    this.#loading = true;
    if (!refreshGateOnly) {
      this.#loadFailed = false;
    }
    const reqSlug = this.slug;
    const query = new URLSearchParams({ slug: reqSlug });
    const url = `${this.endpoint}?${query.toString()}`;

    const promise = (async () => {
      let rejectTimeout;
      const timeoutPromise = new Promise((_, reject) => {
        rejectTimeout = reject;
      });
      let timedOut = false;
      const timeoutId = window.setTimeout(() => {
        timedOut = true;
        ctrl?.abort();
        rejectTimeout?.(new Error("fetch_timeout"));
      }, 15000);

      try {
        const res = await Promise.race([
          fetch(url, {
            credentials: "same-origin",
            headers: { Accept: "application/json" },
            signal: ctrl?.signal,
          }),
          timeoutPromise,
        ]);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await Promise.race([res.json(), timeoutPromise]);
        if (!data || data.ok !== true) throw new Error("Invalid payload");
        if (seq !== this.#fetchSeq || !this.isConnected) return;

        this.#gate = data.gate || null;
        if (data.config && typeof data.config === "object") {
          this.#config = {
            ...this.#config,
            ...data.config,
            imagesEnabled: Boolean(data.config.imagesEnabled),
            maxImages: Number(data.config.maxImages || DEFAULT_MAX_IMAGES),
            maxImageBytes: Number(data.config.maxImageBytes || DEFAULT_MAX_IMAGE_BYTES),
          };
          this.#els.textarea.maxLength = this.#config.maxBodyLength;
          this.#els.nameInput.maxLength = this.#config.maxNameLength;
          if (Array.isArray(this.#config.acceptedImageTypes) && this.#config.acceptedImageTypes.length > 0) {
            this.#els.fileInput.accept = this.#config.acceptedImageTypes.join(",");
          }
          this.#els.bodyError.textContent = this.#config.imagesEnabled
            ? this.#copy.bodyOrImageError
            : this.#copy.bodyError;
          const curLen = this.#els.textarea.value.trim().length;
          this.#els.charCount.textContent = `${curLen} / ${this.#config.maxBodyLength}`;
          this.#setAuthorState(
            Boolean(data.config.authorMode),
            String(data.config.authorName || ""),
            { rerender: refreshGateOnly }
          );
          this.#syncAttachmentUi();
          if (this.#statusKey === "statusReady" && this.#els.statusLine) {
            this.#els.statusLine.textContent = this.#resolveStatusCopy("statusReady");
          }
        }

        if (refreshGateOnly && this.#loaded) {
          return;
        }

        this.#comments = Array.isArray(data.comments) ? data.comments : [];
        const prevPanelHeight = this.#els.panel.hidden ? 0 : readLocalHeight(this.#els.panel);
        const prevBodyMotion = this.#els.panel.hidden ? null : this.#readPanelBodyMotion(false);
        this.#loaded = true;
        this.#loadFailed = false;
        this.dataset.loaded = "true";
        this.#syncCount();
        this.#renderThread("", { revealOnLoad: this.#expanded, prevPanelHeight, prevBodyMotion });
        window.requestAnimationFrame(() => this.#syncSortIndicator(false));
        this.dispatchEvent(
          new CustomEvent("ti-comments:loaded", {
            bubbles: true,
            detail: { slug: reqSlug, count: this.#comments.length },
          })
        );
      } catch (err) {
        if ((!timedOut && err?.name === "AbortError") || seq !== this.#fetchSeq || !this.isConnected) return;
        if (refreshGateOnly && this.#loaded) return;
        this.#loadFailed = true;
        this.#renderLoadError();
      } finally {
        window.clearTimeout(timeoutId);
        if (seq === this.#fetchSeq) {
          this.#loading = false;
          this.#fetchPromise = null;
          if (this.#fetchAbort === ctrl) {
            this.#fetchAbort = null;
          }
        }
      }
    })();

    this.#fetchPromise = promise;
    return promise;
  }

  #cancelTurnstileWait(reason = "turnstile_cancelled") {
    const reject = this.#turnstilePendingReject;
    window.clearTimeout(this.#turnstileWaitTimer);
    this.#turnstileWaitTimer = 0;
    this.#turnstilePendingResolve = null;
    this.#turnstilePendingReject = null;
    reject?.(new Error(reason));
    this.#turnstileWaitSeq += 1;
  }

  #resetAntiAbuseState() {
    this.#cancelTurnstileWait();
    this.#turnstileToken = "";
    this.#precomputedPow = null;
    this.#powAbort?.abort();
    this.#powAbort = null;
    this.#setInteractiveDrawer(false);
    if (this.#turnstileWidgetId !== null && window.turnstile?.reset) {
      try {
        window.turnstile.reset(this.#turnstileWidgetId);
      } catch {
        /* ignore */
      }
    }
  }

  #setInteractiveDrawer(open) {
    this.#turnstileInteractive = open;
    const drawer = this.#els.sealDrawer;
    if (drawer) {
      const op = ++this.#drawerOp;
      if (open) {
        drawer.hidden = false;
        void drawer.offsetHeight;
        drawer.dataset.open = "true";
      } else {
        drawer.dataset.open = "false";
        const hideDrawer = () => {
          if (op === this.#drawerOp && !this.#turnstileInteractive) {
            drawer.hidden = true;
          }
        };
        if (drawer.hidden || reducedMotionQuery.matches || this.hasAttribute("unstyled")) {
          hideDrawer();
        } else {
          const anims = drawer.getAnimations().filter((a) => a instanceof CSSTransition);
          if (anims.length === 0) {
            hideDrawer();
          } else {
            Promise.race([
              Promise.allSettled(anims.map((a) => a.finished)),
              new Promise((r) => window.setTimeout(r, 420)),
            ]).then(hideDrawer);
          }
        }
      }
    }
    this.#setCustomState("interactive", open);
  }

  #remountTurnstileForTheme() {
    if (this.#turnstileWidgetId === null || !window.turnstile?.remove) return;
    try {
      window.turnstile.remove(this.#turnstileWidgetId);
    } catch {
      /* ignore */
    }
    this.#turnstileWidgetId = null;
    this.#turnstileToken = "";
    this.#warmupTurnstile();
  }

  #warmupAntiAbuse() {
    if (this.#submitting || this.#authorMode) return;
    this.#warmupTurnstile();
    this.#warmupLightPow();
  }

  async #warmupLightPow() {
    const gate = this.#gate;
    if (!gate?.token) return;
    const bits = Number(gate.powBits || 12);
    if (this.#precomputedPow && this.#precomputedPow.gateToken === gate.token && this.#precomputedPow.bits >= bits) {
      return;
    }
    this.#powAbort?.abort();
    const ctrl = new AbortController();
    this.#powAbort = ctrl;
    try {
      const nonce = await solveProofOfWork(gate.token, bits, { signal: ctrl.signal });
      if (!ctrl.signal.aborted && this.#gate?.token === gate.token) {
        this.#precomputedPow = { gateToken: gate.token, bits, nonce };
      }
    } catch {
      /* ignore abort */
    }
  }

  async #warmupTurnstile() {
    const sitekey = this.#config.turnstileSitekey;
    if (!sitekey || this.#turnstileUnavailable || this.#turnstileWidgetId !== null) return;
    try {
      const api = await loadTurnstileApi();
      if (this.#turnstileWidgetId !== null || !this.isConnected) return;
      this.#turnstileWidgetId = api.render(this.#els.turnstileMount, {
        sitekey,
        action: this.#config.turnstileAction || "comment",
        appearance: "interaction-only",
        execution: "render",
        theme: getEffectiveColorScheme(this),
        language: this.lang === "en" ? "en" : "zh-cn",
        "response-field": false,
        "refresh-expired": "auto",
        "refresh-timeout": "auto",
        callback: (token) => {
          this.#turnstileToken = token || "";
          this.#setInteractiveDrawer(false);
          if (this.#turnstilePendingResolve) {
            const resolve = this.#turnstilePendingResolve;
            this.#turnstilePendingResolve = null;
            this.#turnstilePendingReject = null;
            resolve(this.#turnstileToken);
          }
        },
        "before-interactive-callback": () => {
          this.#setInteractiveDrawer(true);
          if (this.#submitting) {
            this.#setPhase("interactive", "statusInteractive");
            announcePolite(this.#copy.interactiveCopy);
          }
        },
        "after-interactive-callback": () => {
          this.#setInteractiveDrawer(false);
        },
        "expired-callback": () => {
          this.#turnstileToken = "";
        },
        "timeout-callback": () => {
          this.#turnstileToken = "";
          this.#setInteractiveDrawer(false);
        },
        "error-callback": () => {
          this.#turnstileToken = "";
          this.#turnstileUnavailable = true;
          this.#setInteractiveDrawer(false);
          if (this.#turnstilePendingReject) {
            const reject = this.#turnstilePendingReject;
            this.#turnstilePendingResolve = null;
            this.#turnstilePendingReject = null;
            reject(new Error("turnstile_error"));
          }
        },
        "unsupported-callback": () => {
          this.#turnstileUnavailable = true;
          this.#setInteractiveDrawer(false);
        },
      });
    } catch {
      this.#turnstileUnavailable = true;
    }
  }

  async #acquireTurnstileToken(timeoutMs = 15000) {
    if (!this.#config.turnstileSitekey || this.#turnstileUnavailable) {
      return null;
    }
    if (this.#turnstileToken) {
      return this.#turnstileToken;
    }
    await this.#warmupTurnstile();
    if (this.#turnstileUnavailable || this.#turnstileWidgetId === null) {
      return null;
    }
    if (this.#turnstileToken) {
      return this.#turnstileToken;
    }

    this.#cancelTurnstileWait();
    const waitId = ++this.#turnstileWaitSeq;

    return new Promise((resolve, reject) => {
      const clearOwn = () => {
        if (this.#turnstileWaitSeq === waitId) {
          window.clearTimeout(this.#turnstileWaitTimer);
          this.#turnstileWaitTimer = 0;
          this.#turnstilePendingResolve = null;
          this.#turnstilePendingReject = null;
        }
      };

      const deadline = window.setTimeout(() => {
        if (this.#turnstileWaitSeq !== waitId || !this.#turnstilePendingResolve) return;
        clearOwn();
        if (this.#turnstileInteractive) {
          resolve("__interactive_wait__");
        } else {
          this.#turnstileUnavailable = true;
          reject(new Error("turnstile_wait_timeout"));
        }
      }, timeoutMs);
      this.#turnstileWaitTimer = deadline;

      this.#turnstilePendingResolve = (tok) => {
        if (this.#turnstileWaitSeq !== waitId) return;
        clearOwn();
        resolve(tok);
      };
      this.#turnstilePendingReject = (err) => {
        if (this.#turnstileWaitSeq !== waitId) return;
        clearOwn();
        reject(err);
      };
    });
  }

  #startCooldown(seconds) {
    const secs = Math.max(2, Math.ceil(Number(seconds) || 15));
    this.#cooldownDurationSec = secs;
    this.#cooldownUntil = Date.now() + secs * 1000;
    this.#runCooldownTimer();
  }

  #syncComposerReadyState({ resetPhase = false } = {}) {
    if (!this.#initialized) return;
    const { submitBtn, submitText } = this.#els;
    const c = this.#copy;
    if (this.#submitting) {
      submitBtn.disabled = true;
      submitText.textContent = c.submitSub;
      return;
    }
    const rem = Math.ceil((this.#cooldownUntil - Date.now()) / 1000);
    if (rem > 0) {
      submitBtn.disabled = true;
      submitText.textContent = `${rem}s`;
      this.#setPhase("cooldown", "statusCooldown");
      return;
    }
    if (this.#processingImages) {
      submitBtn.disabled = true;
      submitText.textContent = c.submit;
      this.#setPhase("inking", "statusOptimizing");
      return;
    }
    submitBtn.disabled = false;
    submitText.textContent = c.submit;
    if (
      resetPhase ||
      this.#phase === "cooldown" ||
      (this.#phase === "inking" && this.#statusKey === "statusOptimizing")
    ) {
      this.#setSealProgress(0);
      this.#setPhase("idle", "statusReady");
    }
  }

  #runCooldownTimer() {
    window.clearInterval(this.#cooldownTimer);
    const totalSecs = Math.max(1, this.#cooldownDurationSec || 15);

    const tick = () => {
      const rem = Math.ceil((this.#cooldownUntil - Date.now()) / 1000);
      if (rem <= 0) {
        window.clearInterval(this.#cooldownTimer);
        this.#cooldownTimer = 0;
        this.#cooldownUntil = 0;
        this.#syncComposerReadyState({ resetPhase: true });
        return;
      }
      this.#els.submitBtn.disabled = true;
      this.#els.submitText.textContent = `${rem}s`;
      this.#setSealProgress(Math.min(1, rem / totalSecs));
      this.#setPhase("cooldown", "statusCooldown");
    };

    tick();
    if (this.#cooldownUntil > Date.now()) {
      this.#cooldownTimer = window.setInterval(tick, 250);
    }
  }

  async #handleSubmit() {
    if (this.#submitting || this.#processingImages || Date.now() < this.#cooldownUntil) return;
    const { textarea, nameInput, urlInput, hpInput, submitBtn, submitText } = this.#els;

    if (this.#isAuthorSlashCommand(textarea.value)) {
      this.#consumeAuthorCommand();
      return;
    }

    const bodyOk = this.#syncFieldAria(textarea, true);
    const urlOk = this.#syncFieldAria(urlInput, true);
    if (!bodyOk) {
      textarea.focus();
      announcePolite(this.#config.imagesEnabled ? this.#copy.bodyOrImageError : this.#copy.bodyError);
      return;
    }
    if (!urlOk) {
      urlInput.focus();
      announcePolite(this.#copy.urlError);
      return;
    }

    const submitAsAuthor = this.#authorMode;
    const submittedBody = textarea.value;
    const submittedAttachments = this.#attachments.map((att) => ({
      ...att,
      alt: String(att.alt || "").trim().slice(0, MAX_ALT_LEN),
    }));
    const submittedAttachmentsRev = this.#attachmentsRev;
    const submittedReplyId = this.#replyTarget?.id || null;
    const submittedReplyRev = this.#replyTarget?.rev || 0;
    const body = submittedBody.trim();
    const authorName = nameInput.value.trim();
    const authorUrl = urlInput.value.trim();
    const submitSlug = this.slug;
    const submitEndpoint = this.endpoint;
    const submitLang = this.lang;
    const submitGen = this.#threadGen;
    const submitId = ++this.#submitSeq;
    this.#activeSubmitId = submitId;
    if (!submitAsAuthor) {
      safeStorageSet(STORAGE_NAME_KEY, authorName);
    }
    safeStorageSet(STORAGE_URL_KEY, authorUrl);

    this.#clearMediaError();
    this.#editingAltUid = "";
    this.#submitting = true;
    submitBtn.disabled = true;
    submitText.textContent = this.#copy.submitSub;
    this.#syncAttachmentUi();
    window.clearTimeout(this.#statusResetTimer);

    const startedAt = performance.now();
    const minRitualMs = reducedMotionQuery.matches ? 0 : 280;
    let touchedAntiAbuse = false;
    const isCurrentSubmit = () =>
      this.#threadGen === submitGen && this.#activeSubmitId === submitId && this.isConnected;

    try {
      this.#setPhase("inking", "statusInking");
      this.#setSealProgress(submitAsAuthor ? 0.62 : 0.24);

      let gate = null;
      let turnstileToken = "";
      let powNonce = "";
      let fallbackMode = false;

      if (!submitAsAuthor) {
        if (this.#isGateExpired()) {
          this.#precomputedPow = null;
          await this.#fetchThread({ refreshGateOnly: this.#loaded });
        }
        if (!isCurrentSubmit()) return;

        gate = this.#gate;
        if (!gate?.token || this.#isGateExpired()) {
          throw new Error("missing_gate");
        }

        touchedAntiAbuse = true;
        this.#setPhase("verifying", "statusVerifying");
        this.#setSealProgress(0.48);

        if (this.#config.turnstileSitekey && !this.#turnstileUnavailable) {
          try {
            let tok = await this.#acquireTurnstileToken(6500);
            if (tok === "__interactive_wait__") {
              tok = await this.#acquireTurnstileToken(90000);
            }
            if (tok && tok !== "__interactive_wait__") {
              turnstileToken = tok;
            }
          } catch (err) {
            if (err?.message === "turnstile_cancelled" || !isCurrentSubmit()) {
              return;
            }
            this.#turnstileUnavailable = true;
          }
        }
        if (!isCurrentSubmit()) return;

        fallbackMode = !turnstileToken;
        if (fallbackMode && !this.#config.allowPowFallback) {
          throw new Error("turnstile_failed");
        }

        const targetBits = fallbackMode
          ? Number(gate.fallbackPowBits || 17)
          : Number(gate.powBits || 12);

        if (
          this.#precomputedPow &&
          this.#precomputedPow.gateToken === gate.token &&
          this.#precomputedPow.bits >= targetBits
        ) {
          powNonce = this.#precomputedPow.nonce;
          this.#setSealProgress(0.76);
        } else {
          if (fallbackMode) {
            this.#setPhase("verifying", "statusSealing");
          }
          this.#powAbort?.abort();
          const ctrl = new AbortController();
          this.#powAbort = ctrl;
          powNonce = await solveProofOfWork(gate.token, targetBits, {
            signal: ctrl.signal,
            onProgress: (p) => this.#setSealProgress(0.45 + p * 0.38),
          });
        }
        if (!isCurrentSubmit()) return;

        const minDwell = fallbackMode
          ? Number(gate.fallbackMinDwellMs || 2200)
          : Number(gate.minDwellMs || 1200);
        const elapsedSinceGate = Date.now() - Number(gate.issuedAt || 0);
        if (elapsedSinceGate < minDwell) {
          await new Promise((r) => window.setTimeout(r, Math.min(2500, minDwell - elapsedSinceGate)));
        }
        if (!isCurrentSubmit()) return;
      }

      this.#setSealProgress(0.88);
      if (submittedAttachments.length > 0) {
        this.#setPhase("verifying", "statusUploading");
      }

      const draftFp = JSON.stringify([
        submitSlug,
        submittedReplyId || "",
        body,
        submittedAttachmentsRev,
        submittedAttachments.map((att) => att.alt),
        submitAsAuthor,
      ]);
      if (this.#draftFingerprint !== draftFp || !this.#draftRequestId) {
        this.#draftFingerprint = draftFp;
        this.#draftRequestId =
          typeof crypto?.randomUUID === "function"
            ? `req_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`
            : `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
      }
      const clientRequestId = this.#draftRequestId;

      const reqPayload = {
        slug: submitSlug,
        lang: submitLang,
        parentId: submittedReplyId,
        authorName,
        authorUrl,
        body,
        websiteHp: hpInput.value,
        clientRequestId,
        ...(submitAsAuthor
          ? { expectAuthor: true }
          : {
              gateToken: gate.token,
              powNonce,
              turnstileToken,
              fallbackMode,
            }),
        ...(submittedAttachments.length > 0
          ? { imageAlts: submittedAttachments.map((att) => att.alt) }
          : {}),
      };

      let fetchOpts;
      if (submittedAttachments.length > 0) {
        const fd = new FormData();
        fd.append("payload", JSON.stringify(reqPayload));
        for (const att of submittedAttachments) {
          fd.append("images", att.blob, att.filename);
        }
        fetchOpts = {
          method: "POST",
          credentials: "same-origin",
          headers: { Accept: "application/json" },
          body: fd,
        };
      } else {
        fetchOpts = {
          method: "POST",
          credentials: "same-origin",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify(reqPayload),
        };
      }

      let fetchDispatched = false;
      let res;
      try {
        fetchDispatched = true;
        res = await fetch(submitEndpoint, fetchOpts);
      } catch (netErr) {
        if (fetchDispatched && !submitAsAuthor) {
          // Consumed gate & PoW cannot be safely reused after an ambiguous network failure
          this.#gate = null;
          this.#precomputedPow = null;
        }
        throw netErr;
      }

      const payload = await res.json().catch(() => ({}));
      if (!isCurrentSubmit()) return;

      if (res.ok && payload.ok === true) {
        // Always replace or clear the consumed gate even when nextGate is null
        this.#gate = payload.nextGate || null;
        this.#precomputedPow = null;
        this.#draftRequestId = "";
        this.#draftFingerprint = "";
      } else if (payload.nextGate) {
        this.#gate = payload.nextGate;
        this.#precomputedPow = null;
      } else if (
        !res.ok &&
        (res.status >= 500 ||
          payload.error === "gate_replayed" ||
          payload.error === "gate_expired" ||
          payload.error === "invalid_gate")
      ) {
        this.#gate = null;
        this.#precomputedPow = null;
      }

      if (!res.ok || payload.ok !== true) {
        if (res.status === 401 && payload.error === "author_session_expired") {
          this.#setAuthorState(false, "");
          this.#broadcastAuthorState();
          this.#setPhase("error", "errAuthorExpired");
          announcePolite(this.#copy.errAuthorExpired);
          this.#openAuthDialog({ errorKey: "errAuthorExpired" });
          return;
        }
        if (res.status === 429) {
          const secs = Number(payload.retryAfterSec || 20);
          this.#startCooldown(secs);
          announcePolite(this.#copy.errRateLimited(secs));
          return;
        }
        const errCode = payload.error || "failed";
        let errKey = "errVerifyFailed";
        if (errCode === "duplicate_comment") errKey = "errDuplicate";
        else if (errCode === "too_many_links") errKey = "errTooManyLinks";
        else if (errCode === "too_fast") errKey = "errTooFast";
        else if (errCode === "invalid_url" || errCode === "url_too_long") errKey = "urlError";
        else if (errCode === "too_many_images") errKey = "errImageCount";
        else if (errCode === "image_dimensions_exceeded") errKey = "errImageDimensions";
        else if (errCode === "invalid_image") errKey = "errImageType";
        else if (errCode === "image_too_large") errKey = "errImageTooLarge";
        else if (errCode === "payload_too_large") errKey = "errPayloadTooLarge";
        else if (errCode === "images_unconfigured") errKey = "errImagesUnconfigured";
        else if (errCode === "body_too_short") errKey = this.#config.imagesEnabled ? "bodyOrImageError" : "bodyError";
        this.#setPhase("error", errKey);
        announcePolite(this.#resolveStatusCopy(errKey));
        this.#scheduleStatusReset(4500);
        return;
      }

      if (submittedReplyRev > 0 && this.#replyTarget?.rev === submittedReplyRev) {
        this.#clearReplyTarget();
      }

      const elapsed = performance.now() - startedAt;
      if (elapsed < minRitualMs) {
        await new Promise((r) => window.setTimeout(r, minRitualMs - elapsed));
      }
      if (!isCurrentSubmit()) return;

      this.#setSealProgress(1);
      this.#setPhase("stamped", "statusStamped");

      if (this.#attachmentsRev === submittedAttachmentsRev) {
        this.#clearAttachments({ animate: true });
      }

      // Clear text only if the reader hasn't started typing a new draft while POST was in flight
      if (textarea.value === submittedBody) {
        const curName = nameInput.value;
        const curUrl = urlInput.value;
        this.#els.form.reset();
        nameInput.value = curName;
        urlInput.value = curUrl;
        this.#syncFieldAria(textarea, false);
        this.#syncFieldAria(urlInput, false);
        this.#els.charCount.textContent = `0 / ${this.#config.maxBodyLength}`;
      }

      if (payload.comment) {
        if (!this.#comments.some((c) => c.id === payload.comment.id)) {
          this.#comments.push(payload.comment);
        }
        this.#syncCount();
        this.#renderThread(payload.comment.id);
        this.dispatchEvent(
          new CustomEvent("ti-comments:submitted", {
            bubbles: true,
            detail: { slug: submitSlug, comment: payload.comment },
          })
        );
      }

      announcePolite(this.#copy.statusStamped);
      this.#scheduleStatusReset(2400);
    } catch {
      if (!isCurrentSubmit()) return;
      this.#setPhase("error", "errNetwork");
      announcePolite(this.#copy.errNetwork);
      this.#scheduleStatusReset(4500);
    } finally {
      if (this.#activeSubmitId === submitId && this.#threadGen === submitGen) {
        this.#activeSubmitId = 0;
        this.#submitting = false;
        if (touchedAntiAbuse) {
          this.#resetAntiAbuseState();
        }
        this.#syncComposerReadyState();
        this.#syncAttachmentUi();
      }
    }
  }

  #revokeExitingPreviewUrls() {
    for (const url of this.#exitingPreviewUrls) {
      URL.revokeObjectURL(url);
    }
    this.#exitingPreviewUrls.clear();
  }

  #revokeAttachmentPreviewUrls() {
    for (const att of this.#attachments) {
      if (att.previewUrl) {
        URL.revokeObjectURL(att.previewUrl);
        att.previewUrl = "";
      }
    }
    this.#revokeExitingPreviewUrls();
  }

  #restoreAttachmentPreviewUrls() {
    if (this.#attachments.length === 0) return;
    for (const att of this.#attachments) {
      if (!att.previewUrl && att.blob) {
        att.previewUrl = URL.createObjectURL(att.blob);
      }
    }
    this.#syncAttachmentUi();
  }

  #abortPendingImageQueue() {
    this.#imageOpSeq += 1;
    this.#processingImages = false;
    const pendingBatches = new Set();
    if (this.#activeImageBatch && !this.#activeImageBatch.settled) {
      pendingBatches.add(this.#activeImageBatch);
    }
    this.#activeImageBatch = null;
    for (const entry of this.#pendingFileQueue) {
      if (entry?.batch && !entry.batch.settled) {
        pendingBatches.add(entry.batch);
      }
    }
    this.#pendingFileQueue = [];
    for (const batch of pendingBatches) {
      batch.settled = true;
      batch.resolve({
        ok: false,
        added: batch.added,
        overflowed: batch.overflowed,
        error: batch.firstError,
        addedUids: batch.addedUids,
        cancelled: true,
      });
    }
  }

  #clearAttachments({ animate = false } = {}) {
    const wasProcessing = this.#processingImages;
    const hadItems = this.#attachments.length > 0;
    this.#abortPendingImageQueue();
    this.#editingAltUid = "";
    this.#freshAttachmentUids.clear();

    const shouldAnimate =
      animate &&
      hadItems &&
      this.isConnected &&
      !this.#els.composerMedia?.hidden &&
      !reducedMotionQuery.matches &&
      typeof this.#els.composerMedia?.animate === "function";

    if (shouldAnimate) {
      for (const att of this.#attachments) {
        if (att.previewUrl) {
          this.#exitingPreviewUrls.add(att.previewUrl);
          att.previewUrl = "";
        }
      }
      this.#attachments = [];
      this.#attachmentsRev += 1;
      this.#clearMediaError();
      if (wasProcessing) {
        this.#syncComposerReadyState();
      }
      this.#els.stagedList?.querySelectorAll('[data-part="staged-item"]').forEach((node) => {
        node.dataset.closing = "true";
        node.inert = true;
        node.setAttribute("aria-hidden", "true");
      });
      this.#syncAttachButtonAndConstraints();
      this.#syncAltDrawer({ animate: true });
      this.#collapseComposerMedia({ animate: true });
      return;
    }

    this.#revokeAttachmentPreviewUrls();
    if (hadItems) {
      this.#attachments = [];
      this.#attachmentsRev += 1;
    }
    this.#clearMediaError();
    if (wasProcessing) {
      this.#syncComposerReadyState();
    }
    this.#syncAttachmentUi({ animateTray: false });
  }

  #showMediaError(message) {
    const el = this.#els.mediaError;
    if (!el) return;
    el.textContent = message;
    el.hidden = false;
    announcePolite(message);
  }

  #clearMediaError() {
    const el = this.#els.mediaError;
    if (!el) return;
    el.textContent = "";
    el.hidden = true;
  }

  #syncAttachButtonAndConstraints() {
    const { attachBtn, attachBtnLabel, textarea } = this.#els;
    if (!attachBtn || !textarea) return;
    const c = this.#copy;
    const enabled = Boolean(this.#config.imagesEnabled);
    const maxImages = Math.max(1, Number(this.#config.maxImages || DEFAULT_MAX_IMAGES));
    const count = this.#attachments.length;

    textarea.required = count === 0;
    textarea.minLength = count === 0 ? this.#config.minBodyLength : 0;

    attachBtn.hidden = !enabled;
    attachBtn.disabled = !enabled || this.#submitting || count >= maxImages;
    attachBtnLabel.textContent = count > 0 ? c.attachBtnCount(count, maxImages) : c.attachBtn;
    attachBtn.setAttribute("aria-label", c.attachAria(count, maxImages));
  }

  #buildStagedLightboxEntries() {
    const c = this.#copy;
    return this.#attachments.map((att, i) => {
      const caption = String(att.alt || "").trim();
      return {
        src: att.previewUrl,
        alt: caption || c.previewImage(i + 1),
        caption,
        width: att.width,
        height: att.height,
        openableUrl: "",
      };
    });
  }

  #createStagedItemNode(att, idx) {
    const c = this.#copy;
    const svgNS = "http://www.w3.org/2000/svg";
    const altDrawerId = this.#els.altDrawer?.id || `${this.#uid}-staged-alt-drawer`;

    const item = document.createElement("div");
    item.dataset.part = "staged-item";
    item.dataset.uid = att.uid;
    item.setAttribute("role", "listitem");

    const thumbBtn = document.createElement("button");
    thumbBtn.type = "button";
    thumbBtn.dataset.part = "staged-thumb-btn";
    thumbBtn.addEventListener("click", () => {
      const liveIdx = this.#attachments.findIndex((a) => a.uid === att.uid);
      if (liveIdx >= 0) {
        this.#openLightbox(this.#buildStagedLightboxEntries(), liveIdx);
      }
    });

    const img = document.createElement("img");
    img.dataset.part = "staged-thumb";
    img.src = att.previewUrl;
    img.alt = "";
    img.decoding = "async";
    thumbBtn.append(img);

    const altToggleBtn = document.createElement("button");
    altToggleBtn.type = "button";
    altToggleBtn.dataset.part = "staged-alt-btn";
    altToggleBtn.dataset.uid = att.uid;
    altToggleBtn.setAttribute("aria-controls", altDrawerId);
    altToggleBtn.addEventListener("click", () => {
      if (this.#submitting) return;
      if (this.#editingAltUid === att.uid) {
        this.#closeAltEditor({ restoreFocus: true });
      } else {
        this.#editingAltUid = att.uid;
        this.#syncAttachmentUi({ focusAltEditor: true });
      }
    });

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.dataset.part = "staged-remove";
    removeBtn.addEventListener("click", () => {
      this.#removeAttachment(att.uid);
    });

    const xSvg = document.createElementNS(svgNS, "svg");
    xSvg.setAttribute("viewBox", "0 0 12 12");
    xSvg.setAttribute("width", "10");
    xSvg.setAttribute("height", "10");
    xSvg.setAttribute("aria-hidden", "true");
    const xPath = document.createElementNS(svgNS, "path");
    xPath.setAttribute("d", "M2.5 2.5l7 7M9.5 2.5l-7 7");
    xPath.setAttribute("stroke", "currentColor");
    xPath.setAttribute("stroke-width", "1.4");
    xPath.setAttribute("stroke-linecap", "square");
    xSvg.append(xPath);
    removeBtn.append(xSvg);

    item.append(thumbBtn, altToggleBtn, removeBtn);
    this.#updateStagedItemNode(item, att, idx);
    return item;
  }

  #updateStagedItemNode(item, att, idx) {
    const c = this.#copy;
    const isEditing = this.#editingAltUid === att.uid;
    const hasAlt = Boolean(String(att.alt || "").trim());

    if (this.#freshAttachmentUids.has(att.uid)) item.dataset.fresh = "true";
    else delete item.dataset.fresh;
    if (isEditing) item.dataset.editing = "true";
    else delete item.dataset.editing;

    const thumbBtn = item.querySelector('[data-part="staged-thumb-btn"]');
    if (thumbBtn) thumbBtn.setAttribute("aria-label", c.previewImage(idx + 1));

    const img = item.querySelector('[data-part="staged-thumb"]');
    if (img && att.previewUrl && img.getAttribute("src") !== att.previewUrl) {
      img.src = att.previewUrl;
    }

    const altToggleBtn = item.querySelector('[data-part="staged-alt-btn"]');
    if (altToggleBtn) {
      if (hasAlt) altToggleBtn.dataset.hasAlt = "true";
      else delete altToggleBtn.dataset.hasAlt;
      altToggleBtn.disabled = this.#submitting;
      altToggleBtn.textContent = hasAlt ? c.altBtnFilled : c.altBtn;
      altToggleBtn.setAttribute("aria-label", c.altToggleAria(idx + 1));
      altToggleBtn.setAttribute("aria-expanded", isEditing ? "true" : "false");
    }

    const removeBtn = item.querySelector('[data-part="staged-remove"]');
    if (removeBtn) {
      removeBtn.disabled = this.#submitting || this.#processingImages;
      removeBtn.setAttribute("aria-label", c.removeImage(idx + 1));
    }
  }

  #closeAltEditor({ restoreFocus = false } = {}) {
    const prevUid = this.#editingAltUid;
    if (!prevUid) return;
    this.#editingAltUid = "";
    this.#syncAttachmentUi();
    if (restoreFocus && prevUid) {
      const btn = this.#els.stagedList?.querySelector(
        `[data-part="staged-item"]:not([data-closing="true"]) [data-part="staged-alt-btn"][data-uid="${CSS.escape(prevUid)}"]`
      );
      btn?.focus({ preventScroll: true });
    }
  }

  #syncAltCaret(allowTransition = true, targetRect = null) {
    const { composerMedia, stagedList, altBar, altCaret } = this.#els;
    if (!composerMedia || !stagedList || !altBar || !altCaret || !this.#editingAltUid) return;
    const item = stagedList.querySelector(
      `[data-part="staged-item"]:not([data-closing="true"])[data-uid="${CSS.escape(this.#editingAltUid)}"]`
    );
    if (!targetRect && !item) return;

    let rawX = null;
    let barWidth = altBar.clientWidth;
    if (!targetRect && item) {
      // Untransformed layout coordinates ignore active FLIP transforms & wrapped-row ResizeObserver ticks
      const itemLeft = layoutLeftIn(item, composerMedia);
      const barLeft = layoutLeftIn(altBar, composerMedia);
      if (itemLeft !== null && barLeft !== null && item.offsetWidth > 0 && barWidth > 0) {
        rawX = itemLeft + item.offsetWidth / 2 - (barLeft + altBar.clientLeft);
      }
    }
    if (rawX === null) {
      const barRect = altBar.getBoundingClientRect();
      const itemRect = targetRect || item?.getBoundingClientRect();
      if (!itemRect || barRect.width <= 0 || itemRect.width <= 0) return;
      barWidth = barRect.width;
      rawX = itemRect.left + itemRect.width / 2 - barRect.left;
    }

    const clampedX = Math.max(14, Math.min(Math.max(14, barWidth - 14), rawX));
    if (!allowTransition) {
      delete altBar.dataset.caretAnimated;
    } else {
      altBar.dataset.caretAnimated = "true";
    }
    altBar.style.setProperty("--alt-caret-x", `${clampedX.toFixed(1)}px`);
    if (!allowTransition) {
      void altCaret.offsetWidth;
      altBar.dataset.caretAnimated = "true";
    }
  }

  #syncAltDrawer({ animate = true, focus = false } = {}) {
    const { altDrawer, altTag, altInput, altDoneBtn } = this.#els;
    if (!altDrawer || !altTag || !altInput || !altDoneBtn) return;
    const c = this.#copy;
    const idx = this.#editingAltUid
      ? this.#attachments.findIndex((a) => a.uid === this.#editingAltUid)
      : -1;

    if (idx === -1) {
      const op = ++this.#altDrawerOp;
      const wasOpen = !altDrawer.hidden && altDrawer.dataset.open === "true";
      altDrawer.dataset.open = "false";
      altDrawer.inert = true;
      delete altInput.dataset.boundUid;

      const finishClose = () => {
        if (op === this.#altDrawerOp && !this.#editingAltUid) {
          altDrawer.hidden = true;
        }
      };

      if (!animate || !wasOpen || reducedMotionQuery.matches || this.hasAttribute("unstyled")) {
        finishClose();
        return;
      }

      const anims = altDrawer.getAnimations().filter((a) => a instanceof CSSTransition);
      if (anims.length === 0) {
        finishClose();
      } else {
        Promise.race([
          Promise.allSettled(anims.map((a) => a.finished)),
          new Promise((r) => window.setTimeout(r, 340)),
        ]).then(finishClose);
      }
      return;
    }

    const att = this.#attachments[idx];
    const op = ++this.#altDrawerOp;
    const wasClosed = altDrawer.hidden || altDrawer.dataset.open !== "true";

    altTag.textContent = c.altTag(idx + 1, this.#attachments.length);
    altInput.dataset.uid = att.uid;
    altInput.placeholder = c.altPlaceholder;
    altInput.setAttribute("aria-label", c.altAria(idx + 1));
    altInput.disabled = this.#submitting;
    altDoneBtn.textContent = c.altDone;
    const expectedAlt = att.alt || "";
    if (
      altInput.dataset.boundUid !== att.uid ||
      (document.activeElement !== altInput && altInput.value !== expectedAlt)
    ) {
      altInput.dataset.boundUid = att.uid;
      altInput.value = expectedAlt;
    }

    if (wasClosed) {
      altDrawer.hidden = false;
      altDrawer.inert = false;
      this.#syncAltCaret(false);
      void altDrawer.offsetHeight;
      if (op === this.#altDrawerOp && this.#editingAltUid === att.uid) {
        altDrawer.dataset.open = "true";
      }
    } else {
      altDrawer.hidden = false;
      altDrawer.inert = false;
      altDrawer.dataset.open = "true";
      this.#syncAltCaret(animate && !reducedMotionQuery.matches);
    }

    if (focus && !altInput.disabled && this.isConnected) {
      altInput.focus({ preventScroll: true });
      const end = altInput.value.length;
      try {
        altInput.setSelectionRange(end, end);
      } catch {
        /* ignore */
      }
    }
  }

  #expandComposerMedia({ fromHeight = null } = {}) {
    const { composerMedia, stagedList } = this.#els;
    if (!composerMedia) return;
    const op = ++this.#mediaOp;
    const wasHidden = composerMedia.hidden;
    const startH =
      fromHeight !== null ? fromHeight : wasHidden ? 0 : readLocalHeight(composerMedia);

    this.#mediaAnim?.cancel();
    this.#mediaAnim = null;
    this.#mediaAnimatingMode = null;
    composerMedia.hidden = false;
    composerMedia.style.height = "";
    composerMedia.style.overflow = "";
    composerMedia.style.opacity = "";

    if ((!wasHidden && fromHeight === null) || reducedMotionQuery.matches || typeof composerMedia.animate !== "function") {
      return;
    }

    const targetH = readLocalHeight(composerMedia);
    this.#mediaListHeight = stagedList ? stagedList.offsetHeight : 0;
    if (targetH <= 2 || Math.abs(targetH - startH) <= 1) return;
    composerMedia.style.overflow = "clip";
    const anim = composerMedia.animate(
      [
        { height: `${startH}px`, opacity: wasHidden ? 0 : 1 },
        { height: `${targetH}px`, opacity: 1 },
      ],
      {
        duration: 260,
        easing: "cubic-bezier(0.22, 1, 0.36, 1)",
        fill: "forwards",
      }
    );
    this.#mediaAnim = anim;
    this.#mediaAnimatingMode = "expand";
    Promise.race([anim.finished.catch(() => {}), new Promise((r) => window.setTimeout(r, 340))]).then(() => {
      if (op !== this.#mediaOp || this.#mediaAnim !== anim) return;
      anim.cancel();
      this.#mediaAnim = null;
      this.#mediaAnimatingMode = null;
      composerMedia.style.height = "";
      composerMedia.style.overflow = "";
      composerMedia.style.opacity = "";
    });
  }

  #collapseComposerMedia({ animate = true } = {}) {
    const { composerMedia, stagedList } = this.#els;
    if (!composerMedia || !stagedList) return;
    const op = ++this.#mediaOp;
    const startH = composerMedia.hidden ? 0 : readLocalHeight(composerMedia);

    this.#mediaAnim?.cancel();
    this.#mediaAnim = null;
    this.#mediaAnimatingMode = null;

    const finishHide = () => {
      if (op !== this.#mediaOp || this.#attachments.length > 0) return;
      this.#mediaAnim?.cancel();
      this.#mediaAnim = null;
      this.#mediaAnimatingMode = null;
      stagedList.replaceChildren();
      this.#revokeExitingPreviewUrls();
      composerMedia.hidden = true;
      composerMedia.style.height = "";
      composerMedia.style.overflow = "";
      composerMedia.style.opacity = "";
    };

    if (!animate || composerMedia.hidden || startH <= 1 || reducedMotionQuery.matches || typeof composerMedia.animate !== "function") {
      finishHide();
      return;
    }

    stagedList.querySelectorAll('[data-part="staged-item"]').forEach((node) => {
      if (typeof node.animate === "function") {
        node.animate(
          [
            { opacity: 1, transform: "scale(1) translateY(0px)" },
            { opacity: 0, transform: "scale(0.86) translateY(-4px)" },
          ],
          { duration: 170, easing: "cubic-bezier(0.4, 0, 1, 1)", fill: "forwards" }
        );
      }
    });

    composerMedia.style.overflow = "clip";
    const anim = composerMedia.animate(
      [
        { height: `${startH}px`, opacity: 1 },
        { height: "0px", opacity: 0 },
      ],
      {
        duration: 240,
        easing: "cubic-bezier(0.32, 0, 0.15, 1)",
        fill: "forwards",
      }
    );
    this.#mediaAnim = anim;
    this.#mediaAnimatingMode = "collapse";
    Promise.race([anim.finished.catch(() => {}), new Promise((r) => window.setTimeout(r, 340))]).then(finishHide);
  }

  #syncAttachmentUi({ focusAltEditor = false, preserveClosing = false, animateTray = true } = {}) {
    const { composerMedia, stagedList } = this.#els;
    if (!composerMedia || !stagedList) return;

    this.#syncAttachButtonAndConstraints();
    const count = this.#attachments.length;

    if (count === 0) {
      if (animateTray && this.#mediaAnimatingMode === "collapse" && this.#mediaAnim) {
        return;
      }
      this.#editingAltUid = "";
      this.#syncAltDrawer({ animate: false });
      this.#collapseComposerMedia({ animate: false });
      return;
    }

    if (this.#editingAltUid && !this.#attachments.some((a) => a.uid === this.#editingAltUid)) {
      this.#editingAltUid = "";
    }

    const wasHidden = composerMedia.hidden;
    const wasCollapsing = this.#mediaAnimatingMode === "collapse" && Boolean(this.#mediaAnim);
    const wasExpanding = this.#mediaAnimatingMode === "expand" && Boolean(this.#mediaAnim);
    const currentAnimatedH = wasCollapsing || wasExpanding ? readLocalHeight(composerMedia) : null;

    if (!preserveClosing) {
      const closingNodes = stagedList.querySelectorAll('[data-part="staged-item"][data-closing="true"]');
      if (closingNodes.length > 0) {
        closingNodes.forEach((n) => n.remove());
        this.#revokeExitingPreviewUrls();
      }
    }

    const existingByUid = new Map();
    for (const child of [...stagedList.children]) {
      if (child.dataset?.part === "staged-item" && child.dataset.closing !== "true" && child.dataset.uid) {
        existingByUid.set(child.dataset.uid, child);
      }
    }

    const desiredUids = new Set(this.#attachments.map((a) => a.uid));
    for (const [uid, node] of existingByUid) {
      if (!desiredUids.has(uid)) {
        node.remove();
        existingByUid.delete(uid);
      }
    }

    // Reconcile tiles in place so existing thumbnails never re-trigger entry animation or flicker
    let cursor = stagedList.firstElementChild;
    while (cursor && cursor.dataset?.closing === "true") {
      cursor = cursor.nextElementSibling;
    }

    this.#attachments.forEach((att, idx) => {
      let node = existingByUid.get(att.uid);
      if (node) {
        this.#updateStagedItemNode(node, att, idx);
      } else {
        node = this.#createStagedItemNode(att, idx);
      }
      if (node === cursor) {
        cursor = cursor.nextElementSibling;
        while (cursor && cursor.dataset?.closing === "true") {
          cursor = cursor.nextElementSibling;
        }
      } else {
        stagedList.insertBefore(node, cursor);
      }
    });

    if ((wasHidden || wasCollapsing) && animateTray) {
      this.#expandComposerMedia({ fromHeight: wasCollapsing ? currentAnimatedH : null });
    } else if (wasExpanding && animateTray && !this.#editingAltUid) {
      if (stagedList.offsetHeight !== this.#mediaListHeight) {
        this.#expandComposerMedia({ fromHeight: currentAnimatedH });
      } else {
        composerMedia.hidden = false;
      }
    } else {
      this.#mediaOp += 1;
      this.#mediaAnim?.cancel();
      this.#mediaAnim = null;
      this.#mediaAnimatingMode = null;
      composerMedia.hidden = false;
      composerMedia.style.height = "";
      composerMedia.style.overflow = "";
      composerMedia.style.opacity = "";
    }

    this.#syncAltDrawer({ animate: true, focus: focusAltEditor });
  }

  #removeAttachment(uid) {
    if (this.#submitting || this.#processingImages) return;
    const idx = this.#attachments.findIndex((a) => a.uid === uid);
    if (idx === -1) return;

    const { composerMedia, stagedList } = this.#els;
    const hadFocus =
      document.activeElement instanceof Node &&
      composerMedia.contains(document.activeElement);
    const itemNode = stagedList?.querySelector(
      `[data-part="staged-item"]:not([data-closing="true"])[data-uid="${CSS.escape(uid)}"]`
    );

    // Commit logical removal immediately so submit / paste / rapid removals never race
    const [removed] = this.#attachments.splice(idx, 1);
    this.#attachmentsRev += 1;
    this.#freshAttachmentUids.delete(uid);
    if (this.#editingAltUid === uid) {
      this.#editingAltUid = "";
    }
    this.#clearMediaError();

    const remainingCount = this.#attachments.length;
    const shouldAnimate =
      Boolean(itemNode) &&
      !reducedMotionQuery.matches &&
      typeof itemNode.animate === "function";

    if (removed?.previewUrl) {
      if (shouldAnimate) {
        this.#exitingPreviewUrls.add(removed.previewUrl);
      } else {
        URL.revokeObjectURL(removed.previewUrl);
      }
    }

    if (remainingCount === 0) {
      this.#syncAttachButtonAndConstraints();
      if (itemNode) {
        itemNode.dataset.closing = "true";
        itemNode.inert = true;
        itemNode.setAttribute("aria-hidden", "true");
      }
      if (hadFocus) {
        if (!this.#els.attachBtn.hidden && !this.#els.attachBtn.disabled) {
          this.#els.attachBtn.focus({ preventScroll: true });
        } else {
          this.#els.textarea.focus({ preventScroll: true });
        }
      }
      this.#syncAltDrawer({ animate: shouldAnimate });
      this.#collapseComposerMedia({ animate: shouldAnimate });
      announcePolite(this.#copy.imageRemoved);
      return;
    }

    if (itemNode && shouldAnimate) {
      itemNode.dataset.closing = "true";
      itemNode.inert = true;
      itemNode.setAttribute("aria-hidden", "true");
    }

    this.#syncAttachmentUi({ preserveClosing: shouldAnimate });

    if (hadFocus) {
      const remainingBtns = stagedList.querySelectorAll(
        '[data-part="staged-item"]:not([data-closing="true"]) [data-part="staged-remove"]'
      );
      if (remainingBtns.length > 0) {
        const nextFocus = remainingBtns[Math.min(idx, remainingBtns.length - 1)];
        nextFocus.focus({ preventScroll: true });
      }
    }

    announcePolite(this.#copy.imageRemoved);

    if (!itemNode || !shouldAnimate) {
      if (itemNode && itemNode.isConnected) itemNode.remove();
      if (this.#editingAltUid) this.#syncAltCaret(false);
      return;
    }

    const exitAnim = itemNode.animate(
      [
        { opacity: 1, transform: "scale(1) translateY(0px)" },
        { opacity: 0, transform: "scale(0.84) translateY(-4px)" },
      ],
      { duration: 165, easing: "cubic-bezier(0.4, 0, 1, 1)", fill: "forwards" }
    );

    Promise.race([exitAnim.finished.catch(() => {}), new Promise((r) => window.setTimeout(r, 240))]).then(() => {
      if (removed?.previewUrl && this.#exitingPreviewUrls.has(removed.previewUrl)) {
        URL.revokeObjectURL(removed.previewUrl);
        this.#exitingPreviewUrls.delete(removed.previewUrl);
      }
      if (!itemNode.isConnected) return;

      // FLIP measure remaining live siblings before removing the vacated tile
      const liveSiblings = [...stagedList.querySelectorAll('[data-part="staged-item"]:not([data-closing="true"])')];
      const firstRects = new Map();
      for (const el of liveSiblings) {
        firstRects.set(el, el.getBoundingClientRect());
      }

      itemNode.remove();

      if (!this.isConnected) return;
      // Read final resting layout rects BEFORE applying FLIP transforms so the ALT caret targets the true final slot
      const lastRects = new Map();
      let editingLastRect = null;
      for (const el of liveSiblings) {
        if (!el.isConnected) continue;
        const rect = el.getBoundingClientRect();
        lastRects.set(el, rect);
        if (this.#editingAltUid && el.dataset.uid === this.#editingAltUid) {
          editingLastRect = rect;
        }
      }

      if (this.#editingAltUid && editingLastRect) {
        this.#syncAltCaret(!reducedMotionQuery.matches);
      }

      if (reducedMotionQuery.matches) return;
      const flipAnims = [];
      for (const el of liveSiblings) {
        const last = lastRects.get(el);
        if (!last) continue;
        const first = firstRects.get(el);
        const dx = first.left - last.left;
        const dy = first.top - last.top;
        if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
          flipAnims.push(
            el.animate(
              [
                { transform: `translate(${dx}px, ${dy}px)` },
                { transform: "translate(0px, 0px)" },
              ],
              { duration: 240, easing: "cubic-bezier(0.32, 0, 0.15, 1)" }
            )
          );
        }
      }
      if (flipAnims.length > 0 && this.#editingAltUid) {
        Promise.allSettled(flipAnims.map((a) => a.finished)).then(() => {
          if (this.isConnected && this.#editingAltUid) {
            this.#syncAltCaret(true);
          }
        });
      }
    });
  }

  #markAttachmentsFresh(uids) {
    if (!Array.isArray(uids) || uids.length === 0) return;
    for (const uid of uids) {
      this.#freshAttachmentUids.add(uid);
      const node = this.#els.stagedList?.querySelector(
        `[data-part="staged-item"]:not([data-closing="true"])[data-uid="${CSS.escape(uid)}"]`
      );
      if (node) node.dataset.fresh = "true";
    }
    window.setTimeout(() => {
      for (const uid of uids) {
        this.#freshAttachmentUids.delete(uid);
        const node = this.#els.stagedList?.querySelector(
          `[data-part="staged-item"]:not([data-closing="true"])[data-uid="${CSS.escape(uid)}"]`
        );
        if (node && node.isConnected) delete node.dataset.fresh;
      }
    }, 1400);
  }

  #addImageFiles(rawFiles, options = {}) {
    if (!this.#config.imagesEnabled || this.#submitting) {
      return Promise.resolve({
        ok: false,
        added: 0,
        overflowed: false,
        error: !this.#config.imagesEnabled ? this.#copy.errImagesUnconfigured : "",
        addedUids: [],
        reason: !this.#config.imagesEnabled ? "images_disabled" : "submitting",
      });
    }
    const files = [...rawFiles].filter(Boolean);
    if (files.length === 0) {
      return Promise.resolve({ ok: false, added: 0, overflowed: false, error: "", addedUids: [], reason: "no_files" });
    }

    const c = this.#copy;
    const maxImages = Math.max(1, Number(this.#config.maxImages || DEFAULT_MAX_IMAGES));
    const prepOpts = {
      maxEdge: options.maxEdge,
      targetBytes: options.maxBytes,
      quality: options.quality,
    };
    const defaultAlt = typeof options.alt === "string" ? options.alt.trim().slice(0, MAX_ALT_LEN) : "";
    const announceAdded = options.announceAdded !== false;

    if (!this.#processingImages && this.#attachments.length >= maxImages) {
      this.#clearMediaError();
      const msg = c.errImageCount(maxImages);
      this.#showMediaError(msg);
      return Promise.resolve({ ok: false, added: 0, overflowed: true, error: msg, addedUids: [], reason: "max_images" });
    }

    let resolveBatch;
    const batchPromise = new Promise((resolve) => {
      resolveBatch = resolve;
    });
    const batch = {
      remaining: files.length,
      added: 0,
      overflowed: false,
      firstError: "",
      addedUids: [],
      announceAdded,
      settled: false,
      resolve: resolveBatch,
    };

    // Non-destructive FIFO queue so rapid pastes/drops/quick-attaches append cleanly
    for (const file of files) {
      this.#pendingFileQueue.push({ file, prepOpts, defaultAlt, batch });
    }

    if (!this.#processingImages) {
      this.#drainImageQueue();
    }
    return batchPromise;
  }

  async #drainImageQueue() {
    if (this.#processingImages) return;
    const opSeq = this.#imageOpSeq;
    const maxImages = Math.max(1, Number(this.#config.maxImages || DEFAULT_MAX_IMAGES));
    this.#clearMediaError();
    this.#processingImages = true;
    this.#syncComposerReadyState();
    this.#syncAttachmentUi();

    const finishBatchIfReady = (batch) => {
      if (!batch || batch.settled || batch.remaining > 0) return;
      batch.settled = true;
      if (batch.added > 0) {
        if (this.#els.textarea.getAttribute("aria-invalid") === "true") {
          this.#syncFieldAria(this.#els.textarea, true);
        }
        this.#warmupAntiAbuse();
        if (batch.announceAdded) {
          announcePolite(this.#copy.imageAdded(batch.added));
        }
      }
      if (batch.firstError) {
        this.#showMediaError(batch.firstError);
      } else if (batch.overflowed) {
        this.#showMediaError(this.#copy.errImageCount(maxImages));
      }
      batch.resolve({
        ok: batch.added > 0,
        added: batch.added,
        overflowed: batch.overflowed,
        error: batch.firstError || (batch.overflowed ? this.#copy.errImageCount(maxImages) : ""),
        addedUids: batch.addedUids,
        reason: batch.added > 0 ? undefined : batch.overflowed ? "max_images" : "invalid_image",
      });
    };

    try {
      while (this.#pendingFileQueue.length > 0) {
        if (opSeq !== this.#imageOpSeq || !this.isConnected || this.#submitting) {
          return;
        }
        const entry = this.#pendingFileQueue.shift();
        if (!entry) continue;
        const { file, prepOpts, defaultAlt, batch } = entry;
        this.#activeImageBatch = batch;

        if (this.#attachments.length >= maxImages) {
          batch.overflowed = true;
          batch.remaining -= 1;
          finishBatchIfReady(batch);
          continue;
        }

        try {
          const prepared = await prepareImageAttachment(file, this.#config.maxImageBytes, prepOpts);
          if (opSeq !== this.#imageOpSeq || !this.isConnected || this.#submitting) {
            if (prepared.previewUrl) URL.revokeObjectURL(prepared.previewUrl);
            return;
          }
          if (this.#attachments.length >= maxImages) {
            if (prepared.previewUrl) URL.revokeObjectURL(prepared.previewUrl);
            batch.overflowed = true;
          } else {
            if (defaultAlt) prepared.alt = defaultAlt;
            this.#attachments.push(prepared);
            this.#attachmentsRev += 1;
            batch.added += 1;
            batch.addedUids.push(prepared.uid);
            this.#syncAttachmentUi();
          }
        } catch (err) {
          if (opSeq !== this.#imageOpSeq || !this.isConnected || this.#submitting) return;
          if (!batch.firstError) {
            const code = err?.code;
            const c = this.#copy;
            batch.firstError = code && typeof c[code] === "string" ? c[code] : c.errImageProcess;
          }
        } finally {
          if (opSeq === this.#imageOpSeq) {
            batch.remaining -= 1;
            finishBatchIfReady(batch);
          }
        }
      }
    } finally {
      if (opSeq === this.#imageOpSeq) {
        const unfinished = new Set();
        if (this.#activeImageBatch && !this.#activeImageBatch.settled) {
          unfinished.add(this.#activeImageBatch);
        }
        for (const item of this.#pendingFileQueue) {
          if (item?.batch && !item.batch.settled) unfinished.add(item.batch);
        }
        this.#activeImageBatch = null;
        this.#pendingFileQueue = [];
        this.#processingImages = false;
        this.#syncComposerReadyState();
        this.#syncAttachmentUi();
        for (const batch of unfinished) {
          batch.settled = true;
          batch.resolve({
            ok: false,
            added: batch.added,
            overflowed: batch.overflowed,
            error: batch.firstError,
            addedUids: batch.addedUids,
            cancelled: true,
          });
        }
      }
    }
  }

  #openLightbox(items, startIndex = 0) {
    const { lightbox } = this.#els;
    if (!lightbox || !Array.isArray(items) || items.length === 0) return;
    this.#lightboxItems = items;
    this.#lightboxIndex = Math.max(0, Math.min(items.length - 1, startIndex));
    this.#lightboxOp += 1;
    lightbox.removeAttribute("data-closing");
    this.#renderLightboxSlide();
    if (!lightbox.open) {
      lightbox.showModal();
    }
  }

  #renderLightboxSlide() {
    const item = this.#lightboxItems[this.#lightboxIndex];
    if (!item) return;
    const { lightboxTitle, lightboxOrigin, lightboxPrevBtn, lightboxNextBtn, lightboxImg, lightboxMeta } = this.#els;
    const total = this.#lightboxItems.length;
    lightboxTitle.textContent =
      total > 1
        ? `${this.#copy.lightboxTitle} · ${this.#lightboxIndex + 1} / ${total}`
        : this.#copy.lightboxTitle;
    lightboxImg.src = item.src;
    lightboxImg.alt = item.alt || "";
    const metaParts = [];
    if (item.caption) metaParts.push(item.caption);
    if (item.width > 0 && item.height > 0) {
      lightboxImg.width = item.width;
      lightboxImg.height = item.height;
      metaParts.push(`${item.width} × ${item.height}`);
    } else {
      lightboxImg.removeAttribute("width");
      lightboxImg.removeAttribute("height");
    }
    lightboxMeta.textContent = metaParts.join(" · ");
    const safeOpenUrl = item.openableUrl ? normalizeSafeAttachmentUrl(item.openableUrl) : "";
    if (safeOpenUrl) {
      lightboxOrigin.href = safeOpenUrl;
      lightboxOrigin.hidden = false;
    } else {
      lightboxOrigin.removeAttribute("href");
      lightboxOrigin.hidden = true;
    }
    lightboxPrevBtn.hidden = total <= 1;
    lightboxNextBtn.hidden = total <= 1;
  }

  #stepLightbox(delta) {
    const total = this.#lightboxItems.length;
    if (total <= 1) return;
    this.#lightboxIndex = (this.#lightboxIndex + delta + total) % total;
    this.#renderLightboxSlide();
  }

  async #closeLightbox() {
    const { lightbox } = this.#els;
    if (!lightbox || !lightbox.open) return;
    if (!supportsTopLayerExit()) {
      if (lightbox.hasAttribute("data-closing")) return;
      const op = ++this.#lightboxOp;
      lightbox.setAttribute("data-closing", "");
      const anims = lightbox.getAnimations({ subtree: true });
      if (anims.length > 0) {
        await Promise.race([
          Promise.allSettled(anims.map((a) => a.finished)),
          new Promise((r) => window.setTimeout(r, 500)),
        ]);
      }
      if (op !== this.#lightboxOp || !lightbox.hasAttribute("data-closing")) return;
      lightbox.removeAttribute("data-closing");
    }
    lightbox.close();
  }

  #isAuthorSlashCommand(value) {
    return /^\/author$/i.test(String(value || "").trim());
  }

  #consumeAuthorCommand() {
    const { form, textarea, nameInput, urlInput } = this.#els;
    if (form && textarea) {
      const curName = nameInput?.value ?? "";
      const curUrl = urlInput?.value ?? "";
      // Preserve staged alt inputs (they live inside form) while clearing textarea's :user-invalid state
      const stagedAlts = this.#attachments.map((att) => att.alt);
      form.reset();
      if (nameInput) nameInput.value = curName;
      if (urlInput) urlInput.value = curUrl;
      this.#attachments.forEach((att, idx) => {
        att.alt = stagedAlts[idx] || "";
      });
      if (this.#attachments.length > 0) {
        this.#syncAttachmentUi();
      }
      this.#els.charCount.textContent = `0 / ${this.#config.maxBodyLength}`;
      this.#syncFieldAria(textarea, false);
      if (urlInput) this.#syncFieldAria(urlInput, false);
    } else if (textarea) {
      textarea.value = "";
      this.#els.charCount.textContent = `0 / ${this.#config.maxBodyLength}`;
      this.#syncFieldAria(textarea, false);
    }
    this.#openAuthDialog();
  }

  #siteAuthorFallback() {
    return (document.querySelector(".site-header")?.dataset?.siteAuthor || "").trim();
  }

  #bindAuthorSync() {
    if (this.#onAuthorChange) return;
    this.#onAuthorChange = (event) => {
      const detail = event?.detail;
      if (!detail || detail.source === this || detail.endpoint !== this.endpoint) return;
      this.#setAuthorState(Boolean(detail.authorMode), String(detail.authorName || ""));
    };
    window.addEventListener("ti-comments:author-change", this.#onAuthorChange);
  }

  #unbindAuthorSync() {
    if (!this.#onAuthorChange) return;
    window.removeEventListener("ti-comments:author-change", this.#onAuthorChange);
    this.#onAuthorChange = null;
  }

  #broadcastAuthorState() {
    window.dispatchEvent(
      new CustomEvent("ti-comments:author-change", {
        detail: {
          source: this,
          endpoint: this.endpoint,
          authorMode: this.#authorMode,
          authorName: this.#authorName,
        },
      })
    );
  }

  #setAuthorState(active, authorName = "", { rerender = true } = {}) {
    const nextActive = Boolean(active);
    const prevActive = this.#authorMode;
    this.#authorMode = nextActive;
    this.#authorName = nextActive
      ? String(authorName || this.#authorName || this.#siteAuthorFallback()).trim()
      : "";

    if (nextActive) {
      this.dataset.authorMode = "true";
    } else {
      delete this.dataset.authorMode;
    }
    this.#setCustomState("author", nextActive);

    const { authorBanner, authorBannerText, nameInput, statusLine } = this.#els;
    const c = this.#copy;
    if (authorBannerText) {
      authorBannerText.textContent = c.authorModeBanner(this.#authorName);
    }
    if (authorBanner) {
      if (nextActive) this.#showDiscrete(authorBanner);
      else this.#hideDiscrete(authorBanner);
    }
    if (nameInput) {
      nameInput.placeholder = nextActive && this.#authorName ? this.#authorName : c.namePlaceholder;
      if (nextActive && !prevActive) {
        const storedGuest = safeStorageGet(STORAGE_NAME_KEY);
        if (nameInput.value.trim() === storedGuest) {
          nameInput.value = "";
        }
      } else if (!nextActive && prevActive && !nameInput.value.trim()) {
        nameInput.value = safeStorageGet(STORAGE_NAME_KEY);
      }
    }
    if (statusLine && this.#statusKey === "statusReady") {
      statusLine.textContent = this.#resolveStatusCopy("statusReady");
    }
    if (this.#els.authDialog?.open) {
      this.#syncAuthDialogMode();
    }
    if (rerender && this.#loaded && prevActive !== nextActive) {
      this.#renderThread();
    }
  }

  #syncAuthDialogMode() {
    const { authDesc, authField, authInput, authSubmitBtn } = this.#els;
    if (!authDesc || !authField || !authInput || !authSubmitBtn) return;
    const c = this.#copy;
    if (this.#authorMode) {
      authDesc.textContent = c.authDialogActiveDesc(this.#authorName);
      authField.hidden = true;
      authInput.required = false;
      authSubmitBtn.dataset.mode = "logout";
      authSubmitBtn.textContent = this.#authSubmitting ? c.authSubmitting : c.authSignOutBtn;
    } else {
      authDesc.textContent = c.authDialogDesc;
      authField.hidden = false;
      authInput.required = true;
      delete authSubmitBtn.dataset.mode;
      authSubmitBtn.textContent = this.#authSubmitting ? c.authSubmitting : c.authSubmit;
    }
  }

  #setAuthError(errorKey = "") {
    const { authError, authInput } = this.#els;
    if (!authError || !authInput) return;
    this.#authErrorKey = errorKey;
    const descId = this.#els.authDesc?.id || "";
    if (!errorKey) {
      authError.textContent = "";
      authError.hidden = true;
      authInput.setAttribute("aria-invalid", "false");
      if (descId) authInput.setAttribute("aria-describedby", descId);
      else authInput.removeAttribute("aria-describedby");
      return;
    }
    const msg = typeof this.#copy[errorKey] === "string" ? this.#copy[errorKey] : errorKey;
    authError.textContent = msg;
    authError.hidden = false;
    authInput.setAttribute("aria-invalid", "true");
    const ids = [descId, authError.id].filter(Boolean);
    authInput.setAttribute("aria-describedby", ids.join(" "));
  }

  #resetAuthDialogInputs() {
    const { authInput, authRevealBtn, authSubmitBtn } = this.#els;
    this.#authSubmitting = false;
    if (authInput) {
      authInput.value = "";
      authInput.type = "password";
    }
    if (authRevealBtn) {
      authRevealBtn.setAttribute("aria-pressed", "false");
      authRevealBtn.setAttribute("aria-label", this.#copy.authShowPassword);
      delete authRevealBtn.dataset.revealed;
    }
    if (authSubmitBtn) {
      authSubmitBtn.disabled = false;
    }
    this.#setAuthError("");
    this.#syncAuthDialogMode();
  }

  #openAuthDialog({ errorKey = "" } = {}) {
    const { authDialog, authInput, authSubmitBtn } = this.#els;
    if (!authDialog) return;
    this.#authOp += 1;
    authDialog.removeAttribute("data-closing");
    this.#resetAuthDialogInputs();
    if (errorKey) {
      this.#setAuthError(errorKey);
    }
    if (!authDialog.open) {
      authDialog.showModal();
    }
    if (!this.#authorMode && authInput) {
      authInput.focus();
    } else if (authSubmitBtn) {
      authSubmitBtn.focus();
    }
  }

  async #closeAuthDialog() {
    const { authDialog } = this.#els;
    if (!authDialog || !authDialog.open) return;
    if (!supportsTopLayerExit()) {
      if (authDialog.hasAttribute("data-closing")) return;
      const op = ++this.#authOp;
      authDialog.setAttribute("data-closing", "");
      const anims = authDialog.getAnimations({ subtree: true });
      if (anims.length > 0) {
        await Promise.race([
          Promise.allSettled(anims.map((a) => a.finished)),
          new Promise((r) => window.setTimeout(r, 500)),
        ]);
      }
      if (op !== this.#authOp || !authDialog.hasAttribute("data-closing")) return;
      authDialog.removeAttribute("data-closing");
    }
    authDialog.close();
  }

  async #handleAuthVerify() {
    if (this.#authSubmitting) return;
    const { authInput, authSubmitBtn } = this.#els;
    const password = String(authInput?.value || "").trim();
    if (!password) {
      this.#setAuthError("authErrEmpty");
      authInput?.focus();
      return;
    }

    this.#authSubmitting = true;
    this.#setAuthError("");
    if (authSubmitBtn) {
      authSubmitBtn.disabled = true;
      authSubmitBtn.textContent = this.#copy.authSubmitting;
    }

    try {
      const res = await fetch(`${this.endpoint}/author/verify`, {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!this.isConnected) return;

      if (res.ok && data.ok === true && data.author === true) {
        this.#setAuthorState(true, String(data.authorName || this.#siteAuthorFallback()));
        this.#broadcastAuthorState();
        this.#authReturnFocusToComposer = true;
        await this.#closeAuthDialog();
        announcePolite(this.#copy.authorSignInDone(this.#authorName));
        if (this.#expanded && !this.#loaded && !this.#loading) {
          this.#fetchThread();
        }
        return;
      }

      if (res.status === 429) {
        this.#setAuthError("authErrRateLimited");
      } else if (res.status === 503 || data.error === "auth_unconfigured") {
        this.#setAuthError("authErrUnconfigured");
      } else {
        this.#setAuthError("authErrInvalid");
      }
      if (authInput) {
        authInput.focus();
        authInput.select?.();
      }
    } catch {
      if (!this.isConnected) return;
      this.#setAuthError("authErrNetwork");
    } finally {
      this.#authSubmitting = false;
      if (authSubmitBtn) {
        authSubmitBtn.disabled = false;
      }
      this.#syncAuthDialogMode();
    }
  }

  async #handleAuthorLogout({ fromDialog = false } = {}) {
    if (this.#authSubmitting) return;
    this.#authSubmitting = true;
    if (this.#els.authSubmitBtn) {
      this.#els.authSubmitBtn.disabled = true;
      this.#els.authSubmitBtn.textContent = this.#copy.authSubmitting;
    }
    try {
      await fetch(`${this.endpoint}/author/logout`, {
        method: "POST",
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });
    } catch {
      /* clear local state even if network hiccups */
    } finally {
      this.#authSubmitting = false;
      if (this.#els.authSubmitBtn) {
        this.#els.authSubmitBtn.disabled = false;
      }
    }
    if (!this.isConnected) return;
    this.#setAuthorState(false, "");
    this.#broadcastAuthorState();
    if (fromDialog) {
      this.#authReturnFocusToComposer = true;
      await this.#closeAuthDialog();
    }
    announcePolite(this.#copy.authorSignOutDone);
  }

  #clearDeleteConfirmTimers() {
    for (const timer of this.#deleteConfirmTimers.values()) {
      window.clearTimeout(timer);
    }
    this.#deleteConfirmTimers.clear();
  }

  async #deleteComment(commentId, triggerBtn) {
    if (!this.#authorMode || !commentId) return;
    const prevTimer = this.#deleteConfirmTimers.get(commentId);
    if (prevTimer) {
      window.clearTimeout(prevTimer);
      this.#deleteConfirmTimers.delete(commentId);
    }
    if (triggerBtn) {
      triggerBtn.disabled = true;
      triggerBtn.textContent = this.#copy.deleting;
    }
    try {
      const res = await fetch(`${this.endpoint}/${encodeURIComponent(commentId)}`, {
        method: "DELETE",
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });
      const data = await res.json().catch(() => ({}));
      if (!this.isConnected) return;
      if (res.status === 401) {
        this.#setAuthorState(false, "");
        this.#broadcastAuthorState();
        this.#setPhase("error", "errAuthorExpired");
        announcePolite(this.#copy.errAuthorExpired);
        this.#openAuthDialog({ errorKey: "errAuthorExpired" });
        return;
      }
      if (!res.ok || data.ok !== true) {
        throw new Error(data.error || "delete_failed");
      }
      this.#comments = this.#comments.filter((c) => c.id !== commentId && c.parentId !== commentId);
      if (this.#replyTarget && (this.#replyTarget.id === commentId || !this.#comments.some((c) => c.id === this.#replyTarget.id))) {
        this.#clearReplyTarget();
      }
      this.#syncCount();
      this.#renderThread();
      announcePolite(this.#copy.deleteDone);
    } catch {
      if (!this.isConnected) return;
      if (triggerBtn && triggerBtn.isConnected) {
        triggerBtn.disabled = false;
        delete triggerBtn.dataset.confirm;
        triggerBtn.textContent = this.#copy.delete;
      }
      this.#setPhase("error", "deleteFailed");
      announcePolite(this.#copy.deleteFailed);
      this.#scheduleStatusReset(3200);
    }
  }

  #setReplyTarget(comment) {
    this.#replyTarget = {
      id: comment.id,
      rawName: comment.authorName || "",
      rev: ++this.#replySeq,
    };
    this.#els.replyLabel.textContent = this.#copy.replyingTo(this.#replyDisplayName(this.#replyTarget));
    this.#showDiscrete(this.#els.replyBanner);
    this.#els.textarea.focus({ preventScroll: true });
    this.#els.form.scrollIntoView({
      behavior: reducedMotionQuery.matches ? "auto" : "smooth",
      block: "center",
    });
  }

  #clearReplyTarget() {
    this.#replyTarget = null;
    this.#hideDiscrete(this.#els.replyBanner);
  }

  /**
   * Public helper for starting a top-level note with a reference prefix (e.g. "Re #004: ").
   * Clears any active reader reply target so submission never posts under an unrelated parentId.
   */
  startNoteWithPrefix(prefix = "") {
    if (!this.#initialized) {
      this.#syncOpenAttribute(true);
      return false;
    }
    if (!this.#expanded) {
      this.expand({ animate: true });
    }
    this.#clearReplyTarget();
    const textarea = this.#els.textarea;
    if (!textarea) return false;
    const cleanPrefix = String(prefix || "");
    if (cleanPrefix) {
      const cur = textarea.value || "";
      if (/^Re #\d+:\s*/i.test(cur)) {
        textarea.value = cur.replace(/^Re #\d+:\s*/i, cleanPrefix);
      } else if (!cur.startsWith(cleanPrefix)) {
        textarea.value = cur ? `${cleanPrefix}${cur}` : cleanPrefix;
      }
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    }
    this.#els.form.scrollIntoView({
      behavior: reducedMotionQuery.matches ? "auto" : "smooth",
      block: "center",
    });
    window.setTimeout(() => {
      if (!textarea.isConnected || this.#els.panel.hidden) return;
      textarea.focus({ preventScroll: true });
      const len = textarea.value.length;
      textarea.setSelectionRange?.(len, len);
    }, reducedMotionQuery.matches ? 20 : 280);
    return true;
  }

  async #waitForPanelExpand(maxWaitMs = 520) {
    const deadline = performance.now() + maxWaitMs;
    while (
      this.isConnected &&
      this.#expanded &&
      this.#panelAnimatingMode === "expand" &&
      this.#panelAnims.length > 0
    ) {
      const rem = deadline - performance.now();
      if (rem <= 0) break;
      const current = [...this.#panelAnims];
      await Promise.race([
        Promise.allSettled(current.map((a) => a.finished)),
        new Promise((r) => window.setTimeout(r, rem)),
      ]);
      await Promise.resolve();
    }
  }

  /**
   * Public helper for interactive article pieces to attach image files directly
   * into the composer (expanding, loading live config, compressing locally, scrolling
   * cleanly into view, and moving focus to the note textarea once scrolling completes).
   */
  async attachImageFiles(rawFiles, options = {}) {
    const files = rawFiles instanceof Blob ? [rawFiles] : [...(rawFiles || [])].filter((f) => f instanceof Blob);
    if (files.length === 0) {
      return { ok: false, added: 0, reason: "no_files" };
    }
    if (!this.isConnected || !this.#initialized) {
      return { ok: false, added: 0, reason: "uninitialized" };
    }

    const {
      expand = true,
      scroll = true,
      focus = true,
      maxEdge,
      maxBytes,
      quality,
      alt = "",
      announceAdded = true,
    } = options;
    const startGen = this.#threadGen;
    const scrollBehavior = reducedMotionQuery.matches ? "auto" : "smooth";

    if (expand && !this.#expanded) {
      this.expand({ animate: true });
    }

    if (scroll && !this.#loaded) {
      const rootRect = this.#els.root?.getBoundingClientRect?.();
      if (rootRect && rootRect.top > window.innerHeight * 0.85) {
        this.#els.root.scrollIntoView({ behavior: scrollBehavior, block: "nearest" });
      }
    }

    if (!this.#loaded) {
      await this.#fetchThread();
    }
    if (!this.isConnected || startGen !== this.#threadGen) {
      return { ok: false, added: 0, reason: "cancelled" };
    }
    if (!this.#loaded || this.#loadFailed) {
      if (scroll) {
        await scrollIntoViewAsync(this.#els.root, { behavior: scrollBehavior, block: "nearest" });
      }
      return { ok: false, added: 0, reason: "load_failed" };
    }
    if (this.#submitting) {
      return { ok: false, added: 0, reason: "submitting" };
    }
    if (!this.#config.imagesEnabled) {
      this.#showMediaError(this.#copy.errImagesUnconfigured);
      if (scroll) {
        await this.#waitForPanelExpand();
        if (this.isConnected && !this.#els.panel.hidden) {
          await scrollIntoViewAsync(this.#els.form, { behavior: scrollBehavior, block: "center" });
        }
      }
      return { ok: false, added: 0, reason: "images_disabled" };
    }

    const result = await this.#addImageFiles(files, {
      maxEdge,
      maxBytes,
      quality,
      alt,
      announceAdded,
    });
    if (!this.isConnected || startGen !== this.#threadGen) {
      return { ok: false, added: 0, reason: "cancelled" };
    }

    const reconcileLiveResult = () => {
      if (!result.addedUids?.length) return result;
      const liveIds = new Set(this.#attachments.map((a) => a.uid));
      const remainingUids = result.addedUids.filter((uid) => liveIds.has(uid));
      if (remainingUids.length === 0) {
        return { ok: false, added: 0, overflowed: false, error: "", addedUids: [], reason: "cancelled" };
      }
      return { ...result, added: remainingUids.length, addedUids: remainingUids };
    };

    if (scroll && this.#expanded && !this.#els.panel.hidden) {
      const scrollOp = ++this.#scrollOp;
      await this.#waitForPanelExpand();
      if (!this.isConnected || startGen !== this.#threadGen) {
        return { ok: false, added: 0, reason: "cancelled" };
      }
      if (!this.#expanded || this.#els.panel.hidden) {
        return reconcileLiveResult();
      }
      await scrollIntoViewAsync(this.#els.form, { behavior: scrollBehavior, block: "center" });
      if (!this.isConnected || startGen !== this.#threadGen) {
        return { ok: false, added: 0, reason: "cancelled" };
      }
      const liveResult = reconcileLiveResult();
      if (scrollOp !== this.#scrollOp || !this.#expanded || this.#els.panel.hidden) {
        return liveResult;
      }
      if (liveResult.addedUids?.length > 0) {
        this.#markAttachmentsFresh(liveResult.addedUids);
      }
      if (
        liveResult.ok &&
        focus &&
        this.#els.textarea &&
        !this.#els.form.contains(document.activeElement)
      ) {
        this.#els.textarea.focus({ preventScroll: true });
        const len = this.#els.textarea.value.length;
        this.#els.textarea.setSelectionRange?.(len, len);
      }
      return liveResult;
    }

    const liveResult = reconcileLiveResult();
    if (liveResult.addedUids?.length > 0) {
      this.#markAttachmentsFresh(liveResult.addedUids);
      if (
        focus &&
        this.#expanded &&
        !this.#els.panel.hidden &&
        this.#els.textarea &&
        !this.#els.form.contains(document.activeElement)
      ) {
        this.#els.textarea.focus({ preventScroll: true });
        const len = this.#els.textarea.value.length;
        this.#els.textarea.setSelectionRange?.(len, len);
      }
    }

    return liveResult;
  }

  #buildCommentNode(comment, isReply, freshId, indexNum = 0) {
    const c = this.#copy;
    const li = document.createElement("li");
    li.dataset.part = isReply ? "reply-item" : "item";
    li.dataset.commentId = comment.id;
    if (comment.isAuthor) {
      li.dataset.isAuthor = "true";
    }
    if (comment.id === freshId) {
      li.dataset.fresh = "true";
      window.setTimeout(() => {
        if (li.isConnected) delete li.dataset.fresh;
      }, 2200);
    }

    const head = document.createElement("div");
    head.dataset.part = "item-head";

    const meta = document.createElement("div");
    meta.dataset.part = "item-meta";

    const displayName = comment.authorName || c.anonymous;
    if (isSafeHttpUrl(comment.authorUrl)) {
      const a = document.createElement("a");
      a.dataset.part = "author";
      a.href = comment.authorUrl.trim();
      a.target = "_blank";
      a.rel = "noopener noreferrer ugc nofollow";
      a.textContent = displayName;
      meta.append(a);
    } else {
      const span = document.createElement("span");
      span.dataset.part = "author";
      span.textContent = displayName;
      meta.append(span);
    }

    if (comment.isAuthor) {
      const badge = document.createElement("span");
      badge.dataset.part = "author-badge";
      badge.textContent = c.authorBadge;
      meta.append(badge);
    }

    if (comment.lang && comment.lang !== this.lang) {
      const ltag = document.createElement("span");
      ltag.dataset.part = "lang-tag";
      ltag.textContent = c.otherLangTag;
      meta.append(ltag);
    }

    const time = document.createElement("time");
    time.dataset.part = "time";
    const dt = new Date(comment.createdAt);
    time.dateTime = dt.toISOString();
    time.title = dt.toLocaleString(this.lang === "en" ? "en" : "zh-CN");
    time.textContent = formatTimestamp(comment.createdAt, this.lang);
    meta.append(time);

    const actions = document.createElement("div");
    actions.dataset.part = "item-actions";

    if (!isReply && indexNum > 0) {
      const indexEl = document.createElement("span");
      indexEl.dataset.part = "index";
      indexEl.setAttribute("aria-hidden", "true");
      indexEl.textContent = `#${String(indexNum).padStart(2, "0")}`;
      actions.append(indexEl);
    }

    const replyBtn = document.createElement("button");
    replyBtn.type = "button";
    replyBtn.dataset.part = "action-btn";
    replyBtn.textContent = c.reply;
    replyBtn.addEventListener("click", () => this.#setReplyTarget(comment));
    actions.append(replyBtn);

    if (this.#authorMode) {
      const deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.dataset.part = "delete-btn";
      deleteBtn.textContent = c.delete;
      deleteBtn.addEventListener("click", () => {
        if (deleteBtn.dataset.confirm === "true") {
          this.#deleteComment(comment.id, deleteBtn);
          return;
        }
        deleteBtn.dataset.confirm = "true";
        deleteBtn.textContent = this.#copy.deleteConfirm;
        const prev = this.#deleteConfirmTimers.get(comment.id);
        if (prev) window.clearTimeout(prev);
        const timer = window.setTimeout(() => {
          this.#deleteConfirmTimers.delete(comment.id);
          if (deleteBtn.isConnected && !deleteBtn.disabled) {
            delete deleteBtn.dataset.confirm;
            deleteBtn.textContent = this.#copy.delete;
          }
        }, 4000);
        this.#deleteConfirmTimers.set(comment.id, timer);
      });
      actions.append(deleteBtn);
    }

    head.append(meta, actions);
    li.append(head);

    // Safe plain-text multi-paragraph rendering (0% innerHTML / XSS surface)
    const rawBody = String(comment.body || "").trim();
    if (rawBody) {
      const bodyEl = document.createElement("div");
      bodyEl.dataset.part = "body";
      const paragraphs = rawBody.split(/\n{2,}/);
      for (const para of paragraphs) {
        const p = document.createElement("p");
        const lines = para.split("\n");
        lines.forEach((line, idx) => {
          if (idx > 0) p.append(document.createElement("br"));
          p.append(document.createTextNode(line));
        });
        bodyEl.append(p);
      }
      li.append(bodyEl);
    }

    // Optional same-origin image attachments gallery with native modal lightbox
    const validImages = Array.isArray(comment.images)
      ? comment.images
          .map((img) => {
            if (!img) return null;
            const safeUrl = normalizeSafeAttachmentUrl(img.url);
            return safeUrl ? { ...img, url: safeUrl } : null;
          })
          .filter(Boolean)
      : [];
    if (validImages.length > 0) {
      const gallery = document.createElement("div");
      gallery.dataset.part = "attachments";
      gallery.dataset.count = String(Math.min(3, validImages.length));

      const lightboxEntries = validImages.map((img, i) => {
        const caption = String(img.alt || "").trim();
        return {
          src: img.url,
          alt: caption || c.imageAltFallback(i + 1),
          caption,
          width: Number(img.width || 0),
          height: Number(img.height || 0),
          openableUrl: img.url,
        };
      });

      validImages.forEach((imgObj, idx) => {
        const altText = String(imgObj.alt || "").trim();
        const btn = document.createElement("button");
        btn.type = "button";
        btn.dataset.part = "attachment-btn";
        btn.setAttribute(
          "aria-label",
          altText
            ? `${altText} — ${c.viewImage(idx + 1, validImages.length)}`
            : c.viewImage(idx + 1, validImages.length)
        );
        btn.addEventListener("click", () => {
          this.#openLightbox(lightboxEntries, idx);
        });

        const imgEl = document.createElement("img");
        imgEl.dataset.part = "attachment-img";
        imgEl.src = imgObj.url;
        imgEl.alt = altText || c.imageAltFallback(idx + 1);
        imgEl.loading = "lazy";
        imgEl.decoding = "async";
        if (Number(imgObj.width) > 0 && Number(imgObj.height) > 0) {
          imgEl.width = Number(imgObj.width);
          imgEl.height = Number(imgObj.height);
        }

        btn.append(imgEl);
        gallery.append(btn);
      });

      li.append(gallery);
    }

    return li;
  }

  #animateSortTransition(direction) {
    if (reducedMotionQuery.matches) return;
    const items = [...this.#els.list.children];
    const shift = direction > 0 ? 10 : -10;
    const maxAnimated = Math.min(items.length, 8);
    for (let i = 0; i < maxAnimated; i += 1) {
      const item = items[i];
      if (typeof item.animate !== "function") continue;
      item.animate(
        [
          { opacity: 0, transform: `translateY(${shift}px)` },
          { opacity: 1, transform: "translateY(0)" },
        ],
        {
          duration: 260,
          delay: i * 24,
          easing: "cubic-bezier(0.16, 1, 0.3, 1)",
          fill: "backwards",
        }
      );
    }
  }

  #animateThreadArrival(prevPanelHeight, prevBodyMotion = null) {
    if (reducedMotionQuery.matches) return;
    const { panel, list } = this.#els;
    if (!this.#expanded || panel.hidden) return;

    if (typeof panel.animate === "function") {
      const startHeight = this.#panelAnims.length > 0 ? readLocalHeight(panel) : prevPanelHeight;
      const startBody =
        this.#panelAnims.length > 0
          ? this.#readPanelBodyMotion(false)
          : prevBodyMotion || this.#readPanelBodyMotion(false);
      this.#animatePanelExpand({
        startHeight,
        startBody,
        wasHidden: false,
        heightDuration: 380,
        bodyDuration: 280,
      });
    }

    const items = [...list.children];
    const maxAnimated = Math.min(items.length, 6);
    for (let i = 0; i < maxAnimated; i += 1) {
      const item = items[i];
      if (typeof item.animate !== "function") continue;
      item.animate(
        [
          { opacity: 0, transform: "translateY(8px)" },
          { opacity: 1, transform: "translateY(0)" },
        ],
        {
          duration: 300,
          delay: i * 24,
          easing: "cubic-bezier(0.16, 1, 0.3, 1)",
          fill: "backwards",
        }
      );
    }
  }

  #renderThread(freshId = "", { sortDirection = 0, revealOnLoad = false, prevPanelHeight = 0, prevBodyMotion = null } = {}) {
    const { list, stateNote, threadBar, threadSummary, sortGroup, sortOldestBtn, sortNewestBtn } = this.#els;
    if (!this.#loaded) return;
    this.#clearDeleteConfirmTimers();

    delete stateNote.dataset.state;
    if (this.#comments.length === 0) {
      threadBar.hidden = true;
      list.replaceChildren();
      stateNote.dataset.part = "empty";
      stateNote.textContent = this.#copy.empty;
      stateNote.hidden = false;
      if (revealOnLoad) {
        this.#animateThreadArrival(prevPanelHeight, prevBodyMotion);
      }
      return;
    }

    stateNote.hidden = true;

    const topLevel = [];
    const repliesByParent = new Map();
    for (const comment of this.#comments) {
      if (comment.parentId) {
        const arr = repliesByParent.get(comment.parentId) || [];
        arr.push(comment);
        repliesByParent.set(comment.parentId, arr);
      } else {
        topLevel.push(comment);
      }
    }

    threadBar.hidden = false;
    threadSummary.textContent = this.#copy.threadSummary(this.#comments.length, topLevel.length);
    sortGroup.hidden = topLevel.length < 2;
    sortOldestBtn.setAttribute("aria-pressed", this.#sortOrder === "oldest" ? "true" : "false");
    sortNewestBtn.setAttribute("aria-pressed", this.#sortOrder === "newest" ? "true" : "false");

    const indexedThreads = topLevel.map((parent, idx) => ({ parent, num: idx + 1 }));
    if (this.#sortOrder === "newest") {
      indexedThreads.reverse();
    }

    const frag = document.createDocumentFragment();
    for (const { parent, num } of indexedThreads) {
      const li = this.#buildCommentNode(parent, false, freshId, num);
      const children = repliesByParent.get(parent.id);
      if (children && children.length > 0) {
        const subList = document.createElement("ol");
        subList.dataset.part = "replies";
        for (const child of children) {
          subList.append(this.#buildCommentNode(child, true, freshId));
        }
        li.append(subList);
      }
      frag.append(li);
    }

    list.replaceChildren(frag);
    if (revealOnLoad) {
      this.#animateThreadArrival(prevPanelHeight, prevBodyMotion);
    } else if (sortDirection !== 0) {
      this.#animateSortTransition(sortDirection);
    }
    if (freshId) {
      const freshNode = list.querySelector(`[data-comment-id="${CSS.escape(freshId)}"]`);
      freshNode?.scrollIntoView({ behavior: reducedMotionQuery.matches ? "auto" : "smooth", block: "nearest" });
    }
  }
}

if (!customElements.get("ti-comments")) {
  customElements.define("ti-comments", TiCommentsElement);
}

export { TiCommentsElement };
