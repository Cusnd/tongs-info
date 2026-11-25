/* Issue 05 Interactive Laboratories — Zero-Dependency Vanilla JS */

const isEn = document.documentElement.lang.toLowerCase().startsWith("en");

/* =========================================================
   LAB 01: Dual-Surface Representation Inspector
   ========================================================= */
const dualLab = document.querySelector("[data-dual-lab]");
if (dualLab) {
  const tabList = dualLab.querySelector('[role="tablist"]');
  const tabs = [...dualLab.querySelectorAll('[role="tab"][data-surface]')];
  const view = document.getElementById("dual-specimen-view");
  const bytesEl = document.getElementById("metric-bytes");
  const tokensEl = document.getElementById("metric-tokens");
  const signalEl = document.getElementById("metric-signal");
  const noteEl = document.getElementById("metric-note");
  const bytesBar = document.getElementById("meter-bytes");
  const tokensBar = document.getElementById("meter-tokens");

  function estimateTokens(str) {
    /* Heuristic: CJK ~1.15 tok/char, Latin ~1 tok per 3.8 chars */
    const cjk = (str.match(/[\u4e00-\u9fff]/g) || []).length;
    const other = Math.max(0, str.length - cjk);
    return Math.round(cjk * 1.15 + other / 3.8);
  }

  function formatKb(bytes) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  /* Capture a single immutable baseline snapshot before lab rendering mutates the DOM */
  const baselineHtml = document.documentElement.outerHTML;
  const baselineHtmlBytes = new TextEncoder().encode(baselineHtml).length;
  const baselineHtmlTokens = estimateTokens(baselineHtml);

  const mdCache = {
    status: "idle",
    text: null,
    bytes: 0,
    tokens: 0,
  };

  let activeSurface = "human";
  let renderSeq = 0;

  async function loadMarkdownTwin(force = false) {
    if (!force && mdCache.status === "ready" && mdCache.text !== null) {
      return { ok: true, text: mdCache.text, bytes: mdCache.bytes, tokens: mdCache.tokens };
    }
    try {
      const res = await fetch("./index.md");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      mdCache.status = "ready";
      mdCache.text = text;
      mdCache.bytes = new TextEncoder().encode(text).length;
      mdCache.tokens = estimateTokens(text);
      return { ok: true, text: mdCache.text, bytes: mdCache.bytes, tokens: mdCache.tokens };
    } catch {
      mdCache.status = "error";
      return { ok: false, text: null, bytes: 0, tokens: 0 };
    }
  }

  function pulseMetrics() {
    for (const el of [bytesEl, tokensEl, signalEl]) {
      if (!el) continue;
      delete el.dataset.tick;
      void el.offsetWidth;
      el.dataset.tick = "true";
    }
  }

  function setActiveTab(targetTab, moveFocus = false) {
    for (const t of tabs) {
      const selected = t === targetTab;
      t.setAttribute("aria-selected", String(selected));
      t.tabIndex = selected ? 0 : -1;
    }
    if (view && targetTab.id) {
      view.setAttribute("aria-labelledby", targetTab.id);
    }
    if (moveFocus) {
      targetTab.focus();
    }
  }

  function buildMarkdownNode(mdResult) {
    if (!mdResult.ok) {
      const errWrap = document.createElement("div");
      errWrap.className = "stack-sm ti-panel-swap";
      errWrap.setAttribute("role", "alert");

      const msg = document.createElement("p");
      msg.style.fontSize = "var(--text-sm)";
      msg.style.color = "var(--ink-secondary)";
      msg.textContent = isEn
        ? "Unable to fetch ./index.md right now, so live Markdown metrics are unavailable."
        : "当前无法拉取 ./index.md，因此暂不展示实时 Markdown 体积与 Token 测算。";

      const actionRow = document.createElement("div");
      actionRow.className = "action-row";

      const retryBtn = document.createElement("button");
      retryBtn.type = "button";
      retryBtn.className = "btn primary";
      retryBtn.textContent = isEn ? "Retry ./index.md" : "重试拉取 ./index.md";
      retryBtn.addEventListener("click", () => {
        if (activeSurface === "markdown") {
          renderSurface("markdown", true);
        }
      });

      const rawLink = document.createElement("a");
      rawLink.className = "btn subtle mono";
      rawLink.href = "./index.md";
      rawLink.textContent = isEn ? "Open Raw ./index.md ↗" : "直接打开 ./index.md ↗";

      actionRow.append(retryBtn, rawLink);
      errWrap.append(msg, actionRow);
      return errWrap;
    }

    const pre = document.createElement("pre");
    pre.className = "specimen-code ti-panel-swap";
    pre.setAttribute("role", "region");
    pre.tabIndex = 0;
    pre.setAttribute("aria-label", isEn ? "Live Markdown twin excerpt" : "实时 Markdown 孪生原稿节选");
    const code = document.createElement("code");
    code.textContent = mdResult.text.slice(0, 1200) + (mdResult.text.length > 1200 ? "\n\n[…]" : "");
    pre.appendChild(code);
    return pre;
  }

  function commitMarkdownResult(mdResult) {
    const node = buildMarkdownNode(mdResult);
    view.replaceChildren(node);
    view.removeAttribute("aria-busy");

    if (!mdResult.ok) {
      bytesEl.textContent = "—";
      tokensEl.textContent = "—";
      signalEl.textContent = isEn ? "Unavailable" : "暂不可用";
      bytesBar.style.inlineSize = "0%";
      tokensBar.style.inlineSize = "0%";
      noteEl.textContent = isEn
        ? "Live comparison requires ./index.md to respond with HTTP 200. Use the retry button or open the raw file directly."
        : "实时对比需要 ./index.md 返回 200 响应。请点击重试或直接访问原始 Markdown 文件。";
      pulseMetrics();
      return;
    }

    const savedPct = Math.max(0, Math.round((1 - mdResult.tokens / Math.max(1, baselineHtmlTokens)) * 100));
    bytesEl.textContent = formatKb(mdResult.bytes);
    tokensEl.textContent = `~${mdResult.tokens.toLocaleString()} tok (-${savedPct}%)`;
    signalEl.textContent = isEn ? "96% (Illustrative · Pure Prose + YAML)" : "96%（示意 · 纯正文 + YAML）";
    bytesBar.style.inlineSize = `${Math.max(12, Math.round((mdResult.bytes / Math.max(1, baselineHtmlBytes)) * 62))}%`;
    tokensBar.style.inlineSize = `${Math.max(12, Math.round((mdResult.tokens / Math.max(1, baselineHtmlTokens)) * 65))}%`;
    noteEl.textContent = isEn
      ? `Measured from live ./index.md (${formatKb(mdResult.bytes)}) vs. initial HTML (${formatKb(baselineHtmlBytes)}): estimated ~${savedPct}% fewer LLM tokens while preserving 100% of arguments.`
      : `实测 ./index.md（${formatKb(mdResult.bytes)}）对比初始 HTML（${formatKb(baselineHtmlBytes)}）：估算节省约 ${savedPct}% Token，同时 100% 保留完整论点与元数据。`;
    pulseMetrics();
  }

  async function renderSurface(mode, forceRetry = false) {
    activeSurface = mode;
    const seq = ++renderSeq;

    const domSnippet = [
      `<html lang="${document.documentElement.lang}">`,
      "  <head>",
      '    <link rel="alternate" type="text/markdown" href="./index.md">',
      '    <script type="application/ld+json">{ "@type": "BlogPosting" }</script>',
      "  </head>",
      '  <main id="main-content">',
      '    <article class="prose">',
      "      <h2>§ 01 ...</h2>",
      '      <aside class="sidenote">01 ...</aside>',
      "    </article>",
      "  </main>",
      "</html>",
    ].join("\n");

    if (mode === "human") {
      const wrap = document.createElement("div");
      wrap.className = "stack-sm ti-panel-swap";
      wrap.innerHTML = isEn
        ? `<div class="meta-line"><span class="tier-label">Human Viewport</span><span>Swiss Grid</span></div>
           <p style="font-size: var(--text-xl); font-weight: 700; line-height: 1.25;">Visual Hierarchy, Sidenotes &amp; Interactive Labs</p>
           <p style="font-size: var(--text-sm); color: var(--ink-secondary);">Optimized for biological eyes: balanced line measure, crisp hairlines, light/dark color-scheme, and tactile demonstrations with zero framework hydration.</p>`
        : `<div class="meta-line"><span class="tier-label">人类视口</span><span>瑞士网格</span></div>
           <p style="font-size: var(--text-xl); font-weight: 700; line-height: 1.3;">视觉层级、右侧边注与零框架交互装置</p>
           <p style="font-size: var(--text-sm); color: var(--ink-secondary);">为人类阅读优化：克制的栏宽比例、清晰发丝线、自动响应系统的暗色模式，以及随文嵌入的可操作实验台。</p>`;
      view.replaceChildren(wrap);
      view.removeAttribute("aria-busy");

      bytesEl.textContent = formatKb(baselineHtmlBytes);
      tokensEl.textContent = `~${baselineHtmlTokens.toLocaleString()} tok`;
      signalEl.textContent = isEn ? "58% (Illustrative · HTML + Labs)" : "58%（示意 · HTML + 交互实验）";
      bytesBar.style.inlineSize = "62%";
      tokensBar.style.inlineSize = "65%";
      noteEl.textContent = isEn
        ? "Measured from initial document HTML snapshot; tokens are heuristic estimates. Clean static HTML still carries layout markup and interactive lab code."
        : "体积基于页面初始 HTML 快照实测，Token 为启发式估算。纯静态 HTML 仍包含版式标签与交互实验代码。";
      pulseMetrics();
      return;
    }

    if (mode === "dom") {
      const pre = document.createElement("pre");
      pre.className = "specimen-code ti-panel-swap";
      pre.setAttribute("role", "region");
      pre.tabIndex = 0;
      pre.setAttribute("aria-label", isEn ? "Semantic HTML5 skeleton" : "语义 HTML5 结构示意代码");
      const code = document.createElement("code");
      code.textContent = domSnippet;
      pre.appendChild(code);
      view.replaceChildren(pre);
      view.removeAttribute("aria-busy");

      const domBytes = new TextEncoder().encode(domSnippet).length;
      const domTokens = estimateTokens(domSnippet);
      bytesEl.textContent = `${formatKb(baselineHtmlBytes)} (HTML) · ${domBytes} B`;
      tokensEl.textContent = `~${domTokens.toLocaleString()} tok (skeleton)`;
      signalEl.textContent = isEn ? "79% (Illustrative · Semantic HTML5)" : "79%（示意 · 语义 HTML5）";
      bytesBar.style.inlineSize = "44%";
      tokensBar.style.inlineSize = "45%";
      noteEl.textContent = isEn
        ? "Explicit semantic landmarks (<main>, <article>, JSON-LD, hreflang) let crawlers discover the clean ./index.md twin immediately."
        : "清晰的 HTML5 语义地标、JSON-LD 与 rel=alternate 头部，让外部爬虫第一时间定位到同目录的洁净 ./index.md。";
      pulseMetrics();
      return;
    }

    /* Cached Markdown renders synchronously with zero loading flicker */
    if (!forceRetry && mdCache.status === "ready" && mdCache.text !== null) {
      commitMarkdownResult({ ok: true, text: mdCache.text, bytes: mdCache.bytes, tokens: mdCache.tokens });
      return;
    }

    /* Keep existing content visible while fetching and discard stale responses via seq guard */
    view.setAttribute("aria-busy", "true");
    const mdResult = await loadMarkdownTwin(forceRetry);
    if (seq !== renderSeq || activeSurface !== "markdown") {
      return;
    }
    commitMarkdownResult(mdResult);
  }

  for (const tab of tabs) {
    tab.addEventListener("click", () => {
      setActiveTab(tab, false);
      renderSurface(tab.getAttribute("data-surface") || "human");
    });
  }

  if (tabList && tabs.length > 0) {
    tabList.addEventListener("keydown", (event) => {
      const currentIdx = tabs.indexOf(document.activeElement);
      if (currentIdx === -1) return;
      let nextIdx = currentIdx;
      if (event.key === "ArrowRight") nextIdx = (currentIdx + 1) % tabs.length;
      else if (event.key === "ArrowLeft") nextIdx = (currentIdx - 1 + tabs.length) % tabs.length;
      else if (event.key === "Home") nextIdx = 0;
      else if (event.key === "End") nextIdx = tabs.length - 1;
      else return;

      event.preventDefault();
      const targetTab = tabs[nextIdx];
      setActiveTab(targetTab, true);
      renderSurface(targetTab.getAttribute("data-surface") || "human");
    });
  }

  if (tabs[0]) {
    setActiveTab(tabs[0], false);
  }
  renderSurface("human");
}

