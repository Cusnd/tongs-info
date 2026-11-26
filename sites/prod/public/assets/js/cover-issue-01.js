// Issue 01. Coordinates are registration points on the original 1376 × 768 print.
const PRINT = { w: 1376, h: 768 };
const MERIDIAN = 688;
const COMPASS = { x: 1008, y: 386, r: 320 };
const FREE = { x: 1154, y: 254, r: 22 };
const POCKET = { x: 204, y: 303, r: 10, halfW: 61, halfH: 15 };
const PI = Math.PI;
const TAU = 2 * PI;
const DEG = PI / 180;
const mounts = new WeakMap();
const mix = (a, b, t) => a + (b - a) * t;
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const unit = n => clamp(n, 0, 1);
const blend = (a, b, t) => a.map((v, i) => mix(v, b[i], t));

const COPY = {
  en: {
    group: "Cover composition", names: ["Unbound", "Framed"],
    cue: "Click to ripple · Drag vermilion disc",
    labels: ["Unbound. Black louvers fan into cobalt planes. A vermilion disc floats inside the compass circle.",
      "Framed. The louvers are closed. The vermilion disc rests inside six nested frames."],
    actions: ["Send a ripple from the vermilion disc", "Release the vermilion disc from its frame"],
    pulse: "Ripple sent from the disc.",
  },
  zh: {
    group: "封面构图", names: ["舒展", "框定"], cue: "点击释放波纹 · 拖拽朱红圆点",
    labels: ["舒展。墨色栅片向钴蓝平面扇形展开，朱红圆点悬浮在右侧的定位圆内。",
      "框定。栅片合拢，朱红圆点落入左侧六重矩形线框的中心。"],
    actions: ["从朱红圆点释放波纹", "将朱红圆点从线框中释放"], pulse: "波纹已从圆点散开。",
  },
};

function palette(probe) {
  const rgb = {};
  for (const [key, token] of Object.entries({
    paper: "cover-paper", subtle: "bg-subtle", ink: "ink-primary", secondary: "ink-secondary",
    rule: "rule", accent: "accent", signal: "signal",
  })) {
    probe.style.color = "var(--" + token + ")";
    rgb[key] = getComputedStyle(probe).color.match(/[\d.]+/g).slice(0, 3).map(Number);
  }
  const dark = (rgb.paper[0] * .213 + rgb.paper[1] * .715 + rgb.paper[2] * .072) < 89;
  rgb.mass = dark ? blend(rgb.subtle, rgb.secondary, .065) : rgb.ink;
  rgb.slat = dark ? blend(rgb.subtle, rgb.secondary, .21) : rgb.ink;
  rgb.edge = dark ? blend(rgb.slat, rgb.secondary, .52) : rgb.ink;
  rgb.frame = dark ? blend(rgb.secondary, rgb.ink, .21) : rgb.ink;
  rgb.graphite = dark ? 1 : 0;
  return rgb;
}

function inks(from, to = from, t = 1) {
  const result = { graphite: mix(from.graphite, to.graphite, t) };
  for (const key of Object.keys(to)) {
    if (key === "graphite") continue;
    const rgb = blend(from[key], to[key], t);
    result[key] = "rgb(" + rgb.map(Math.round).join(",") + ")";
  }
  return result;
}

function line(path, x, y, endX, endY) {
  path.moveTo(x, y);
  path.lineTo(endX, endY);
}

function stroke(ctx, path, color, width, alpha = 1) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.globalAlpha = alpha;
  ctx.stroke(path);
  ctx.globalAlpha = 1;
}

function fill(ctx, path, color, alpha = 1) {
  ctx.fillStyle = color;
  ctx.globalAlpha = alpha;
  ctx.fill(path);
  ctx.globalAlpha = 1;
}

function ring(x, y, r) {
  const path = new Path2D();
  path.arc(x, y, r, 0, TAU);
  return path;
}

function makeCage() {
  const p = new Path2D();
  p.rect(66, 66, 275, 175);
  for (let i = 0; i < 6; i++) p.rect(346 + i * 36, 66, 28, i < 2 ? 175 : 146);
  for (const [y, height] of [[245, 137], [386, 136], [526, 42], [573, 24], [602, 103]]) {
    p.rect(346, y, 72, height);
  }
  // Seven bays, five courses. The last bay registers to the sub-column below.
  for (let row = 0; row < 5; row++) {
    for (let col = 0; col < 7; col++) p.rect(66 + col * 40, 386 + row * 28, 36, 24);
  }
  p.rect(66, 526, 82, 179);
  for (let i = 0; i < 5; i++) p.rect(152 + i * 29, 526, 25, 179);
  for (const [y, height] of [[526, 42], [573, 24], [602, 103]]) p.rect(297, y, 44, height);
  return p;
}
const cage = makeCage();

