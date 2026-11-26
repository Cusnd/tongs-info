/* Tong's Information — Stream (思维) Kinetic Interaction Module (Zero Dependencies)
 * Handles:
 *   1. Progressive activation of JS-only controls (zero dead buttons when JS is disabled)
 *   2. Kind / Concept / Date cross-filtering with Group View Transitions, popstate & URL/lang sync
 *   3. Interactive 35-day Swiss Cadence Matrix (hover readout, cross-highlight, post-layout jump)
 *   4. Serendipity Roam ("随机捞一条") with crisp tabular shuffle & cobalt ink sweep
 *   5. Sticky Month Rail scroll-spy with smooth vertical cobalt indicator
 *   6. Permalink copy & <ti-comments slug="stream"> top-level echo handoff
 */

const reducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
const isEnglish = document.documentElement.lang.toLowerCase().startsWith("en");

/* =====================================================================
   0. WHISPER-LIGHT RIVER STREAMLINE HERO CANVAS ("思维的流动")
   - Hairline horizontal river currents flowing softly left → right
   - Damped elastic cursor parting + subtle downstream wake ripple
   - Text-clearance alpha fade, theme-switch snap, offscreen/hidden pause,
     reduced-motion static contour frame & quiet keyboard-accessible Pause/Flow
   ===================================================================== */
