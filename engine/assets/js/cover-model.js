/* Tong's Information · Issue 02. All artwork is drawn in CSS pixels. */

const mounts = new WeakMap();
const PI = Math.PI;
const TAU = 2 * PI;
const ARRIVAL = 0.62;
const LANES = [-1, 1, 0];

function line(path, x1, y1, x2, y2) {
  path.moveTo(x1, y1);
  path.lineTo(x2, y2);
}

function stroke(ctx, path, color, alpha, width) {
  ctx.strokeStyle = color;
  ctx.globalAlpha = alpha;
  ctx.lineWidth = width;
  ctx.stroke(path);
}

function parseRgbString(str) {
  const m = String(str).match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
}

function rgbToCss(rgb) {
  return `rgb(${Math.round(rgb[0])}, ${Math.round(rgb[1])}, ${Math.round(rgb[2])})`;
}

function palette(probe) {
  function resolve(token) {
    probe.style.color = `var(--${token})`;
    return getComputedStyle(probe).color;
  }
  return {
    paper: resolve("cover-paper"), ink: resolve("ink-primary"),
    secondary: resolve("ink-secondary"), muted: resolve("ink-muted"),
    rule: resolve("rule"), accent: resolve("accent"), signal: resolve("signal"),
  };
}

function paletteRgb(pal) {
  const out = {};
  for (const key of Object.keys(pal)) out[key] = parseRgbString(pal[key]);
  return out;
}

// An elliptical ribbon with cut ends. Dimensions are fractions of the print height.
function ribbon(rx, ry, thickness, start, end) {
  const path = new Path2D();
  path.ellipse(0, 0, rx, ry, 0, start, end, true);
  path.ellipse(0, 0, rx - thickness, ry - thickness, 0, end, start);
  path.closePath();
  return path;
}

function makeOptics() {
  const rear = -0.445;
  // The dark rear ribbon overprints the upper blue sweep at their crossing.
  return [
    [rear, 0, "accent", ribbon(0.479, 0.500, 0.055, -1.08, 0.60)],
    [rear, 0, "accent", ribbon(0.269, 0.283, 0.055, -1.47, 1.28)],
    [0, 0, "accent", ribbon(0.536, 0.500, 0.055, -1.43, -2.55)],
    [rear, 0, "ink", ribbon(0.374, 0.391, 0.055, -1.08, 0.76)],
    [0, -0.010, "ink", ribbon(0.520, 0.420, 0.064, -1.43, 2.14)],
    [0, -0.010, "accent", ribbon(0.386, 0.311, 0.057, -1.43, 1.43)],
  ];
}