// Left pivot, midline height, open length and inclination. In the closed
// edition every blade returns to the same jamb and equal vertical pitch.
const BLADES = [
  [418, 229, 160, 0], [422, 259, 152, 0], [422, 298, 167, -6],
  [422, 336, 194, -9], [422, 374, 205, -11], [422, 412, 220, -13],
  [422, 450, 233, -14], [422, 475, 135, -9], [422, 503, 113, -7],
  [486, 530, 174, -34], [504, 556, 170, -37], [523, 582, 171, -39],
  [543, 605, 153, -41], [422, 612, 174, -2], [562, 629, 132, -42],
  [422, 639, 191, -1], [584, 648, 99, -44],
  [422, 667, 226, 0], [422, 695, 226, 0],
];

function makeField(ctx, w, h, ox, oy, scale) {
  const pitch = Math.max(29, 96 * scale);
  const startX = (ox + MERIDIAN * scale) % pitch;
  const startY = (oy + COMPASS.y * scale) % pitch;
  const grid = new Path2D(), marks = new Path2D(), crosses = [];
  for (let x = startX; x < w; x += pitch) {
    line(grid, x, 0, x, h);
    for (let y = startY; y < h; y += pitch) {
      line(marks, x - 2, y, x + 2, y);
      line(marks, x, y - 2, x, y + 2);
      crosses.push({ x, y });
    }
  }
  for (let y = startY; y < h; y += pitch) line(grid, 0, y, w, y);
  const fades = [ctx.createLinearGradient(0, 0, w, 0), ctx.createLinearGradient(0, 0, 0, h)];
  for (const fade of fades) {
    fade.addColorStop(0, "#000"); fade.addColorStop(.12, "transparent");
    fade.addColorStop(.88, "transparent"); fade.addColorStop(1, "#000");
  }
  return { w, h, ox, oy, scale, grid, marks, crosses, fades };
}

function drawField(ctx, g, c, pointer, waves) {
  stroke(ctx, g.grid, c.rule, .7, .58);
  stroke(ctx, g.marks, c.secondary, .65, .18);
  const sx = x => g.ox + x * g.scale, sy = y => g.oy + y * g.scale;
  const fronts = waves.map(w => ({ x: sx(w.x), y: sy(w.y),
    r: w.age * Math.max(160, 580 * g.scale), power: (1 - w.age / 1.45) * w.strength }));
  for (const w of fronts) {
    stroke(ctx, ring(w.x, w.y, w.r), c.accent, .85, .55 * w.power);
    if (w.r > 7) stroke(ctx, ring(w.x, w.y, w.r - 7), c.secondary, .6, .28 * w.power);
  }
  if (pointer || fronts.length) {
    for (const { x, y } of g.crosses) {
      let light = pointer ? unit(1 - Math.hypot(x - sx(pointer.x), y - sy(pointer.y)) / 78) : 0;
      for (const w of fronts) {
        const gap = Math.abs(Math.hypot(x - w.x, y - w.y) - w.r);
        light = Math.max(light, w.power * unit(1 - gap / 21));
      }
      if (light < .04) continue;
      const cross = new Path2D(), size = 2 + 2.5 * light;
      line(cross, x - size, y, x + size, y); line(cross, x, y - size, x, y + size);
      stroke(ctx, cross, c.accent, .85, .6 * light);
    }
  }
  ctx.save();
  ctx.globalCompositeOperation = "destination-out";
  ctx.fillStyle = g.fades[0];
  ctx.fillRect(0, 0, g.w * .12, g.h);
  ctx.fillRect(g.w * .88, 0, g.w * .12, g.h);
  ctx.fillStyle = g.fades[1];
  ctx.fillRect(0, 0, g.w, g.h * .12);
  ctx.fillRect(0, g.h * .88, g.w, g.h * .12);
  ctx.restore();
}

