/* Issue 01 · A margin for the notes, four memories, and a sheet of paper. */
const en = document.documentElement.lang === "en";
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
const announcer = document.getElementById("live-announcer");
let announcement;
function announce(message) {
  clearTimeout(announcement);
  announcer.textContent = "";
  announcement = setTimeout(() => { announcer.textContent = message; }, 40);
}

const prose = document.querySelector(".prose");
const eraLab = document.getElementById("lab-eras");
const wide = matchMedia("(min-width: 1180px)");
const refs = [...prose.querySelectorAll(".sidenote-ref")];
const rail = refs.map(ref => {
  const note = document.getElementById(ref.hash.slice(1));
  const highlight = () => note.toggleAttribute("data-highlight", ref.matches(":hover, :focus"));
  for (const event of ["mouseenter", "mouseleave", "focus", "blur"]) {
    ref.addEventListener(event, highlight);
  }
  return { ref, note, anchor: ref.closest(".sidenote-anchor") };
});

let layoutFrame = 0;
function layoutNotes() {
  layoutFrame = 0;
  prose.toggleAttribute("data-margin-notes", wide.matches);
  if (!wide.matches) return;
  // Offset coordinates ignore the lab's scroll-reveal transform. Neither note
  // placement nor highlighting changes a note's width or its measured height.
  let bottom = -16;
  for (const { ref, note, anchor } of rail) {
    const top = Math.max(anchor.offsetTop + ref.offsetTop, bottom + 16);
    note.style.setProperty("--note-top", top - anchor.offsetTop + "px");
    bottom = top + Math.ceil(note.getBoundingClientRect().height);
  }
  const prior = parseFloat(eraLab.style.getPropertyValue("--rail-extra")) || 0;
  const naturalTop = eraLab.offsetTop - prior;
  eraLab.style.setProperty("--rail-extra", Math.max(0, bottom + 24 - naturalTop) + "px");
}
function scheduleNotes() {
  if (!layoutFrame) layoutFrame = requestAnimationFrame(layoutNotes);
}
layoutNotes();
window.addEventListener("resize", scheduleNotes);
document.fonts.ready.then(scheduleNotes);
document.fonts.addEventListener("loadingdone", scheduleNotes);
const noteObserver = new ResizeObserver(scheduleNotes);
noteObserver.observe(prose);
for (const { note, anchor } of rail) {
  noteObserver.observe(note);
  noteObserver.observe(anchor);
}

