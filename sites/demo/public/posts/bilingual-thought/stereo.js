/* =====================================================================
   Issue 03 Exclusive — Stereo Margin Reveal & Swiss Onboarding Guide
   Merged Production Edition (Antigravity × Codex)
   ===================================================================== */

function mountStereo() {
  const page = document.querySelector(".page-stereo");
  const article = page?.querySelector("article.prose[data-stereo-article]");
  const rail = article?.closest(".essay-grid")?.querySelector(".essay-rail");
  const json = page?.querySelector("#stereo-data");
  if (!article || !rail || !json || article.hasAttribute("data-stereo-ready")) return;

  let data;
  try {
    data = JSON.parse(json.textContent || "");
  } catch {
    return;
  }
  if (!data?.items || !data.ui || !data.targetLang) return;

  const { items, ui, targetLang, targetBadge } = data;
  const sources = [
    ...article.querySelectorAll("p[data-stereo-id], blockquote[data-stereo-id], aside.sidenote[data-stereo-id]"),
  ].filter((source) => typeof items[source.dataset.stereoId]?.text === "string");
  if (!sources.length) return;

  article.setAttribute("data-stereo-ready", "");

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function btn(className, label) {
    const control = el("button", className, label);
    control.type = "button";
    return control;
  }

  /** Render plain text with inline code spans. */
  function writeCopy(node, text) {
    const fragments = String(text).split(/(`[^`\n]+`)/g);
    fragments.forEach((part, index) => {
      if (!part) return;
      node.append(index % 2 ? el("code", "stereo-code", part.slice(1, -1)) : part);
    });
  }

  let live = document.getElementById("live-announcer");
  if (!live) {
    live = el("div", "stereo-sr");
    live.id = "live-announcer";
    live.setAttribute("aria-live", "polite");
    live.setAttribute("aria-atomic", "true");
    page.append(live);
  }

  let announceTimer = 0;
  function announce(message) {
    if (!message) return;
    window.clearTimeout(announceTimer);
    live.textContent = "";
    announceTimer = window.setTimeout(() => {
      live.textContent = message;
    }, 40);
  }

  const labelDefault = `${targetBadge || "ALT"} · STEREO`;
  const labelPreview =
    data.sourceLang === "en"
      ? `${targetBadge || "中文"} · PREVIEW`
      : `${targetBadge || "EN"} · 示例`;

  // Keep live ranges for the original text only. Sidenote controls and translations
  // are inserted later, and a wrapped text node produces a separate rect per line.
  function textRanges(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const ranges = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!node.data.trim()) continue;
      const range = document.createRange();
      range.setStart(node, node.data.length - node.data.trimStart().length);
      range.setEnd(node, node.data.trimEnd().length);
      ranges.push(range);
    }
    return ranges;
  }

  const entries = sources.map((source) => {
    const id = source.dataset.stereoId;
    const isQuote = source.matches("blockquote");
    const isSidenote = source.matches("aside.sidenote");

    const entry = el("div", "stereo-entry");
    entry.dataset.kind = isSidenote ? "sidenote" : isQuote ? "blockquote" : "p";

    const key = btn("stereo-key");
    const keyText = el("span", "stereo-key-text", ui.mobileCue || targetBadge);
    key.append(keyText);

    const panel = el("div", "stereo-panel");
    panel.id = `stereo-counterpart-${id}`;
    panel.inert = true;
    panel.setAttribute("aria-hidden", "true");

    const clip = el("div", "stereo-clip");
    const inner = el("div", "stereo-panel-inner");

    const head = el("div", "stereo-panel-head");
    const label = el("span", "stereo-label", isSidenote ? (targetBadge || "EN") : labelDefault);
    label.setAttribute("aria-hidden", "true");

    const foldBtn = btn("stereo-fold-btn", ui.mobileCollapse || "Fold");
    foldBtn.setAttribute("aria-label", ui.toggleCloseAria || "Hide counterpart");

    head.append(label, foldBtn);

    const copy = el(isQuote ? "blockquote" : "p", "stereo-copy");
    copy.lang = targetLang;
    writeCopy(copy, items[id].text);

    inner.append(head, copy);
    clip.append(inner);
    panel.append(clip);

    key.setAttribute("aria-controls", panel.id);
    key.setAttribute("aria-expanded", "false");
    key.setAttribute("aria-label", ui.toggleOpenAria || "Reveal counterpart");

    const sourceRanges = textRanges(source);
    const copyRanges = textRanges(copy);
    entry.append(key, panel);
    if (isSidenote) {
      source.append(entry);
    } else {
      source.after(entry);
    }

    const record = { source, entry, key, keyText, panel, label, isSidenote, sourceRanges, copyRanges, open: false };
    key.addEventListener("click", () => toggle(record));
    foldBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (record.open) toggle(record);
    });
    return record;
  });

  /* Quiet borderless controls appended to .essay-rail */
  const railControls = el("div", "stereo-rail-controls");
  const railLabel = el("span", "stereo-rail-label", "STEREO · 2CH");
  const replayBtn = btn("stereo-action", ui.replayGuide || "Replay guide");
  const bulkBtn = btn("stereo-action", ui.toggleAllOpen || "Unfold all");
  bulkBtn.setAttribute("aria-controls", entries.map(({ panel }) => panel.id).join(" "));
  bulkBtn.setAttribute("aria-expanded", "false");

  railControls.append(railLabel, bulkBtn);
  rail.append(railControls);

  function setOpen(record, open) {
    const nextOpen = Boolean(open);
    if (!nextOpen && record.panel.contains(document.activeElement)) {
      record.key.focus({ preventScroll: true });
    }
    record.open = nextOpen;
    record.entry.toggleAttribute("data-open", record.open);
    record.source.toggleAttribute("data-stereo-open", record.open);
    record.label.textContent = record.isSidenote ? (targetBadge || "EN") : labelDefault;
    record.keyText.textContent = record.open
      ? ui.mobileCollapse || "Fold"
      : ui.mobileCue || targetBadge;
    record.key.setAttribute("aria-label", record.open ? ui.toggleCloseAria : ui.toggleOpenAria);
    record.key.setAttribute("aria-expanded", String(record.open));
    record.panel.inert = !record.open;
    record.panel.setAttribute("aria-hidden", String(!record.open));
  }

  function updateBulk() {
    const allOpen = entries.every((record) => record.open);
    bulkBtn.textContent = allOpen ? ui.toggleAllClose : ui.toggleAllOpen;
    bulkBtn.setAttribute("aria-expanded", String(allOpen));
  }

  function toggle(record, forceState) {
    const wasPreview =
      record === first && record.entry.dataset.guide === "preview" && !record.open;
    finishGuide(true);
    const nextOpen = typeof forceState === "boolean" ? forceState : wasPreview ? true : !record.open;
    setOpen(record, nextOpen);
    updateBulk();
    announce(record.open ? ui.announcedOpen : ui.announcedClose);
  }

  bulkBtn.addEventListener("click", () => {
    finishGuide(true);
    const nextOpen = !entries.every((record) => record.open);
    entries.forEach((record) => setOpen(record, nextOpen));
    updateBulk();
    if (data.sourceLang === "en") {
      announce(nextOpen ? "All Chinese counterparts unfolded" : "All Chinese counterparts folded");
    } else {
      announce(nextOpen ? "已展开全部英译" : "已收起全部英译");
    }
  });

  /* ===================================================================
     SWISS ONBOARDING CHOREOGRAPHY (Plays once per session on p1)
     =================================================================== */
  const first = entries.find(({ source }) => source.dataset.stereoId === "p1") || entries[0];
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const SEEN_KEY = "tongs.issue03.margin-guide.v1";

  let seen = false;
  let firstInView = false;
  let guideTimers = [];
  let guideEl = null;

  try {
    seen = sessionStorage.getItem(SEEN_KEY) === "1";
  } catch {
    seen = false;
  }

  function rememberSeen() {
    if (seen) return;
    seen = true;
    try {
      sessionStorage.setItem(SEEN_KEY, "1");
    } catch {}
  }

  function clearGuideTimers() {
    guideTimers.forEach((id) => window.clearTimeout(id));
    guideTimers = [];
  }

  function finishGuide(markSeen = false) {
    if (markSeen) rememberSeen();
    clearGuideTimers();
    if (first?.entry.hasAttribute("data-guide")) {
      first.entry.removeAttribute("data-guide");
      first.label.textContent = labelDefault;
    }
  }

  function showPreview(isStatic = false) {
    if (!first) return;
    first.entry.dataset.guide = isStatic ? "static" : "preview";
    first.label.textContent = labelPreview;
    rememberSeen();
    if (!isStatic) {
      guideTimers.push(window.setTimeout(() => finishGuide(true), 3900));
    }
  }

  function buildGuideNode(showDismiss) {
    const wrap = el("div", "stereo-guide");
    wrap.setAttribute("aria-hidden", showDismiss ? "false" : "true");

    const leader = el("span", "stereo-guide-leader");
    const beacon = el("span", "stereo-guide-beacon");
    beacon.append(
      el("span", "stereo-guide-wave w1"),
      el("span", "stereo-guide-wave w2"),
      el("span", "stereo-guide-core")
    );

    const text = el("div", "stereo-guide-text");
    text.append(
      el("span", "stereo-guide-title", ui.guideTitle),
      el("span", "stereo-guide-sub", ui.guideSub)
    );

    if (showDismiss) {
      const dismiss = btn("stereo-guide-dismiss", ui.guideDismiss || "Got it");
      dismiss.addEventListener("click", (ev) => {
        ev.stopPropagation();
        finishGuide(true);
      });
      text.append(dismiss);
    }

    wrap.append(leader, beacon, text);
    return wrap;
  }

  function startGuide(manual = false) {
    if (!first || document.hidden) return;
    const restarting = first.entry.hasAttribute("data-guide");
    finishGuide(false);
    hideCue();

    if (manual) {
      if (first.open) {
        setOpen(first, false);
        updateBulk();
      }
      first.source.scrollIntoView({
        block: "center",
        behavior: reducedMotion.matches ? "auto" : "smooth",
      });
      first.key.focus({ preventScroll: true });
    }

    if (guideEl) guideEl.remove();
    guideEl = buildGuideNode(reducedMotion.matches);
    first.entry.prepend(guideEl);

    announce(ui.guideSub);

    if (reducedMotion.matches) {
      showPreview(true);
      return;
    }

    if (restarting) first.entry.getBoundingClientRect();
    first.entry.dataset.guide = "taps";
    guideTimers.push(window.setTimeout(() => showPreview(false), 1240));
  }

  if (first) {
    first.key.append(el("span", "stereo-caption", ui.guideTitle));
    railControls.insertBefore(replayBtn, bulkBtn);
    replayBtn.addEventListener("click", () => startGuide(true));

    reducedMotion.addEventListener("change", () => {
      if (reducedMotion.matches && first.entry.dataset.guide === "taps") {
        finishGuide(false);
        if (guideEl) guideEl.remove();
        guideEl = buildGuideNode(true);
        first.entry.prepend(guideEl);
        showPreview(true);
      }
    });
  }

  /* ===================================================================
     PRECISION MARGIN HIT-TESTING (Left & Right Blank Whitespace Only)
     =================================================================== */
  const BLANK_SURFACES = [
    "html",
    "body",
    "main",
    ".article-body-wrap",
    ".essay-grid",
    ".essay-rail",
    ".stereo-rail-controls",
    "[data-stereo-article]",
    ".sidenote-anchor",
  ].join(",");

  const PROTECTED = [
    "a",
    "button",
    "input",
    "select",
    "textarea",
    "label",
    "summary",
    "dialog",
    "[contenteditable]:not([contenteditable='false'])",
    "[role='button']",
    "[role='link']",
    "header",
    "footer",
    ".article-footer-band",
    ".article-tools",
    ".toc-list",
    ".stereo-label",
    ".stereo-guide",
  ].join(",");

  const owners = new Map();
  for (const record of entries) {
    owners.set(record.source, record);
    owners.set(record.entry, record);
  }

  function ownerOf(target) {
    return owners.get(target?.closest(".stereo-entry, [data-stereo-id]"));
  }

  function overText(ranges, x, y) {
    let left = Infinity;
    let right = -Infinity;
    for (const range of ranges) {
      for (const rect of range.getClientRects()) {
        if (rect.width && y >= rect.top && y < rect.bottom) {
          left = Math.min(left, rect.left);
          right = Math.max(right, rect.right);
        }
      }
    }
    // Include the spaces between inline runs on the same line.
    return x >= left && x < right;
  }

  function marginAt(x, y, target) {
    if (!target || target.closest(PROTECTED)) return null;
    const owner = ownerOf(target);
    if (!owner && !target.matches(BLANK_SURFACES)) return null;
    if (owner && !target.closest(".stereo-entry") && overText(owner.sourceRanges, x, y)) return null;
    if (owner?.open && target.closest(".stereo-panel") && overText(owner.copyRanges, x, y)) return null;

    // Split shared gutters at the nearest visible edge. The vertical allowance
    // also covers the space below a note's last line, outside its DOM box.
    let best = null;
    let distance = Infinity;
    const bounds = [];
    for (const record of entries) {
      const rect = record.source.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      const bottom = Math.max(rect.bottom, record.entry.getBoundingClientRect().bottom);
      const dy = Math.max(rect.top - y, y - bottom, 0);
      if (dy > 16) continue;
      bounds.push(rect);
      const dx = Math.max(rect.left - x, x - rect.right, 0);
      const gap = dx * dx + dy * dy;
      if (record === owner || (!owner && gap < distance)) {
        best = { record, rect };
        distance = gap;
      }
    }
    if (!best) return null;

    const { record, rect } = best;
    const left = x < (rect.left + rect.right) / 2;
    const edge = left ? rect.left : rect.right;
    let room = left ? edge : document.documentElement.clientWidth - edge;
    for (const other of bounds) {
      const gap = left ? edge - other.right : other.left - edge;
      if (gap >= 0) room = Math.min(room, gap / 2);
    }
    const railRect = rail.getBoundingClientRect();
    if (left && y >= railRect.top && y <= railRect.bottom && railRect.right <= edge) {
      room = Math.min(room, edge - railRect.right);
    }
    return { record, side: left ? "left" : "right", edge, room };
  }

  /* Overlay for floating hover cue & click-origin dual-ring ripple */
  const overlay = el("div", "stereo-overlay");
  overlay.setAttribute("aria-hidden", "true");
  const cue = el("span", "stereo-cue");
  const cueText = el("span", "stereo-cue-text");
  cue.append(cueText);
  cue.hidden = true;
  overlay.append(cue);
  page.append(overlay);

  let hoveredRecord = null;
  function clearParagraphHover() {
    if (hoveredRecord) {
      delete hoveredRecord.source.dataset.marginHover;
      hoveredRecord = null;
    }
  }

  function hideCue() {
    cue.hidden = true;
    clearParagraphHover();
  }

  function spawnEcho(x, y) {
    if (reducedMotion.matches) return;
    const ring = el("span", "stereo-echo");
    ring.style.left = `${x}px`;
    ring.style.top = `${y}px`;
    overlay.append(ring);
    window.setTimeout(() => ring.remove(), 560);
  }

  let pressed = null;
  let firstClick = null;

  function nearby(point, event) {
    return point && Math.abs(point.x - event.clientX) <= 4 && Math.abs(point.y - event.clientY) <= 4;
  }

  // Cancel the browser's selection default at the start of a whitespace press.
  // Waiting for dblclick is too late: Chrome can already have extended a range.
  document.addEventListener("pointerdown", (event) => {
    leave();
    pressed = null;
    if (!event.isPrimary || event.button !== 0 || event.target.closest(PROTECTED) ||
        event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
      firstClick = null;
      return;
    }

    const { clientX: x, clientY: y } = event;
    const target = document.elementFromPoint(x, y);
    const hit = marginAt(x, y, target);
    // A few pixels of drift can move the second press onto the first glyph or
    // across DOM targets (where Chromium may restart the native click count).
    if (!nearby(firstClick, event) || event.timeStamp - firstClick.time > 400) firstClick = null;
    let record = hit?.record;
    if (firstClick && !target?.closest(PROTECTED) && (record || ownerOf(target) === firstClick.record)) {
      record = firstClick.record;
    }
    if (record) {
      pressed = { record, x, y };
      event.preventDefault();
    } else {
      firstClick = null;
    }
  });

  document.addEventListener("click", (event) => {
    const down = pressed;
    pressed = null;
    if (!nearby(down, event) || event.detail === 0 || event.defaultPrevented) {
      firstClick = null;
      return;
    }
    if (event.detail !== 2 && !firstClick) {
      firstClick = { ...down, time: event.timeStamp };
      return;
    }

    firstClick = null;
    window.getSelection()?.removeAllRanges();
    hideCue();
    toggle(down.record);
    spawnEcho(event.clientX, event.clientY);
  });

  document.addEventListener("dblclick", (event) => {
    if (first.entry.hasAttribute("data-guide") && event.button === 0 &&
        !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      finishGuide(true);
    }
  });

  /* Subtle hover proximity feedback in blank margin whitespace */
  let pointer = null;
  let frame = 0;

  function drawCue() {
    frame = 0;
    if (!pointer || first?.entry.hasAttribute("data-guide")) {
      hideCue();
      return;
    }

    const { x, y } = pointer;
    const hit = marginAt(x, y, document.elementFromPoint(x, y));
    if (!hit) {
      hideCue();
      return;
    }

    if (hoveredRecord && hoveredRecord !== hit.record) {
      delete hoveredRecord.source.dataset.marginHover;
    }
    hoveredRecord = hit.record;
    hit.record.source.dataset.marginHover = hit.side;

    const isLeft = hit.side === "left";
    const room = hit.room;
    const offset = Math.min(hit.record.isSidenote ? 14 : 18, room / 2);
    cue.style.maxWidth = `${Math.max(0, room - offset)}px`;
    cue.dataset.side = hit.side;
    cueText.textContent = hit.record.open
      ? ui.collapseCue || ui.mobileCollapse
      : ui.marginCue || targetBadge;
    cue.style.left = `${hit.edge + (isLeft ? -offset : offset)}px`;
    cue.style.top = `${y}px`;
    cue.hidden = false;
    cue.removeAttribute("data-short");
    cue.toggleAttribute("data-short", cue.scrollWidth > room - offset);
  }

  function requestCue() {
    if (!frame) frame = window.requestAnimationFrame(drawCue);
  }

  function leave() {
    pointer = null;
    hideCue();
  }

  // Keep a stationary pointer in sync while a translation is unfolding below it.
  const layoutObserver = new ResizeObserver(() => {
    if (pointer) requestCue();
  });
  for (const { panel } of entries) layoutObserver.observe(panel);

  document.addEventListener(
    "pointermove",
    (event) => {
      if (event.buttons && !nearby(pressed, event)) {
        pressed = null;
        firstClick = null;
      }
      if (event.pointerType === "touch" || event.buttons) {
        leave();
        return;
      }
      pointer = { x: event.clientX, y: event.clientY };
      requestCue();
    },
    { passive: true }
  );

  function cancelGesture() {
    pressed = null;
    firstClick = null;
    leave();
  }

  // Touch also emits pointerleave after a tap, before the corresponding click.
  document.documentElement.addEventListener("pointerleave", leave);
  document.addEventListener("pointercancel", cancelGesture);
  window.addEventListener("blur", cancelGesture);
  window.addEventListener("resize", cancelGesture);
  window.addEventListener("scroll", cancelGesture, { passive: true });

  document.addEventListener("keydown", (event) => {
    cancelGesture();
    if (event.key === "Escape" && first?.entry.hasAttribute("data-guide")) {
      finishGuide(true);
    }
  });

  if (first && "IntersectionObserver" in window) {
    function playWhenVisible() {
      if (firstInView && !document.hidden && !seen && !first.entry.hasAttribute("data-guide")) {
        startGuide(false);
      }
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        firstInView = entry.isIntersecting && entry.intersectionRatio >= 0.45;
        if (!entry.isIntersecting) {
          finishGuide(false);
        } else {
          playWhenVisible();
        }
      },
      { rootMargin: "0px 0px -10% 0px", threshold: [0, 0.45] }
    );
    observer.observe(first.source);

    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        finishGuide(false);
        leave();
      } else {
        playWhenVisible();
      }
    });
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", mountStereo, { once: true });
} else {
  mountStereo();
}