function drawCage(ctx, c, s, pixel) {
  fill(ctx, cage, c.mass);
  if (c.graphite > .001) stroke(ctx, cage, c.edge, pixel * .85, .82 * c.graphite);
  ctx.fillStyle = c.paper;
  ctx.fillRect(67, 241, 274, 144);
  for (let i = 0; i < 6; i++) {
    const depth = i / 5;
    const flex = Math.sin(s.time * .72) * .7 + s.rattle * (i % 2 ? -2.1 : 2.1);
    const dx = depth * (s.lookX * 2.7 + flex) * (1 - s.fold);
    const dy = depth * s.lookY * 1.8 * (1 - s.fold);
    const x = mix(70, POCKET.x - POCKET.halfW, depth) + dx;
    const y = mix(243, POCKET.y - POCKET.halfH, depth) + dy;
    const w = mix(268, POCKET.halfW * 2, depth), h = mix(140, POCKET.halfH * 2, depth);
    const path = new Path2D();
    const tremor = s.rattle * Math.sin(depth * 4 + s.time * 19) * 2;
    path.rect(x - tremor, y - tremor, w + 2 * tremor, h + 2 * tremor);
    stroke(ctx, path, c.frame, Math.max(.76 * pixel, 2.5));
  }
  if (s.wall) {
    const p = new Path2D(), { x, y, halfW: w, halfH: h } = POCKET;
    if (s.wall === "left" || s.wall === "right") {
      const edge = x + (s.wall === "left" ? -w : w);
      line(p, edge, y - h, edge, y + h);
    } else {
      const edge = y + (s.wall === "top" ? -h : h);
      line(p, x - w, edge, x + w, edge);
    }
    stroke(ctx, p, c.signal, 1.65 * pixel, .95);
  }
}

function drawBlades(ctx, c, s, pixel) {
  // The short root of each lifted blade remains in its mortise.
  const roots = new Path2D(), blades = new Path2D();
  s.blades.forEach((b, i) => {
    const [x, y, length] = BLADES[i];
    const closedY = mix(229, 695, i / (BLADES.length - 1));
    const px = mix(x, 422, s.fold) + b.shift, py = mix(y, closedY, s.fold);
    // The three lowest diagonals share the returning horizontal blades as roots.
    if (x > 422 && y < 600) roots.rect(422, py - 9, (x - 420) * (1 - s.fold), 18);
    const a = b.angle * DEG, cos = Math.cos(a), sin = Math.sin(a);
    const l = mix(length, 154, s.fold), half = i === 0 ? 11 : 10;
    blades.moveTo(px + sin * half, py - cos * half);
    blades.lineTo(px + l * cos + sin * half, py + l * sin - cos * half);
    blades.lineTo(px + l * cos - sin * half, py + l * sin + cos * half);
    blades.lineTo(px - sin * half, py + cos * half);
    blades.closePath();
  });
  fill(ctx, roots, c.mass); fill(ctx, blades, c.slat);
  if (c.graphite > .001) stroke(ctx, blades, c.edge, .82 * pixel, c.graphite);
}

function drawCompass(ctx, c, s, pixel) {
  const { x, y, r } = COMPASS;
  const quiet = 1 - .48 * s.fold;
  stroke(ctx, ring(x, y, r), c.secondary, .8 * pixel, .52 * quiet);
  const axes = new Path2D(), ticks = new Path2D();
  line(axes, x, y - r - 22, x, y + r + 22);
  line(axes, MERIDIAN, y, x + r + 20, y);
  stroke(ctx, axes, c.secondary, .72 * pixel, .43 * quiet);
  for (let i = 0; i < 48; i++) {
    const a = i * TAU / 48 + .007 * Math.sin(s.time * .23);
    const length = i % 12 === 0 ? 7 : 3;
    line(ticks, x + (r - length) * Math.cos(a), y + (r - length) * Math.sin(a),
      x + r * Math.cos(a), y + r * Math.sin(a));
  }
  stroke(ctx, ticks, c.secondary, .66 * pixel, .36 * quiet);
}

function drawPlanes(ctx, c, s) {
  const open = 1 - s.fold;
  const dx = s.leanX * open, dy = s.leanY * open;
  const angle = open * (-45 + Math.sin(s.time * .48) * .9 + dx * 3 + s.rattle);
  // Lay down a transparent ink pass, then a thin cobalt wash over the graphite.
  function plane(path, opacity) {
    ctx.save();
    ctx.globalCompositeOperation = "multiply";
    fill(ctx, path, c.accent, opacity * (1 - c.graphite));
    ctx.globalCompositeOperation = "source-over";
    fill(ctx, path, c.accent, mix(opacity * .33, opacity * .88, c.graphite));
    ctx.restore();
  }
  function plate(x, y, w, h, a, alpha) {
    ctx.save(); ctx.translate(x, y); ctx.rotate(a * DEG);
    const p = new Path2D(); p.rect(-w / 2, -h / 2, w, h);
    plane(p, alpha); ctx.restore();
  }
  // The solid-looking upper square shares a cut edge with the climbing ribbon.
  const square = new Path2D();
  const x = mix(631, 584, s.fold) + dx * 3, y = mix(242, 245, s.fold) + dy * 2;
  const side = mix(142, 102, s.fold);
  square.moveTo(x, y); square.lineTo(x + mix(198, side, s.fold), y);
  square.lineTo(x + mix(57, side, s.fold), y + side); square.lineTo(x, y + side); square.closePath();
  plane(square, .78);
  plate(mix(741, 635, s.fold) + dx * 5, mix(295, 363, s.fold) + dy * 3,
    mix(202, 102, s.fold), mix(50, 24, s.fold), angle, .52);
  const cx = mix(652, 635, s.fold) + dx * 8, cy = mix(511, 470, s.fold) + dy * 4;
  const width = mix(288, 102, s.fold), height = mix(136, 164, s.fold);
  plate(cx + 39 * open + dx * 3, cy + 39 * open - dy * 3, width, height,
    angle - open * 1.7 * Math.sin(s.time * .48), .42);
  plate(cx, cy, width - s.tension * 13, height, angle, .66);
  plate(mix(724, 635, s.fold) + dx * 2, mix(642.5, 630, s.fold),
    mix(210, 102, s.fold), mix(125, 150, s.fold), 0, .78);
}

