/* Tong's Information — Zero-Dependency Progressive Enhancement & Motion Runtime */

const COLOR_SCHEME_KEY = "color-scheme";
const reducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
const isEnglish = document.documentElement.lang.toLowerCase().startsWith("en");
let cachedCatalog = null;
let cachedStream = null;

function getSiteMeta() {
  const header = document.querySelector(".site-header");
  const titleParts = document.title.split("|").map((s) => s.trim()).filter(Boolean);
  const titleFallback = titleParts.length > 0 ? titleParts[titleParts.length - 1] : "";
  return {
    name:
      cachedCatalog?.site?.name ||
      header?.dataset.siteName ||
      document.querySelector(".brand-wordmark")?.textContent?.trim() ||
      titleFallback ||
      window.location.hostname,
    author:
      cachedCatalog?.site?.author ||
      header?.dataset.siteAuthor ||
      "",
  };
}

/* =====================================================================
   SHARED MOTION PRIMITIVES & FEATURE PROBES
   ===================================================================== */
let cachedDisplayTransitionSupport;
function canTransitionDisplay() {
  if (cachedDisplayTransitionSupport !== undefined) return cachedDisplayTransitionSupport;
  if (!window.CSS?.supports?.("transition-behavior", "allow-discrete") || !document.body) {
    return false;
  }
  const probe = document.createElement("div");
  probe.style.cssText = "transition: display 1s allow-discrete !important; display: block;";
  document.body.appendChild(probe);
  getComputedStyle(probe).display;
  probe.style.display = "none";
  cachedDisplayTransitionSupport = getComputedStyle(probe).display === "block";
  probe.remove();
  return cachedDisplayTransitionSupport;
}

function supportsTopLayerExit() {
  return Boolean(window.CSS?.supports?.("overlay", "auto") && canTransitionDisplay());
}

let activeViewTransition = null;
let viewTransitionSeq = 0;

/** Run a typed same-document View Transition with rapid-trigger resilience & graceful fallback. */
function runViewTransition(updateFn, typeName, onFinally) {
  if (!document.startViewTransition || reducedMotionQuery.matches) {
    updateFn();
    onFinally?.(true);
    return null;
  }

  /* Supersede any in-flight same-document transition immediately on rapid clicks */
  if (activeViewTransition) {
    try {
      activeViewTransition.skipTransition?.();
    } catch {
      /* ignore already-finished transitions */
    }
    activeViewTransition = null;
  }

  const root = document.documentElement;
  const seq = ++viewTransitionSeq;
  if (typeName) root.dataset.vtMode = typeName;

  let vt;
  try {
    vt = document.startViewTransition({
      update: updateFn,
      types: typeName ? [typeName] : [],
    });
  } catch {
    try {
      vt = document.startViewTransition(updateFn);
    } catch {
      if (seq === viewTransitionSeq && typeName) delete root.dataset.vtMode;
      updateFn();
      onFinally?.(true);
      return null;
    }
  }

  activeViewTransition = vt;
  vt.updateCallbackDone?.catch?.(() => {});
  vt.ready?.catch?.(() => {});
  vt.finished
    ?.catch?.(() => {})
    .finally(() => {
      const isLatest = seq === viewTransitionSeq;
      if (activeViewTransition === vt) {
        activeViewTransition = null;
      }
      if (isLatest && typeName && root.dataset.vtMode === typeName) {
        delete root.dataset.vtMode;
      }
      onFinally?.(isLatest);
    });
  return vt;
}

function announce(message) {
  const region = document.getElementById("live-announcer");
  if (!region) return;
  region.textContent = "";
  window.setTimeout(() => {
    region.textContent = message;
  }, 40);
}

/* =====================================================================
   LAYER 2: LIGHT ↔ DARK THEME SWITCH WITH INK-WASH VIEW TRANSITION
   ===================================================================== */