function initEvolutionCanvas() {
  const lab = document.getElementById("lab-eras");
  if (!lab) return;
  const canvas = lab.querySelector("[data-evo-canvas]");
  const ctx = canvas?.getContext?.("2d");
  const controls = lab.querySelector("[data-evo-controls]");
  const range = lab.querySelector("[data-evo-range]");
  const stops = [...lab.querySelectorAll("[data-evo-stop]")];
  const pauseBtn = lab.querySelector("[data-evo-pause]");
  if (!canvas || !ctx || !controls || !range) return;

  const W = 960, H = 540, CX = W / 2, CY = H / 2;

  const probe = document.createElement("span");
  probe.style.cssText = "position:absolute;visibility:hidden;pointer-events:none;";
  probe.setAttribute("aria-hidden", "true");
  document.body.appendChild(probe);

  function parseRgb(str, fallback) {
    const m = String(str).match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : fallback;
  }
  function rgba(rgb, alpha = 1) {
    return alpha >= 0.999
      ? `rgb(${Math.round(rgb[0])}, ${Math.round(rgb[1])}, ${Math.round(rgb[2])})`
      : `rgba(${Math.round(rgb[0])}, ${Math.round(rgb[1])}, ${Math.round(rgb[2])}, ${alpha.toFixed(3)})`;
  }
  function mixRgb(a, b, t) {
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  }
  function tokenRgb(name, fallback) {
    probe.style.color = `var(${name})`;
    return parseRgb(getComputedStyle(probe).color, fallback);
  }
  function readPalette() {
    return {
      canvas: tokenRgb("--bg-canvas", [255, 255, 255]),
      subtle: tokenRgb("--bg-subtle", [244, 245, 247]),
      ink: tokenRgb("--ink-primary", [17, 19, 24]),
      secondary: tokenRgb("--ink-secondary", [78, 86, 102]),
      muted: tokenRgb("--ink-muted", [116, 125, 143]),
      rule: tokenRgb("--rule", [229, 232, 238]),
      accent: tokenRgb("--accent", [0, 71, 255]),
      signal: tokenRgb("--signal", [217, 56, 26]),
    };
  }

  const smooth = (t) => {
    const c = Math.max(0, Math.min(1, t));
    return c * c * (3 - 2 * c);
  };
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  let pal = readPalette();
  let u = 0;
  let targetU = 0;
  let simTime = 0;
  let paused = reducedMotion.matches;
  let visible = true;
  let rafId = 0;
  let lastTs = 0;
  let rasterDpr = 0;

  /* The Vermilion Core ("thought / person") — its physics morph with u */
  const core = { x: CX, y: CY, vx: 0, vy: 0, r: 10 };
  const shell = { x: CX, y: CY };
  const pointer = { id: null, x: CX, y: CY, dragging: false };
  const trail = [];
  const ripples = [];
  let wallFlash = { left: 0, right: 0, top: 0, bottom: 0 };
  let snappedNode = { x: CX, y: CY };

  /* Era 03 distributed edge lattice coordinates (9 x 5) */
  const gridCols = 9, gridRows = 5;
  const gridMarginX = 110, gridMarginY = 82;
  const stepX = (W - gridMarginX * 2) / (gridCols - 1);
  const stepY = (H - gridMarginY * 2) / (gridRows - 1);

  function nearestLattice(px, py) {
    const col = clamp(Math.round((px - gridMarginX) / stepX), 0, gridCols - 1);
    const row = clamp(Math.round((py - gridMarginY) / stepY), 0, gridRows - 1);
    return { x: gridMarginX + col * stepX, y: gridMarginY + row * stepY, col, row };
  }

  function syncUi(activeVal) {
    const nearest = clamp(Math.round(activeVal), 0, 3);
    stops.forEach((btn, i) => btn.setAttribute("aria-pressed", String(i === nearest)));
  }

  function syncPauseLabel() {
    if (!pauseBtn) return;
    pauseBtn.textContent = paused ? (en ? "Play" : "继续") : (en ? "Pause" : "暂停");
  }

  function updateCanvasSize() {
    const rect = canvas.getBoundingClientRect();
    const w = Math.round(rect.width * devicePixelRatio);
    const h = Math.round(rect.height * devicePixelRatio);
    if (!w || !h) return;
    rasterDpr = devicePixelRatio;
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    pal = readPalette();
    draw();
  }

  function emitRipple(x, y, kind = "accent") {
    ripples.push({ x, y, born: simTime, kind });
    if (ripples.length > 10) ripples.shift();
  }

  function stepPhysics(dt) {
    u += (targetU - u) * Math.min(1, dt * 8.5);
    if (Math.abs(targetU - u) < 0.001) u = targetU;

    const w0 = smooth(1 - Math.abs(u - 0));
    const w1 = smooth(1 - Math.abs(u - 1));
    const w2 = smooth(1 - Math.abs(u - 2));
    const w3 = smooth(1 - Math.abs(u - 3));

    /* Compute desired core coordinates under the current era's physical bounds */
    let destX = CX;
    let destY = CY;
    let followRate = 11;

    if (pointer.dragging) {
      const px = pointer.x;
      const py = pointer.y;

      /* Era 0: Hard rectangular box walls (156 x 104 around center) */
      const boxHW = 78 - core.r - 4;
      const boxHH = 52 - core.r - 4;
      const clamped0X = clamp(px, CX - boxHW, CX + boxHW);
      const clamped0Y = clamp(py, CY - boxHH, CY + boxHH);
      if (w0 > 0.45) {
        if (px < CX - boxHW - 4) wallFlash.left = 1;
        if (px > CX + boxHW + 4) wallFlash.right = 1;
        if (py < CY - boxHH - 4) wallFlash.top = 1;
        if (py > CY + boxHH + 4) wallFlash.bottom = 1;
      }

      /* Era 1: Heavy damped circular core inside stacked machinery (R = 104) */
      const dx1 = px - CX, dy1 = py - CY;
      const dist1 = Math.hypot(dx1, dy1) || 1;
      const maxR1 = 104;
      const pull1 = Math.min(dist1, maxR1) * 0.78;
      const clamped1X = CX + (dx1 / dist1) * pull1;
      const clamped1Y = CY + (dy1 / dist1) * pull1;

      /* Era 2: Clean magnetic snapping onto distributed edge lattice */
      const snap = nearestLattice(px, py);
      snappedNode = snap;
      const clamped2X = snap.x;
      const clamped2Y = snap.y;

      /* Era 3: Unbound blank HTML sheet */
      const clamped3X = clamp(px, 34, W - 34);
      const clamped3Y = clamp(py, 34, H - 34);

      const sumW = w0 + w1 + w2 + w3 || 1;
      destX = (clamped0X * w0 + clamped1X * w1 + clamped2X * w2 + clamped3X * w3) / sumW;
      destY = (clamped0Y * w0 + clamped1Y * w1 + clamped2Y * w2 + clamped3Y * w3) / sumW;
      followRate = (18 * w0 + 4.2 * w1 + 14 * w2 + 16 * w3) / sumW;
    } else {
      /* Idle resting pose per era */
      const idle0X = CX, idle0Y = CY;
      const idle1X = CX + Math.cos(simTime * 0.7) * 6, idle1Y = CY + Math.sin(simTime * 0.9) * 6;
      const idle2X = snappedNode.x, idle2Y = snappedNode.y;
      const idle3X = clamp(core.x + Math.sin(simTime * 0.55) * 0.25, 110, W - 110);
      const idle3Y = clamp(core.y + Math.cos(simTime * 0.45) * 0.2, 90, H - 90);

      const sumW = w0 + w1 + w2 + w3 || 1;
      if (w3 > 0.65 && trail.length > 0) {
        destX = idle3X;
        destY = idle3Y;
        followRate = 3.5;
      } else {
        destX = (idle0X * w0 + idle1X * w1 + idle2X * w2 + (CX + 132) * w3) / sumW;
        destY = (idle0Y * w0 + idle1Y * w1 + idle2Y * w2 + (CY - 38) * w3) / sumW;
        followRate = (10 * w0 + 3.8 * w1 + 9 * w2 + 4.5 * w3) / sumW;
      }
    }

    const prevX = core.x, prevY = core.y;
    const step = Math.min(1, dt * followRate);
    core.x += (destX - core.x) * step;
    core.y += (destY - core.y) * step;
    core.vx = (core.x - prevX) / Math.max(0.008, dt);
    core.vy = (core.y - prevY) / Math.max(0.008, dt);

    /* Heavy outer shell lags behind core in Era 02 */
    shell.x += (core.x - shell.x) * Math.min(1, dt * 2.4);
    shell.y += (core.y - shell.y) * Math.min(1, dt * 2.4);

    /* Decay wall hit highlights */
    const decay = Math.max(0, 1 - dt * 5.5);
    wallFlash.left *= decay;
    wallFlash.right *= decay;
    wallFlash.top *= decay;
    wallFlash.bottom *= decay;

    /* Record delicate breathing ribbon trail in Era 04 */
    if (w3 > 0.25) {
      const last = trail[trail.length - 1];
      if (!last || Math.hypot(core.x - last.x, core.y - last.y) > 4) {
        trail.push({ x: core.x, y: core.y, born: simTime });
        if (trail.length > 44) trail.shift();
      }
    } else if (trail.length > 0) {
      trail.shift();
    }
  }

  function draw() {
    if (!canvas.width || !canvas.height) return;
    ctx.setTransform(canvas.width / W, 0, 0, canvas.height / H, 0, 0);

    const w0 = smooth(1 - Math.abs(u - 0));
    const w1 = smooth(1 - Math.abs(u - 1));
    const w2 = smooth(1 - Math.abs(u - 2));
    const w3 = smooth(1 - Math.abs(u - 3));

    /* Paper background warms from subtle drafting surface to crisp pure blank paper in Era 04 */
    const bg = mixRgb(pal.subtle, pal.canvas, smooth(u / 3));
    ctx.fillStyle = rgba(bg, 1);
    ctx.fillRect(0, 0, W, H);

    /* Quiet architectural registration meridian + horizon */
    ctx.strokeStyle = rgba(pal.rule, 0.55 + w3 * 0.25);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(CX + 0.5, 22);
    ctx.lineTo(CX + 0.5, H - 22);
    ctx.moveTo(28, CY + 0.5);
    ctx.lineTo(W - 28, CY + 0.5);
    ctx.stroke();

    /* -----------------------------------------------------------
       ERA 01 (Hexo): Rigid Nested Obsidian Template Cages & Slats
       ----------------------------------------------------------- */
    if (w0 > 0.01) {
      ctx.save();
      const spread = (1 - w0) * 140;

      /* Heavy outer template sidebars echoing the cover lithograph */
      ctx.fillStyle = rgba(pal.ink, 0.86 * w0);
      const barW = 46 * w0;
      ctx.fillRect(62 - spread, 64, barW, 412);
      ctx.fillRect(W - 62 - barW + spread, 64, barW, 412);

      /* Rigid vertical column rhythm bars */
      ctx.fillStyle = rgba(pal.ink, 0.14 * w0);
      for (let i = 0; i < 4; i++) {
        const sx = 128 + i * 20 - spread * 0.5;
        ctx.fillRect(sx, 64, 9, 412);
        ctx.fillRect(W - sx - 9, 64, 9, 412);
      }

      /* Four concentric rigid rectangular frames locking the center */
      const boxes = [
        { w: 500, h: 356, lw: 1.4, a: 0.35 },
        { w: 380, h: 266, lw: 1.4, a: 0.52 },
        { w: 264, h: 182, lw: 1.6, a: 0.72 },
        { w: 156, h: 104, lw: 2.0, a: 0.92 },
      ];
      for (const b of boxes) {
        const bw = b.w + (1 - w0) * 90;
        const bh = b.h + (1 - w0) * 55;
        ctx.strokeStyle = rgba(pal.ink, b.a * w0);
        ctx.lineWidth = b.lw;
        ctx.strokeRect(CX - bw / 2, CY - bh / 2, bw, bh);
      }

      /* Wall-hit feedback pulses on the innermost cage */
      const ix = CX - 78, iy = CY - 52, iw = 156, ih = 104;
      const drawWallHit = (alpha, x1, y1, x2, y2) => {
        if (alpha < 0.03) return;
        ctx.strokeStyle = rgba(pal.accent, alpha * w0);
        ctx.lineWidth = 3.5;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
      };
      drawWallHit(wallFlash.left, ix, iy, ix, iy + ih);
      drawWallHit(wallFlash.right, ix + iw, iy, ix + iw, iy + ih);
      drawWallHit(wallFlash.top, ix, iy, ix + iw, iy);
      drawWallHit(wallFlash.bottom, ix, iy + ih, ix + iw, iy + ih);

      ctx.restore();
    }

    /* -----------------------------------------------------------
       ERA 02 (WordPress · Sakurairo): Stacked Rings + Inner Bloom
       ----------------------------------------------------------- */
    if (w1 > 0.01) {
      ctx.save();
      const ox = shell.x;
      const oy = shell.y;

      /* Heavy layered concentric VPS / panel machinery rings */
      const rings = [
        { r: 214, lw: 10, segs: 4, speed: 0.14, alpha: 0.14 },
        { r: 176, lw: 4.5, segs: 6, speed: -0.22, alpha: 0.42 },
        { r: 138, lw: 2.4, segs: 3, speed: 0.31, alpha: 0.68 },
        { r: 106, lw: 1.5, segs: 8, speed: -0.18, alpha: 0.55 },
      ];
      for (const rg of rings) {
        const radius = rg.r * (0.85 + 0.15 * w1);
        const span = (Math.PI * 2) / rg.segs;
        ctx.strokeStyle = rgba(pal.ink, rg.alpha * w1);
        ctx.lineWidth = rg.lw;
        for (let k = 0; k < rg.segs; k++) {
          const a0 = simTime * rg.speed + k * span + 0.12;
          const a1 = a0 + span * 0.68;
          ctx.beginPath();
          ctx.arc(ox, oy, radius, a0, a1);
          ctx.stroke();
        }
      }

      /* Perimeter metering ticks (bandwidth / quotas) */
      ctx.strokeStyle = rgba(pal.muted, 0.45 * w1);
      ctx.lineWidth = 1;
      for (let i = 0; i < 48; i++) {
        const a = (i / 48) * Math.PI * 2;
        const len = i % 4 === 0 ? 9 : 4;
        ctx.beginPath();
        ctx.moveTo(ox + Math.cos(a) * 228, oy + Math.sin(a) * 228);
        ctx.lineTo(ox + Math.cos(a) * (228 + len), oy + Math.sin(a) * (228 + len));
        ctx.stroke();
      }

      /* Delicate Sakurairo abstract five-fold bloom glowing inside the heavy shell */
      const bx = CX + (core.x - CX) * 0.65;
      const by = CY + (core.y - CY) * 0.65;
      for (let p = 0; p < 5; p++) {
        const theta = simTime * 0.28 + (p * Math.PI * 2) / 5;
        ctx.save();
        ctx.translate(bx, by);
        ctx.rotate(theta);
        ctx.fillStyle = p % 2 === 0 ? rgba(pal.signal, 0.13 * w1) : rgba(pal.accent, 0.12 * w1);
        ctx.beginPath();
        ctx.ellipse(26, 0, 26, 11, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = p % 2 === 0 ? rgba(pal.signal, 0.42 * w1) : rgba(pal.accent, 0.35 * w1);
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.restore();
      }

      /* Elastic tether from core back to nested center */
      ctx.strokeStyle = rgba(pal.ink, 0.25 * w1);
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(CX, CY);
      ctx.lineTo(core.x, core.y);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.restore();
    }

    /* -----------------------------------------------------------
       ERA 03 (Astro · Workers): Airy Distributed Edge Lattice
       ----------------------------------------------------------- */
    if (w2 > 0.01) {
      ctx.save();
      /* Orthogonal whisper-thin lattice lines */
      ctx.strokeStyle = rgba(pal.rule, 0.85 * w2);
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let c = 0; c < gridCols; c++) {
        const gx = gridMarginX + c * stepX;
        ctx.moveTo(gx, gridMarginY - 14);
        ctx.lineTo(gx, H - gridMarginY + 14);
      }
      for (let r = 0; r < gridRows; r++) {
        const gy = gridMarginY + r * stepY;
        ctx.moveTo(gridMarginX - 18, gy);
        ctx.lineTo(W - gridMarginX + 18, gy);
      }
      ctx.stroke();

      /* Distributed edge nodes */
      const activeSnap = nearestLattice(core.x, core.y);
      for (let r = 0; r < gridRows; r++) {
        for (let c = 0; c < gridCols; c++) {
          const gx = gridMarginX + c * stepX;
          const gy = gridMarginY + r * stepY;
          const dist = Math.hypot(gx - activeSnap.x, gy - activeSnap.y);
          const near = dist < stepX * 1.45;
          ctx.fillStyle = near ? rgba(pal.accent, 0.65 * w2) : rgba(pal.ink, 0.22 * w2);
          ctx.beginPath();
          ctx.arc(gx, gy, near ? 3.2 : 2.1, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      /* Active cobalt rail lock highlighting the snapped node */
      ctx.strokeStyle = rgba(pal.accent, 0.65 * w2);
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(Math.max(gridMarginX, activeSnap.x - stepX), activeSnap.y);
      ctx.lineTo(Math.min(W - gridMarginX, activeSnap.x + stepX), activeSnap.y);
      ctx.moveTo(activeSnap.x, Math.max(gridMarginY, activeSnap.y - stepY));
      ctx.lineTo(activeSnap.x, Math.min(H - gridMarginY, activeSnap.y + stepY));
      ctx.stroke();

      /* Crisp reticle framing the snapped lattice slot */
      const rs = 22;
      ctx.strokeStyle = rgba(pal.accent, 0.8 * w2);
      ctx.lineWidth = 1.4;
      ctx.strokeRect(activeSnap.x - rs, activeSnap.y - rs, rs * 2, rs * 2);
      ctx.restore();
    }

    /* -----------------------------------------------------------
       ERA 04 (HTML · Blank Sheet): Unbound Living Swiss Canvas
       ----------------------------------------------------------- */
    if (w3 > 0.01) {
      ctx.save();
      const nx = (core.x - CX) / (W * 0.5);
      const ny = (core.y - CY) / (H * 0.5);

      /* Delicate giant drafting compass circle responding softly to thought */
      ctx.strokeStyle = rgba(pal.rule, 0.9 * w3);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(CX + 90 + nx * 26, CY + ny * 18, 224, 0, Math.PI * 2);
      ctx.stroke();

      /* Three translucent International Cobalt geometric planes unfolding organically */
      const planes = [
        { x: CX - 56 + nx * 52, y: CY + 42 + ny * 46, w: 148, h: 122, rot: -0.68 + nx * 0.35 + Math.sin(simTime * 0.7) * 0.03, a: 0.24 },
        { x: CX + 4 + nx * 84, y: CY - 10 + ny * 68, w: 128, h: 96, rot: -0.32 + ny * 0.42 - Math.cos(simTime * 0.6) * 0.03, a: 0.34 },
        { x: CX - 14 + nx * 38, y: CY + 112 + ny * 28, w: 164, h: 72, rot: 0.04 + nx * 0.14, a: 0.46 },
      ];
      for (const pl of planes) {
        ctx.save();
        ctx.translate(pl.x, pl.y);
        ctx.rotate(pl.rot);
        ctx.fillStyle = rgba(pal.accent, pl.a * w3);
        ctx.fillRect(-pl.w / 2, -pl.h / 2, pl.w, pl.h);
        ctx.restore();
      }

      /* Signature sweeping cobalt arc bending toward the free Vermilion Core */
      ctx.strokeStyle = rgba(pal.accent, 0.92 * w3);
      ctx.lineWidth = 7.5;
      ctx.lineCap = "butt";
      ctx.beginPath();
      ctx.moveTo(CX - 70 + nx * 24, CY + 54 + ny * 18);
      ctx.quadraticCurveTo(
        CX + 128 + (core.x - CX) * 0.45,
        CY + 28 + (core.y - CY) * 0.45,
        CX + 162 + nx * 54,
        42
      );
      ctx.stroke();

      /* Flowing calligraphic ink trail behind the free core */
      if (trail.length > 2) {
        for (let i = 1; i < trail.length; i++) {
          const frac = i / trail.length;
          ctx.strokeStyle = rgba(pal.signal, frac * 0.36 * w3);
          ctx.lineWidth = 1.2 + frac * 2.2;
          ctx.beginPath();
          ctx.moveTo(trail[i - 1].x, trail[i - 1].y);
          ctx.lineTo(trail[i].x, trail[i].y);
          ctx.stroke();
        }
      }

      ctx.restore();
    }

    /* Expanding calm harmonic ripples on click/release */
    for (let i = ripples.length - 1; i >= 0; i--) {
      const rp = ripples[i];
      const age = simTime - rp.born;
      if (age > 1.7) {
        ripples.splice(i, 1);
        continue;
      }
      const p = Math.max(0, age / 1.7);
      const col = rp.kind === "signal" ? pal.signal : pal.accent;
      ctx.strokeStyle = rgba(col, (1 - p) * 0.65);
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.arc(rp.x, rp.y, 12 + p * 150, 0, Math.PI * 2);
      ctx.stroke();
    }

    /* -----------------------------------------------------------
       THE VERMILION CORE — Always Present Across All Four Eras
       ----------------------------------------------------------- */
    const haloR = core.r + 7 + (pointer.dragging ? 5 : Math.sin(simTime * 2.2) * 2) * (0.3 + 0.7 * w3);
    ctx.strokeStyle = rgba(pal.signal, pointer.dragging ? 0.55 : 0.28);
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    ctx.arc(core.x, core.y, haloR, 0, Math.PI * 2);
    ctx.stroke();

    ctx.fillStyle = rgba(pal.signal, 0.98);
    ctx.beginPath();
    ctx.arc(core.x, core.y, core.r + w3 * 2.5, 0, Math.PI * 2);
    ctx.fill();
  }

  function tick(ts) {
    if (!visible) {
      rafId = 0;
      return;
    }
    const dt = lastTs ? Math.min(0.05, (ts - lastTs) / 1000) : 0.016;
    lastTs = ts;
    if (!paused) {
      simTime += dt;
    }
    stepPhysics(dt);
    draw();

    const stillMoving =
      !paused ||
      pointer.dragging ||
      Math.abs(targetU - u) > 0.002 ||
      ripples.length > 0 ||
      Math.hypot(core.vx, core.vy) > 1.5;

    if (stillMoving) {
      rafId = requestAnimationFrame(tick);
    } else {
      rafId = 0;
      lastTs = 0;
    }
  }

  function wake() {
    if (!visible || rafId) return;
    lastTs = 0;
    rafId = requestAnimationFrame(tick);
  }

  function canvasCoords(event) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / Math.max(1, rect.width)) * W,
      y: ((event.clientY - rect.top) / Math.max(1, rect.height)) * H,
    };
  }

  canvas.addEventListener("pointerdown", (event) => {
    if (pointer.id !== null || event.button !== 0) return;
    canvas.focus({ preventScroll: true });
    canvas.setPointerCapture(event.pointerId);
    const pt = canvasCoords(event);
    pointer.id = event.pointerId;
    pointer.x = pt.x;
    pointer.y = pt.y;
    pointer.dragging = true;
    if (u > 2.2) emitRipple(pt.x, pt.y, "signal");
    wake();
  });

  canvas.addEventListener("pointermove", (event) => {
    if (event.pointerId !== pointer.id) return;
    const pt = canvasCoords(event);
    pointer.x = pt.x;
    pointer.y = pt.y;
    wake();
  });

  const endDrag = (event) => {
    if (event.pointerId !== pointer.id) return;
    if (u > 2.35) emitRipple(core.x, core.y, "accent");
    if (canvas.hasPointerCapture(pointer.id)) canvas.releasePointerCapture(pointer.id);
    pointer.id = null;
    pointer.dragging = false;
    wake();
  };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);
  canvas.addEventListener("lostpointercapture", endDrag);

  /* Keyboard interaction: arrow keys nudge the vermilion point to feel walls/snapping/freedom */
  canvas.addEventListener("keydown", (event) => {
    const step = 42;
    let dx = 0, dy = 0;
    if (event.key === "ArrowLeft") dx = -step;
    else if (event.key === "ArrowRight") dx = step;
    else if (event.key === "ArrowUp") dy = -step;
    else if (event.key === "ArrowDown") dy = step;
    else return;
    event.preventDefault();
    pointer.x = clamp(core.x + dx, 24, W - 24);
    pointer.y = clamp(core.y + dy, 24, H - 24);
    pointer.dragging = true;
    stepPhysics(0.08);
    pointer.dragging = false;
    draw();
    wake();
  });

  range.addEventListener("input", () => {
    targetU = Number(range.value);
    syncUi(targetU);
    if (paused) {
      u = targetU;
      stepPhysics(0.05);
      draw();
    }
    wake();
  });

  stops.forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.dataset.evoStop || 0);
      targetU = idx;
      range.value = String(idx);
      syncUi(idx);
      if (idx === 3) emitRipple(core.x, core.y, "accent");
      if (paused) {
        u = targetU;
        stepPhysics(0.08);
        draw();
      }
      wake();
      announce(btn.textContent.trim());
    });
  });

  pauseBtn?.addEventListener("click", () => {
    paused = !paused;
    syncPauseLabel();
    if (!paused) wake();
    announce(paused ? (en ? "Animation paused." : "动态演进已暂停。") : (en ? "Animation playing." : "动态演进继续运行。"));
  });

  controls.hidden = false;
  if (pauseBtn) pauseBtn.hidden = false;
  syncPauseLabel();
  syncUi(0);
  updateCanvasSize();

  const ro = new ResizeObserver(updateCanvasSize);
  const box = "devicePixelContentBoxSize" in ResizeObserverEntry.prototype
    ? "device-pixel-content-box" : "content-box";
  ro.observe(canvas, { box });

  new MutationObserver(() => {
    pal = readPalette();
    draw();
  }).observe(document.querySelector('meta[name="color-scheme"]'), {
    attributes: true, attributeFilter: ["content"],
  });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    pal = readPalette();
    draw();
  });
  reducedMotion.addEventListener("change", () => {
    if (reducedMotion.matches) {
      paused = true;
      syncPauseLabel();
    }
  });

  let densityTimer;
  new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    clearInterval(densityTimer);
    if (visible) {
      if (rasterDpr !== devicePixelRatio) updateCanvasSize();
      densityTimer = setInterval(() => {
        if (rasterDpr !== devicePixelRatio) updateCanvasSize();
      }, 450);
      wake();
    } else if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
  }).observe(lab);

  scheduleNotes();
  if (!paused) wake();
}
initEvolutionCanvas();