/* =========================================================
   LAB 02: Swiss Modular Grid & Type Scale Workbench
   ========================================================= */
const gridLab = document.querySelector("[data-grid-lab]");
if (gridLab) {
  const poster = document.getElementById("swiss-grid-poster");
  const overlay = document.getElementById("swiss-grid-overlay");
  const colsInput = document.getElementById("lab-cols-input");
  const scaleInput = document.getElementById("lab-scale-input");
  const opacityInput = document.getElementById("lab-opacity-input");
  const colsOut = document.getElementById("lab-cols-out");
  const scaleOut = document.getElementById("lab-scale-out");
  const opacityOut = document.getElementById("lab-opacity-out");
  const computedOut = document.getElementById("lab-computed-size");

  function ratioName(r) {
    if (isEn) {
      if (r < 1.2) return "Minor Third";
      if (r < 1.28) return "Major Third";
      if (r < 1.37) return "Perfect Fourth";
      return "Augmented Fourth";
    }
    if (r < 1.2) return "小三度";
    if (r < 1.28) return "大三度";
    if (r < 1.37) return "纯四度";
    return "增四度";
  }

  function syncGridColumns(cols) {
    while (overlay.childElementCount < cols) {
      overlay.appendChild(document.createElement("span"));
    }
    while (overlay.childElementCount > cols) {
      overlay.lastElementChild?.remove();
    }
  }

  function updateGridLab() {
    const cols = Number(colsInput.value);
    const scale = Number(scaleInput.value);
    const op = Number(opacityInput.value);

    poster.style.setProperty("--lab-cols", String(cols));
    poster.style.setProperty("--lab-scale", String(scale));
    poster.style.setProperty("--lab-grid-opacity", String(op / 100));
    poster.style.setProperty("--lab-title-span", String(Math.max(3, Math.round(cols * 0.78))));
    poster.style.setProperty("--lab-copy-span", String(Math.max(3, Math.round(cols * 0.66))));

    /* Preserve existing column nodes so opacity slider transitions stay continuous */
    syncGridColumns(cols);

    colsOut.textContent = isEn ? `${cols} cols` : `${cols} 栏`;
    scaleOut.textContent = `${scale.toFixed(2)} (${ratioName(scale)})`;
    opacityOut.textContent = `${op}%`;
    computedOut.textContent = `${(scale * scale).toFixed(2)} rem`;
  }

  colsInput.addEventListener("input", updateGridLab);
  scaleInput.addEventListener("input", updateGridLab);
  opacityInput.addEventListener("input", updateGridLab);
  updateGridLab();
}