function getSystemScheme() {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function getStoredScheme() {
  try {
    const val = localStorage.getItem(COLOR_SCHEME_KEY);
    return val === "light" || val === "dark" ? val : null;
  } catch {
    return null;
  }
}

function getMetaScheme() {
  const val = document.querySelector('meta[name="color-scheme"]')?.content?.trim();
  return val === "light" || val === "dark" ? val : null;
}

function applySchemeMeta(scheme) {
  const meta = document.querySelector('meta[name="color-scheme"]');
  if (meta) {
    meta.content = scheme ?? "light dark";
  }
}

let pendingThemeTarget = null;
let detachRapidThemeProxy = null;

function clearRapidThemeProxy() {
  if (detachRapidThemeProxy) {
    detachRapidThemeProxy();
    detachRapidThemeProxy = null;
  }
}

function attachRapidThemeProxy(triggerBtn) {
  clearRapidThemeProxy();
  if (!triggerBtn) return;
  const rect = triggerBtn.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return;

  /* In Chromium, a second physical click during a root View Transition can hit
     document.documentElement (HTML) instead of the underlying toggle button. */
  const handler = (event) => {
    if (event.button !== 0 || event.target !== document.documentElement) return;
    const x = event.clientX;
    const y = event.clientY;
    if (x >= rect.left - 2 && x <= rect.right + 2 && y >= rect.top - 2 && y <= rect.bottom + 2) {
      event.stopImmediatePropagation();
      toggleColorScheme(event, triggerBtn);
    }
  };
  document.addEventListener("click", handler, true);
  detachRapidThemeProxy = () => {
    document.removeEventListener("click", handler, true);
  };
}

function toggleColorScheme(originEvent, triggerBtn) {
  const currentRendered = pendingThemeTarget ?? getMetaScheme() ?? getStoredScheme() ?? getSystemScheme();
  const target = currentRendered === "dark" ? "light" : "dark";
  const systemNow = getSystemScheme();
  pendingThemeTarget = target;

  const commitScheme = () => {
    if (pendingThemeTarget === target) {
      pendingThemeTarget = null;
    }
    if (target === systemNow) {
      try {
        localStorage.removeItem(COLOR_SCHEME_KEY);
      } catch {
        /* ignore storage restrictions */
      }
      applySchemeMeta(null);
    } else {
      try {
        localStorage.setItem(COLOR_SCHEME_KEY, target);
      } catch {
        /* ignore storage restrictions */
      }
      applySchemeMeta(target);
    }
  };

  /* Compute circular wash origin from pointer click or button center */
  let x = window.innerWidth * 0.9;
  let y = 28;
  if (originEvent && originEvent.clientX > 0 && originEvent.clientY > 0) {
    x = originEvent.clientX;
    y = originEvent.clientY;
  } else if (triggerBtn) {
    const rect = triggerBtn.getBoundingClientRect();
    x = rect.left + rect.width / 2;
    y = rect.top + rect.height / 2;
  }

  const maxRadius = Math.hypot(
    Math.max(x, window.innerWidth - x),
    Math.max(y, window.innerHeight - y)
  );
  const rootStyle = document.documentElement.style;
  rootStyle.setProperty("--theme-origin-x", `${x.toFixed(1)}px`);
  rootStyle.setProperty("--theme-origin-y", `${y.toFixed(1)}px`);
  rootStyle.setProperty("--theme-radius", `${Math.ceil(maxRadius)}px`);

  clearRapidThemeProxy();
  const vt = runViewTransition(commitScheme, "theme-switch", (isLatest) => {
    if (isLatest) clearRapidThemeProxy();
  });
  if (vt && triggerBtn) {
    attachRapidThemeProxy(triggerBtn);
  }

  announce(
    isEnglish
      ? target === "dark"
        ? "Switched to dark theme."
        : "Switched to light theme."
      : target === "dark"
        ? "已切换至深色模式。"
        : "已切换至浅色模式。"
  );
}

/* Sync theme override across browser tabs */
window.addEventListener("storage", (event) => {
  if (event.key === COLOR_SCHEME_KEY) {
    applySchemeMeta(getStoredScheme());
  }
});

/* Theme toggle button */
for (const btn of document.querySelectorAll("[data-theme-toggle]")) {
  btn.addEventListener("click", (event) => {
    toggleColorScheme(event, btn);
  });
}

/* =====================================================================
   LAYER 3: TOP-LAYER DIALOG ANIMATION & SAFARI/FIREFOX EXIT FALLBACK
   ===================================================================== */
const dialogOpSeq = new WeakMap();

function nextDialogOp(dialog) {
  const next = (dialogOpSeq.get(dialog) || 0) + 1;
  dialogOpSeq.set(dialog, next);
  return next;
}

async function closeTopLayer(dialog) {
  if (!dialog || !dialog.open) return;
  if (!supportsTopLayerExit()) {
    if (dialog.hasAttribute("data-closing")) return;
    const seq = nextDialogOp(dialog);
    dialog.setAttribute("data-closing", "");
    const animations = dialog.getAnimations({ subtree: true });
    if (animations.length > 0) {
      await Promise.race([
        Promise.allSettled(animations.map((a) => a.finished)),
        new Promise((resolve) => window.setTimeout(resolve, 600)),
      ]);
    }
    if (dialogOpSeq.get(dialog) !== seq || !dialog.hasAttribute("data-closing")) return;
    dialog.removeAttribute("data-closing");
  }
  dialog.close();
}

function bindDialog(dialog) {
  if (!dialog || dialog.dataset.dialogBound === "true") return;
  dialog.dataset.dialogBound = "true";

  /* Route Esc & native light dismiss through top-layer exit helper */
  dialog.addEventListener("cancel", (event) => {
    if (!supportsTopLayerExit()) {
      event.preventDefault();
      closeTopLayer(dialog);
    }
  });

  /* Route explicit form[method="dialog"] Close button through exit helper */
  const closeForm = dialog.querySelector('form[method="dialog"]');
  if (closeForm) {
    closeForm.addEventListener("submit", (event) => {
      if (!supportsTopLayerExit()) {
        event.preventDefault();
        closeTopLayer(dialog);
      }
    });
  }

  dialog.addEventListener("close", () => {
    nextDialogOp(dialog);
    dialog.removeAttribute("data-closing");
    dialog.returnValue = "";
  });

  /* Mandatory Safari fallback for <dialog closedby="any"> */
  if (!("closedBy" in HTMLDialogElement.prototype) && dialog.getAttribute("closedby") === "any") {
    const outside = (e) => {
      const r = dialog.getBoundingClientRect();
      return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
    };
    let pressedOutside = false;
    dialog.addEventListener("pointerdown", (e) => {
      pressedOutside = outside(e);
    });
    dialog.addEventListener("pointerup", (e) => {
      if (pressedOutside && outside(e)) {
        closeTopLayer(dialog);
      }
      pressedOutside = false;
    });
  }
}

for (const dialog of document.querySelectorAll("dialog.command-dialog")) {
  bindDialog(dialog);
}

/* Native Command Palette (<dialog id="command-palette">) */
const paletteDialog = document.getElementById("command-palette");
const paletteInput = document.getElementById("palette-search");
const paletteResults = document.getElementById("palette-results");
const supportsSiblingIndex = Boolean(
  window.CSS?.supports?.("animation-delay: calc(sibling-index() * 0.1s)")
);
let catalogLoadFailed = false;
let paletteLoadSeq = 0;
let paletteNavPending = false;

async function loadStream(forceRetry = false) {
  if (cachedStream && !forceRetry) return cachedStream;
  try {
    const res = await fetch("/api/stream.json");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data || !Array.isArray(data.entries)) throw new Error("Invalid stream payload");
    cachedStream = data;
    return cachedStream;
  } catch {
    return null;
  }
}

async function loadCatalog(forceRetry = false) {
  if (cachedCatalog && !forceRetry) return cachedCatalog;
  catalogLoadFailed = false;
  try {
    const res = await fetch("/api/posts.json");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data || !Array.isArray(data.posts)) throw new Error("Invalid catalog payload");
    cachedCatalog = data;
    return cachedCatalog;
  } catch {
    catalogLoadFailed = true;
    return null;
  }
}

