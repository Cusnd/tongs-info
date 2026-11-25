/* Tong's Information — Swiss Modular Knowledge Graph Canvas (Animated Transitions) */

const canvas = document.getElementById("knowledge-graph-canvas");
const inspectorEl = document.getElementById("graph-inspector-body");
const isEn = document.documentElement.lang.toLowerCase().startsWith("en");

if (canvas && inspectorEl) {
  const ctx = canvas.getContext("2d");
  const reducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");

  let graphData = null;
  let nodes = [];
  let edges = [];
  let selectedId = null;
  let hoveredId = null;
  let lastLayoutW = 0;
  let lastLayoutH = 0;
  let lastBitmapW = 0;
  let lastBitmapH = 0;
  let lastDpr = 0;
  let rafId = null;
  let lastFrameTs = null;

  /* Smooth per-node, per-edge, pulse ring & theme-color interpolation states */
  const nodeAnim = new Map();
  const edgeAnim = new Map();
  const pulses = [];
  let currentPalette = null;
  let targetPalette = null;

  /* Hidden probe element resolves light-dark() & CSS custom properties into real rgb() for Canvas 2D */
  const colorProbe = document.createElement("span");
  colorProbe.style.position = "absolute";
  colorProbe.style.visibility = "hidden";
  colorProbe.style.pointerEvents = "none";
  colorProbe.setAttribute("aria-hidden", "true");
  document.body.appendChild(colorProbe);

  function parseRgb(str, fallback = [0, 0, 0]) {
    const m = String(str).match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : fallback;
  }

  function rgbCss(c, alpha = 1) {
    const r = Math.round(c[0]);
    const g = Math.round(c[1]);
    const b = Math.round(c[2]);
    return alpha >= 0.999 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(3)})`;
  }

  function mixRgb(a, b, t) {
    return [
      a[0] + (b[0] - a[0]) * t,
      a[1] + (b[1] - a[1]) * t,
      a[2] + (b[2] - a[2]) * t,
    ];
  }

  function resolveRgb(varName, fallbackRgb) {
    colorProbe.style.color = `var(${varName})`;
    const resolved = getComputedStyle(colorProbe).color;
    return parseRgb(resolved, fallbackRgb);
  }

  function readTargetPalette() {
    const styles = getComputedStyle(document.documentElement);
    return {
      bg: resolveRgb("--bg-canvas", [255, 255, 255]),
      surface: resolveRgb("--bg-surface", [255, 255, 255]),
      ink: resolveRgb("--ink-primary", [17, 19, 24]),
      secondary: resolveRgb("--ink-secondary", [78, 86, 102]),
      muted: resolveRgb("--ink-muted", [116, 125, 143]),
      rule: resolveRgb("--rule", [229, 232, 238]),
      accent: resolveRgb("--accent", [0, 71, 255]),
      signal: resolveRgb("--signal", [217, 56, 26]),
      mono: styles.getPropertyValue("--font-mono").trim() || "monospace",
      sans: styles.getPropertyValue("--font-sans").trim() || "sans-serif",
    };
  }

  function clonePalette(p) {
    return {
      bg: [...p.bg],
      surface: [...p.surface],
      ink: [...p.ink],
      secondary: [...p.secondary],
      muted: [...p.muted],
      rule: [...p.rule],
      accent: [...p.accent],
      signal: [...p.signal],
      mono: p.mono,
      sans: p.sans,
    };
  }

  function ensurePalette() {
    if (!targetPalette) targetPalette = readTargetPalette();
    if (!currentPalette) currentPalette = clonePalette(targetPalette);
  }

  function edgeKey(e) {
    return `${e.source}->${e.target}`;
  }

  function layoutNodes(width, height) {
    if (!graphData || width <= 0 || height <= 0) return;
    lastLayoutW = width;
    lastLayoutH = height;

    const cx = width * 0.5;
    const cy = height * 0.5;
    const postNodes = graphData.nodes.filter((n) => n.type === "post");
    const conceptNodes = graphData.nodes.filter((n) => n.type === "concept");

    const rx = Math.min(width * (width < 480 ? 0.34 : 0.4), 300);
    const ry = Math.min(height * 0.37, 195);
    const innerRx = Math.min(width * 0.16, 130);
    const innerRy = Math.min(height * 0.16, 82);

    nodes = [];
    postNodes.forEach((p, i) => {
      if (postNodes.length <= 2) {
        const spread =
          postNodes.length === 1
            ? 0
            : (i / (postNodes.length - 1) - 0.5) * Math.min(width * 0.3, 190);
        nodes.push({
          ...p,
          x: cx + spread,
          y: cy + (i % 2 === 0 ? -20 : 24),
          r: p.tier === "feature" ? 13 : 10,
        });
      } else {
        const angle = (i / postNodes.length) * Math.PI * 2 - Math.PI / 2;
        nodes.push({
          ...p,
          x: cx + Math.cos(angle) * innerRx,
          y: cy + Math.sin(angle) * innerRy,
          r: p.tier === "feature" ? 12 : 9.5,
        });
      }
    });

    conceptNodes.forEach((c, i) => {
      const angle = (i / Math.max(1, conceptNodes.length)) * Math.PI * 2 - Math.PI / 2 + 0.22;
      nodes.push({
        ...c,
        x: cx + Math.cos(angle) * rx,
        y: cy + Math.sin(angle) * ry,
        r: 7.5,
      });
    });

    edges = graphData.edges || [];

    for (const node of nodes) {
      if (!nodeAnim.has(node.id)) {
        nodeAnim.set(node.id, { active: 0, hover: 0 });
      }
    }
    for (const edge of edges) {
      const k = edgeKey(edge);
      if (!edgeAnim.has(k)) {
        edgeAnim.set(k, { highlight: 0 });
      }
    }
  }

  function syncTableHighlight(nodeId) {
    for (const btn of document.querySelectorAll("[data-select-graph-node]")) {
      const row = btn.closest("tr");
      if (!row) continue;
      const match = btn.getAttribute("data-select-graph-node") === nodeId;
      if (match) {
        row.setAttribute("data-graph-active", "true");
        btn.setAttribute("aria-pressed", "true");
      } else {
        row.removeAttribute("data-graph-active");
        btn.setAttribute("aria-pressed", "false");
      }
    }
  }

  function emitNodePulse(node) {
    if (!node || reducedMotionQuery.matches) return;
    pulses.push({ x: node.x, y: node.y, r: node.r, age: 0 });
    if (pulses.length > 4) pulses.shift();
  }

  function selectNode(node, withPulse = true) {
    if (!node) return;
    const changed = selectedId !== node.id;
    selectedId = node.id;
    syncTableHighlight(node.id);
    if (changed) {
      renderInspector(node);
    }
    if (withPulse) {
      emitNodePulse(node);
    }
    requestAnimate();
  }

  function renderInspector(node) {
    if (!node) return;
    const hadFocus = inspectorEl.contains(document.activeElement);
    const label = isEn ? node.en : node.zh;
    const desc = node.description ? (isEn ? node.description.en : node.description.zh) : "";

    const connected = edges
      .filter((e) => e.source === node.id || e.target === node.id)
      .map((e) => (e.source === node.id ? e.target : e.source))
      .map((id) => nodes.find((n) => n.id === id))
      .filter(Boolean);

    inspectorEl.textContent = "";

    /* Wrapper carries @starting-style entry transition */
    const panel = document.createElement("div");
    panel.className = "stack-sm ti-panel-swap";

    const badge = document.createElement("span");
    badge.className = `badge ${node.tier || ""}`.trim();
    badge.textContent =
      node.type === "post"
        ? `NO.${node.issue_no} · ${(node.tier || "essay").toUpperCase()}`
        : isEn
          ? "CONCEPT NODE"
          : "核心概念节点";

    const h2 = document.createElement("h2");
    h2.tabIndex = -1;
    h2.style.fontSize = "var(--text-xl)";
    h2.textContent = label;

    const p = document.createElement("p");
    p.style.fontSize = "var(--text-sm)";
    p.style.color = "var(--ink-secondary)";
    p.textContent = desc;

    panel.append(badge, h2, p);

    if (node.type === "post") {
      const actions = document.createElement("div");
      actions.style.display = "flex";
      actions.style.flexWrap = "wrap";
      actions.style.gap = "0.5rem";

      const readLink = document.createElement("a");
      readLink.className = "btn primary";
      readLink.href = isEn ? node.url.en : node.url.zh;
      readLink.textContent = isEn ? "Open Magazine Edition →" : "阅读杂志版 →";

      const mdLink = document.createElement("a");
      mdLink.className = "btn subtle";
      mdLink.href = isEn ? node.md_url.en : node.md_url.zh;
      mdLink.textContent = "index.md";

      actions.append(readLink, mdLink);
      panel.appendChild(actions);
    } else {
      const filterLink = document.createElement("a");
      filterLink.className = "btn subtle";
      const conceptSlug = node.id.replace(/^concept:/, "");
      filterLink.href = `${isEn ? "/en/archive/" : "/archive/"}?concept=${encodeURIComponent(conceptSlug)}`;
      filterLink.textContent = isEn ? "Filter Archive by Concept →" : "在归档中筛选此概念 →";
      panel.appendChild(filterLink);
    }

    const relHead = document.createElement("h3");
    relHead.className = "footer-heading";
    relHead.style.marginBlockStart = "1rem";
    relHead.textContent = isEn ? `Connected Nodes (${connected.length})` : `直接关联节点（${connected.length}）`;

    const ul = document.createElement("ul");
    ul.className = "footer-list";
    for (const target of connected) {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn subtle";
      btn.style.inlineSize = "100%";
      btn.style.justifyContent = "flex-start";
      btn.style.paddingInline = "0";
      btn.style.textAlign = "start";
      btn.textContent = isEn ? target.en : target.zh;
      btn.addEventListener("click", () => {
        selectNode(target, true);
      });
      li.appendChild(btn);
      ul.appendChild(li);
    }

    panel.append(relHead, ul);
    inspectorEl.appendChild(panel);
    if (hadFocus) {
      h2.focus({ preventScroll: true });
    }
  }

  function advanceAnimations(dt) {
    ensurePalette();
    const instant = reducedMotionQuery.matches;
    const easeRate = instant ? 1 : 1 - Math.exp(-14 * dt);
    const colorRate = instant ? 1 : 1 - Math.exp(-12 * dt);
    let moving = false;

    /* Interpolate palette colors smoothly on theme change */
    for (const key of ["bg", "surface", "ink", "secondary", "muted", "rule", "accent", "signal"]) {
      const cur = currentPalette[key];
      const tgt = targetPalette[key];
      for (let i = 0; i < 3; i++) {
        const diff = tgt[i] - cur[i];
        if (Math.abs(diff) > 0.35) {
          cur[i] += diff * colorRate;
          moving = true;
        } else {
          cur[i] = tgt[i];
        }
      }
    }
    currentPalette.mono = targetPalette.mono;
    currentPalette.sans = targetPalette.sans;

    const activeId = hoveredId || selectedId;

    /* Interpolate node hover & active states */
    for (const node of nodes) {
      const state = nodeAnim.get(node.id);
      if (!state) continue;
      const targetActive = node.id === selectedId || node.id === hoveredId ? 1 : 0;
      const targetHover = node.id === hoveredId ? 1 : 0;

      const da = targetActive - state.active;
      if (Math.abs(da) > 0.004) {
        state.active += da * easeRate;
        moving = true;
      } else {
        state.active = targetActive;
      }

      const dh = targetHover - state.hover;
      if (Math.abs(dh) > 0.004) {
        state.hover += dh * easeRate;
        moving = true;
      } else {
        state.hover = targetHover;
      }
    }

    /* Interpolate edge highlights */
    for (const edge of edges) {
      const state = edgeAnim.get(edgeKey(edge));
      if (!state) continue;
      const targetHl = activeId && (edge.source === activeId || edge.target === activeId) ? 1 : 0;
      const de = targetHl - state.highlight;
      if (Math.abs(de) > 0.004) {
        state.highlight += de * easeRate;
        moving = true;
      } else {
        state.highlight = targetHl;
      }
    }

    /* Advance selection pulse rings (clear immediately under reduced motion) */
    if (instant) {
      pulses.length = 0;
    } else {
      for (let i = pulses.length - 1; i >= 0; i--) {
        pulses[i].age += dt / 0.52;
        if (pulses[i].age >= 1) {
          pulses.splice(i, 1);
        } else {
          moving = true;
        }
      }
    }

    return moving;
  }

  function draw() {
    if (!ctx || !graphData) return;
    ensurePalette();
    const rect = canvas.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    if (w <= 0 || h <= 0) return;

    if (Math.abs(w - lastLayoutW) > 1 || Math.abs(h - lastLayoutH) > 1 || !nodes.length) {
      layoutNodes(w, h);
    }

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const targetBitmapW = Math.max(1, Math.floor(w * dpr));
    const targetBitmapH = Math.max(1, Math.floor(h * dpr));
    if (targetBitmapW !== lastBitmapW || targetBitmapH !== lastBitmapH || dpr !== lastDpr) {
      canvas.width = targetBitmapW;
      canvas.height = targetBitmapH;
      lastBitmapW = targetBitmapW;
      lastBitmapH = targetBitmapH;
      lastDpr = dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const p = currentPalette;

    ctx.fillStyle = rgbCss(p.bg);
    ctx.fillRect(0, 0, w, h);

    /* Subtle Swiss architectural grid lines */
    ctx.strokeStyle = rgbCss(p.rule);
    ctx.lineWidth = 0.75;
    const step = 40;
    ctx.beginPath();
    for (let x = step; x < w; x += step) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
    }
    for (let y = step; y < h; y += step) {
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
    }
    ctx.stroke();

    /* Edges with interpolated emphasis */
    for (const edge of edges) {
      const a = nodes.find((n) => n.id === edge.source);
      const b = nodes.find((n) => n.id === edge.target);
      if (!a || !b) continue;
      const hl = edgeAnim.get(edgeKey(edge))?.highlight ?? 0;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.strokeStyle = rgbCss(mixRgb(p.rule, p.accent, hl));
      ctx.lineWidth = 1.1 + hl * 1.1;
      ctx.stroke();
    }

    /* Expanding Swiss pulse rings on node selection */
    for (const pulse of pulses) {
      const easeOut = 1 - (1 - pulse.age) ** 3;
      const radius = pulse.r + 4 + easeOut * 26;
      const alpha = (1 - pulse.age) ** 1.5 * 0.55;
      ctx.beginPath();
      ctx.arc(pulse.x, pulse.y, radius, 0, Math.PI * 2);
      ctx.strokeStyle = rgbCss(p.accent, alpha);
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    /* Nodes with interpolated scale, halo & label ink */
    for (const node of nodes) {
      const anim = nodeAnim.get(node.id) || { active: 0, hover: 0 };
      const radius = node.r + anim.active * 1.6 + anim.hover * 0.9;

      if (node.type === "post") {
        ctx.beginPath();
        ctx.arc(node.x, node.y, radius, 0, Math.PI * 2);
        ctx.fillStyle = rgbCss(node.tier === "feature" ? p.signal : p.ink);
        ctx.fill();
        if (anim.active > 0.02) {
          ctx.lineWidth = 2.5 * anim.active + 0.5;
          ctx.strokeStyle = rgbCss(p.accent, anim.active);
          ctx.stroke();
        }
      } else {
        const size = radius * 2;
        ctx.fillStyle = rgbCss(mixRgb(p.surface, p.accent, anim.active));
        ctx.strokeStyle = rgbCss(mixRgb(p.ink, p.accent, anim.active));
        ctx.lineWidth = 1.75 + anim.active * 0.4;
        ctx.fillRect(node.x - radius, node.y - radius, size, size);
        ctx.strokeRect(node.x - radius, node.y - radius, size, size);
      }

      /* Labels with crisp paper backdrop so crossing edges never obscure text */
      const label = node.type === "post" ? `NO.${node.issue_no}` : isEn ? node.en : node.zh;
      const fontSize = w < 420 && node.type !== "post" ? 11 : 12;
      ctx.font = `600 ${fontSize}px ${node.type === "post" ? p.mono : p.sans}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      const textWidth = ctx.measureText(label).width;
      const halfW = textWidth / 2;
      const pad = 10;
      const labelX = Math.max(pad + halfW, Math.min(w - pad - halfW, node.x));
      const labelY = Math.min(h - fontSize - 8, node.y + radius + 9);
      ctx.fillStyle = rgbCss(p.bg, 0.88);
      ctx.fillRect(labelX - halfW - 4, labelY - 2, textWidth + 8, fontSize + 4);
      ctx.fillStyle = rgbCss(mixRgb(p.ink, p.accent, anim.active));
      ctx.fillText(label, labelX, labelY);
    }

    /* Swiss coordinate legend inside top-left corner */
    ctx.font = `600 11px ${p.mono}`;
    ctx.fillStyle = rgbCss(p.muted);
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText(
      isEn ? "● ISSUE   ■ CONCEPT   CLICK NODE TO INSPECT" : "● 刊物文章   ■ 核心概念   点击节点查看关联",
      16,
      14
    );
  }

  function tick(now) {
    rafId = null;
    if (!graphData) return;
    const dt = lastFrameTs === null ? 1 / 60 : Math.min(0.05, (now - lastFrameTs) / 1000);
    lastFrameTs = now;
    const stillMoving = advanceAnimations(dt);
    draw();
    if (stillMoving) {
      rafId = window.requestAnimationFrame(tick);
    } else {
      lastFrameTs = null;
    }
  }

  function requestAnimate() {
    if (rafId === null) {
      rafId = window.requestAnimationFrame(tick);
    }
  }

  function hitTest(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    for (const node of nodes) {
      const dx = x - node.x;
      const dy = y - node.y;
      if (dx * dx + dy * dy <= (node.r + 16) * (node.r + 16)) {
        return node;
      }
    }
    return null;
  }

  canvas.addEventListener("mousemove", (e) => {
    const hit = hitTest(e.clientX, e.clientY);
    const nextHover = hit ? hit.id : null;
    if (nextHover !== hoveredId) {
      hoveredId = nextHover;
      requestAnimate();
    }
  });

  canvas.addEventListener("mouseleave", () => {
    if (hoveredId !== null) {
      hoveredId = null;
      requestAnimate();
    }
  });

  canvas.addEventListener("click", (e) => {
    const hit = hitTest(e.clientX, e.clientY);
    if (hit) {
      selectNode(hit, true);
    }
  });

  if ("ResizeObserver" in window) {
    new ResizeObserver(() => requestAnimate()).observe(canvas);
  }
  window.addEventListener("resize", () => requestAnimate());

  /* Re-interpolate canvas smoothly when color scheme changes via toggle or OS */
  function refreshThemePalette() {
    targetPalette = readTargetPalette();
    if (document.documentElement.dataset.vtMode === "theme-switch" || reducedMotionQuery.matches) {
      currentPalette = clonePalette(targetPalette);
      draw();
      return;
    }
    requestAnimate();
  }

  const meta = document.querySelector('meta[name="color-scheme"]');
  if (meta) {
    new MutationObserver(refreshThemePalette).observe(meta, {
      attributes: true,
      attributeFilter: ["content"],
    });
  }
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", refreshThemePalette);
  reducedMotionQuery.addEventListener("change", () => {
    if (reducedMotionQuery.matches) {
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
        rafId = null;
      }
      lastFrameTs = null;
      pulses.length = 0;
      advanceAnimations(1);
      draw();
    }
  });
  function watchDensity() {
    const query = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    query.addEventListener("change", () => { requestAnimate(); watchDensity(); }, { once: true });
  }
  watchDensity();

  /* Hook accessible list buttons on the page to also select nodes with smooth scroll */
  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-select-graph-node]");
    if (!btn) return;
    const id = btn.getAttribute("data-select-graph-node");
    const node = nodes.find((n) => n.id === id);
    if (node) {
      selectNode(node, true);
      const workspace = canvas.closest(".graph-workspace");
      if (workspace) {
        const rect = workspace.getBoundingClientRect();
        if (rect.top < 0 || rect.bottom > window.innerHeight) {
          workspace.scrollIntoView({
            behavior: reducedMotionQuery.matches ? "auto" : "smooth",
            block: "nearest",
          });
        }
      }
    }
  });

  fetch("/api/graph.json")
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    })
    .then((data) => {
      graphData = data;
      for (const btn of document.querySelectorAll("[data-select-graph-node]")) {
        btn.hidden = false;
      }
      ensurePalette();
      const rect = canvas.getBoundingClientRect();
      layoutNodes(rect.width, rect.height);
      const firstPost = nodes.find((n) => n.type === "post") || nodes[0];
      if (firstPost) {
        selectedId = firstPost.id;
        const initState = nodeAnim.get(firstPost.id);
        if (initState) initState.active = 1;
        for (const edge of edges) {
          if (edge.source === firstPost.id || edge.target === firstPost.id) {
            const es = edgeAnim.get(edgeKey(edge));
            if (es) es.highlight = 1;
          }
        }
        syncTableHighlight(firstPost.id);
        renderInspector(firstPost);
      }
      requestAnimate();
    })
    .catch(() => {
      inspectorEl.textContent = isEn
        ? "Could not load /api/graph.json."
        : "无法加载 /api/graph.json 数据。";
    });
}