function mountStreamHeroCurrent() {
  const hero = document.getElementById("hero-fold");
  if (!hero || hero.dataset.streamCurrentReady === "true") return;
  hero.dataset.streamCurrentReady = "true";

  const canvas = document.createElement("canvas");
  canvas.className = "stream-hero-canvas";
  canvas.setAttribute("aria-hidden", "true");
  hero.prepend(canvas);

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    canvas.remove();
    return;
  }

  /* Quiet WCAG 2.2.2 Pause / Flow control (label swaps cleanly, no aria-pressed) */
  const toggleBtn = document.createElement("button");
  toggleBtn.type = "button";
  toggleBtn.className = "stream-flow-toggle";
  const setToggleLabel = (paused) => {
    toggleBtn.textContent = isEnglish
      ? paused ? "Flow" : "Pause"
      : paused ? "流动" : "静流";
    toggleBtn.setAttribute(
      "aria-label",
      isEnglish
        ? paused ? "Resume background stream current" : "Pause background stream current"
        : paused ? "恢复页首水流动画" : "暂停页首水流动画"
    );
  };
  let userPaused = false;
  setToggleLabel(false);
  toggleBtn.hidden = reducedMotionQuery.matches;
  hero.append(toggleBtn);

  /* Hidden probe to resolve current CSS custom property tokens accurately */
  const probe = document.createElement("span");
  probe.style.cssText = "position:absolute;visibility:hidden;pointer-events:none;inline-size:0;block-size:0;";
  hero.append(probe);

  function parseRgb(str) {
    const m = String(str).match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [116, 125, 143];
  }

  function readPalette() {
    const resolve = (tok) => {
      probe.style.color = `var(--${tok})`;
      return parseRgb(getComputedStyle(probe).color);
    };
    const isDark =
      document.querySelector('meta[name="color-scheme"]')?.content?.trim() === "dark" ||
      (document.querySelector('meta[name="color-scheme"]')?.content?.trim() !== "light" &&
        window.matchMedia("(prefers-color-scheme: dark)").matches);
    return {
      isDark,
      ink: resolve("ink-secondary"),
      accent: resolve("accent"),
    };
  }

  let pal = readPalette();
  let width = 0;
  let height = 0;
  let dpr = 1;
  let textMask = { left: 0, right: 0 };
  let cachedGradients = { ink: null, accent: null };
  let inViewport = true;
  let rafId = 0;
  let lastTs = 0;
  let phaseTime = 0;

  /* 8 restrained horizontal current threads — 6 pencil-light drafting hairlines + 2 cobalt threads */
  const STREAM_SPECS = [
    { yFrac: 0.16, amp1: 8.0, amp2: 3.2, k1: 0.0044, k2: 0.0105, speed: 0.24, phase: 0.4, weight: 1.0, alpha: 0.24, accent: false },
    { yFrac: 0.28, amp1: 10.5, amp2: 4.0, k1: 0.0050, k2: 0.0122, speed: 0.31, phase: 1.9, weight: 1.1, alpha: 0.31, accent: false },
    { yFrac: 0.40, amp1: 12.5, amp2: 4.6, k1: 0.0040, k2: 0.0094, speed: 0.36, phase: 3.1, weight: 1.35, alpha: 0.42, accent: true },
    { yFrac: 0.51, amp1: 9.5, amp2: 3.6, k1: 0.0055, k2: 0.0118, speed: 0.29, phase: 4.4, weight: 1.1, alpha: 0.33, accent: false },
    { yFrac: 0.62, amp1: 11.0, amp2: 4.2, k1: 0.0046, k2: 0.0102, speed: 0.33, phase: 0.9, weight: 1.05, alpha: 0.29, accent: false },
    { yFrac: 0.73, amp1: 12.0, amp2: 3.8, k1: 0.0042, k2: 0.0112, speed: 0.38, phase: 2.5, weight: 1.30, alpha: 0.38, accent: true },
    { yFrac: 0.84, amp1: 8.5, amp2: 3.2, k1: 0.0052, k2: 0.0126, speed: 0.26, phase: 5.2, weight: 1.0, alpha: 0.25, accent: false },
    { yFrac: 0.93, amp1: 6.0, amp2: 2.4, k1: 0.0058, k2: 0.0135, speed: 0.22, phase: 1.3, weight: 0.95, alpha: 0.20, accent: false },
  ];

  const SAMPLES = 72;
  const streams = STREAM_SPECS.map((spec, idx) => ({
    ...spec,
    idx,
    disp: new Float32Array(SAMPLES),
    vel: new Float32Array(SAMPLES),
  }));

  /* Smoothed pointer state + subtle downstream click crests */
  const ptr = {
    inside: false,
    x: 0,
    y: 0,
    tx: 0,
    ty: 0,
    vx: 0,
    vy: 0,
    strength: 0,
  };
  const crests = [];

  function measureTextZone() {
    const heroRect = hero.getBoundingClientRect();
    const inner = hero.querySelector(".article-hero-inner");
    if (!inner || heroRect.width <= 0) {
      textMask = { left: 0, right: 0 };
      return;
    }
    const textEls = inner.querySelectorAll(".meta-line, h1, .article-deck");
    const range = document.createRange();
    let minL = Infinity;
    let maxR = 0;
    for (const el of textEls) {
      range.selectNodeContents(el);
      const r = range.getBoundingClientRect();
      if (r.width <= 0) continue;
      minL = Math.min(minL, r.left - heroRect.left);
      maxR = Math.max(maxR, r.right - heroRect.left);
    }
    if (!Number.isFinite(minL)) {
      const ir = inner.getBoundingClientRect();
      textMask = { left: ir.left - heroRect.left, right: ir.left - heroRect.left + Math.min(ir.width, 240) };
    } else {
      textMask = { left: Math.max(0, minL), right: Math.min(heroRect.width, maxR) };
    }
  }

  function buildMaskGradient(rgb) {
    const [r, g, b] = rgb;
    const grad = ctx.createLinearGradient(0, 0, width, 0);
    const clampStop = (px) => Math.max(0.001, Math.min(0.999, px / Math.max(1, width)));
    const tL = textMask.left;
    const tR = textMask.right;

    grad.addColorStop(0, `rgba(${r},${g},${b},0)`);
    if (tR > tL && width > 420) {
      const sLeftIn = clampStop(Math.min(tL * 0.45, 72));
      const sTextStart = clampStop(Math.max(0, tL - 28));
      const sTextEnd = clampStop(Math.min(width, tR + 24));
      const sOpenStart = clampStop(Math.min(width - 24, tR + Math.min(110, width * 0.1)));

      if (sLeftIn < sTextStart - 0.02) {
        grad.addColorStop(sLeftIn, `rgba(${r},${g},${b},0.46)`);
      }
      grad.addColorStop(sTextStart, `rgba(${r},${g},${b},0.14)`);
      grad.addColorStop(sTextEnd, `rgba(${r},${g},${b},0.14)`);
      if (sOpenStart > sTextEnd + 0.01) {
        grad.addColorStop(sOpenStart, `rgba(${r},${g},${b},1)`);
      }
      grad.addColorStop(0.94, `rgba(${r},${g},${b},0.78)`);
    } else {
      grad.addColorStop(0.12, `rgba(${r},${g},${b},0.34)`);
      grad.addColorStop(0.75, `rgba(${r},${g},${b},0.42)`);
    }
    grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
    return grad;
  }

  function rebuildGradients() {
    if (width <= 0) return;
    cachedGradients.ink = buildMaskGradient(pal.ink);
    cachedGradients.accent = buildMaskGradient(pal.accent);
  }

  function resize() {
    const rect = hero.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    width = rect.width;
    height = rect.height;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    measureTextZone();
    rebuildGradients();
    drawFrame();
  }

  function stepPhysics(dt) {
    phaseTime += dt;

    /* Smooth pointer tracking & presence ramp */
    const targetStrength = ptr.inside ? 1 : 0;
    const ramp = 1 - Math.exp(-dt * (ptr.inside ? 10 : 5.5));
    ptr.strength += (targetStrength - ptr.strength) * ramp;

    const follow = 1 - Math.exp(-dt * 18);
    const prevX = ptr.x;
    const prevY = ptr.y;
    ptr.x += (ptr.tx - ptr.x) * follow;
    ptr.y += (ptr.ty - ptr.y) * follow;
    if (dt > 0.0005) {
      const ivx = (ptr.x - prevX) / dt;
      const ivy = (ptr.y - prevY) / dt;
      ptr.vx += (ivx - ptr.vx) * Math.min(1, dt * 10);
      ptr.vy += (ivy - ptr.vy) * Math.min(1, dt * 10);
    }

    /* Advance optional click crests */
    for (let i = crests.length - 1; i >= 0; i -= 1) {
      const c = crests[i];
      c.age += dt;
      c.x += c.speed * dt;
      if (c.age > 2.2 || c.x > width + 180) {
        crests.splice(i, 1);
      }
    }

    const radius = Math.max(120, Math.min(185, height * 0.74));
    const sigma = radius * 0.45;
    const invTwoSigma2 = 1 / (2 * sigma * sigma);
    const maxPush = Math.max(34, Math.min(54, height * 0.22));
    const stiffness = 62;
    const damping = Math.exp(-11.5 * dt);
    const spanX = width + 40;
    const stepX = spanX / (SAMPLES - 1);

    for (const s of streams) {
      const baseY = height * s.yFrac;
      const biasDir = s.idx % 2 === 0 ? -1 : 1;

      for (let i = 0; i < SAMPLES; i += 1) {
        const x = -20 + i * stepX;
        const restY =
          baseY +
          Math.sin(x * s.k1 - phaseTime * s.speed * 2.1 + s.phase) * s.amp1 +
          Math.sin(x * s.k2 - phaseTime * s.speed * 3.2 + s.phase * 1.7) * s.amp2;

        let targetDisp = 0;

        if (ptr.strength > 0.002) {
          const dx = x - ptr.x;
          const dy = restY - ptr.y;
          const dist2 = dx * dx + dy * dy;
          if (dist2 < radius * radius * 2.4) {
            const falloff = Math.exp(-dist2 * invTwoSigma2);
            /* Smooth odd parting: upper streams yield upward, lower streams yield downward */
            const dir = (dy + biasDir * 5.5) / Math.hypot(dy, 20);
            const wake = Math.max(-12, Math.min(12, ptr.vy * 0.018)) * falloff;
            targetDisp += (dir * maxPush * falloff + wake) * ptr.strength;
          }
        }

        for (const c of crests) {
          const cdx = x - c.x;
          const cdy = restY - c.y;
          const cDist2 = cdx * cdx + cdy * cdy * 1.4;
          if (cDist2 < 140 * 140) {
            const fade = Math.max(0, 1 - c.age / 2.2);
            const env = Math.exp(-cDist2 / (2 * 48 * 48)) * fade;
            const cDir = (cdy + biasDir * 4) / Math.hypot(cdy, 24);
            targetDisp += cDir * 16 * env;
          }
        }

        const acc = (targetDisp - s.disp[i]) * stiffness;
        s.vel[i] = (s.vel[i] + acc * dt) * damping;
        s.disp[i] += s.vel[i] * dt;
      }
    }
  }

  function drawFrame() {
    if (width <= 0 || height <= 0) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    const spanX = width + 40;
    const stepX = spanX / (SAMPLES - 1);
    const [ar, ag, ab] = pal.accent;

    for (const s of streams) {
      const baseY = height * s.yFrac;
      const ptsY = new Float32Array(SAMPLES);

      for (let i = 0; i < SAMPLES; i += 1) {
        const x = -20 + i * stepX;
        const wave =
          Math.sin(x * s.k1 - phaseTime * s.speed * 2.1 + s.phase) * s.amp1 +
          Math.sin(x * s.k2 - phaseTime * s.speed * 3.2 + s.phase * 1.7) * s.amp2;
        ptsY[i] = baseY + wave + s.disp[i];
      }

      /* Base whisper-light full-width current curve */
      ctx.beginPath();
      ctx.moveTo(-20, ptsY[0]);
      for (let i = 1; i < SAMPLES - 1; i += 1) {
        const xc = -20 + i * stepX;
        const nx = -20 + (i + 1) * stepX;
        ctx.quadraticCurveTo(xc, ptsY[i], (xc + nx) * 0.5, (ptsY[i] + ptsY[i + 1]) * 0.5);
      }
      ctx.lineTo(-20 + (SAMPLES - 1) * stepX, ptsY[SAMPLES - 1]);
      const boost = pal.isDark ? 1.18 : 1.0;
      ctx.globalAlpha = Math.min(0.62, s.alpha * boost);
      ctx.strokeStyle = s.accent ? cachedGradients.accent : cachedGradients.ink;
      ctx.lineWidth = s.weight;
      ctx.stroke();

      /* Local cobalt shimmer where the pointer gently parts the streamline */
      if (ptr.strength > 0.02) {
        const dyCenter = Math.abs(baseY - ptr.y);
        if (dyCenter < 150) {
          const proximity = Math.exp(-(dyCenter * dyCenter) / (2 * 74 * 74)) * ptr.strength;
          const shimmerAlpha = (pal.isDark ? 0.48 : 0.38) * proximity;
          if (shimmerAlpha > 0.015) {
            ctx.globalAlpha = 1;
            const localGrad = ctx.createRadialGradient(ptr.x, ptr.y, 10, ptr.x, ptr.y, 155);
            localGrad.addColorStop(0, `rgba(${ar},${ag},${ab},${shimmerAlpha.toFixed(3)})`);
            localGrad.addColorStop(1, `rgba(${ar},${ag},${ab},0)`);
            ctx.strokeStyle = localGrad;
            ctx.lineWidth = s.weight + 0.45;
            ctx.stroke();
          }
        }
      }
    }
    ctx.globalAlpha = 1;
  }

  function shouldRun() {
    return !reducedMotionQuery.matches && !userPaused && inViewport && !document.hidden;
  }

  function loop(ts) {
    rafId = 0;
    if (!shouldRun()) return;
    if (!lastTs) lastTs = ts;
    const dt = Math.min(0.05, Math.max(0.001, (ts - lastTs) / 1000));
    lastTs = ts;
    stepPhysics(dt);
    drawFrame();
    rafId = window.requestAnimationFrame(loop);
  }

  function startLoop() {
    if (rafId || !shouldRun()) return;
    lastTs = 0;
    rafId = window.requestAnimationFrame(loop);
  }

  function stopLoop() {
    if (rafId) {
      window.cancelAnimationFrame(rafId);
      rafId = 0;
    }
    lastTs = 0;
  }

  /* Pointer parting listeners on hero (passive, never blocks selection or clicks) */
  hero.addEventListener(
    "pointermove",
    (event) => {
      if (event.pointerType === "touch") return;
      const rect = hero.getBoundingClientRect();
      ptr.tx = event.clientX - rect.left;
      ptr.ty = event.clientY - rect.top;
      if (!ptr.inside) {
        ptr.x = ptr.tx;
        ptr.y = ptr.ty;
        ptr.inside = true;
      }
      startLoop();
    },
    { passive: true }
  );

  hero.addEventListener(
    "pointerleave",
    () => {
      ptr.inside = false;
    },
    { passive: true }
  );

  hero.addEventListener(
    "pointerdown",
    (event) => {
      if (event.target?.closest?.("a, button") || reducedMotionQuery.matches || userPaused) return;
      const rect = hero.getBoundingClientRect();
      crests.push({
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
        speed: 190,
        age: 0,
      });
      if (crests.length > 4) crests.shift();
      startLoop();
    },
    { passive: true }
  );

  toggleBtn.addEventListener("click", () => {
    userPaused = !userPaused;
    setToggleLabel(userPaused);
    if (userPaused) {
      stopLoop();
      drawFrame();
    } else {
      startLoop();
    }
  });

  /* Theme-switch sync (instant redraw inside theme-switch View Transition) */
  const syncTheme = () => {
    pal = readPalette();
    rebuildGradients();
    drawFrame();
  };
  const metaScheme = document.querySelector('meta[name="color-scheme"]');
  if (metaScheme) {
    new MutationObserver(syncTheme).observe(metaScheme, { attributes: true, attributeFilter: ["content"] });
  }
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", syncTheme);

  reducedMotionQuery.addEventListener("change", () => {
    toggleBtn.hidden = reducedMotionQuery.matches;
    if (reducedMotionQuery.matches) {
      stopLoop();
      ptr.inside = false;
      ptr.strength = 0;
      crests.length = 0;
      for (const s of streams) {
        s.disp.fill(0);
        s.vel.fill(0);
      }
      drawFrame();
    } else if (!userPaused) {
      startLoop();
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      stopLoop();
    } else {
      pal = readPalette();
      rebuildGradients();
      drawFrame();
      startLoop();
    }
  });

  if ("ResizeObserver" in window) {
    new ResizeObserver(resize).observe(hero);
  }
  window.addEventListener("resize", resize, { passive: true });
  document.fonts?.ready?.then(resize);

  if ("IntersectionObserver" in window) {
    new IntersectionObserver(
      ([entry]) => {
        inViewport = Boolean(entry?.isIntersecting);
        if (inViewport) {
          pal = readPalette();
          rebuildGradients();
          drawFrame();
          startLoop();
        } else {
          stopLoop();
        }
      },
      { rootMargin: "80px 0px", threshold: 0 }
    ).observe(hero);
  }

  resize();
  window.requestAnimationFrame(() => {
    canvas.dataset.ready = "true";
    startLoop();
  });
}