function buildResultNode(item, index, animateMode) {
  const li = document.createElement("li");
  li.dataset.resultKey = item.key;
  if (!supportsSiblingIndex) {
    li.style.setProperty("--sibling-index", String(Math.min(index + 1, 10)));
  }
  if (animateMode === "filter") {
    li.className = "ti-result-enter";
  }

  if (item.kind === "status") {
    li.classList.add("dialog-result-status");
    li.setAttribute("role", "status");

    const msg = document.createElement("span");
    msg.textContent = isEnglish
      ? "Could not load the article index (/api/posts.json). Static navigation remains available."
      : "无法加载文章检索索引（/api/posts.json），下方静态导航入口仍可使用。";

    const retryBtn = document.createElement("button");
    retryBtn.type = "button";
    retryBtn.className = "btn subtle";
    retryBtn.textContent = isEnglish ? "Retry" : "重试";
    retryBtn.addEventListener("click", async () => {
      const seq = ++paletteLoadSeq;
      await Promise.all([loadCatalog(true), loadStream(true)]);
      if (seq === paletteLoadSeq && paletteDialog?.open && !paletteDialog.hasAttribute("data-closing")) {
        renderPaletteResults(paletteInput ? paletteInput.value : "", "filter");
      }
    });

    li.append(msg, retryBtn);
    return li;
  }

  if (item.kind === "empty") {
    li.classList.add("dialog-result-link");
    li.textContent = isEnglish ? "No matching dispatches or endpoints." : "未找到匹配的刊物或协议入口。";
    return li;
  }

  const a = document.createElement("a");
  a.className = "dialog-result-link";
  a.href = item.href;

  const titleSpan = document.createElement("span");
  titleSpan.textContent = item.title;

  const metaSpan = document.createElement("span");
  metaSpan.className = "mono";
  metaSpan.style.fontSize = "var(--text-xs)";
  metaSpan.style.color = "var(--ink-muted)";
  metaSpan.textContent = item.meta;

  a.append(titleSpan, metaSpan);
  li.appendChild(a);
  return li;
}

function renderPaletteResults(query = "", animateMode = "filter") {
  if (!paletteResults) return;
  const q = query.trim().toLowerCase();
  const langKey = isEnglish ? "en" : "zh";
  const entries = [];

  if (catalogLoadFailed && !cachedCatalog) {
    entries.push({ key: "__status__", kind: "status" });
  }

  const items = [];
  if (cachedCatalog) {
    const conceptLookup = new Map();
    for (const c of cachedCatalog.concepts || []) {
      conceptLookup.set(c.id, `${c.id} ${c.zh || ""} ${c.en || ""}`);
    }

    for (const post of cachedCatalog.posts || []) {
      const loc = post[langKey] || post.zh;
      const conceptTerms = (post.concepts || [])
        .map((cid) => conceptLookup.get(cid) || cid)
        .join(" ");
      const haystack = `${post.issue_no} ${loc.title} ${loc.summary} ${conceptTerms}`.toLowerCase();
      if (!q || haystack.includes(q)) {
        items.push({
          key: `link:${loc.url}`,
          kind: "link",
          href: loc.url,
          title: loc.title,
          meta: `NO.${post.issue_no} · ${post.tier.toUpperCase()}`,
        });
      }
    }
  }

  if (cachedStream && Array.isArray(cachedStream.entries)) {
    const kindLabels = cachedStream.kinds || {};
    const conceptLookup = new Map();
    for (const c of cachedCatalog?.concepts || []) {
      conceptLookup.set(c.id, `${c.id} ${c.zh || ""} ${c.en || ""}`);
    }
    const streamBase = isEnglish ? "/en/stream/" : "/stream/";

    for (const entry of cachedStream.entries) {
      const loc = entry[langKey] || entry.zh;
      if (!loc) continue;
      const bodyText = Array.isArray(loc.body) ? loc.body.join(" ") : "";
      const quoteText = loc.quote?.text || "";
      const quoteSource = loc.quote?.source || "";
      const codeLang = loc.code?.lang || "";
      const codeContent = loc.code?.content || "";
      const updatesText = Array.isArray(loc.updates) ? loc.updates.map((u) => u.text || "").join(" ") : "";
      const kindLabel = kindLabels[entry.kind]?.[langKey] || entry.kind;
      const conceptTerms = (entry.concepts || [])
        .map((cid) => conceptLookup.get(cid) || cid)
        .join(" ");
      const haystack = `#${entry.id} ${entry.date} ${entry.kind} ${kindLabel} ${loc.lead || ""} ${bodyText} ${quoteText} ${quoteSource} ${codeLang} ${codeContent} ${updatesText} ${conceptTerms}`.toLowerCase();

      if (q && haystack.includes(q)) {
        const rawSnippet = (loc.lead || bodyText || quoteText).replace(/\s+/g, " ").trim();
        const snippet = rawSnippet.length > 56 ? `${rawSnippet.slice(0, 56).trim()}…` : rawSnippet;
        items.push({
          key: `link:${streamBase}#t-${entry.id}`,
          kind: "link",
          href: `${streamBase}#t-${entry.id}`,
          title: snippet,
          meta: `#${entry.id} · ${String(kindLabel).toUpperCase()}`,
        });
      }
    }
  }

  const siteName = getSiteMeta().name;
  const staticEntries = isEnglish
    ? [
        { href: "/en/", title: "Cover — Latest Issue", meta: "COVER" },
        { href: "/en/archive/", title: "Complete Issue Archive", meta: "INDEX" },
        { href: "/en/stream/", title: "Stream — Fragments & Field Notes", meta: "STREAM" },
        { href: "/en/graph/", title: "Knowledge Graph — Concept Network", meta: "VIEW" },
        { href: "/en/about/", title: `About ${siteName}`, meta: "INFO" },
        { href: "/llms.txt", title: "llms.txt — Agent Discovery Manifest", meta: "AGENT" },
        { href: "/api/posts.json", title: "api/posts.json — Structured Catalog", meta: "JSON" },
        { href: "/api/stream.json", title: "api/stream.json — Stream Fragments", meta: "JSON" },
      ]
    : [
        { href: "/", title: "封面 — 最新一期", meta: "COVER" },
        { href: "/archive/", title: "完整刊物归档索引", meta: "INDEX" },
        { href: "/stream/", title: "思维 — 碎片思考与公开手记", meta: "STREAM" },
        { href: "/graph/", title: "思想图谱 — 文章与概念拓扑网络", meta: "VIEW" },
        { href: "/about/", title: `关于 ${siteName}`, meta: "INFO" },
        { href: "/llms.txt", title: "llms.txt — Agent 站点导览协议", meta: "AGENT" },
        { href: "/api/posts.json", title: "api/posts.json — 结构化刊物目录", meta: "JSON" },
        { href: "/api/stream.json", title: "api/stream.json — 思维碎片数据", meta: "JSON" },
      ];

  for (const entry of staticEntries) {
    if (!q || `${entry.title} ${entry.meta} ${entry.href}`.toLowerCase().includes(q)) {
      items.push({ key: `link:${entry.href}`, kind: "link", ...entry });
    }
  }

  if (items.length === 0) {
    entries.push({ key: "__empty__", kind: "empty" });
  } else {
    entries.push(...items);
  }

  paletteResults.dataset.stagger = animateMode;

  if (animateMode === "open") {
    const frag = document.createDocumentFragment();
    entries.forEach((item, index) => {
      frag.appendChild(buildResultNode(item, index, "open"));
    });
    paletteResults.replaceChildren(frag);
    return;
  }

  /* Reconcile in place while typing or hydrating so visible items never flicker to opacity 0 */
  const existingByKey = new Map();
  for (const child of [...paletteResults.children]) {
    if (child.dataset?.resultKey) {
      existingByKey.set(child.dataset.resultKey, child);
    }
  }

  const desiredKeys = new Set(entries.map((item) => item.key));
  for (const [key, node] of existingByKey) {
    if (!desiredKeys.has(key)) {
      node.remove();
    }
  }

  let cursor = paletteResults.firstElementChild;
  entries.forEach((item, index) => {
    let node = existingByKey.get(item.key);
    if (node) {
      node.classList.remove("ti-result-enter");
      if (!supportsSiblingIndex) {
        node.style.setProperty("--sibling-index", String(Math.min(index + 1, 10)));
      }
    } else {
      node = buildResultNode(item, index, "filter");
    }

    if (node === cursor) {
      cursor = cursor.nextElementSibling;
    } else {
      paletteResults.insertBefore(node, cursor);
    }
  });
}