// A sub-curve of the same cubic for both the retracting stroke and its moving glint.
function arcSegment(points, start, end) {
  function sample(t) {
    const a = 1 - t;
    return [0, 1].map(k => {
      const [p, q, r, s] = points.map(v => v[k]);
      return { v: a**3*p + 3*a*a*t*q + 3*a*t*t*r + t**3*s,
        tangent: a*a*(q-p) + 2*a*t*(r-q) + t*t*(s-r) };
    });
  }
  const [ax, ay] = sample(start), [bx, by] = sample(end), span = end - start;
  const p = new Path2D();
  p.moveTo(ax.v, ay.v);
  p.bezierCurveTo(ax.v + span * ax.tangent, ay.v + span * ay.tangent,
    bx.v - span * bx.tangent, by.v - span * by.tangent, bx.v, by.v);
  return p;
}

function drawArc(ctx, c, s) {
  const end = 1 - s.fold;
  if (end < .002) return;
  const north = COMPASS.y - COMPASS.r;
  const points = [[631, 454], [840 + s.leanX * 30, 454],
    [COMPASS.x, 281 + s.leanY * 42], [COMPASS.x, north]];
  stroke(ctx, arcSegment(points, 0, end), c.accent, 12, .96);
  for (const { age } of s.pulses) {
    const t = (age - .22) / .88, lo = Math.max(0, t - .09), hi = Math.min(end, t);
    if (hi > lo) stroke(ctx, arcSegment(points, lo, hi), c.paper, 3.8, .78);
  }
}

function controls(copy) {
  const hud = document.createElement("div");
  hud.className = "cover-hud-frame";
  hud.innerHTML = '<div class="cover-surface-switch" role="group">' +
    '<button type="button" class="cover-surface-btn" data-cover-face="unbound"><span class="cover-surface-idx" aria-hidden="true">01</span><span></span></button>' +
    '<span class="cover-surface-sep" aria-hidden="true">/</span>' +
    '<button type="button" class="cover-surface-btn" data-cover-face="framed"><span class="cover-surface-idx" aria-hidden="true">02</span><span></span></button>' +
    '</div><span class="cover-stage-cue" aria-hidden="true"></span>';
  hud.firstElementChild.setAttribute("aria-label", copy.group);
  hud.lastElementChild.textContent = copy.cue;
  const buttons = [...hud.querySelectorAll("button")];
  buttons.forEach((btn, i) => { btn.lastElementChild.textContent = copy.names[i]; });
  return { hud, buttons };
}