function makeLayout(ctx, width, height) {
  const cx = width / 2;
  const cy = height / 2;
  const size = Math.min(height * 0.78, width * 0.56);
  const sx = Math.min(size, width * 0.51); // Leave a margin around the outer arc on phones.
  const step = Math.max(24, size * 0.23);
  const compassX = cx - 0.445 * sx;
  const anchorX = cx + 0.635 * sx;
  const grid = new Path2D();
  const diagonals = new Path2D();
  const ruler = new Path2D();
  const compass = new Path2D();
  const sweeps = new Path2D();
  const radii = [];
  const crosses = [];
  const cols = Math.ceil(cx / step);
  const rows = Math.ceil(cy / step);

  for (let col = -cols; col <= cols; col++) {
    const x = cx + col * step;
    line(grid, x, 0, x, height);
    for (let row = -rows; row <= rows; row++) {
      crosses.push([x, cy + row * step]);
    }
  }
  for (let row = -rows; row <= rows; row++) {
    const y = cy + row * step;
    line(grid, 0, y, width, y);
  }
  for (const x of [compassX, cx, anchorX]) {
    line(diagonals, x - cy, 0, x + cy, height);
  }
  line(diagonals, cx - cy, height, cx + cy, 0);
  line(diagonals, anchorX - cy, height, anchorX + cy, 0);
  line(ruler, 0, cy, width, cy);
  for (let i = -cols * 4; i <= cols * 4; i++) {
    const x = cx + i * step / 4;
    const mark = i % 4 === 0 ? 4 : i % 2 === 0 ? 2.5 : 1.5;
    line(ruler, x, cy - mark, x, cy + mark);
  }
  for (let r = step * 2.85; r < compassX + step; r += step * 1.8) {
    radii.push(r);
    compass.moveTo(compassX + r * Math.cos(PI * 0.59), cy + r * Math.sin(PI * 0.59));
    compass.arc(compassX, cy, r, PI * 0.59, PI * 1.41);
    const outer = r + step * 0.13;
    const angle = Math.min(0.75, cy * 0.85 / outer);
    sweeps.moveTo(compassX + outer * Math.cos(PI - angle), cy + outer * Math.sin(PI - angle));
    sweeps.arc(compassX, cy, outer, PI - angle, PI + angle * 0.55);
  }

  // Erase only the outer strips of the drafting layer, leaving the paper transparent.
  const fades = [ctx.createLinearGradient(0, 0, width, 0), ctx.createLinearGradient(0, 0, 0, height)];
  for (const fade of fades) {
    fade.addColorStop(0, "#000");
    fade.addColorStop(0.12, "transparent");
    fade.addColorStop(0.88, "transparent");
    fade.addColorStop(1, "#000");
  }
  return {
    width, height, cx, cy, size, sx, step, compassX, anchorX, dot: size * 0.048,
    railRise: Math.min(height * 0.125, (width - anchorX) * 0.20),
    outerRise: Math.min(height * 0.32, (width - cx - 0.519 * sx) * 0.42),
    grid, diagonals, ruler, compass, sweeps, crosses, radii, fades,
  };
}

function fadeEdges(ctx, { width, height, fades }) {
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "destination-out";
  ctx.fillStyle = fades[0];
  ctx.fillRect(0, 0, width * 0.12, height);
  ctx.fillRect(width * 0.88, 0, width * 0.12, height);
  ctx.fillStyle = fades[1];
  ctx.fillRect(0, 0, width, height * 0.12);
  ctx.fillRect(0, height * 0.88, width, height * 0.12);
  ctx.restore();
}

function drawCompass(ctx, g, colors, time) {
  stroke(ctx, g.compass, colors.secondary, 0.37, 0.75);
  ctx.setLineDash([1.3, 4]);
  ctx.lineDashOffset = -time * 0.8;
  stroke(ctx, g.sweeps, colors.muted, 0.55, 0.75);
  ctx.setLineDash([]);
  const ticks = new Path2D();
  const indices = new Path2D();
  g.radii.forEach((r, i) => {
    const aperture = Math.min(0.58, g.cy * 0.80 / r);
    const angle = PI + Math.sin(time * 0.19 + i * 1.7) * aperture * 0.13;
    for (const division of [-0.77, -0.67, 0.33, 0.72]) {
      const a = angle + aperture * division;
      const dx = Math.cos(a);
      const dy = Math.sin(a);
      const x = g.compassX + r * dx;
      const y = g.cy + r * dy;
      line(ticks, x - 2.5 * dx, y - 2.5 * dy, x + 3 * dx, y + 3 * dy);
      if (division === 0.33 && i % 2 === 0) indices.rect(x - 1.4, y - 1.4, 2.8, 2.8);
    }
  });
  stroke(ctx, ticks, colors.secondary, 0.62, 0.85);
  ctx.fillStyle = colors.accent;
  ctx.fill(indices);
}