async function openPalette() {
  if (!paletteDialog) return;
  nextDialogOp(paletteDialog);
  paletteDialog.removeAttribute("data-closing");
  paletteNavPending = false;

  const wasOpen = paletteDialog.open;
  if (!wasOpen) {
    paletteDialog.showModal();
  }

  /* Render immediately (static links + cached articles) so initial open never stalls empty */
  renderPaletteResults(paletteInput ? paletteInput.value : "", wasOpen ? "filter" : "open");
  if (paletteInput && (!wasOpen || !paletteDialog.contains(document.activeElement))) {
    paletteInput.focus();
  }

  if (!cachedCatalog || !cachedStream) {
    const seq = ++paletteLoadSeq;
    await Promise.all([
      cachedCatalog ? Promise.resolve(cachedCatalog) : loadCatalog(true),
      cachedStream ? Promise.resolve(cachedStream) : loadStream(true),
    ]);
    if (seq !== paletteLoadSeq) return;
    if (catalogLoadFailed) {
      announce(
        isEnglish
          ? "Article search index failed to load. Showing static navigation links."
          : "文章检索索引加载失败，已显示静态导航入口。"
      );
    }
    /* Hydrate articles & stream matches in place without stealing focus from wherever the user navigated */
    if (paletteDialog.open && !paletteDialog.hasAttribute("data-closing")) {
      renderPaletteResults(paletteInput ? paletteInput.value : "", "filter");
    }
  }
}

for (const trigger of document.querySelectorAll("[data-open-palette]")) {
  trigger.addEventListener("click", () => {
    openPalette();
  });
}

if (paletteInput) {
  paletteInput.addEventListener("input", () => {
    renderPaletteResults(paletteInput.value, "filter");
  });
}

if (paletteResults) {
  paletteResults.addEventListener("click", (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    const anchor = event.target?.closest?.("a[href]");
    if (!anchor || (anchor.target && anchor.target !== "_self") || anchor.hasAttribute("download")) return;
    try {
      const dest = new URL(anchor.href, window.location.href);
      const normPath = (p) => p.replace(/\/index\.html$/i, "/");
      if (dest.origin === window.location.origin && normPath(dest.pathname) === normPath(window.location.pathname) && dest.hash) {
        if (paletteDialog?.open) {
          closeTopLayer(paletteDialog);
        }
        return;
      }
    } catch {
      /* fall through to standard navigation */
    }
    paletteNavPending = true;
  });
}

if (paletteDialog && paletteResults) {
  paletteDialog.addEventListener("keydown", (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const links = [...paletteResults.querySelectorAll("a.dialog-result-link")];
    if (links.length === 0) return;

    const currentIdx = links.indexOf(document.activeElement);
    if (event.key === "ArrowDown") {
      event.preventDefault();
      const target = links[currentIdx < 0 ? 0 : (currentIdx + 1) % links.length];
      target.focus();
      target.scrollIntoView({ block: "nearest" });
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (currentIdx <= 0 && paletteInput) {
        paletteInput.focus();
      } else {
        const target = links[currentIdx < 0 ? links.length - 1 : currentIdx - 1];
        target.focus();
        target.scrollIntoView({ block: "nearest" });
      }
    } else if (currentIdx >= 0 && (event.key === "Home" || event.key === "End")) {
      event.preventDefault();
      const target = event.key === "Home" ? links[0] : links[links.length - 1];
      target.focus();
      target.scrollIntoView({ block: "nearest" });
    }
  });
}

window.addEventListener("pagehide", () => {
  if (paletteNavPending && paletteDialog?.open) {
    paletteDialog.removeAttribute("data-closing");
    paletteDialog.close();
  }
  paletteNavPending = false;
});

window.addEventListener("pageshow", (event) => {
  if (event.persisted && paletteDialog?.open) {
    paletteDialog.removeAttribute("data-closing");
    paletteDialog.close();
  }
  paletteNavPending = false;
});

document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    if (paletteDialog?.open && !paletteDialog.hasAttribute("data-closing")) {
      closeTopLayer(paletteDialog);
    } else {
      openPalette();
    }
  }
});

/* =====================================================================
   ARTICLE AGENT TOOLBAR: COPY MARKDOWN TWIN & COPY CITATION
   ===================================================================== */
let copyFallbackDialog = null;