function initSketch() {
  const lab = document.getElementById("lab-canvas");
  const workspace = lab.querySelector(".sketch-workspace");
  const sheet = lab.querySelector(".sketch-sheet");
  const canvas = sheet.querySelector("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    const message = document.createElement("p");
    message.textContent = en ? "This browser can’t open the drawing sheet." : "当前浏览器无法打开这张画纸。";
    lab.append(message);
    return;
  }
  const paperWidth = 800, paperHeight = 500;
  const nibWidths = { fine: 2.8, medium: 5.5, broad: 11 };
  const strokes = [];
  const selected = { ink: "ink", nib: "fine", paper: "blank" };
  const undo = lab.querySelector('[data-action="undo"]');
  const clear = lab.querySelector('[data-action="clear"]');
  const sendComment = lab.querySelector('[data-action="send-comment"]');
  const sendCommentLabel = sendComment?.textContent?.trim() || (en ? "Send to Notes" : "发送到评论区");
  const swatches = [...lab.querySelectorAll("[data-ink]:not([data-ink=eraser])")];
  const forcedColors = matchMedia("(forced-colors: active)");
  const darkSchemeQuery = matchMedia("(prefers-color-scheme: dark)");
  const guideCanvas = document.createElement("canvas");
  guideCanvas.className = "sketch-guide";
  guideCanvas.setAttribute("aria-hidden", "true");
  guideCanvas.hidden = true;
  sheet.append(guideCanvas);
  const guideCtx = guideCanvas.getContext("2d");
  let colors = {};
  let pointer = null;
  let current = null;
  let lastTime = 0;
  let rasterDpr = 0;
  let sendingToComments = false;
  let sendConfirmTimer = 0;

  function isDarkSchemeActive() {
    const meta = document.querySelector('meta[name="color-scheme"]')?.content?.trim();
    if (meta === "dark") return true;
    if (meta === "light") return false;
    return darkSchemeQuery.matches;
  }

  function parseColorRgb(str) {
    const raw = String(str || "").trim();
    const hex = raw.match(/^#([0-9a-f]{6})$/i);
    if (hex) {
      const n = parseInt(hex[1], 16);
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }
    const m = raw.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  }

  function relativeLuminance([r, g, b]) {
    const lin = (v) => {
      const c = Math.max(0, Math.min(255, v)) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  }

  function contrastRatio(rgbA, rgbB) {
    const la = relativeLuminance(rgbA);
    const lb = relativeLuminance(rgbB);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }

  function pickContrastingColor(paperRgb, candidates, minRatio) {
    let bestColor = candidates[candidates.length - 1];
    let bestRatio = -1;
    for (const candidate of candidates) {
      const rgb = parseColorRgb(candidate);
      if (!rgb) continue;
      const ratio = contrastRatio(rgb, paperRgb);
      if (ratio >= minRatio) return candidate;
      if (ratio > bestRatio) {
        bestRatio = ratio;
        bestColor = candidate;
      }
    }
    return bestColor;
  }

  function forcedPalette() {
    const sheetStyle = getComputedStyle(sheet);
    const bgStr = sheetStyle.backgroundColor;
    const bgRgb = parseColorRgb(bgStr);
    const fgStr = sheetStyle.color;
    const fgRgb = parseColorRgb(fgStr);
    const paperRgb = bgRgb || (isDarkSchemeActive() ? [13, 15, 19] : [255, 255, 255]);
    const paperIsDark = relativeLuminance(paperRgb) < 0.179;
    const paper = bgRgb ? bgStr : paperIsDark ? "#0d0f13" : "#ffffff";
    const poles = paperIsDark ? ["#ffffff", "#000000"] : ["#000000", "#ffffff"];
    return {
      paper,
      dots: pickContrastingColor(
        paperRgb,
        paperIsDark
          ? ["#768299", "#9aa5b8", "#556073", ...poles]
          : ["#8a94a6", "#667085", "#4e5666", ...poles],
        3.0
      ),
      inks: {
        ink: pickContrastingColor(paperRgb, [...(fgRgb ? [fgStr] : []), ...poles], 4.5),
        cobalt: pickContrastingColor(
          paperRgb,
          paperIsDark ? ["#689bff", "#8fb6ff", "#0047ff", ...poles] : ["#0047ff", "#0033cc", "#689bff", ...poles],
          3.0
        ),
        vermilion: pickContrastingColor(
          paperRgb,
          paperIsDark ? ["#ff6b4e", "#ff9680", "#d9381a", ...poles] : ["#d9381a", "#b0250c", "#ff6b4e", ...poles],
          3.0
        ),
        graphite: pickContrastingColor(
          paperRgb,
          paperIsDark ? ["#b8c0cc", "#d5dce6", "#4e5666", ...poles] : ["#4e5666", "#373f4d", "#b8c0cc", ...poles],
          3.0
        ),
      },
    };
  }

  function readColors() {
    if (forcedColors.matches) {
      colors = { ...forcedPalette().inks };
      return;
    }
    for (const swatch of swatches) {
      colors[swatch.dataset.ink] = getComputedStyle(swatch, "::before").backgroundColor;
    }
  }

  function drawDotGrid(context, width, height, dotColor, cssWidth) {
    context.save();
    context.setTransform(width / paperWidth, 0, 0, height / paperHeight, 0, 0);
    const scale = paperWidth / Math.max(1, cssWidth || paperWidth);
    context.fillStyle = dotColor;
    for (let y = 10 * scale; y < paperHeight; y += 20 * scale) {
      for (let x = 10 * scale; x < paperWidth; x += 20 * scale) {
        context.beginPath();
        context.arc(x, y, 0.9 * scale, 0, Math.PI * 2);
        context.fill();
      }
    }
    context.restore();
  }

  function updateGuide() {
    if (!guideCtx) return;
    const sheetStyle = getComputedStyle(sheet);
    const showCanvasDots =
      selected.paper === "dots" &&
      (forcedColors.matches || sheetStyle.backgroundImage === "none");
    guideCanvas.hidden = !showCanvasDots;
    if (!showCanvasDots) return;
    if (guideCanvas.width !== canvas.width) guideCanvas.width = canvas.width;
    if (guideCanvas.height !== canvas.height) guideCanvas.height = canvas.height;
    if (!guideCanvas.width || !guideCanvas.height) return;
    guideCtx.setTransform(1, 0, 0, 1, 0, 0);
    guideCtx.clearRect(0, 0, guideCanvas.width, guideCanvas.height);
    const dotColor = forcedColors.matches ? forcedPalette().dots : sheetStyle.borderTopColor;
    drawDotGrid(
      guideCtx,
      guideCanvas.width,
      guideCanvas.height,
      dotColor,
      canvas.getBoundingClientRect().width
    );
  }

  // Store positions as fractions of the sheet. A fixed paper aspect ratio and a
  // single pen coordinate system keep loops circular on every display and export.
  function setupBrush(context, stroke) {
    context.globalCompositeOperation = stroke.eraser ? "destination-out" : "source-over";
    context.fillStyle = context.strokeStyle = colors[stroke.color];
    context.lineCap = context.lineJoin = "round";
  }

  function paintPoint(context, stroke, i, finish = false) {
    const points = stroke.points;
    const p = points[i];
    const x = p.x * paperWidth, y = p.y * paperHeight;
    const width = nibWidths[stroke.nib] * p.weight * (stroke.eraser ? 3 : 1);
    context.lineWidth = width;
    context.beginPath();
    if (i === 0) {
      context.arc(x, y, width / 2, 0, Math.PI * 2);
      context.fill();
      return;
    }
    const prev = points[i - 1];
    const mx = (prev.x * paperWidth + x) / 2, my = (prev.y * paperHeight + y) / 2;
    if (finish) {
      context.moveTo(mx, my);
      context.lineTo(x, y);
    } else {
      const older = points[Math.max(0, i - 2)];
      context.moveTo((older.x + prev.x) * paperWidth / 2, (older.y + prev.y) * paperHeight / 2);
      context.quadraticCurveTo(prev.x * paperWidth, prev.y * paperHeight, mx, my);
    }
    context.stroke();
  }

  function replay(context, width, height) {
    context.setTransform(width / paperWidth, 0, 0, height / paperHeight, 0, 0);
    context.clearRect(0, 0, paperWidth, paperHeight);
    for (const stroke of strokes) {
      setupBrush(context, stroke);
      stroke.points.forEach((_, i) => paintPoint(context, stroke, i));
      if (stroke !== current && stroke.points.length > 1) paintPoint(context, stroke, stroke.points.length - 1, true);
    }
  }

  function updatePaper() {
    const rect = canvas.getBoundingClientRect();
    const width = Math.round(rect.width * devicePixelRatio);
    const height = Math.round(rect.height * devicePixelRatio);
    if (!width || !height) return;
    rasterDpr = devicePixelRatio;
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    readColors();
    replay(ctx, width, height);
    updateGuide();
  }

  function updateActions() {
    const empty = strokes.length === 0;
    undo.disabled = clear.disabled = empty;
    if (sendComment) {
      sendComment.disabled = empty || sendingToComments;
      if (empty && sendConfirmTimer) {
        clearTimeout(sendConfirmTimer);
        sendConfirmTimer = 0;
        sendComment.textContent = sendCommentLabel;
      }
    }
    sheet.toggleAttribute("data-marked", !empty);
  }

  function newStroke(ink = selected.ink) {
    if (forcedColors.matches) readColors();
    const eraser = ink === "eraser";
    const stroke = { color: eraser ? "ink" : ink, nib: selected.nib, eraser, points: [] };
    strokes.push(stroke);
    setupBrush(ctx, stroke);
    updateActions();
    return stroke;
  }

  function addSample(event, rect) {
    const x = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    const y = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
    const prev = current.points.at(-1);
    if (prev && x === prev.x && y === prev.y) return;
    const distance = prev ? Math.hypot((x - prev.x) * rect.width, (y - prev.y) * rect.height) : 0;
    const speed = distance / Math.max(1, event.timeStamp - lastTime);
    const pressure = event.pointerType === "pen" ? Math.max(0.05, event.pressure) : 0.5;
    const target = (0.48 + pressure) / (1 + Math.min(2, speed) * 0.18);
    const weight = prev ? prev.weight * 0.55 + target * 0.45 : target * 0.8;
    lastTime = event.timeStamp;
    current.points.push({ x, y, weight });
    paintPoint(ctx, current, current.points.length - 1);
  }

  function finishStroke() {
    if (!current) return;
    if (current.points.length > 1) paintPoint(ctx, current, current.points.length - 1, true);
    current = null;
    if (canvas.hasPointerCapture(pointer)) canvas.releasePointerCapture(pointer);
    pointer = null;
  }

  canvas.addEventListener("pointerdown", event => {
    if (pointer !== null || event.button !== 0 || (selected.ink === "eraser" && !strokes.length)) return;
    canvas.focus({ preventScroll: true });
    canvas.setPointerCapture(event.pointerId);
    pointer = event.pointerId;
    current = newStroke();
    addSample(event, canvas.getBoundingClientRect());
  });
  canvas.addEventListener("pointermove", event => {
    if (event.pointerId !== pointer) return;
    const rect = canvas.getBoundingClientRect();
    for (const sample of event.getCoalescedEvents?.() || []) addSample(sample, rect);
    addSample(event, rect);
  });
  canvas.addEventListener("pointerup", event => {
    if (event.pointerId !== pointer) return;
    addSample(event, canvas.getBoundingClientRect());
    finishStroke();
  });
  for (const type of ["pointercancel", "lostpointercapture"]) {
    canvas.addEventListener(type, event => { if (event.pointerId === pointer) finishStroke(); });
  }

  function doodle() {
    const stroke = newStroke(selected.ink === "eraser" ? "ink" : selected.ink);
    const startX = 0.12 + Math.random() * 0.45, centerY = 0.25 + Math.random() * 0.5;
    const turns = 1.15 + Math.random() * 1.5;
    for (let i = 0; i <= 72; i++) {
      const t = i / 72, angle = t * turns * Math.PI * 2;
      stroke.points.push({ x: startX + 0.30 * t + 0.05 * Math.sin(angle),
        y: centerY + 0.09 * Math.sin(angle + 0.9), weight: 0.65 + 0.35 * Math.sin(t * Math.PI) });
    }
    replay(ctx, canvas.width, canvas.height);
    announce(en ? "Doodle added." : "已在纸上落了一笔。");
  }

  function undoStroke() {
    finishStroke();
    if (!strokes.length) return;
    strokes.pop();
    replay(ctx, canvas.width, canvas.height);
    updateActions();
    announce(en ? "Last stroke undone." : "已撤销上一笔。");
  }

  function renderExportCanvas(targetWidth) {
    readColors();
    const output = document.createElement("canvas");
    output.width = Math.max(1, Math.round(targetWidth));
    output.height = Math.max(1, Math.round(output.width * paperHeight / paperWidth));
    const context = output.getContext("2d");
    if (!context) return null;
    const sheetStyle = getComputedStyle(sheet);
    const useForced = forcedColors.matches || colors.ink === sheetStyle.backgroundColor;
    const fallbackPal = useForced ? forcedPalette() : null;
    if (useForced) {
      colors = { ...fallbackPal.inks };
    }
    replay(context, output.width, output.height);
    // Put guides and paper behind the transparent ink, including erased areas.
    context.globalCompositeOperation = "destination-over";
    const cssWidth = canvas.getBoundingClientRect().width;
    if (selected.paper === "dots") {
      drawDotGrid(
        context,
        output.width,
        output.height,
        fallbackPal ? fallbackPal.dots : sheetStyle.borderTopColor,
        cssWidth
      );
    }
    context.fillStyle = fallbackPal ? fallbackPal.paper : sheetStyle.backgroundColor;
    context.fillRect(0, 0, paperWidth, paperHeight);
    return output;
  }

  function exportCanvasBlob(output, mimeType, quality) {
    return new Promise((resolve) => {
      try {
        output.toBlob((blob) => resolve(blob || null), mimeType, quality);
      } catch {
        resolve(null);
      }
    });
  }

  function savePNG() {
    const output = renderExportCanvas(Math.max(paperWidth * 2, canvas.width));
    if (!output) {
      announce(en ? "The PNG could not be created." : "未能生成 PNG。");
      return;
    }
    output.toBlob(blob => {
      if (!blob) { announce(en ? "The PNG could not be created." : "未能生成 PNG。"); return; }
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "tongs-information-issue-01.png";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      announce(en ? "PNG ready to save." : "画作已生成 PNG。");
    }, "image/png");
  }

  async function sendToComments() {
    if (!sendComment || sendingToComments) return;
    if (strokes.length === 0) {
      announce(en ? "Draw something on the sheet first." : "请先在画纸上画几笔。");
      return;
    }
    const commentsEl = document.querySelector("ti-comments");
    if (!commentsEl) {
      announce(en ? "Reader Notes is unavailable on this page." : "当前页面未找到评论区。");
      return;
    }

    clearTimeout(sendConfirmTimer);
    sendConfirmTimer = 0;
    sendingToComments = true;
    sendComment.disabled = true;
    sendComment.setAttribute("aria-busy", "true");
    sendComment.textContent = en ? "Attaching…" : "正在附入…";

    let attached = false;
    try {
      // Export at a crisp 1200x750 intermediate PNG so <ti-comments> compresses once (WebP/PNG/JPEG) with zero double-loss
      const output = renderExportCanvas(1200);
      const blob = output ? await exportCanvasBlob(output, "image/png") : null;
      if (!blob) {
        announce(en ? "Could not export the sketch." : "未能导出当前画作。");
        return;
      }
      const file = new File([blob], "tongs-sketch-issue-01.png", { type: "image/png" });

      if (!customElements.get("ti-comments")) {
        await import("/assets/js/comments.js");
      }
      await customElements.whenDefined("ti-comments");

      if (typeof commentsEl.attachImageFiles !== "function") {
        announce(en ? "Reader Notes could not accept the sketch." : "评论区暂不支持直接附入画作。");
        return;
      }

      const res = await commentsEl.attachImageFiles([file], {
        maxEdge: 1200,
        maxBytes: 400 * 1024,
        quality: 0.82,
        announceAdded: false,
      });

      if (res?.ok && res.added > 0) {
        attached = true;
        sendComment.textContent = en ? "Attached ✓" : "已附入评论区 ✓";
        announce(
          en
            ? "Compressed sketch attached to Reader Notes. Write a note or post directly."
            : "已将压缩后的画作附入评论区，可继续留言或直接投递。"
        );
        sendConfirmTimer = setTimeout(() => {
          sendConfirmTimer = 0;
          if (!sendingToComments && sendComment.isConnected) {
            sendComment.textContent = sendCommentLabel;
          }
        }, 2200);
      } else if (res?.reason === "load_failed") {
        announce(en ? "Could not load Reader Notes right now." : "暂时无法读取评论区，请稍后再试。");
      } else if (res?.reason === "submitting") {
        announce(en ? "A note is currently being posted. Try again in a moment." : "当前正在投递评论，请稍后再试。");
      }
    } catch {
      announce(en ? "Could not attach the sketch to Reader Notes right now." : "暂时无法将画作发送到评论区，请稍后再试。");
    } finally {
      sendingToComments = false;
      sendComment.removeAttribute("aria-busy");
      if (!attached) {
        sendComment.textContent = sendCommentLabel;
      }
      updateActions();
    }
  }

  workspace.addEventListener("click", event => {
    const button = event.target.closest("button");
    if (!button) return;
    finishStroke();
    for (const key of ["ink", "nib", "paper"]) {
      if (!button.dataset[key]) continue;
      selected[key] = button.dataset[key];
      for (const option of button.parentElement.querySelectorAll("button")) {
        option.setAttribute("aria-pressed", String(option === button));
      }
      sheet.dataset.guide = selected.paper;
      if (key === "paper") updateGuide();
      announce(button.parentElement.getAttribute("aria-label") + " · " + button.textContent);
      return;
    }
    switch (button.dataset.action) {
      case "undo": undoStroke(); break;
      case "doodle": doodle(); break;
      case "save": savePNG(); break;
      case "send-comment": sendToComments(); break;
      case "clear":
        strokes.length = 0;
        replay(ctx, canvas.width, canvas.height);
        updateActions();
        announce(en ? "The sheet is blank again." : "纸面又空出来了。");
        break;
    }
  });
  workspace.addEventListener("keydown", event => {
    if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "z") {
      event.preventDefault();
      undoStroke();
    }
  });

  workspace.hidden = false;
  updatePaper();
  const rasterObserver = new ResizeObserver(updatePaper);
  const box = "devicePixelContentBoxSize" in ResizeObserverEntry.prototype
    ? "device-pixel-content-box" : "content-box";
  rasterObserver.observe(canvas, { box });
  new MutationObserver(updatePaper).observe(document.querySelector('meta[name="color-scheme"]'), {
    attributes: true, attributeFilter: ["content"],
  });
  darkSchemeQuery.addEventListener("change", updatePaper);
  forcedColors.addEventListener("change", updatePaper);
  // Some display/emulation changes update devicePixelRatio without a CSS resize
  // or resolution event. Check only while the paper is on screen.
  let densityTimer;
  const checkDensity = () => { if (rasterDpr !== devicePixelRatio) updatePaper(); };
  new IntersectionObserver(([entry]) => {
    clearInterval(densityTimer);
    if (entry.isIntersecting) {
      checkDensity();
      densityTimer = setInterval(checkDensity, 400);
    }
  }).observe(sheet);
}
initSketch();