// Every rail shares its origin with either the moving apex or the moving datum.
function drawRails(ctx, g, colors, fx, fy, tipX, tipY, time) {
  const rails = new Path2D();
  const ticks = new Path2D();
  const extent = g.width - fx;
  if (Math.abs(fy - g.cy) > 0.5) line(rails, fx, fy, g.width, g.cy);
  for (const lane of [-2, -1, 1, 2]) {
    const outer = Math.abs(lane) === 2;
    const startX = outer ? tipX : fx;
    const startY = outer ? tipY : fy;
    const endY = g.cy + Math.sign(lane) * (outer ? g.outerRise : g.railRise);
    line(rails, startX, startY, g.width, endY);
    for (let n = 1; n * g.step * 2 < extent; n++) {
      const drift = Math.sin(time * 0.24 + n + lane) * g.step * 0.07;
      const x = fx + n * g.step * 2 + drift;
      const y = startY + (endY - startY) * (x - startX) / (g.width - startX);
      line(ticks, x, y - 3, x, y + 3);
      if ((n + lane) % 2 === 0) line(ticks, x - 3.5, y, x + 3.5, y);
    }
  }
  stroke(ctx, rails, colors.secondary, 0.37, 0.8);
  stroke(ctx, ticks, colors.muted, 0.72, 0.85);
}

function drawField(ctx, g, colors, pointer, presence, waves) {
  if (presence < 0.005 && !waves.length) return;
  const px = (1 + pointer.x) * g.cx;
  const py = (1 + pointer.y) * g.cy;
  const reach = g.step * 2.35;
  if (presence >= 0.005) {
    const glow = ctx.createRadialGradient(px, py, 0, px, py, reach);
    glow.addColorStop(0, colors.accent);
    glow.addColorStop(1, "transparent");
    stroke(ctx, g.grid, glow, presence * 0.55, 1);
  }
  for (const [x, y] of g.crosses) {
    let strength = presence * Math.max(0, 1 - Math.hypot(x - px, y - py) / reach) ** 2;
    let dx = 0;
    let dy = 0;
    for (const wave of waves) {
      const wx = x - wave.x * g.width;
      const wy = y - wave.y * g.height;
      const distance = Math.hypot(wx, wy);
      const crest = Math.max(0, 1 - Math.abs(distance - wave.radius) / (g.step * 0.45)) * wave.opacity;
      strength += crest * 0.8;
      dx += wx / (distance || 1) * crest * 2;
      dy += wy / (distance || 1) * crest * 2;
    }
    if (strength < 0.035) continue;
    const arm = 1.8 + Math.min(1, strength) * 3;
    ctx.beginPath();
    line(ctx, x + dx - arm, y + dy, x + dx + arm, y + dy);
    line(ctx, x + dx, y + dy - arm, x + dx, y + dy + arm);
    ctx.strokeStyle = colors.accent;
    ctx.globalAlpha = Math.min(0.85, strength);
    ctx.lineWidth = 0.9;
    ctx.stroke();
  }
}

function drawWaves(ctx, g, colors, waves) {
  for (const wave of waves) {
    ctx.strokeStyle = wave.fromDisc ? colors.signal : colors.accent;
    ctx.lineWidth = 0.85;
    for (let i = 0; i < wave.rings; i++) {
      const radius = wave.radius - i * g.step * 0.19;
      if (radius <= 0) continue;
      ctx.beginPath();
      ctx.arc(wave.x * g.width, wave.y * g.height, radius, 0, TAU);
      ctx.globalAlpha = wave.opacity * (0.46 - i * 0.11);
      ctx.stroke();
    }
  }
}

function drawOptics(ctx, optics, colors, angle) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(-1, -0.6, 1, 1.2);
  ctx.clip();
  ctx.globalAlpha = 1;
  for (const [x, y, ink, path] of optics) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(x === 0 ? -angle : angle);
    ctx.fillStyle = colors[ink];
    ctx.fill(path);
    ctx.restore();
  }
  ctx.restore();
}

function face(ctx, color, points, alpha = 1) {
  ctx.fillStyle = color;
  ctx.globalAlpha = alpha;
  ctx.beginPath();
  ctx.moveTo(points[0], points[1]);
  for (let i = 2; i < points.length; i += 2) ctx.lineTo(points[i], points[i + 1]);
  ctx.closePath();
  ctx.fill();
}