function showManualCopyFallback(text) {
  if (!copyFallbackDialog) {
    copyFallbackDialog = document.createElement("dialog");
    copyFallbackDialog.id = "copy-fallback-dialog";
    copyFallbackDialog.className = "command-dialog";
    copyFallbackDialog.setAttribute("closedby", "any");
    copyFallbackDialog.setAttribute("aria-labelledby", "copy-fallback-title");

    const head = document.createElement("div");
    head.className = "dialog-head";

    const title = document.createElement("h2");
    title.id = "copy-fallback-title";
    title.className = "dialog-title";
    title.textContent = isEnglish ? "Manual Copy" : "手动复制";

    const closeForm = document.createElement("form");
    closeForm.method = "dialog";
    const closeBtn = document.createElement("button");
    closeBtn.type = "submit";
    closeBtn.className = "btn subtle";
    closeBtn.textContent = isEnglish ? "Close" : "关闭";
    closeForm.appendChild(closeBtn);
    head.append(title, closeForm);

    const body = document.createElement("div");
    body.className = "dialog-copy-body";

    const hint = document.createElement("p");
    hint.className = "dialog-copy-hint";
    hint.textContent = isEnglish
      ? "Automatic clipboard access is unavailable in this browser context. Press Ctrl+C / Cmd+C to copy the selected text below."
      : "当前浏览器环境阻止了自动写入剪贴板，请直接按 Ctrl+C / Cmd+C 复制下方已选中的文本。";

    const area = document.createElement("textarea");
    area.id = "copy-fallback-textarea";
    area.className = "dialog-copy-textarea";
    area.readOnly = true;
    area.rows = 6;
    area.setAttribute("aria-label", isEnglish ? "Text ready to copy" : "待复制文本");

    body.append(hint, area);
    copyFallbackDialog.append(head, body);
    document.body.appendChild(copyFallbackDialog);
    bindDialog(copyFallbackDialog);
  }

  const area = copyFallbackDialog.querySelector("#copy-fallback-textarea");
  if (area) {
    area.value = text;
  }
  nextDialogOp(copyFallbackDialog);
  copyFallbackDialog.removeAttribute("data-closing");
  if (!copyFallbackDialog.open) {
    copyFallbackDialog.showModal();
  }
  if (area) {
    area.focus();
    area.select();
  }
}

async function copyText(text, btn, doneLabel, announceMsg) {
  const original = btn.dataset.originalLabel || btn.textContent;
  btn.dataset.originalLabel = original;
  try {
    if (!navigator.clipboard?.writeText) {
      throw new Error("Clipboard API unavailable");
    }
    await navigator.clipboard.writeText(text);
    btn.textContent = doneLabel;
    btn.dataset.copied = "true";
    announce(announceMsg);
    window.clearTimeout(Number(btn.dataset.copyTimer || 0));
    const timer = window.setTimeout(() => {
      btn.textContent = original;
      delete btn.dataset.copied;
    }, 2200);
    btn.dataset.copyTimer = String(timer);
  } catch {
    showManualCopyFallback(text);
    announce(
      isEnglish
        ? "Clipboard access blocked. Opened selectable text dialog for manual copy."
        : "浏览器阻止了剪贴板访问，已打开可手动复制的文本窗口。"
    );
  }
}

for (const btn of document.querySelectorAll("[data-copy-md]")) {
  btn.addEventListener("click", async () => {
    const mdPath = btn.getAttribute("data-copy-md");
    if (!mdPath) return;
    try {
      const res = await fetch(mdPath);
      if (!res.ok) throw new Error("fetch failed");
      const text = await res.text();
      await copyText(
        text,
        btn,
        isEnglish ? "Copied Markdown ✓" : "已复制 Markdown ✓",
        isEnglish ? "Article Markdown copied to clipboard." : "文章洁净 Markdown 已复制到剪贴板。"
      );
    } catch {
      announce(isEnglish ? "Unable to load Markdown twin." : "无法读取 Markdown 孪生原稿。");
    }
  });
}

for (const btn of document.querySelectorAll("[data-copy-cite]")) {
  btn.addEventListener("click", async () => {
    const title = btn.getAttribute("data-cite-title") || document.title;
    const date = btn.getAttribute("data-cite-date") || "2026";
    const issue = btn.getAttribute("data-cite-issue") || "";
    const canonicalHref = document.querySelector('link[rel="canonical"]')?.getAttribute("href");
    const citeUrl = canonicalHref || `${window.location.origin}${window.location.pathname}`;
    const { name: siteName, author } = getSiteMeta();
    const authorPrefix = author ? `${author} (${date}). ` : `(${date}). `;
    const citation = `${authorPrefix}"${title}." ${siteName}${issue ? `, Issue ${issue}` : ""}. ${citeUrl}`;
    await copyText(
      citation,
      btn,
      isEnglish ? "Citation Copied ✓" : "已复制引用 ✓",
      isEnglish ? "Citation copied to clipboard." : "学术引用格式已复制到剪贴板。"
    );
  });
}

/* =====================================================================
   SHARED CROSS-ENGINE SLIDING INDICATOR (CHROME, EDGE, FIREFOX, WEBKIT)
   ===================================================================== */
function mountSlidingIndicator(container, activeSelector, orientation = "horizontal") {
  if (!container || container.dataset.indicatorReady === "true") return null;
  container.dataset.indicatorReady = "true";

  let animated = false;
  let rafId = 0;

  const update = (allowTransition = true) => {
    rafId = 0;
    const activeEl = container.querySelector(activeSelector);
    if (!activeEl) {
      container.style.setProperty("--ind-visible", "0");
      return;
    }

    const cr = container.getBoundingClientRect();
    const ar = activeEl.getBoundingClientRect();
    if (cr.width <= 0 || ar.width <= 0 || ar.height <= 0) {
      container.style.setProperty("--ind-visible", "0");
      return;
    }

    if (!allowTransition) {
      delete container.dataset.indicatorAnimated;
    } else if (animated) {
      container.dataset.indicatorAnimated = "true";
    }

    if (orientation === "vertical") {
      container.style.setProperty("--ind-y", `${(ar.top - cr.top).toFixed(2)}px`);
      container.style.setProperty("--ind-h", `${ar.height.toFixed(2)}px`);
    } else {
      container.style.setProperty("--ind-x", `${(ar.left - cr.left).toFixed(2)}px`);
      container.style.setProperty("--ind-y", `${(ar.bottom - cr.top - 1.5).toFixed(2)}px`);
      container.style.setProperty("--ind-w", `${ar.width.toFixed(2)}px`);
    }
    container.style.setProperty("--ind-visible", "1");

    if (!animated) {
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          animated = true;
          container.dataset.indicatorAnimated = "true";
        });
      });
    } else if (!allowTransition) {
      void container.offsetWidth;
      container.dataset.indicatorAnimated = "true";
    }
  };

  const scheduleUpdate = (allowTransition = true) => {
    if (rafId) window.cancelAnimationFrame(rafId);
    rafId = window.requestAnimationFrame(() => update(allowTransition));
  };

  const mo = new MutationObserver(() => update(true));
  mo.observe(container, {
    subtree: true,
    attributes: true,
    attributeFilter: ["aria-pressed", "aria-selected", "aria-current"],
  });

  if ("ResizeObserver" in window) {
    const ro = new ResizeObserver(() => scheduleUpdate(false));
    ro.observe(container);
  }
  window.addEventListener("resize", () => scheduleUpdate(false), { passive: true });
  document.fonts?.ready?.then(() => scheduleUpdate(false));

  update(false);
  return { update };
}