mountStreamHeroCurrent();

const ledger = document.querySelector("[data-stream-ledger]");

if (ledger) {
  /* Reveal progressive JS-only controls now that handlers are mounting */
  for (const el of document.querySelectorAll("[data-stream-js]")) {
    el.hidden = false;
  }
  window.requestAnimationFrame(() => {
    window.dispatchEvent(new Event("resize"));
  });

  const items = [...ledger.querySelectorAll("[data-stream-item]")];
  const monthGroups = [...ledger.querySelectorAll(".stream-month-group")];
  const kindButtons = [...document.querySelectorAll("[data-stream-kind]")];
  const conceptLinks = [...document.querySelectorAll("[data-stream-concept]")];
  const matrixCells = [...document.querySelectorAll("a.stream-cell[data-matrix-date]")];
  const matrixReadout = document.querySelector("[data-matrix-readout]");
  const countEl = document.getElementById("stream-count");
  const activeBar = document.querySelector("[data-stream-active-bar]");
  const activeLabel = document.querySelector("[data-stream-active-label]");
  const emptyState = document.querySelector("[data-stream-empty]");
  const randomBtn = document.querySelector("[data-stream-random]");
  const monthRailList = document.querySelector(".stream-rail .stream-month-list");

  const KIND_LABELS = isEnglish
    ? { musing: "Musing", quote: "Quote", question: "Question", snippet: "Snippet" }
    : { musing: "随想", quote: "摘录", question: "待解", snippet: "切片" };

  let activeKind = "all";
  let activeConcept = "all";
  let activeDate = "";
  let activeVt = null;
  let vtSeq = 0;
  let lastRandomId = "";
  let shuffleTimer = 0;
  let pulseTimer = 0;
  let pulsedEntry = null;

  function announce(message) {
    const region = document.getElementById("live-announcer");
    if (!region || !message) return;
    region.textContent = "";
    window.setTimeout(() => {
      region.textContent = message;
    }, 40);
  }

  function isModifiedClick(event) {
    return (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    );
  }

  function runStreamTransition(updateFn, onUpdated, onFinished) {
    if (!document.startViewTransition || reducedMotionQuery.matches) {
      updateFn();
      onUpdated?.(true);
      onFinished?.(true);
      return null;
    }

    if (activeVt) {
      try {
        activeVt.skipTransition?.();
      } catch {
        /* ignore */
      }
      activeVt = null;
    }

    const root = document.documentElement;
    const seq = ++vtSeq;
    root.dataset.vtMode = "stream-filter";

    let vt;
    try {
      vt = document.startViewTransition({
        update: updateFn,
        types: ["stream-filter"],
      });
    } catch {
      try {
        vt = document.startViewTransition(updateFn);
      } catch {
        if (seq === vtSeq) delete root.dataset.vtMode;
        updateFn();
        onUpdated?.(true);
        onFinished?.(true);
        return null;
      }
    }

    activeVt = vt;
    vt.updateCallbackDone
      ?.then(() => {
        onUpdated?.(seq === vtSeq);
      })
      .catch(() => {});
    vt.ready?.catch?.(() => {});
    vt.finished
      ?.catch?.(() => {})
      .finally(() => {
        const isLatest = seq === vtSeq;
        if (activeVt === vt) activeVt = null;
        if (isLatest && root.dataset.vtMode === "stream-filter") {
          delete root.dataset.vtMode;
        }
        onFinished?.(isLatest);
      });
    return vt;
  }

  function assignItemVtNames() {
    items.forEach((item) => {
      const id = (item.getAttribute("data-stream-id") || "").replace(/[^a-z0-9_-]/gi, "-");
      if (id) item.style.viewTransitionName = `stream-item-${id}`;
    });
  }

  function clearItemVtNames() {
    for (const item of items) {
      item.style.viewTransitionName = "";
    }
  }

  function getConceptLabel(cid) {
    const link = conceptLinks.find((el) => el.getAttribute("data-stream-concept") === cid);
    if (!link) return cid;
    const firstSpan = link.querySelector("span");
    return (firstSpan ? firstSpan.textContent : link.textContent || cid).trim();
  }

  function syncButtons() {
    for (const btn of kindButtons) {
      btn.setAttribute("aria-pressed", String(btn.getAttribute("data-stream-kind") === activeKind));
    }
    for (const link of conceptLinks) {
      if (activeConcept !== "all" && link.getAttribute("data-stream-concept") === activeConcept) {
        link.setAttribute("aria-current", "true");
      } else {
        link.removeAttribute("aria-current");
      }
    }
    for (const cell of matrixCells) {
      if (activeDate && cell.getAttribute("data-matrix-date") === activeDate) {
        cell.dataset.selected = "true";
      } else {
        delete cell.dataset.selected;
      }
    }
  }

  function syncActiveFilterBar() {
    if (!activeBar || !activeLabel) return;
    const parts = [];
    if (activeConcept !== "all") {
      parts.push(
        isEnglish
          ? `Concept: ${getConceptLabel(activeConcept)}`
          : `概念：${getConceptLabel(activeConcept)}`
      );
    }
    if (activeDate) {
      parts.push(
        isEnglish ? `Date: ${activeDate.replace(/-/g, ".")}` : `日期：${activeDate.replace(/-/g, ".")}`
      );
    }
    if (parts.length === 0) {
      activeBar.hidden = true;
      activeLabel.textContent = "";
      return;
    }
    activeLabel.textContent = parts.join(" · ");
    activeBar.hidden = false;
  }

  function isHashTargetHidden(hash) {
    if (!hash || hash === "#") return false;
    const id = hash.slice(1);
    if (!/^(?:t-[a-z0-9-]+|m-\d{4}-\d{2})$/i.test(id)) return false;
    const el = document.getElementById(id);
    if (!el) return false;
    if (el.hidden) return true;
    const itemHost = el.closest(".stream-item");
    if (itemHost?.hidden) return true;
    const monthHost = el.closest(".stream-month-group");
    if (monthHost?.hidden) return true;
    return false;
  }

  function syncUrlAndLangLinks({ clearHiddenHash = false, explicitHash = null } = {}) {
    const params = new URLSearchParams();
    if (activeKind !== "all") params.set("kind", activeKind);
    if (activeConcept !== "all") params.set("concept", activeConcept);
    if (activeDate) params.set("date", activeDate);
    const qs = params.toString();
    const suffix = qs ? `?${qs}` : "";

    let nextHash = explicitHash !== null ? explicitHash : window.location.hash;
    if (clearHiddenHash && isHashTargetHidden(nextHash)) {
      nextHash = "";
    }

    try {
      const nextSelf = `${window.location.pathname}${suffix}${nextHash}`;
      if (nextSelf !== `${window.location.pathname}${window.location.search}${window.location.hash}`) {
        window.history.replaceState(null, "", nextSelf);
      }
    } catch {
      /* ignore history restrictions */
    }

    for (const link of document.querySelectorAll("header a[hreflang], footer a[hreflang]")) {
      const raw = link.getAttribute("href") || "";
      const baseHref = raw.split(/[?#]/)[0];
      if (baseHref === "/stream/" || baseHref === "/en/stream/") {
        link.setAttribute("href", `${baseHref}${suffix}${nextHash}`);
      }
    }
  }

  function tickCount(visible) {
    if (!countEl) return;
    const nextText = isEnglish
      ? `${visible} / ${items.length} notes`
      : `显示 ${visible} / ${items.length} 条`;
    if (countEl.textContent !== nextText) {
      countEl.textContent = nextText;
      delete countEl.dataset.updated;
      void countEl.offsetWidth;
      countEl.dataset.updated = "true";
    }
  }

  let syncMonthRail = () => {};
  const defaultMatrixText = matrixReadout?.dataset.defaultLabel || "";

  function updateMatrixReadout(cell) {
    if (!matrixReadout) return;
    if (!cell) {
      if (activeDate) {
        const activeCell = matrixCells.find((c) => c.getAttribute("data-matrix-date") === activeDate);
        if (activeCell) {
          updateMatrixReadout(activeCell);
          return;
        }
      }
      matrixReadout.textContent = defaultMatrixText;
      return;
    }
    const d = (cell.getAttribute("data-matrix-date") || "").replace(/-/g, ".");
    const cnt = Number(cell.getAttribute("data-count") || 0);
    const isSel = activeDate === cell.getAttribute("data-matrix-date");
    if (isEnglish) {
      matrixReadout.textContent = isSel
        ? `${d} · ${cnt} ${cnt === 1 ? "note" : "notes"} (filtered · click to clear)`
        : `${d} · ${cnt} ${cnt === 1 ? "note" : "notes"} · click to locate`;
    } else {
      matrixReadout.textContent = isSel
        ? `${d} · ${cnt} 条（已筛选 · 再次点击清除）`
        : `${d} · ${cnt} 条 · 点击定位`;
    }
  }

  function updateStreamDOM({ clearHiddenHash = false } = {}) {
    let visibleTotal = 0;
    const visibleByMonth = new Map();

    for (const item of items) {
      const kind = item.getAttribute("data-kind") || "";
      const concepts = (item.getAttribute("data-concepts") || "").split(",").filter(Boolean);
      const date = item.getAttribute("data-date") || "";
      const month = item.getAttribute("data-month") || "";

      const matchKind = activeKind === "all" || kind === activeKind;
      const matchConcept = activeConcept === "all" || concepts.includes(activeConcept);
      const matchDate = !activeDate || date === activeDate;
      const show = matchKind && matchConcept && matchDate;

      item.removeAttribute("data-closing");
      item.hidden = !show;
      if (show) {
        visibleTotal += 1;
        visibleByMonth.set(month, (visibleByMonth.get(month) || 0) + 1);
      }
    }

    for (const group of monthGroups) {
      const ym = group.getAttribute("data-month") || "";
      const mCount = visibleByMonth.get(ym) || 0;
      group.hidden = mCount === 0;
      const countSpan = group.querySelector("[data-month-count]");
      if (countSpan && mCount > 0) {
        countSpan.textContent = isEnglish
          ? `${String(mCount).padStart(2, "0")} ${mCount === 1 ? "note" : "notes"}`
          : `${String(mCount).padStart(2, "0")} 条`;
      }
      const railLink = monthRailList?.querySelector(`a[data-rail-month="${CSS.escape(ym)}"]`);
      const railLi = railLink?.closest("li");
      if (railLi) {
        railLi.hidden = mCount === 0;
      }
      const railNum = railLink?.querySelector(".stream-rail-num");
      if (railNum && mCount > 0) {
        railNum.textContent = String(mCount).padStart(2, "0");
      }
    }

    if (emptyState) {
      emptyState.hidden = visibleTotal > 0;
    }

    tickCount(visibleTotal);
    syncButtons();
    syncActiveFilterBar();
    updateMatrixReadout(null);
    syncUrlAndLangLinks({ clearHiddenHash });
    syncMonthRail();
  }

  function applyFilter(immediate = false, { clearHiddenHash = true, onAfterUpdate = null } = {}) {
    if (immediate) {
      clearItemVtNames();
      updateStreamDOM({ clearHiddenHash });
      onAfterUpdate?.();
      return;
    }

    if (document.startViewTransition && !reducedMotionQuery.matches) {
      delete document.documentElement.dataset.streamFallback;
      assignItemVtNames();
      runStreamTransition(
        () => updateStreamDOM({ clearHiddenHash }),
        null,
        (isLatest) => {
          if (isLatest) {
            clearItemVtNames();
            syncMonthRail();
            onAfterUpdate?.();
          }
        }
      );
    } else {
      clearItemVtNames();
      document.documentElement.dataset.streamFallback = "";
      updateStreamDOM({ clearHiddenHash });
      onAfterUpdate?.();
    }
  }

  function resetAllFilters(immediate = false, opts = {}) {
    if (activeKind === "all" && activeConcept === "all" && !activeDate) {
      opts.onAfterUpdate?.();
      return;
    }
    activeKind = "all";
    activeConcept = "all";
    activeDate = "";
    applyFilter(immediate, opts);
  }

  function pulseEntry(entryEl) {
    if (!entryEl) return;
    window.clearTimeout(pulseTimer);
    if (pulsedEntry && pulsedEntry !== entryEl) {
      delete pulsedEntry.dataset.streamPulse;
    }
    const itemHost = entryEl.closest(".stream-item");
    if (itemHost?.getAttribute("data-stream-reveal") === "pending") {
      itemHost.setAttribute("data-stream-reveal", "visible");
    }
    delete entryEl.dataset.streamPulse;
    void entryEl.offsetWidth;
    entryEl.dataset.streamPulse = "true";
    pulsedEntry = entryEl;
    pulseTimer = window.setTimeout(() => {
      if (pulsedEntry === entryEl) {
        delete entryEl.dataset.streamPulse;
        pulsedEntry = null;
      }
    }, 1250);
  }

  function scrollAndPulseEntry(eid) {
    const item = items.find((el) => el.getAttribute("data-stream-id") === eid);
    if (!item || item.hidden) return;
    const entry = item.querySelector(".stream-entry");
    if (!entry) return;
    entry.scrollIntoView({
      behavior: reducedMotionQuery.matches ? "auto" : "smooth",
      block: "center",
    });
    pulseEntry(entry);
    syncUrlAndLangLinks({ explicitHash: `#t-${eid}` });
  }

  function jumpToEntryById(eid) {
    const item = items.find((el) => el.getAttribute("data-stream-id") === eid);
    if (!item) return;
    if (item.hidden) {
      resetAllFilters(true, { clearHiddenHash: false });
    }
    scrollAndPulseEntry(eid);
  }

  /* =====================================================================
     1. FILTER INTERACTIONS (KIND, CONCEPT, RESET)
     ===================================================================== */
  for (const btn of kindButtons) {
    btn.addEventListener("click", () => {
      activeKind = btn.getAttribute("data-stream-kind") || "all";
      applyFilter(false, { clearHiddenHash: true });
    });
  }

  ledger.addEventListener("click", (event) => {
    const anchorLink = event.target?.closest?.("[data-stream-anchor]");
    if (anchorLink) {
      if (isModifiedClick(event)) return;
      const entry = anchorLink.closest(".stream-entry");
      if (entry) pulseEntry(entry);
      return;
    }

    const copyBtn = event.target?.closest?.("[data-stream-copy]");
    if (copyBtn) {
      const eid = copyBtn.getAttribute("data-stream-copy") || "";
      handleCopyPermalink(eid, copyBtn);
      return;
    }

    const replyBtn = event.target?.closest?.("[data-stream-reply]");
    if (replyBtn) {
      const eid = replyBtn.getAttribute("data-stream-reply") || "";
      handleEchoReply(eid);
    }
  });

  for (const link of conceptLinks) {
    link.addEventListener("click", (event) => {
      if (isModifiedClick(event)) return;
      event.preventDefault();
      const cid = link.getAttribute("data-stream-concept") || "all";
      activeConcept = activeConcept === cid ? "all" : cid;
      applyFilter(false, { clearHiddenHash: true });
    });
  }

  for (const btn of document.querySelectorAll("[data-stream-reset]")) {
    btn.addEventListener("click", () => {
      resetAllFilters(false, { clearHiddenHash: true });
      announce(isEnglish ? "Cleared all Stream filters." : "已清除全部思维筛选。");
    });
  }

  /* =====================================================================
     2. INTERACTIVE 35-DAY SWISS CADENCE MATRIX
     ===================================================================== */
  function setDateHover(dateIso) {
    for (const item of items) {
      const entry = item.querySelector(".stream-entry");
      if (!entry) continue;
      if (dateIso && item.getAttribute("data-date") === dateIso) {
        entry.dataset.dateHover = "true";
      } else {
        delete entry.dataset.dateHover;
      }
    }
  }

  for (const cell of matrixCells) {
    const dateIso = cell.getAttribute("data-matrix-date") || "";
    const firstId = cell.getAttribute("data-first-id") || "";

    cell.addEventListener("pointerenter", () => {
      updateMatrixReadout(cell);
      setDateHover(dateIso);
    });
    cell.addEventListener("pointerleave", () => {
      updateMatrixReadout(null);
      setDateHover("");
    });
    cell.addEventListener("focus", () => {
      updateMatrixReadout(cell);
      setDateHover(dateIso);
    });
    cell.addEventListener("blur", () => {
      updateMatrixReadout(null);
      setDateHover("");
    });
    cell.addEventListener("click", (event) => {
      if (isModifiedClick(event)) return;
      event.preventDefault();
      setDateHover("");
      if (activeDate === dateIso) {
        activeDate = "";
        applyFilter(false, { clearHiddenHash: true });
        return;
      }
      const targetVisible = items.find(
        (el) => !el.hidden && el.getAttribute("data-date") === dateIso
      );
      if (targetVisible) {
        const tid = targetVisible.getAttribute("data-stream-id") || firstId;
        jumpToEntryById(tid);
      } else {
        activeDate = dateIso;
        activeKind = "all";
        activeConcept = "all";
        applyFilter(false, {
          clearHiddenHash: true,
          onAfterUpdate: () => {
            window.requestAnimationFrame(() => scrollAndPulseEntry(firstId));
          },
        });
      }
    });
  }

  /* =====================================================================
     3. SERENDIPITY ROAM ("随机捞一条 ↻")
     ===================================================================== */
  if (randomBtn) {
    const labelSpan = randomBtn.querySelector("[data-random-label]");
    const defaultBtnLabel = labelSpan?.textContent || randomBtn.textContent || "";

    randomBtn.addEventListener("click", () => {
      window.clearTimeout(shuffleTimer);
      let pool = items.filter((el) => !el.hidden);
      if (pool.length === 0) {
        resetAllFilters(true, { clearHiddenHash: false });
        pool = items.filter((el) => !el.hidden);
      }
      if (pool.length === 0) return;

      const candidates =
        pool.length > 1 ? pool.filter((el) => el.getAttribute("data-stream-id") !== lastRandomId) : pool;
      const chosen = candidates[Math.floor(Math.random() * candidates.length)];
      const chosenId = chosen.getAttribute("data-stream-id") || "";
      lastRandomId = chosenId;

      if (reducedMotionQuery.matches || !labelSpan) {
        jumpToEntryById(chosenId);
        announce(isEnglish ? `Jumped to note #${chosenId}.` : `已随机定位至思维碎片 #${chosenId}。`);
        return;
      }

      const poolIds = pool.map((el) => el.getAttribute("data-stream-id") || "").filter(Boolean);
      const steps = Math.min(4, Math.max(2, poolIds.length));
      let step = 0;
      randomBtn.dataset.shuffling = "true";

      const tick = () => {
        if (step < steps) {
          const previewId = poolIds[Math.floor(Math.random() * poolIds.length)] || chosenId;
          labelSpan.textContent = `#${previewId}`;
          step += 1;
          shuffleTimer = window.setTimeout(tick, 58);
          return;
        }
        labelSpan.textContent = `#${chosenId}`;
        jumpToEntryById(chosenId);
        announce(isEnglish ? `Jumped to note #${chosenId}.` : `已随机定位至思维碎片 #${chosenId}。`);
        shuffleTimer = window.setTimeout(() => {
          labelSpan.textContent = defaultBtnLabel;
          delete randomBtn.dataset.shuffling;
        }, 720);
      };
      tick();
    });
  }

  /* =====================================================================
     4. PERMALINK COPY & <ti-comments> TOP-LEVEL ECHO HANDOFF
     ===================================================================== */
  async function handleCopyPermalink(eid, btn) {
    if (!eid || !btn) return;
    const url = `${window.location.origin}${window.location.pathname}#t-${eid}`;
    const original = btn.dataset.originalLabel || btn.textContent;
    btn.dataset.originalLabel = original;

    const doneLabel = isEnglish ? "Copied ✓" : "已复制 ✓";
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard API unavailable");
      await navigator.clipboard.writeText(url);
      btn.textContent = doneLabel;
      btn.dataset.copied = "true";
      announce(isEnglish ? `Copied link to note #${eid}.` : `已复制碎片 #${eid} 的直达链接。`);
      window.clearTimeout(Number(btn.dataset.copyTimer || 0));
      const t = window.setTimeout(() => {
        btn.textContent = original;
        delete btn.dataset.copied;
      }, 2000);
      btn.dataset.copyTimer = String(t);
    } catch {
      window.location.hash = `t-${eid}`;
      announce(isEnglish ? `Updated address bar to note #${eid}.` : `已在地址栏定位至碎片 #${eid}。`);
    }
  }

  async function handleEchoReply(eid) {
    if (!eid) return;
    const commentsEl = document.querySelector("ti-comments");
    if (!commentsEl) return;

    if (!customElements.get("ti-comments")) {
      try {
        await import("/assets/js/comments.js");
      } catch {
        /* ignore */
      }
    }
    try {
      await customElements.whenDefined("ti-comments");
    } catch {
      /* ignore */
    }

    const prefix = `Re #${eid}: `;
    if (typeof commentsEl.startNoteWithPrefix === "function") {
      commentsEl.startNoteWithPrefix(prefix);
    } else {
      if (typeof commentsEl.expand === "function" && !commentsEl.open) {
        commentsEl.expand({ animate: true });
      }
      const textarea = commentsEl.querySelector('[data-part="textarea"]');
      if (textarea) {
        const cur = textarea.value || "";
        textarea.value = /^Re #\d+:\s*/i.test(cur)
          ? cur.replace(/^Re #\d+:\s*/i, prefix)
          : cur.startsWith(prefix)
            ? cur
            : cur
              ? `${prefix}${cur}`
              : prefix;
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
        commentsEl.scrollIntoView({
          behavior: reducedMotionQuery.matches ? "auto" : "smooth",
          block: "center",
        });
        textarea.focus({ preventScroll: true });
      }
    }

    announce(
      isEnglish
        ? `Opened notes composer referencing fragment #${eid}.`
        : `已展开评论区并引用思维碎片 #${eid}。`
    );
  }

  /* =====================================================================
     5. STICKY MONTH RAIL SCROLL-SPY & SLIDING VERTICAL INDICATOR
     ===================================================================== */
  if (monthRailList) {
    const railLinks = [...monthRailList.querySelectorAll('a[href^="#"]')];
    let indicatorReady = false;
    let activeRailLink = null;
    let railRaf = 0;

    const updateRailIndicator = (allowTransition = true) => {
      railRaf = 0;
      const activeEl = monthRailList.querySelector('a[aria-current="location"]');
      if (!activeEl || activeEl.closest("li")?.hidden) {
        monthRailList.style.setProperty("--ind-visible", "0");
        return;
      }
      const cr = monthRailList.getBoundingClientRect();
      const ar = activeEl.getBoundingClientRect();
      if (cr.width <= 0 || ar.height <= 0) {
        monthRailList.style.setProperty("--ind-visible", "0");
        return;
      }
      if (!allowTransition) {
        delete monthRailList.dataset.indicatorAnimated;
      } else if (indicatorReady) {
        monthRailList.dataset.indicatorAnimated = "true";
      }
      monthRailList.dataset.indicatorReady = "true";
      monthRailList.style.setProperty("--ind-y", `${(ar.top - cr.top).toFixed(2)}px`);
      monthRailList.style.setProperty("--ind-h", `${ar.height.toFixed(2)}px`);
      monthRailList.style.setProperty("--ind-visible", "1");

      if (!indicatorReady) {
        window.requestAnimationFrame(() => {
          window.requestAnimationFrame(() => {
            indicatorReady = true;
            monthRailList.dataset.indicatorAnimated = "true";
          });
        });
      }
    };

    const setActiveRail = (link) => {
      if (!link || link === activeRailLink) return;
      for (const l of railLinks) {
        if (l === link) l.setAttribute("aria-current", "location");
        else l.removeAttribute("aria-current");
      }
      activeRailLink = link;
      updateRailIndicator(true);
    };

    const pickActiveMonth = () => {
      const visiblePairs = railLinks
        .map((link) => {
          const id = link.getAttribute("href")?.slice(1);
          const target = id ? document.getElementById(id) : null;
          return target && !target.hidden ? { link, target } : null;
        })
        .filter(Boolean);

      if (visiblePairs.length === 0) {
        activeRailLink = null;
        for (const l of railLinks) l.removeAttribute("aria-current");
        updateRailIndicator(false);
        return;
      }

      const markerY = Math.min(200, window.innerHeight * 0.28);
      let current = visiblePairs[0];
      for (const pair of visiblePairs) {
        if (pair.target.getBoundingClientRect().top <= markerY) {
          current = pair;
        }
      }
      setActiveRail(current.link);
      updateRailIndicator(true);
    };

    syncMonthRail = () => {
      pickActiveMonth();
      if (railRaf) window.cancelAnimationFrame(railRaf);
      railRaf = window.requestAnimationFrame(() => updateRailIndicator(false));
    };

    let scrollTick = false;
    window.addEventListener(
      "scroll",
      () => {
        if (!scrollTick) {
          scrollTick = true;
          window.requestAnimationFrame(() => {
            scrollTick = false;
            pickActiveMonth();
          });
        }
      },
      { passive: true }
    );
    window.addEventListener("resize", () => updateRailIndicator(false), { passive: true });
    document.fonts?.ready?.then(() => updateRailIndicator(false));
    pickActiveMonth();
  }

  /* =====================================================================
     6. SCROLL-DRIVEN REVEAL FALLBACK (WHEN NATIVE view() IS UNSUPPORTED)
     ===================================================================== */
  const supportsNativeViewReveal = Boolean(
    window.CSS?.supports?.("(animation-timeline: view()) and (animation-range: entry)")
  );

  if (!supportsNativeViewReveal && "IntersectionObserver" in window) {
    let revealObserver = null;

    const clearRevealFallback = () => {
      if (revealObserver) {
        revealObserver.disconnect();
        revealObserver = null;
      }
      for (const item of items) item.removeAttribute("data-stream-reveal");
    };

    const syncRevealFallback = () => {
      if (reducedMotionQuery.matches) {
        clearRevealFallback();
        return;
      }
      if (revealObserver) return;
      const belowFold = items.filter(
        (el) =>
          !el.hidden &&
          el.getAttribute("data-stream-reveal") !== "visible" &&
          el.getBoundingClientRect().top > window.innerHeight * 0.92
      );
      if (belowFold.length === 0) return;

      revealObserver = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) {
              entry.target.setAttribute("data-stream-reveal", "visible");
              revealObserver?.unobserve(entry.target);
            }
          }
        },
        { rootMargin: "0px 0px -6% 0px", threshold: 0.08 }
      );

      for (const el of belowFold) {
        el.setAttribute("data-stream-reveal", "pending");
        revealObserver.observe(el);
      }
    };

    document.addEventListener("focusin", (event) => {
      const host = event.target?.closest?.('[data-stream-reveal="pending"]');
      if (host) {
        host.setAttribute("data-stream-reveal", "visible");
        revealObserver?.unobserve(host);
      }
    });

    syncRevealFallback();
    reducedMotionQuery.addEventListener("change", syncRevealFallback);
  }

  /* =====================================================================
     7. URL QUERY, POPSTATE & HASH HYDRATION
     ===================================================================== */
  function readFiltersFromLocation() {
    const params = new URLSearchParams(window.location.search);
    const qKind = params.get("kind");
    const qConcept = params.get("concept");
    const qDate = params.get("date");

    activeKind = qKind && Object.hasOwn(KIND_LABELS, qKind) ? qKind : "all";
    activeConcept =
      qConcept && conceptLinks.some((el) => el.getAttribute("data-stream-concept") === qConcept)
        ? qConcept
        : "all";
    activeDate = qDate && /^\d{4}-\d{2}-\d{2}$/.test(qDate) ? qDate : "";
  }

  function handleHashPulse() {
    const hash = window.location.hash;
    if (!hash || !hash.startsWith("#t-")) {
      syncUrlAndLangLinks();
      return;
    }
    const target = document.getElementById(hash.slice(1));
    if (target) {
      const host = target.closest(".stream-item");
      if (host?.hidden) {
        resetAllFilters(true, { clearHiddenHash: false });
      }
      pulseEntry(target);
      syncUrlAndLangLinks({ explicitHash: hash });
    }
  }

  window.addEventListener("popstate", () => {
    readFiltersFromLocation();
    applyFilter(true, { clearHiddenHash: false });
    handleHashPulse();
  });

  window.addEventListener("hashchange", handleHashPulse);

  readFiltersFromLocation();
  if (activeKind !== "all" || activeConcept !== "all" || activeDate) {
    applyFilter(true, { clearHiddenHash: false });
  }
  handleHashPulse();
}