function drawPrism(ctx, c, fold, tipX, tipY) {
  // Back to front, with the two large leaves hinged on the vertical meridian.
  face(ctx, c.accent, [0.376, -0.075, 0.427, -0.075, tipX, tipY, 0.427, 0.075, 0.376, 0.075]);
  face(ctx, c.ink, [0.376, 0.025, tipX, tipY, 0.427, 0.075, 0.376, 0.075], 0.12);
  face(ctx, c.ink, [0.333, -0.12, 0.388, -0.12, 0.388, 0.12, 0.333, 0.12]);
  face(ctx, c.secondary, [0.373, -0.12, 0.388, -0.12, 0.388, 0.12], 0.27);
  face(ctx, c.accent, [0.221, -0.166, 0.342, -0.166, 0.342, 0.166, 0.221, 0.166]);
  face(ctx, c.ink, [0.221, -0.166, 0.342, -0.166, 0.271 + fold, 0.166, 0.221, 0.166]);
  face(ctx, c.secondary, [0.221, 0.166, 0.271 + fold, 0.166, 0.225, 0.250]);
  const ridge = 0.115 + fold;
  face(ctx, c.ink, [0, -0.244, ridge, -0.322, ridge, 0.260, 0, 0.332]);
  face(ctx, c.accent, [ridge, -0.322, 0.231, -0.244, 0.231, 0.244, ridge, 0.332]);
  face(ctx, c.paper, [ridge, -0.322, ridge + 0.009, -0.316, ridge + 0.009, 0.325, ridge, 0.332], 0.13);
  face(ctx, c.ink, [0.231, -0.244, 0.231, 0.244, ridge, 0.332], 0.07);
  ctx.globalAlpha = 1;
}

function drawSignal(ctx, g, colors, phase, lane, tipX, tipY, fx, fy) {
  let x, y, dx, dy;
  let color = colors.accent;
  if (phase < 0.30) {
    // Follow the negative space between the two front optical bands.
    const a = PI + phase / 0.30 * PI / 2;
    x = g.cx + g.sx * 0.421 * Math.cos(a);
    y = g.cy + g.size * (-0.01 + 0.35 * Math.sin(a));
    dx = -g.sx * 0.421 * Math.sin(a);
    dy = g.size * 0.35 * Math.cos(a);
  } else {
    let x1, y1, x2, y2, t;
    if (phase < 0.38) {
      x1 = x2 = g.cx;
      y1 = g.cy - g.size * 0.36;
      y2 = g.cy - g.size * 0.11;
      t = (phase - 0.30) / 0.08;
    } else if (phase < 0.54) {
      x1 = g.cx; y1 = g.cy - g.size * 0.11;
      x2 = tipX; y2 = tipY;
      t = (phase - 0.38) / 0.16;
      color = colors.paper;
    } else if (phase < ARRIVAL) {
      x1 = tipX; y1 = tipY;
      x2 = fx; y2 = fy;
      t = (phase - 0.54) / (ARRIVAL - 0.54);
    } else {
      x1 = fx; y1 = fy;
      x2 = g.width; y2 = g.cy + lane * g.railRise;
      t = (phase - ARRIVAL) / (1 - ARRIVAL);
      color = lane === 0 ? colors.accent : colors.signal;
    }
    dx = x2 - x1; dy = y2 - y1;
    x = x1 + t * dx; y = y1 + t * dy;
  }
  const length = Math.hypot(dx, dy) || 1;
  const half = Math.max(1.5, g.size * 0.011);
  dx *= half / length; dy *= half / length;
  ctx.beginPath();
  line(ctx, x - dx, y - dy, x + dx, y + dy);
  ctx.strokeStyle = color;
  ctx.globalAlpha = Math.min(1, phase / 0.05, (1 - phase) / 0.06) * 0.85;
  ctx.lineWidth = 1.6;
  ctx.stroke();
}

function spring() {
  return { x: 0, y: 0, vx: 0, vy: 0 };
}