for (const group of document.querySelectorAll(".filter-group[data-filter-group]")) {
  mountSlidingIndicator(group, '.btn[aria-pressed="true"]', "horizontal");
}
for (const tablist of document.querySelectorAll(".lab-tabs")) {
  mountSlidingIndicator(tablist, '.btn[aria-selected="true"]', "horizontal");
}

/* =====================================================================
   BILINGUAL READING-LOCATION HASH PRESERVATION (A18)
   ===================================================================== */
const COUNTERPART_HASH_MAP = {
  "graph-table-heading": "graph-table-heading-en",
  "graph-table-heading-en": "graph-table-heading",
  "lab01-title": "lab01-title-en",
  "lab01-title-en": "lab01-title",
  "lab02-title": "lab02-title-en",
  "lab02-title-en": "lab02-title",
  "quiet-lab-title": "quiet-lab-title-en",
  "quiet-lab-title-en": "quiet-lab-title",
};

function mapCounterpartHash(rawHash) {
  if (!rawHash || rawHash === "#") return "";
  const id = rawHash.startsWith("#") ? rawHash.slice(1) : rawHash;
  if (!id) return "";
  if (Object.hasOwn(COUNTERPART_HASH_MAP, id)) {
    return `#${COUNTERPART_HASH_MAP[id]}`;
  }
  /* Shared section/lab/stream/inside IDs (no language-specific suffix) carry directly across ZH ↔ EN */
  if (/^(?:s\d+|lab-[a-z0-9-]+|t-[a-z0-9-]+|m-\d{4}-\d{2}|comments|inside|dual-lab|hero-fold)$/i.test(id)) {
    return `#${id}`;
  }
  return "";
}

function getActiveReadingHash() {
  const fromUrl = mapCounterpartHash(window.location.hash);
  if (fromUrl) return fromUrl;

  if (window.scrollY > 220) {
    const activeToc = document.querySelector('.essay-rail .toc-list a[aria-current="location"]');
    const tocHref = activeToc?.getAttribute("href") || "";
    if (tocHref.startsWith("#")) {
      return mapCounterpartHash(tocHref);
    }
  }
  return "";
}

function syncLanguageHashLinks() {
  const mappedHash = getActiveReadingHash();
  for (const link of document.querySelectorAll("header a[hreflang], footer a[hreflang], .article-tools a[hreflang]")) {
    const rawHref = link.getAttribute("href") || "";
    if (!rawHref || rawHref.startsWith("http://") || rawHref.startsWith("https://")) continue;
    const baseWithoutHash = rawHref.split("#")[0];
    const nextHref = mappedHash ? `${baseWithoutHash}${mappedHash}` : baseWithoutHash;
    if (nextHref !== rawHref) {
      link.setAttribute("href", nextHref);
    }
  }
}

window.addEventListener("hashchange", syncLanguageHashLinks);
document.addEventListener(
  "click",
  (event) => {
    const langLink = event.target?.closest?.("header a[hreflang], footer a[hreflang], .article-tools a[hreflang]");
    if (langLink) {
      syncLanguageHashLinks();
    }
  },
  true
);
syncLanguageHashLinks();

/* =====================================================================
   LAYER 4A: READING PROGRESS BAR (NATIVE CSS SCROLL TIMELINE + FALLBACK)
   ===================================================================== */
const progressFill = document.querySelector(".reading-progress-fill");
if (progressFill) {
  const supportsScrollTimeline = Boolean(window.CSS?.supports?.("animation-timeline", "scroll()"));
  let scrollListenerBound = false;
  let progressResizeObserver = null;
  let ticking = false;

  const updateProgress = () => {
    ticking = false;
    const scrollable = document.documentElement.scrollHeight - window.innerHeight;
    const ratio = scrollable > 0 ? Math.min(1, Math.max(0, window.scrollY / scrollable)) : 0;
    progressFill.style.setProperty("--read-progress", ratio.toFixed(4));
  };

  const onProgressMeasure = () => {
    if (!ticking) {
      ticking = true;
      window.requestAnimationFrame(updateProgress);
    }
  };

  const syncProgressMode = () => {
    /* Native CSS scroll() handles normal motion when supported; JS covers unsupported browsers & reduced motion */
    const needsFallback = !supportsScrollTimeline || reducedMotionQuery.matches;
    if (needsFallback && !scrollListenerBound) {
      scrollListenerBound = true;
      window.addEventListener("scroll", onProgressMeasure, { passive: true });
      window.addEventListener("resize", onProgressMeasure, { passive: true });
      if ("ResizeObserver" in window) {
        progressResizeObserver = new ResizeObserver(onProgressMeasure);
        progressResizeObserver.observe(document.documentElement);
        const mainEl = document.querySelector("main") || document.body;
        if (mainEl) progressResizeObserver.observe(mainEl);
      }
      updateProgress();
    } else if (!needsFallback && scrollListenerBound) {
      scrollListenerBound = false;
      window.removeEventListener("scroll", onProgressMeasure);
      window.removeEventListener("resize", onProgressMeasure);
      if (progressResizeObserver) {
        progressResizeObserver.disconnect();
        progressResizeObserver = null;
      }
    }
  };

  syncProgressMode();
  reducedMotionQuery.addEventListener("change", syncProgressMode);
}

/* =====================================================================
   LAYER 4B: ARTICLE TOC SCROLL-SPY (DRIVES SLIDING VERTICAL RAIL MARKER)
   ===================================================================== */