export function mountCoverModel(hostEl) {
  if (mounts.has(hostEl)) return mounts.get(hostEl);
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return { destroy() {} };

  const originalReady = hostEl.getAttribute("data-model-ready");
  const originalLive = hostEl.getAttribute("data-canvas-live");
  const fallback = hostEl.querySelector("img[data-cover-fallback]");
  const copy = document.documentElement.lang.startsWith("zh") ? COPY.zh : COPY.en;
  const { hud, buttons } = controls(copy);
  const stage = document.createElement("div");
  stage.setAttribute("data-cover-canvas-stage", "");
  stage.inert = true;
  canvas.setAttribute("role", "img");
  const handle = document.createElement("button");
  handle.type = "button";
  handle.className = "cover-disc-handle";
  const probe = document.createElement("span");
  probe.hidden = true;
  stage.append(canvas, handle, hud, probe);
  hostEl.append(stage);

  const events = new AbortController();
  const listen = { signal: events.signal };
  const preference = matchMedia("(prefers-reduced-motion: reduce)");
  let reduced = preference.matches;
  let live = false, revealFinished = false, destroyed = false, visible = false;
  let g, density, frame = 0, revealFrame = 0, lastTime = null;
  let targetPalette = palette(probe), fromPalette = targetPalette, paletteTime = 1;
  let colors = inks(targetPalette);
  let framed = false, flight = null, pointer = null, press = null;
  let announcement = null, stampTimer = 0, lastHandlePosition = "";
  let ambientAt = 5.6;
  const disc = { ...FREE, vx: 0, vy: 0 };
  const s = {
    time: 0, fold: 0, tension: 0, leanX: 0, leanY: 0, lookX: 0, lookY: 0,
    wall: null, stamp: null, rattle: 0, waves: [], pulses: [],
    blades: BLADES.map(([, , , angle]) => ({ angle, shift: 0, va: 0, vx: 0 })),
  };

  function announce(message) {
    const region = document.getElementById("live-announcer");
    if (!region) return;
    announcement = document.createTextNode(message);
    region.replaceChildren(announcement);
  }

  function labels() {
    const i = Number(framed);
    buttons.forEach((btn, index) => btn.setAttribute("aria-pressed", String(index === i)));
    canvas.setAttribute("aria-label", copy.labels[i]);
    handle.setAttribute("aria-label", copy.actions[i]);
  }

  function excite(x, y, strength = 1) {
    if (reduced) {
      // An instantaneous registration mark acknowledges input without animating.
      clearTimeout(stampTimer);
      s.stamp = { x, y };
      draw();
      stampTimer = setTimeout(() => { s.stamp = null; draw(); }, 380);
      return;
    }
    if (s.waves.length >= 8) s.waves.shift();
    if (s.pulses.length >= 6) s.pulses.shift();
    s.waves.push({ x, y, age: 0, strength });
    s.pulses.push({ age: 0, strength });
    ambientAt = s.time + 5.6;
  }

  function draw() {
    if (!g) return;
    ctx.setTransform(density, 0, 0, density, 0, 0);
    ctx.clearRect(0, 0, g.w, g.h);
    drawField(ctx, g, colors, reduced ? null : pointer, s.waves);
    ctx.save();
    ctx.translate(g.ox, g.oy);
    ctx.scale(g.scale, g.scale);
    const pixel = 1 / g.scale;
    drawCompass(ctx, colors, s, pixel);
    drawCage(ctx, colors, s, pixel);
    drawBlades(ctx, colors, s, pixel);
    drawPlanes(ctx, colors, s);
    drawArc(ctx, colors, s);
    const axis = new Path2D(), tick = new Path2D();
    line(axis, MERIDIAN, 48, MERIDIAN, 726);
    line(tick, MERIDIAN - 4, disc.y, MERIDIAN + 4, disc.y);
    stroke(ctx, axis, colors.frame, 1.08 * pixel, .96);
    stroke(ctx, tick, colors.signal, .85 * pixel, .28 + .45 * s.tension);
    if (s.tension > .008) {
      const tether = new Path2D();
      line(tether, disc.x, disc.y, FREE.x, FREE.y);
      stroke(ctx, tether, colors.signal, .7 * pixel, .46 * s.tension);
    }
    fill(ctx, ring(disc.x, disc.y, disc.r), colors.signal);
    if (s.stamp) stroke(ctx, ring(s.stamp.x, s.stamp.y, disc.r + 8 * pixel), colors.accent, pixel, .65);
    ctx.restore();
    const x = g.ox + disc.x * g.scale, y = g.oy + disc.y * g.scale;
    const position = "translate(" + x.toFixed(2) + "px," + y.toFixed(2) + "px) translate(-50%,-50%)";
    if (position !== lastHandlePosition) {
      lastHandlePosition = position;
      handle.style.transform = position;
    }
  }

  function resetPose() {
    flight = null;
    clearTimeout(stampTimer); s.stamp = null;
    const target = framed ? POCKET : FREE;
    Object.assign(disc, { x: target.x, y: target.y, r: target.r, vx: 0, vy: 0 });
    Object.assign(s, { fold: Number(framed), lookX: 0, lookY: 0, leanX: 0, leanY: 0,
      time: 0, tension: 0, rattle: 0, wall: null });
    s.waves.length = s.pulses.length = 0;
    ambientAt = 5.6;
    s.blades.forEach((b, i) => Object.assign(b, {
      angle: framed ? 0 : BLADES[i][3], shift: 0, va: 0, vx: 0,
    }));
  }

  function select(next) {
    if (framed === next) return;
    framed = next;
    labels();
    announce(copy.labels[Number(framed)]);
    s.wall = null;
    if (reduced) resetPose();
    else {
      flight = { elapsed: 0, fold: s.fold, x: disc.x, y: disc.y, carriesDisc: !(press?.drag && press.moved) };
      disc.vx = disc.vy = 0;
      excite(disc.x, disc.y);
    }
    draw();
  }

  function dragTarget(raw) {
    const x = raw.x, y = raw.y;
    if (framed) {
      const dx = x - POCKET.x, dy = y - POCKET.y;
      const w = POCKET.halfW - disc.r, h = POCKET.halfH - disc.r;
      s.wall = null;
      if (Math.abs(dx) > w || Math.abs(dy) > h) {
        s.wall = Math.abs(dx) - w > Math.abs(dy) - h
          ? (dx < 0 ? "left" : "right") : (dy < 0 ? "top" : "bottom");
      }
      return { x: POCKET.x + clamp(dx, -w, w), y: POCKET.y + clamp(dy, -h, h) };
    }
    const pull = unit((MERIDIAN - x) / (MERIDIAN - POCKET.x));
    // The tether stiffens across the meridian, then the nested pocket takes the weight.
    const nearBox = unit(1 - Math.hypot((x - POCKET.x) / 158, (y - POCKET.y) / 89));
    const resistedX = x + 94 * pull ** 1.6 * (1 - nearBox);
    return {
      x: clamp(mix(resistedX, POCKET.x, nearBox * .45), (12 - g.ox) / g.scale + disc.r, (g.w - 12 - g.ox) / g.scale - disc.r),
      y: clamp(y, (6 - g.oy) / g.scale + disc.r, (g.h - 6 - g.oy) / g.scale - disc.r),
    };
  }

  function updateDisc(dt) {
    const target = framed ? POCKET : FREE;
    const held = press?.drag && press.moved;
    if (flight) {
      flight.elapsed += dt;
      const progress = unit(flight.elapsed / .56);
      const t = 1 - (1 - progress) ** 3;
      s.fold = mix(flight.fold, Number(framed), t);
      if (flight.carriesDisc) {
        const lift = Math.min(110, Math.abs(flight.x - target.x) * .13);
        disc.x = mix(flight.x, target.x, t);
        disc.y = mix(flight.y, target.y, t) - Math.sin(t * PI) * lift;
      }
      if (progress === 1) {
        flight = null;
        if (framed) excite(POCKET.x, POCKET.y, .55);
      }
    }
    disc.r = held && framed ? POCKET.r : mix(FREE.r, POCKET.r, s.fold);
    if (held || !flight?.carriesDisc) {
      const aim = held ? dragTarget(press.raw) : target;
      if (held && framed) {
        disc.x = aim.x; disc.y = aim.y; disc.vx = disc.vy = 0;
      } else {
        const k = held ? 1000 : 155, damping = held ? 56 : 18;
        disc.vx += ((aim.x - disc.x) * k - damping * disc.vx) * dt;
        disc.vy += ((aim.y - disc.y) * k - damping * disc.vy) * dt;
        disc.x += disc.vx * dt; disc.y += disc.vy * dt;
      }
    }
  }

  function advance(dt) {
    s.time += dt;
    if (s.time >= ambientAt) {
      if (!framed) s.pulses.push({ age: 0, strength: .22 });
      ambientAt = s.time + 5.6;
    }
    for (const list of [s.pulses, s.waves]) {
      for (let i = list.length - 1; i >= 0; i--) {
        list[i].age += dt;
        if (list[i].age > 1.45) list.splice(i, 1);
      }
    }
    updateDisc(dt);
    const follow = 1 - Math.exp(-8 * dt);
    s.tension = mix(s.tension, !framed && press?.drag ? unit((MERIDIAN - disc.x) / 440) : 0, follow);
    s.lookX = mix(s.lookX, pointer ? clamp((pointer.x - POCKET.x) / 650, -1, 1) : 0, follow);
    s.lookY = mix(s.lookY, pointer ? clamp((pointer.y - POCKET.y) / 300, -1, 1) : 0, follow);
    s.leanX = mix(s.leanX, clamp((disc.x - mix(FREE.x, POCKET.x, s.fold)) / 370, -1, 1), follow);
    s.leanY = mix(s.leanY, clamp((disc.y - mix(FREE.y, POCKET.y, s.fold)) / 230, -1, 1), follow);
    s.rattle = 0;
    for (const p of s.pulses) s.rattle += p.strength * Math.exp(-4.5 * p.age) * Math.sin(p.age * 18);
    s.blades.forEach((b, i) => {
      const [, y, , rest] = BLADES[i];
      let kick = 0;
      for (const p of s.pulses) {
        const delay = p.age - i * .018;
        if (delay > 0) kick += p.strength * Math.exp(-7 * delay) * Math.sin(delay * 21);
      }
      const near = pointer ? unit(1 - Math.hypot((pointer.x - 540) / 240, (pointer.y - y) / 145)) : 0;
      const open = 1 - s.fold;
      const breath = Math.sin(s.time * .76 - i * .29) * .48;
      const angle = (rest + breath - near * 4 - s.tension * 8) * open - kick * mix(10, 2, s.fold);
      const shift = (near * 4 + s.tension * 11) * open + kick * 9;
      b.va += ((angle - b.angle) * 530 - 39 * b.va) * dt;
      b.vx += ((shift - b.shift) * 385 - 29 * b.vx) * dt;
      b.angle += b.va * dt; b.shift += b.vx * dt;
    });
  }

  function start() {
    if (live && !frame && g && visible && !destroyed && !document.hidden && !reduced) {
      frame = requestAnimationFrame(tick);
    }
  }
  function stop() {
    cancelAnimationFrame(frame);
    frame = 0; lastTime = null;
  }
  function tick(now) {
    frame = 0;
    const dt = lastTime === null ? 0 : clamp((now - lastTime) / 1000, 0, .05);
    lastTime = now;
    // Short physics steps keep the stiff springs stable on slow screens.
    const steps = Math.ceil(dt * 120);
    for (let i = 0; i < steps; i++) advance(dt / steps);
    if (paletteTime < 1) {
      paletteTime = unit(paletteTime + dt / .25);
      colors = inks(fromPalette, targetPalette, paletteTime);
    }
    draw();
    start();
  }

  function refreshPalette(instant = false) {
    // Restart an interrupted system-theme fade at its actual displayed color.
    const previous = {};
    for (const key of Object.keys(targetPalette)) {
      previous[key] = key === "graphite" ? colors.graphite : blend(fromPalette[key], targetPalette[key], paletteTime);
    }
    fromPalette = previous;
    targetPalette = palette(probe);
    paletteTime = instant || reduced || !visible || !live || document.hidden ||
      document.documentElement.dataset.vtMode === "theme-switch" ? 1 : 0;
    colors = inks(fromPalette, targetPalette, paletteTime);
    draw();
    start();
  }

  function resize() {
    const w = stage.clientWidth, h = stage.clientHeight;
    if (!w || !h) { g = null; stop(); return; }
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    // CSS sizes and centers the print, including its mobile HUD margin. Read its
    // actual content box so the canvas and each shared-element snapshot register.
    const box = fallback?.getBoundingClientRect(), rect = stage.getBoundingClientRect();
    const bw = box?.width || w, bh = box?.height || h;
    const scale = Math.min(bw / PRINT.w, bh / PRINT.h);
    const ox = (box ? box.left - rect.left : 0) + (bw - PRINT.w * scale) / 2;
    const oy = (box ? box.top - rect.top : 0) + (bh - PRINT.h * scale) / 2;
    if (g?.w === w && g.h === h && g.ox === ox && g.oy === oy && g.scale === scale && density === dpr) return;
    density = dpr;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    g = makeField(ctx, w, h, ox, oy, scale);
    handle.style.width = handle.style.height = Math.max(36, FREE.r * scale * 2 + 8) + "px";
    draw();
    if (revealFinished && !live) makeLive();
    start();
  }

  function point(event) {
    const rect = canvas.getBoundingClientRect();
    return { x: (event.clientX - rect.left - g.ox) / g.scale,
      y: (event.clientY - rect.top - g.oy) / g.scale };
  }

  function release() {
    const held = press;
    press = pointer = s.wall = null;
    if (held?.surface.hasPointerCapture(held.id)) held.surface.releasePointerCapture(held.id);
  }

  function activateDisc() {
    if (framed) select(false);
    else {
      excite(disc.x, disc.y);
      announce(copy.pulse);
    }
  }

  function trackDrag(event) {
    pointer = point(event);
    if (!press) return;
    press.moved ||= Math.hypot(event.clientX - press.startX, event.clientY - press.startY) > 5;
    if (!press.drag || !press.moved) return;
    if (flight) flight.carriesDisc = false;
    press.raw = { x: pointer.x - press.dx, y: pointer.y - press.dy };
    if (framed && press.raw.x > MERIDIAN + 4) select(false);
    if (reduced) {
      Object.assign(disc, dragTarget(press.raw));
      draw();
    }
  }

  for (const surface of [canvas, handle]) {
    surface.addEventListener("pointerdown", event => {
      if (!g || !event.isPrimary || event.button !== 0 || press) return;
      pointer = point(event);
      press = { id: event.pointerId, surface, drag: surface === handle, moved: false,
        startX: event.clientX, startY: event.clientY, dx: pointer.x - disc.x, dy: pointer.y - disc.y };
      surface.setPointerCapture(event.pointerId);
    }, listen);
    surface.addEventListener("pointermove", event => {
      if (g && event.isPrimary && (!press || press.id === event.pointerId)) trackDrag(event);
    }, listen);
    surface.addEventListener("pointerleave", () => { if (!press) pointer = null; }, listen);
    surface.addEventListener("pointerup", event => {
      if (!g || !event.isPrimary || press?.id !== event.pointerId || event.button !== 0) return;
      trackDrag(event);
      const { drag, moved, raw } = press, at = pointer;
      release();
      if (reduced && drag && moved) { resetPose(); draw(); }
      if (!drag && !moved) excite(at.x, at.y);
      if (drag && !moved) activateDisc();
      if (drag && moved) {
        if (!framed && raw.x >= 70 && raw.x <= 338 && raw.y >= 243 && raw.y <= 383) select(true);
        else excite(disc.x, disc.y);
      }
    }, listen);
    const cancel = event => {
      if (press?.id !== event.pointerId) return;
      release();
      if (reduced) { resetPose(); draw(); }
    };
    surface.addEventListener("lostpointercapture", cancel, listen);
    surface.addEventListener("pointercancel", cancel, listen);
  }
  // Pointer taps are handled on release. Native keyboard/AT clicks have detail zero.
  handle.addEventListener("click", e => { if (e.detail === 0) activateDisc(); }, listen);
  buttons.forEach((btn, i) => btn.addEventListener("click", () => select(i === 1), listen));
  hud.addEventListener("keydown", event => {
    if (!["ArrowLeft", "ArrowRight"].includes(event.key) || !buttons.includes(event.target)) return;
    event.preventDefault();
    const next = event.target === buttons[0];
    buttons[Number(next)].focus();
    select(next);
  }, listen);

  preference.addEventListener("change", event => {
    reduced = event.matches; stop(); release(); resetPose(); refreshPalette(true);
  }, listen);
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => refreshPalette(), listen);
  const theme = new MutationObserver(() => refreshPalette());
  const meta = document.querySelector('meta[name="color-scheme"]');
  if (meta) theme.observe(meta, { attributes: true, attributeFilter: ["content"] });
  const sizeObserver = new ResizeObserver(resize);
  for (const el of [hostEl, stage, fallback]) if (el) sizeObserver.observe(el);
  window.addEventListener("resize", resize, listen);
  function watchDensity() {
    matchMedia("(resolution: " + (window.devicePixelRatio || 1) + "dppx)").addEventListener("change", () => {
      resize(); watchDensity();
    }, { ...listen, once: true });
  }
  watchDensity();
  function suspend() {
    stop();
    release();
    if (reduced) { resetPose(); draw(); }
  }
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) suspend();
    else refreshPalette(true);
  }, listen);
  const viewport = new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    if (visible) refreshPalette(true);
    else suspend();
  }, { rootMargin: "120px 0px" });
  viewport.observe(hostEl);

  labels();
  hostEl.dataset.modelReady = "true";
  resize();
  // pagereveal precedes the first rendering opportunity. Check the incoming
  // transition here as well as at mount so a deferred module cannot race it.
  function reveal() {
    if (destroyed) return;
    const transition = window.__tiRevealTransition;
    if (transition?.finished) {
      transition.finished.then(makeLive, makeLive);
    } else makeLive();
  }
  function makeLive() {
    revealFinished = true;
    if (!g || destroyed) return;
    refreshPalette(true);
    live = true;
    hostEl.dataset.canvasLive = "true";
    stage.inert = false;
    start();
  }
  if (window.__tiRevealTransition?.finished) reveal();
  else revealFrame = requestAnimationFrame(reveal);

  const model = {
    destroy() {
      if (destroyed) return;
      destroyed = true;
      stop(); cancelAnimationFrame(revealFrame); clearTimeout(stampTimer);
      release(); events.abort();
      sizeObserver.disconnect(); viewport.disconnect(); theme.disconnect();
      stage.remove(); announcement?.remove();
      for (const [attr, value] of [["data-model-ready", originalReady], ["data-canvas-live", originalLive]]) {
        if (value === null) hostEl.removeAttribute(attr);
        else hostEl.setAttribute(attr, value);
      }
      mounts.delete(hostEl);
    },
  };
  mounts.set(hostEl, model);
  return model;
}

document.querySelectorAll('[data-cover-model="issue-01"]').forEach(mountCoverModel);