function advanceSpring(s, x, y, stiffness, damping, dt) {
  // Small integration steps keep the release oscillation consistent at low refresh rates.
  const steps = Math.max(1, Math.ceil(dt * 120));
  const h = dt / steps;
  for (let i = 0; i < steps; i++) {
    s.vx += ((x - s.x) * stiffness - s.vx * damping) * h;
    s.vy += ((y - s.y) * stiffness - s.vy * damping) * h;
    s.x += s.vx * h;
    s.y += s.vy * h;
  }
}

export function mountCoverModel(hostEl) {
  if (mounts.has(hostEl)) return mounts.get(hostEl);
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return { destroy() {} };

  const fallback = hostEl.querySelector("img[data-cover-fallback]");
  const originalReady = hostEl.getAttribute("data-model-ready");
  const originalCanvasLive = hostEl.getAttribute("data-canvas-live");
  const stage = document.createElement("div");
  stage.setAttribute("data-cover-canvas-stage", "");
  stage.style.cssText = "position:absolute;inset:0;width:100%;height:100%;min-width:0;min-height:0";
  canvas.style.cssText = "position:absolute;inset:0;display:block;width:100%;height:100%;touch-action:pan-y";
  if (fallback?.alt) {
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", fallback.alt);
  } else {
    canvas.setAttribute("aria-hidden", "true");
  }
  // Browsers decide touch-action at contact time. Only the disc owns a non-scrolling surface.
  const handle = document.createElement("button");
  handle.type = "button";
  handle.setAttribute("aria-label", hostEl.closest("[lang]")?.lang.startsWith("zh") ? "从朱红圆点发出脉冲" : "Pulse the vermilion disc");
  handle.style.cssText = "position:absolute;left:0;top:0;margin:0;padding:0;border:0;border-radius:50%;background:transparent;touch-action:none;cursor:grab";
  stage.append(canvas, handle);
  hostEl.append(stage);
  const probe = document.createElement("span");
  probe.hidden = true;
  document.body.append(probe);
  let colors = palette(probe);
  let colorsCurrentRgb = paletteRgb(colors);
  let colorsTargetRgb = paletteRgb(colors);
  let colorBlending = false;
  const optics = makeOptics();
  const motionPreference = window.matchMedia("(prefers-reduced-motion: reduce)");
  let reducedMotion = motionPreference.matches;
  const osTheme = window.matchMedia("(prefers-color-scheme: dark)");
  const events = new AbortController();
  const listen = { signal: events.signal };
  const pointer = spring();
  const focus = spring();
  const aim = { x: 0, y: 0 };
  const waves = [];
  let g, dpr, handleSize, handlePosition;
  let press = null;
  let hovering = false;
  let presence = 0;
  let time = 0;
  let phase = 0;
  let lap = 0;
  let boost = 0;
  let frame = null;
  let lastTime = null;
  let inViewport = true;
  let destroyed = false;

  function emit(x, y, fromDisc, rings) {
    if (!g || reducedMotion) return;
    if (waves.length === 4) waves.shift();
    waves.push({ x: x / g.width, y: y / g.height, fromDisc, rings, age: 0, radius: fromDisc ? g.dot : 0, opacity: 1 });
  }

  function pulseDisc(rings) {
    emit(g.anchorX + focus.x * g.sx, g.cy + focus.y * g.size, true, rings);
  }

  function advance(dt) {
    time += dt;
    if (colorBlending) {
      const rate = 1 - Math.exp(-12 * dt);
      let stillBlending = false;
      for (const key of Object.keys(colorsCurrentRgb)) {
        const cur = colorsCurrentRgb[key];
        const tgt = colorsTargetRgb[key];
        for (let i = 0; i < 3; i++) {
          const diff = tgt[i] - cur[i];
          if (Math.abs(diff) > 0.4) {
            cur[i] += diff * rate;
            stillBlending = true;
          } else {
            cur[i] = tgt[i];
          }
        }
        colors[key] = rgbToCss(cur);
      }
      colorBlending = stillBlending;
    }
    advanceSpring(pointer, hovering ? aim.x : 0, hovering ? aim.y : 0, 150, 22, dt);
    presence += ((hovering ? 1 : 0) - presence) * (1 - Math.exp(-8 * dt));
    const dragging = press?.drag;
    let tx = 0;
    let ty = 0;
    if (hovering || dragging) {
      const gain = dragging ? 0.82 : 0.082;
      const limit = dragging ? 0.19 : 0.042;
      const px = dragging ? aim.x : pointer.x;
      const py = dragging ? aim.y : pointer.y;
      const dx = ((1 + px) * g.cx - g.anchorX - (dragging ? press.offsetX : 0)) / g.sx;
      const dy = (py * g.cy - (dragging ? press.offsetY : 0)) / g.size;
      const scale = gain / Math.hypot(1, dx * gain / limit, dy * gain / limit);
      tx = Math.max(-0.105, dx * scale);
      ty = dy * scale;
    }
    advanceSpring(focus, tx, ty, dragging ? 220 : 145, dragging ? 19 : 12, dt);
    const previous = phase;
    phase += dt * (0.12 + boost);
    boost *= Math.exp(-dt * 1.08);
    if (previous < ARRIVAL && phase >= ARRIVAL) pulseDisc(1);
    if (phase >= 1) {
      phase -= 1;
      lap = (lap + 1) % LANES.length;
    }
    for (let i = waves.length - 1; i >= 0; i--) {
      const wave = waves[i];
      wave.age += dt / (wave.fromDisc ? 1.55 : 1.85);
      if (wave.age >= 1) {
        waves.splice(i, 1);
        continue;
      }
      const travel = 1 - (1 - wave.age) ** 2;
      wave.radius = (wave.fromDisc ? g.dot : 0) + g.size * (wave.fromDisc ? 0.27 : 0.94) * travel;
      wave.opacity = (1 - wave.age) ** 1.4;
    }
  }

  function draw() {
    if (!g || document.hidden) return;
    const nx = Math.max(-1, Math.min(1, pointer.x));
    const ny = Math.max(-1, Math.min(1, pointer.y));
    const angle = Math.sin(time * 0.48) * 0.016 + nx * 0.022 + ny * 0.013;
    const spread = 1 + Math.sin(time * 0.43) * 0.012 + nx * 0.025;
    const tip = 0.519 + focus.x * 0.61;
    const tilt = focus.y * 0.34 + ny * 0.008;
    const tipX = g.cx + g.sx * spread * tip;
    const tipY = g.cy + g.size * tilt;
    const fx = g.anchorX + focus.x * g.sx;
    const fy = g.cy + focus.y * g.size;
    ctx.clearRect(0, 0, g.width, g.height);
    stroke(ctx, g.grid, colors.rule, 1, 0.9);
    stroke(ctx, g.diagonals, colors.muted, 0.26, 0.7);
    drawCompass(ctx, g, colors, time);
    drawRails(ctx, g, colors, fx, fy, tipX, tipY, time);
    stroke(ctx, g.ruler, colors.secondary, 0.51, 0.75);
    drawField(ctx, g, colors, pointer, presence, waves);
    drawWaves(ctx, g, colors, waves);
    fadeEdges(ctx, g);

    ctx.save();
    ctx.translate(g.cx, g.cy);
    ctx.scale(g.sx, g.size);
    drawOptics(ctx, optics, colors, angle);
    ctx.scale(spread, 1);
    drawPrism(ctx, colors, Math.sin(time * 0.51) * 0.003 + nx * 0.01, tip, tilt);
    ctx.restore();
    if (!reducedMotion) drawSignal(ctx, g, colors, phase, LANES[lap], tipX, tipY, fx, fy);
    if (press?.drag) {
      const tension = new Path2D();
      line(tension, g.anchorX, g.cy - g.dot * 0.55, fx, fy);
      line(tension, g.anchorX, g.cy + g.dot * 0.55, fx, fy);
      stroke(ctx, tension, colors.signal, 0.55, 0.8);
    }
    ctx.beginPath();
    ctx.arc(fx, fy, g.dot, 0, TAU);
    ctx.globalAlpha = 1;
    ctx.fillStyle = colors.signal;
    ctx.fill();
    const position = `translate(${(fx - handleSize / 2).toFixed(2)}px,${(fy - handleSize / 2).toFixed(2)}px)`;
    if (position !== handlePosition) {
      handle.style.transform = position;
      handlePosition = position;
    }
  }

  function start() {
    if (frame === null && g && !destroyed && !document.hidden && !reducedMotion && inViewport) {
      frame = requestAnimationFrame(tick);
    }
  }

  function stop() {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = lastTime = null;
  }

  function tick(now) {
    frame = null;
    if (!g || destroyed || document.hidden || reducedMotion || !inViewport) return;
    advance(lastTime === null ? 0 : Math.min(0.05, (now - lastTime) / 1000));
    lastTime = now;
    draw();
    start();
  }

  function resize() {
    const width = stage.clientWidth;
    const height = stage.clientHeight;
    const density = Math.min(window.devicePixelRatio || 1, 2);
    if (!width || !height) {
      release();
      g = null;
      stop();
      return;
    }
    if (g?.width === width && g.height === height && dpr === density) return;
    dpr = density;
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    g = makeLayout(ctx, width, height);
    handleSize = Math.max(36, (g.dot + 6) * 2);
    handle.style.width = handle.style.height = `${handleSize}px`;
    draw();
    start();
  }

  function track(event) {
    const rect = canvas.getBoundingClientRect();
    const x = (event.clientX - rect.left) * g.width / rect.width;
    const y = (event.clientY - rect.top) * g.height / rect.height;
    aim.x = x / g.cx - 1;
    aim.y = y / g.cy - 1;
    hovering = true;
    return { x, y };
  }

  function release(keepHover = false) {
    const id = press?.id;
    press = null;
    hovering = keepHover;
    handle.style.cursor = "grab";
    if (id != null && handle.hasPointerCapture(id)) handle.releasePointerCapture(id);
  }

  stage.addEventListener("pointermove", event => {
    if (!g || reducedMotion || !event.isPrimary || (press && press.id !== event.pointerId)) return;
    const point = track(event);
    if (press && Math.hypot(point.x - press.x, point.y - press.y) > 8) press.moved = true;
  }, listen);
  stage.addEventListener("pointerleave", event => {
    if (event.isPrimary && !press?.drag) release();
  }, listen);
  stage.addEventListener("pointerdown", event => {
    if (!g || reducedMotion || !event.isPrimary || event.button !== 0 || press) return;
    const { x, y } = track(event);
    const offsetX = x - g.anchorX - focus.x * g.sx;
    const offsetY = y - g.cy - focus.y * g.size;
    const drag = event.target === handle || Math.hypot(offsetX, offsetY) <= handleSize / 2;
    press = { id: event.pointerId, drag, x, y, offsetX, offsetY, moved: false };
    if (drag) {
      handle.setPointerCapture(event.pointerId);
      handle.style.cursor = "grabbing";
    }
  }, listen);
  stage.addEventListener("pointerup", event => {
    if (!g || press?.id !== event.pointerId) return;
    const { x, y } = track(event);
    const keepHover = event.pointerType !== "touch" && !press.drag;
    if (press.drag) {
      pulseDisc(2);
    } else if (!press.moved && Math.hypot(x - press.x, y - press.y) <= 8) {
      emit(x, y, false, 3);
      phase = 0;
      boost = 1;
    }
    release(keepHover);
  }, listen);
  stage.addEventListener("pointercancel", event => {
    if (event.isPrimary && (!press || press.id === event.pointerId)) release();
  }, listen);
  handle.addEventListener("lostpointercapture", event => {
    if (press?.id === event.pointerId) release();
  }, listen);
  handle.addEventListener("click", event => {
    // Native button activation from the keyboard or assistive technology.
    if (event.detail === 0 && g && !reducedMotion) {
      pulseDisc(2);
      phase = 0;
      boost = 1;
    }
  }, listen);

  function snapPalette() {
    const next = palette(probe);
    colors = next;
    colorsCurrentRgb = paletteRgb(next);
    colorsTargetRgb = paletteRgb(next);
    colorBlending = false;
  }

  function motionChange(event) {
    reducedMotion = event.matches;
    stop();
    release();
    Object.assign(pointer, spring());
    Object.assign(focus, spring());
    waves.length = 0;
    time = phase = lap = boost = presence = 0;
    snapPalette();
    handle.hidden = reducedMotion;
    draw();
    start();
  }

  function themeChange() {
    const next = palette(probe);
    const inViewTransition = document.documentElement.dataset.vtMode === "theme-switch";
    if (reducedMotion || document.hidden || inViewTransition || !inViewport) {
      colors = next;
      colorsCurrentRgb = paletteRgb(next);
      colorsTargetRgb = paletteRgb(next);
      colorBlending = false;
      draw();
      return;
    }
    colorsTargetRgb = paletteRgb(next);
    colorBlending = true;
    start();
  }

  const theme = new MutationObserver(themeChange);
  const meta = document.querySelector('meta[name="color-scheme"]');
  if (meta) theme.observe(meta, { attributes: true, attributeFilter: ["content"] });
  osTheme.addEventListener("change", themeChange, listen);
  motionPreference.addEventListener("change", motionChange, listen);
  document.addEventListener("visibilitychange", () => {
    stop();
    release();
    if (!document.hidden) {
      snapPalette();
      draw();
      start();
    }
  }, listen);
  window.addEventListener("resize", resize, listen);
  function watchDensity() {
    const query = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    query.addEventListener("change", () => { resize(); watchDensity(); }, { ...listen, once: true });
  }
  watchDensity();
  const observer = new ResizeObserver(resize);
  observer.observe(hostEl);
  observer.observe(stage);

  let viewportObserver = null;
  if ("IntersectionObserver" in window) {
    viewportObserver = new IntersectionObserver(
      ([entry]) => {
        const nextVisible = Boolean(entry?.isIntersecting);
        if (nextVisible === inViewport) return;
        inViewport = nextVisible;
        if (!inViewport) {
          stop();
        } else {
          lastTime = null;
          snapPalette();
          draw();
          start();
        }
      },
      { rootMargin: "120px 0px", threshold: 0 }
    );
    viewportObserver.observe(hostEl);
  }

  handle.hidden = reducedMotion;
  hostEl.dataset.modelReady = "true";
  resize();

  /* Hand off seamlessly from print plate to Canvas after first frame & any active reveal VT */
  const revealCanvas = () => {
    if (destroyed) return;
    snapPalette();
    draw();
    window.requestAnimationFrame(() => {
      if (!destroyed) {
        hostEl.dataset.canvasLive = "true";
        start();
      }
    });
  };

  const activeReveal = window.__tiRevealTransition;
  if (activeReveal?.finished) {
    activeReveal.finished.catch(() => {}).finally(revealCanvas);
  } else {
    revealCanvas();
  }

  const model = {
    destroy() {
      if (destroyed) return;
      destroyed = true;
      stop();
      release();
      events.abort();
      theme.disconnect();
      observer.disconnect();
      viewportObserver?.disconnect();
      stage.remove();
      probe.remove();
      if (originalReady === null) hostEl.removeAttribute("data-model-ready");
      else hostEl.setAttribute("data-model-ready", originalReady);
      if (originalCanvasLive === null) hostEl.removeAttribute("data-canvas-live");
      else hostEl.setAttribute("data-canvas-live", originalCanvasLive);
      mounts.delete(hostEl);
    },
  };
  mounts.set(hostEl, model);
  return model;
}

function mountCovers() {
  document.querySelectorAll("[data-cover-model]").forEach(mountCoverModel);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", mountCovers, { once: true });
} else {
  mountCovers();
}