const tocList = document.querySelector(".essay-rail .toc-list");
if (tocList) {
  const tocLinks = [...tocList.querySelectorAll('a[href^="#"]')];
  const sections = tocLinks
    .map((link) => {
      const id = link.getAttribute("href")?.slice(1);
      const target = id ? document.getElementById(id) : null;
      return target ? { link, target } : null;
    })
    .filter(Boolean);

  if (sections.length > 0) {
    let activeLink = null;
    let lockedTocItem = null;
    let lockStartTs = 0;
    let lockIdleTimer = 0;
    let lockMaxTimer = 0;

    const releaseTocLock = (resync = false) => {
      if (!lockedTocItem) return;
      lockedTocItem = null;
      lockStartTs = 0;
      window.clearTimeout(lockIdleTimer);
      window.clearTimeout(lockMaxTimer);
      lockIdleTimer = 0;
      lockMaxTimer = 0;
      if (resync) pickByScroll();
    };

    const setActiveToc = (link) => {
      if (!link || link === activeLink) return;
      for (const item of sections) {
        if (item.link === link) {
          item.link.setAttribute("aria-current", "location");
        } else {
          item.link.removeAttribute("aria-current");
        }
      }
      activeLink = link;
      syncLanguageHashLinks();
    };

    const pickByScroll = () => {
      if (lockedTocItem) return;
      const markerY = Math.min(200, window.innerHeight * 0.28);
      let current = sections[0];
      for (const item of sections) {
        const rect = item.target.getBoundingClientRect();
        if (rect.top <= markerY) {
          current = item;
        }
      }
      if (
        window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 4 &&
        sections.length > 0
      ) {
        const lastRect = sections[sections.length - 1].target.getBoundingClientRect();
        if (lastRect.top < window.innerHeight) {
          current = sections[sections.length - 1];
        }
      }
      setActiveToc(current.link);
      syncLanguageHashLinks();
    };

    if ("IntersectionObserver" in window) {
      const tocObserver = new IntersectionObserver(
        () => {
          pickByScroll();
        },
        { rootMargin: "-12% 0px -65% 0px", threshold: [0, 0.1, 1] }
      );
      for (const item of sections) tocObserver.observe(item.target);
    }

    let tocTick = false;
    window.addEventListener(
      "scroll",
      () => {
        if (lockedTocItem) {
          window.clearTimeout(lockIdleTimer);
          lockIdleTimer = window.setTimeout(() => releaseTocLock(true), 180);
          return;
        }
        if (!tocTick) {
          tocTick = true;
          window.requestAnimationFrame(() => {
            tocTick = false;
            pickByScroll();
          });
        }
      },
      { passive: true }
    );

    if ("onscrollend" in window) {
      window.addEventListener(
        "scrollend",
        () => {
          if (lockedTocItem && performance.now() - lockStartTs > 160) {
            releaseTocLock(true);
          }
        },
        { passive: true }
      );
    }

    /* Release programmatic TOC lock immediately if the reader scrolls manually */
    window.addEventListener("wheel", () => releaseTocLock(true), { passive: true });
    window.addEventListener("touchstart", () => releaseTocLock(true), { passive: true });
    window.addEventListener("keydown", (event) => {
      if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) {
        releaseTocLock(true);
      }
    });

    for (const item of sections) {
      item.link.addEventListener("click", () => {
        releaseTocLock(false);
        setActiveToc(item.link);
        if (!reducedMotionQuery.matches) {
          lockedTocItem = item;
          lockStartTs = performance.now();
          lockIdleTimer = window.setTimeout(() => releaseTocLock(true), 280);
          lockMaxTimer = window.setTimeout(() => releaseTocLock(true), 1500);
        }
      });
    }

    pickByScroll();
    mountSlidingIndicator(tocList, 'a[aria-current="location"]', "vertical");
  }
}

/* =====================================================================
   LAYER 4C: SCROLL-DRIVEN REVEAL FALLBACK (DYNAMIC REDUCED-MOTION SAFE)
   ===================================================================== */
const supportsNativeViewReveal = Boolean(
  window.CSS?.supports?.("(animation-timeline: view()) and (animation-range: entry)")
);

if (!supportsNativeViewReveal && "IntersectionObserver" in window) {
  const revealTargets = [
    ...document.querySelectorAll(
      ".inside-band .feature-plate-card, .inside-band .editor-note-col, .prose .feature-lab, .prose figure, .prose blockquote, .article-footer-band"
    ),
  ];

  let revealObserver = null;

  const revealElementImmediately = (el) => {
    if (!el) return;
    if (el.getAttribute("data-scroll-reveal") === "pending") {
      el.setAttribute("data-scroll-reveal", "visible");
    }
    revealObserver?.unobserve(el);
  };

  const clearScrollRevealFallback = () => {
    if (revealObserver) {
      revealObserver.disconnect();
      revealObserver = null;
    }
    for (const el of revealTargets) {
      el.removeAttribute("data-scroll-reveal");
    }
  };

  const syncScrollRevealFallback = () => {
    if (reducedMotionQuery.matches) {
      clearScrollRevealFallback();
      return;
    }

    if (revealObserver) return;
    const belowFold = revealTargets.filter(
      (el) =>
        el.getAttribute("data-scroll-reveal") !== "visible" &&
        el.getBoundingClientRect().top > window.innerHeight * 0.92
    );
    if (belowFold.length === 0) return;

    revealObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.setAttribute("data-scroll-reveal", "visible");
            revealObserver?.unobserve(entry.target);
          }
        }
      },
      { rootMargin: "0px 0px -6% 0px", threshold: 0.08 }
    );

    for (const el of belowFold) {
      el.setAttribute("data-scroll-reveal", "pending");
      revealObserver.observe(el);
    }
  };

  /* Keyboard focus or hash jump into a pending target always reveals it immediately */
  document.addEventListener("focusin", (event) => {
    const pendingHost = event.target?.closest?.('[data-scroll-reveal="pending"]');
    if (pendingHost) revealElementImmediately(pendingHost);
  });

  window.addEventListener("hashchange", () => {
    const id = window.location.hash.slice(1);
    if (!id) return;
    const target = document.getElementById(id);
    const pendingHost = target?.closest?.('[data-scroll-reveal="pending"]');
    if (pendingHost) revealElementImmediately(pendingHost);
  });

  syncScrollRevealFallback();
  reducedMotionQuery.addEventListener("change", syncScrollRevealFallback);
}

/* =====================================================================
   LAYER 4D: ARCHIVE TIER & CONCEPT FILTERING (GROUP VIEW TRANSITIONS)
   ===================================================================== */
const archiveList = document.querySelector("[data-archive-list]");
if (archiveList) {
  const tierButtons = [...document.querySelectorAll("[data-filter-tier]")];
  const conceptButtons = [...document.querySelectorAll("[data-filter-concept]")];
  const rows = [...archiveList.querySelectorAll("[data-tier]")];
  const countEl = document.getElementById("archive-count");

  let activeTier = "all";
  let activeConcept = "all";

  function rowVtName(row, index) {
    const slug = (row.getAttribute("data-post-slug") || `item-${index}`)
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, "-");
    return `archive-row-${slug}`;
  }

  function assignArchiveRowNames() {
    rows.forEach((row, index) => {
      row.style.viewTransitionName = rowVtName(row, index);
    });
  }

  function clearArchiveRowNames() {
    for (const row of rows) {
      row.style.viewTransitionName = "";
    }
  }

  async function hideRowFallback(row) {
    if (row.hidden) return;
    if (canTransitionDisplay()) {
      row.hidden = true;
      return;
    }
    row.setAttribute("data-closing", "");
    const animations = row.getAnimations();
    if (animations.length > 0) {
      await Promise.race([
        Promise.allSettled(animations.map((a) => a.finished)),
        new Promise((r) => window.setTimeout(r, 400)),
      ]);
    }
    if (row.hasAttribute("data-closing")) {
      row.removeAttribute("data-closing");
      row.hidden = true;
    }
  }

  function showRowFallback(row) {
    row.removeAttribute("data-closing");
    row.hidden = false;
  }

  function tickArchiveCount(visible) {
    if (!countEl) return;
    const nextText = isEnglish
      ? `${visible} / ${rows.length} dispatches`
      : `显示 ${visible} / ${rows.length} 期`;
    if (countEl.textContent !== nextText) {
      countEl.textContent = nextText;
      delete countEl.dataset.updated;
      void countEl.offsetWidth;
      countEl.dataset.updated = "true";
    }
  }

  const updateArchiveDOM = (useFallbackExit) => {
    let visible = 0;
    for (const row of rows) {
      const tier = row.getAttribute("data-tier");
      const concepts = (row.getAttribute("data-concepts") || "").split(",");
      const matchTier = activeTier === "all" || tier === activeTier;
      const matchConcept = activeConcept === "all" || concepts.includes(activeConcept);
      const show = matchTier && matchConcept;
      if (useFallbackExit) {
        if (show) showRowFallback(row);
        else hideRowFallback(row);
      } else {
        row.removeAttribute("data-closing");
        row.hidden = !show;
      }
      if (show) visible += 1;
    }
    tickArchiveCount(visible);
  };

  const syncArchiveLinks = () => {
    const params = new URLSearchParams();
    if (activeTier !== "all") params.set("tier", activeTier);
    if (activeConcept !== "all") params.set("concept", activeConcept);
    const qs = params.toString();
    const suffix = qs ? `?${qs}` : "";

    /* Keep current URL and bilingual language-switch links aligned with active filters */
    try {
      const nextSelf = `${window.location.pathname}${suffix}${window.location.hash}`;
      if (nextSelf !== `${window.location.pathname}${window.location.search}${window.location.hash}`) {
        window.history.replaceState(null, "", nextSelf);
      }
    } catch {
      /* ignore history restrictions */
    }

    for (const link of document.querySelectorAll("header a[hreflang], footer a[hreflang]")) {
      const baseHref = (link.getAttribute("href") || "").split(/[?#]/)[0];
      if (baseHref === "/archive/" || baseHref === "/en/archive/") {
        link.setAttribute("href", `${baseHref}${suffix}`);
      }
    }
  };

  const applyFilter = (immediate = false) => {
    syncArchiveLinks();
    if (immediate) {
      clearArchiveRowNames();
      updateArchiveDOM(false);
      return;
    }
    if (document.startViewTransition && !reducedMotionQuery.matches) {
      delete document.documentElement.dataset.archiveFallback;
      assignArchiveRowNames();
      runViewTransition(
        () => updateArchiveDOM(false),
        "archive-filter",
        (isLatest) => {
          if (isLatest) clearArchiveRowNames();
        }
      );
    } else {
      clearArchiveRowNames();
      document.documentElement.dataset.archiveFallback = "";
      updateArchiveDOM(true);
    }
  };

  for (const btn of tierButtons) {
    btn.addEventListener("click", () => {
      activeTier = btn.getAttribute("data-filter-tier") || "all";
      for (const b of tierButtons) b.setAttribute("aria-pressed", String(b === btn));
      applyFilter(false);
    });
  }

  for (const btn of conceptButtons) {
    btn.addEventListener("click", () => {
      activeConcept = btn.getAttribute("data-filter-concept") || "all";
      for (const b of conceptButtons) b.setAttribute("aria-pressed", String(b === btn));
      applyFilter(false);
    });
  }

  /* Support URL query ?concept=<id>&tier=<tier> across ZH ↔ EN navigation */
  const initialParams = new URLSearchParams(window.location.search);
  const initialTier = initialParams.get("tier");
  const initialConcept = initialParams.get("concept");
  let hasInitialFilter = false;

  if (initialTier) {
    const matchTierBtn = tierButtons.find((b) => b.getAttribute("data-filter-tier") === initialTier);
    if (matchTierBtn) {
      activeTier = initialTier;
      for (const b of tierButtons) b.setAttribute("aria-pressed", String(b === matchTierBtn));
      hasInitialFilter = true;
    }
  }
  if (initialConcept) {
    const matchBtn = conceptButtons.find((b) => b.getAttribute("data-filter-concept") === initialConcept);
    if (matchBtn) {
      activeConcept = initialConcept;
      for (const b of conceptButtons) b.setAttribute("aria-pressed", String(b === matchBtn));
      hasInitialFilter = true;
    }
  }
  if (hasInitialFilter) {
    applyFilter(true);
  }
}

/* =====================================================================
   LAZY WEB COMPONENT HYDRATION: <ti-comments>
   ===================================================================== */
if (document.querySelector("ti-comments")) {
  import("/assets/js/comments.js").catch(() => {});
}
