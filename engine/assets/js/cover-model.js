/* The two faces share one plate, one dispatch gate, and the same in-flight signals. */

const mounts = new WeakMap();
const PI = Math.PI;
const TAU = 2 * PI;
const ARRIVAL = 0.62;
const LANES = [-1, 0, 1];
const MAX_PULSES = 28;
const MAX_WAVES = 14;
const FLIP_SECONDS = 0.46;
const ROUTES = ["/llms.txt", "./index.md", "/api/graph.json"];
const FORMATS = ["utf-8", "text/markdown", "application/json"];
const BADGES = ["LLMS", "MD", "JSON"];
const SPECIMEN = ["---", "surface: agent-twin", "signal:  94% · 0% chrome", "links:   llms.txt | index.md", "---"];
const COPY = {
  en: {
    group: "Switch cover perspective", human: "Human", agent: "Agent",
    cue: "Click to pulse · Drag focal disc", handle: "Fire a pulse along all three lanes",
    humanFolio: "RECTO · HUMAN · index.html", agentFolio: "VERSO · AGENT · index.md",
    humanLabel: "Human face. Optical rings and a folded prism guide light through a vermilion disc to breath, type, and craft.",
    agentLabel: "Agent face. Discovery orbits feed a Markdown syntax tree. The vermilion gate dispatches packets to llms.txt, index.md, and the graph API.",
    axis: "VISUAL FIELD · GRID & BREATH", waypoints: ["01 BREATH", "02 TYPE", "03 CRAFT"],
  },
  zh: {
    group: "切换封面视角", human: "人类", agent: "Agent",
    cue: "点击连发脉冲 · 拖拽朱红焦点", handle: "从朱红焦点向三条轨道同时发射脉冲",
    humanFolio: "RECTO · 人类 · index.html", agentFolio: "VERSO · AGENT · index.md",
    humanLabel: "人类面封面。光穿过圆环、折叠棱面与朱红焦点，沿三条轨道照亮留白、排印与交互。",
    agentLabel: "Agent 面封面。发现端点接入 Markdown 语法树，数据包经朱红节点发往 llms.txt、index.md 和图谱 API。",
    axis: "视觉感知 · 网格与留白", waypoints: ["01 留白", "02 排印", "03 交互"],
  },
};

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const mix = (a, b, t) => a + (b - a) * t;

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

// Plate coordinates are fractions of the print height. Full orbits have two
// closed contours, so stroking the wire edition never draws a radial seam.
function optic(x, y, rx, ry, t, ink, start = 0, end = -TAU) {
  const path = new Path2D();
  if (end - start === -TAU) {
    path.ellipse(0, 0, rx, ry, 0, 0, TAU);
    path.closePath();
    path.moveTo(rx - t, 0);
    path.ellipse(0, 0, rx - t, ry - t, 0, 0, -TAU, true);
  } else {
    path.ellipse(0, 0, rx, ry, 0, start, end, true);
    path.ellipse(0, 0, rx - t, ry - t, 0, end, start);
  }
  path.closePath();
  const orbit = new Path2D();
  orbit.ellipse(0, 0, rx - t / 2, ry - t / 2, 0, start, end, true);
  const ticks = new Path2D();
  for (let i = 0; i < 72; i++) {
    const a = i * TAU / 72;
    const mark = i % 3 === 0 ? t * 0.36 : t * 0.17;
    line(ticks, (rx - mark) * Math.cos(a), (ry - mark) * Math.sin(a), rx * Math.cos(a), ry * Math.sin(a));
  }
  return { x, y, rx, ry, t, ink, path, orbit, ticks };
}

function makeOptics() {
  const rear = -0.445;
  return {
    rearOuter: optic(rear, 0, 0.479, 0.500, 0.055, "accent", -0.82, 0.35),
    rearInner: optic(rear, 0, 0.269, 0.283, 0.055, "accent"),
    frontOuter: optic(0, 0, 0.536, 0.500, 0.055, "accent", -1.20, -2.85),
    rearMiddle: optic(rear, 0, 0.374, 0.391, 0.055, "ink"),
    frontMiddle: optic(0, -0.010, 0.520, 0.420, 0.064, "ink", -1.20, 1.20),
    frontInner: optic(0, -0.010, 0.386, 0.311, 0.057, "accent", -1.20, 1.20),
  };
}

function makeLayout(ctx, width, height, margin, mono) {
  const cx = width / 2;
  const cy = height * (height < 280 ? 0.44 : 0.50);
  ctx.save();
  ctx.font = `10px ${mono}`;
  const legendWidth = ctx.measureText("/api/graph.json").width;
  ctx.restore();
  const legendLimit = width >= 760 ? (cx - margin - legendWidth - 14) / 0.97 : width;
  const size = Math.max(1, Math.min(height * 0.78, width * 0.46, legendLimit, 2 * (cy - 24), 2 * (height - 48 - cy)));
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
  const rows = Math.ceil(Math.max(cy, height - cy) / step);

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
    margin, portX: width - margin, compact: width < 680 || height < 260,
    folioY: height < 280 ? 18 : 26, mono,
    railRise: Math.min(height * 0.125, Math.max(22, (width - anchorX) * 0.20)),
    outerRise: Math.min(height * 0.32, Math.max(48, (width - cx - 0.519 * sx) * 0.42)),
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

// Stroke, packet and waypoint all use the same vertices and the same clock.
const WAYPOINT = 0.80;
function makeRail(g, fx, fy, lane, agent) {
  const portY = g.cy + lane * g.railRise;
  const slope = clamp((portY - fy) / Math.max(1, g.portX - fx), -1, 1);
  const endY = agent ? portY : portY + (g.width - g.portX) * slope;
  const points = [{ x: fx, y: fy, at: 0 }];
  if (agent) {
    const elbow = mix(fx, g.portX, 0.18 + (lane + 1) * 0.055);
    points.push({ x: elbow, y: fy, at: 0.18 }, { x: elbow + Math.min(Math.abs(portY - fy), (g.portX - fx) * 0.26), y: portY, at: 0.39 });
  }
  points.push({ x: g.portX, y: portY, at: WAYPOINT }, { x: g.width, y: endY, at: 1 });
  return points;
}

function along(a, b, t) {
  return { x: mix(a.x, b.x, t), y: mix(a.y, b.y, t), dx: b.x - a.x, dy: b.y - a.y };
}

function onRail(points, t) {
  const i = points.findIndex((p, i) => i > 0 && p.at >= t);
  const end = i < 0 ? points.length - 1 : i;
  const a = points[end - 1], b = points[end];
  return along(a, b, (t - a.at) / (b.at - a.at));
}

function drawRails(ctx, g, c, rails, agent, tip) {
  const path = new Path2D(), marks = new Path2D();
  if (!agent && !g.compact) {
    line(path, tip.x, tip.y, g.width, g.cy - g.outerRise);
    line(path, tip.x, tip.y, g.width, g.cy + g.outerRise);
  }
  for (const points of rails) {
    path.moveTo(points[0].x, points[0].y);
    for (const p of points.slice(1)) path.lineTo(p.x, p.y);
    if (agent) {
      for (const p of points.slice(1, 3)) marks.rect(p.x - 1, p.y - 1, 2, 2);
    } else if (!g.compact) {
      for (const t of [0.28, 0.53]) {
        const p = onRail(points, t);
        line(marks, p.x, p.y - 2, p.x, p.y + 2);
      }
    }
  }
  stroke(ctx, path, c.secondary, agent ? 0.56 : 0.40, 0.8);
  stroke(ctx, marks, c.secondary, 0.66, 0.85);
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
    ctx.globalAlpha = Math.min(0.52, strength);
    ctx.lineWidth = 0.9;
    ctx.stroke();
  }
}

function drawWaves(ctx, g, colors, waves, fromDisc) {
  for (const wave of waves) {
    if (wave.fromDisc !== fromDisc) continue;
    ctx.strokeStyle = wave.fromDisc ? colors.signal : colors.accent;
    ctx.lineWidth = 0.85;
    for (let i = 0; i < wave.rings; i++) {
      const radius = wave.radius - i * g.step * 0.19;
      if (radius <= 0) continue;
      ctx.beginPath();
      ctx.arc(wave.x * g.width, wave.y * g.height, radius, 0, TAU);
      ctx.globalAlpha = wave.opacity * (1 - i * 0.24);
      ctx.stroke();
    }
  }
}

// Build masks in plate coordinates, before rotating the ribbon being painted.
// A centreline cut lies half a band inside the overprint at every live angle.
function ellipseContour(rim, angle, inset, upper = false) {
  const edge = new Path2D();
  edge.ellipse(rim.x, rim.y, rim.rx - inset, rim.ry - inset, rim.x ? angle : -angle, upper ? PI : 0, TAU);
  edge.closePath();
  return edge;
}

function exterior(rim, angle, upper = false) {
  const edge = ellipseContour(rim, angle, rim.t / 2, upper);
  const path = new Path2D();
  path.rect(-2, -1, 4, 2);
  path.addPath(edge);
  return path;
}

function drawOptics(ctx, o, colors, angle, agent, unit) {
  const outsideMiddle = exterior(o.frontMiddle, angle);
  const outsideInner = exterior(o.frontInner, angle);
  const rearBoundary = ellipseContour(o.rearMiddle, angle, 0);
  ctx.save();
  ctx.beginPath();
  ctx.rect(-1.18, -0.68, 1.18, 1.36);
  ctx.clip();

  function print(rim, masks, rule = "evenodd") {
    ctx.save();
    for (const mask of masks) ctx.clip(mask, rule);
    ctx.translate(rim.x, rim.y);
    ctx.rotate(rim.x ? angle : -angle);
    if (agent) {
      const ink = rim.ink === "ink" ? colors.secondary : colors.accent;
      stroke(ctx, rim.path, ink, 0.86, 1 / unit);
      ctx.clip(rim.path, "evenodd");
      stroke(ctx, rim.ticks, ink, 0.65, 0.8 / unit);
      ctx.setLineDash([2 / unit, 4 / unit]);
      stroke(ctx, rim.orbit, ink, 0.50, 0.75 / unit);
    } else {
      ctx.globalAlpha = 1;
      ctx.fillStyle = colors[rim.ink];
      ctx.fill(rim.path, "evenodd");
    }
    ctx.restore();
  }

  // At the crown, stop R0 in F0 before it can enter the fine F0–F1 paper gap.
  print(o.rearOuter, [outsideInner, exterior(o.frontMiddle, angle, true), exterior(o.frontOuter, angle, true)]);
  print(o.rearInner, [outsideMiddle]);
  print(o.frontOuter, [exterior(o.rearMiddle, angle), outsideMiddle]);

  // The print shows two short returns between overprints. Each is bounded
  // at BOTH ends: cobalt runs R2 → R1 above, ink runs F1 → F2 below.
  // Extending either parent arc unmasked would enter an adjacent paper gap.
  print(o.frontOuter, [rearBoundary, exterior(o.rearInner, angle), outsideMiddle]);
  print(o.rearMiddle, [outsideMiddle]);
  const lower = new Path2D();
  lower.rect(-2, 0.12, 4, 1);
  print(o.rearMiddle, [lower, ellipseContour(o.frontMiddle, angle, 0), outsideInner]);
  const tail = new Path2D(rearBoundary);
  tail.rect(-2, -1, 4, 1.12); // Nonzero union: free above y = 0.12, inside R2 below.
  print(o.frontMiddle, [tail], "nonzero");
  print(o.frontInner, []);
  ctx.restore();
}

function drawPrism(ctx, g, c, fold, tipX, tipY, agent, coreGlow) {
  // The two editions share the actual facets, including their moving ridge.
  function facet(color, points, shade = 1) {
    if (agent && shade < 1) return;
    const path = new Path2D();
    path.moveTo(points[0], points[1]);
    for (let i = 2; i < points.length; i += 2) path.lineTo(points[i], points[i + 1]);
    path.closePath();
    ctx.fillStyle = color;
    ctx.globalAlpha = agent ? 0.06 : shade;
    ctx.fill(path);
    if (agent) stroke(ctx, path, color, 0.83, 1 / g.size);
  }
  facet(c.accent, [0.376, -0.075, 0.427, -0.075, tipX, tipY, 0.427, 0.075, 0.376, 0.075]);
  facet(c.ink, [0.376, 0.025, tipX, tipY, 0.427, 0.075, 0.376, 0.075], 0.12);
  facet(c.ink, [0.333, -0.12, 0.388, -0.12, 0.388, 0.12, 0.333, 0.12]);
  facet(c.secondary, [0.373, -0.12, 0.388, -0.12, 0.388, 0.12], 0.27);
  facet(c.accent, [0.221, -0.166, 0.342, -0.166, 0.342, 0.166, 0.221, 0.166]);
  facet(c.ink, [0.221, -0.166, 0.342, -0.166, 0.271 + fold, 0.166, 0.221, 0.166]);
  facet(c.secondary, [0.221, 0.166, 0.271 + fold, 0.166, 0.225, 0.250]);
  const ridge = 0.115 + fold;
  facet(c.ink, [0, -0.244, ridge, -0.322, ridge, 0.260, 0, 0.332]);
  facet(c.accent, [ridge, -0.322, 0.231, -0.244, 0.231, 0.244, ridge, 0.332]);
  facet(c.paper, [ridge, -0.322, ridge + 0.009, -0.316, ridge + 0.009, 0.325, ridge, 0.332], 0.18);
  facet(c.ink, [0.231, -0.244, 0.231, 0.244, ridge, 0.332], 0.07);
  if (agent) {
    ctx.save();
    ctx.scale(1 / g.size, 1 / g.size);
    const em = clamp(g.size * 0.038, 8, 12);
    ctx.font = `${em}px ${g.mono}`;
    ctx.fillStyle = c.ink;
    ctx.globalAlpha = 0.70 + 0.30 * coreGlow;
    const bars = new Path2D();
    for (const [i, mark] of ["---", "#", "§01", "§02"].entries()) {
      const x = g.size * (i > 1 ? 0.038 : 0.018);
      const y = (i - 1.5) * g.size * 0.108;
      ctx.fillText(mark, x, y);
      line(bars, x, y + 4, g.size * (i % 2 ? 0.195 : 0.16), y + 4);
      if (i > 0) line(bars, x + 3, y + 7, g.size * 0.14, y + 7);
    }
    stroke(ctx, bars, c.accent, 0.45 + 0.30 * coreGlow, 0.85);
    ctx.restore();
  }
  ctx.globalAlpha = 1;
}

function signalPoint(g, p, rail, tip) {
  const phase = p.phase;
  if (phase < 0.30) {
    const a = PI + phase / 0.30 * PI / 2;
    return {
      x: g.cx + g.sx * 0.421 * Math.cos(a), y: g.cy + g.size * (-0.01 + 0.35 * Math.sin(a)),
      dx: -g.sx * 0.421 * Math.sin(a), dy: g.size * 0.35 * Math.cos(a),
    };
  }
  const entry = { x: g.cx, y: g.cy - g.size * 0.36 };
  const fold = { x: g.cx, y: g.cy - g.size * 0.11 };
  if (phase < 0.38) return along(entry, fold, (phase - 0.30) / 0.08);
  if (phase < 0.54) return along(fold, tip, (phase - 0.38) / 0.16);
  if (phase < ARRIVAL) return along(tip, rail[0], (phase - 0.54) / (ARRIVAL - 0.54));
  return onRail(rail, (phase - ARRIVAL) / (1 - ARRIVAL));
}

function drawSignal(ctx, g, c, p, rail, tip, agent, leading) {
  const { x, y, dx, dy } = signalPoint(g, p, rail, tip);
  const outgoing = p.phase >= ARRIVAL;
  const inCore = p.phase >= 0.38 && p.phase < 0.54;
  ctx.save();
  ctx.fillStyle = outgoing && p.lane !== 0 ? c.signal : inCore && !agent ? c.paper : c.accent;
  ctx.globalAlpha = (p.ambient ? 0.48 : 0.90) * clamp(Math.min((p.phase - p.start) / 0.018, (1 - p.phase) / 0.05), 0, 1);
  ctx.translate(x, y);
  if (agent && leading && !g.compact && p.phase > 0.69 && x < g.portX - 70) {
    ctx.font = `9px ${g.mono}`;
    ctx.fillText(BADGES[p.lane + 1], 3, 11);
  }
  ctx.rotate(Math.atan2(dy, dx));
  if (agent) {
    ctx.fillRect(-3, -1.5, 6, 3);
    ctx.globalAlpha *= 0.62;
    ctx.fillRect(-8, -1, 3, 2);
    ctx.fillRect(-12, -0.75, 1.5, 1.5);
  } else {
    const length = Math.max(7, g.size * 0.032);
    const tail = ctx.createLinearGradient(-length, 0, 2, 0);
    tail.addColorStop(0, "transparent");
    tail.addColorStop(1, ctx.fillStyle);
    ctx.fillStyle = tail;
    ctx.fillRect(-length, -1, length + 2, 2);
  }
  ctx.restore();
}

function drawDiscovery(ctx, g, c, optics, angle) {
  const entries = [
    [optics.rearOuter, -2.37, "/llms.txt"], [optics.rearInner, -2.82, "./index.md"],
    [optics.rearMiddle, 2.88, "/api/posts.json"], [optics.rearOuter, 2.37, "/api/graph.json"],
  ];
  ctx.font = `10px ${g.mono}`;
  ctx.textAlign = "right";
  const textX = g.cx - 0.97 * g.sx - 12;
  const labelsFit = textX - g.margin >= ctx.measureText("/api/graph.json").width;
  for (const [rim, a, label] of entries) {
    const dx = (rim.rx - rim.t / 2) * Math.cos(a), dy = (rim.ry - rim.t / 2) * Math.sin(a);
    const x = g.cx + g.sx * (rim.x + dx * Math.cos(angle) - dy * Math.sin(angle));
    const y = g.cy + g.size * (rim.y + dx * Math.sin(angle) + dy * Math.cos(angle));
    if (labelsFit) {
      const leader = new Path2D();
      line(leader, textX + 5, y, x - 3, y);
      stroke(ctx, leader, c.muted, 0.52, 0.7);
      ctx.fillStyle = c.secondary;
      ctx.globalAlpha = 0.93;
      ctx.fillText(label, textX, y + 3);
    }
    ctx.beginPath();
    ctx.arc(x, y, 2.2, 0, TAU);
    ctx.fillStyle = c.accent;
    ctx.globalAlpha = 1;
    ctx.fill();
  }
  ctx.textAlign = "left";
}

function drawStory(ctx, g, c, copy, agent, rails, laneGlow, active, rhythm, telemetry) {
  const small = g.compact;
  ctx.font = `${small ? 10 : 11}px ${g.mono}`;
  ctx.fillStyle = c.secondary;
  ctx.globalAlpha = 1;
  ctx.fillText(agent ? copy.agentFolio : copy.humanFolio, g.margin, g.folioY);
  const font = ctx.font;
  if (!agent && !small) {
    ctx.fillText(copy.axis, Math.max(g.margin, g.cx - g.sx * 0.924), g.cy + g.size * 0.5 + 17);
  }
  if (agent && g.width >= 760) {
    const lineHeight = small ? 11 : 14;
    // On shallow sheets the telemetry and upper port can share a baseline.
    // Reserve the port's column even while the specimen is idle.
    const labelRoom = g.folioY + 5 * lineHeight + 12 > g.cy - g.railRise - 5
      ? ctx.measureText("GET /llms.txt").width + 14 : 0;
    ctx.font = `${small ? 9 : 10}px ${g.mono}`;
    const x = g.portX - labelRoom - ctx.measureText("200 OK · /api/graph.json · application/json").width;
    for (const [i, row] of SPECIMEN.entries()) {
      ctx.fillStyle = i === 0 || i === 4 ? c.muted : c.secondary;
      ctx.fillText(row, x, g.folioY + i * lineHeight);
    }
    if (telemetry.opacity > 0.012) {
      ctx.globalAlpha = telemetry.opacity;
      ctx.fillStyle = c.accent;
      ctx.fillText(`200 OK · ${ROUTES[telemetry.lane + 1]} · ${FORMATS[telemetry.lane + 1]}`, x, g.folioY + 5 * lineHeight);
    }
  }
  ctx.font = font;
  ctx.textAlign = "right";
  for (const [i, points] of rails.entries()) {
    const port = points[points.length - 2];
    const glow = laneGlow[i];
    ctx.fillStyle = c.accent;
    ctx.globalAlpha = 0.58 + 0.35 * glow;
    ctx.fillRect(port.x - 1.5, port.y - 1.5, 3, 3);
    const room = port.x - points[0].x - g.dot - 8;
    let label = agent ? `GET ${ROUTES[i]}` : copy.waypoints[i];
    if (ctx.measureText(label).width > room) label = agent ? BADGES[i] : label.slice(0, 2);
    if (ctx.measureText(label).width > room) label = copy.waypoints[i].slice(0, 2);
    if (ctx.measureText(label).width > room) continue;
    ctx.fillStyle = c.ink;
    ctx.globalAlpha = 0.64 + 0.35 * glow;
    ctx.fillText(label, port.x, port.y - 5);
  }
  ctx.textAlign = "left";
  if (rhythm > 0.015) {
    ctx.fillStyle = c.secondary;
    ctx.globalAlpha = rhythm;
    const besideRuler = g.cx - g.sx * 0.924 - g.margin > 76;
    ctx.fillText(`PULSE ×${String(active).padStart(2, "0")}`, g.margin, besideRuler ? g.cy - 7 : g.height - 52);
  }
  ctx.globalAlpha = 1;
}

function drawGate(ctx, g, c, fx, fy, agent, dragging) {
  if (dragging) {
    const tension = new Path2D();
    line(tension, g.anchorX, g.cy - g.dot * 0.55, fx, fy);
    line(tension, g.anchorX, g.cy + g.dot * 0.55, fx, fy);
    stroke(ctx, tension, c.signal, 0.50, 0.8);
  }
  if (agent) {
    const r = g.dot + 4;
    const target = new Path2D();
    target.arc(fx, fy, r, 0, TAU);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      line(target, fx + dx * (r + 1), fy + dy * (r + 1), fx + dx * (r + 5), fy + dy * (r + 5));
    }
    stroke(ctx, target, c.signal, 0.75, 0.85);
    ctx.fillStyle = c.secondary;
    ctx.font = `10px ${g.mono}`;
    ctx.globalAlpha = 0.92;
    if (dragging || !g.compact) {
      const label = dragging ? `Δx ${Math.round(fx - g.anchorX)}  Δy ${Math.round(fy - g.cy)}` : "Accept: text/markdown";
      if (g.compact) {
        ctx.textAlign = "right";
        ctx.fillText(label, g.portX, g.height - 52);
      } else if (dragging) {
        ctx.textAlign = "center";
        ctx.fillText(label, fx, fy + r + 20);
      } else {
        const w = ctx.measureText(label).width;
        ctx.textAlign = "left";
        ctx.fillText(label, Math.min(fx - g.dot, g.portX - w), fy + r + 20);
      }
      ctx.textAlign = "left";
    }
  }
  ctx.beginPath();
  ctx.arc(fx, fy, g.dot, 0, TAU);
  ctx.globalAlpha = 1;
  ctx.fillStyle = c.signal;
  ctx.fill();
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

function makeHud(copy) {
  const frame = document.createElement("div");
  frame.className = "cover-hud-frame";
  frame.innerHTML = `<div class="cover-surface-switch" role="group" aria-label="${copy.group}">
    <button type="button" class="cover-surface-btn" data-cover-face="human" aria-pressed="true"><span class="cover-surface-idx mono" aria-hidden="true">01</span><span>${copy.human}</span></button>
    <span class="cover-surface-sep" aria-hidden="true">/</span>
    <button type="button" class="cover-surface-btn" data-cover-face="agent" aria-pressed="false"><span class="cover-surface-idx mono" aria-hidden="true">02</span><span>${copy.agent}</span></button>
  </div><span class="cover-stage-cue" aria-hidden="true">${copy.cue}</span>`;
  return frame;
}

export function mountCoverModel(hostEl) {
  if (mounts.has(hostEl)) return mounts.get(hostEl);
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return { destroy() {} };

  const copy = document.documentElement.lang.startsWith("zh") ? COPY.zh : COPY.en;
  const originalReady = hostEl.getAttribute("data-model-ready");
  const originalCanvasLive = hostEl.getAttribute("data-canvas-live");
  const stage = document.createElement("div");
  stage.setAttribute("data-cover-canvas-stage", "");
  stage.inert = true;
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", copy.humanLabel);
  // Browsers decide touch-action at contact time. Only the disc owns a non-scrolling surface.
  const handle = document.createElement("button");
  handle.type = "button";
  handle.className = "cover-disc-handle";
  handle.setAttribute("aria-label", copy.handle);
  const hud = makeHud(copy);
  const switcher = hud.querySelector(".cover-surface-switch");
  const buttons = [...switcher.querySelectorAll("button")];
  stage.append(canvas, handle, hud);
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
  const pulses = [];
  const pending = []; // Keep a volley together until it has enough free flight slots.
  const laneGlow = [0, 0, 0];
  const telemetry = { lane: 0, until: -1, opacity: 0 };
  let g, dpr, handleSize, handlePosition;
  let press = null;
  let hovering = false;
  let presence = 0;
  let time = 0;
  let nextLane = 0, ambientLane = 0, nextAmbient = 3.6;
  let lastUser = -Infinity, lastArrival = -Infinity, burstStreak = 0;
  let recoil = 0, glint = 0, rhythm = 0, rhythmCount = 0;
  let face = "human", flipTarget = 0, flipProgress = 0, flipFrom = 0, flipStarted = 0;
  let scaleX = 1, scaleY = 1, shear = 0;
  let announceTimer, announcement, revealFrame;
  let frame = null;
  let lastTime = null;
  let inViewport = true;
  let destroyed = false;

  function emit(x, y, fromDisc, rings) {
    if (!g || reducedMotion) return;
    if (waves.length === MAX_WAVES) waves.shift();
    waves.push({ x: x / g.width, y: y / g.height, fromDisc, rings, age: 0, radius: fromDisc ? g.dot : 0, opacity: 0 });
  }

  function pulseDisc(rings) {
    emit(g.anchorX + focus.x * g.sx, g.cy + focus.y * g.size, true, rings);
  }

  function dispatch(lane) {
    telemetry.lane = lane;
    telemetry.until = time + 1.3;
  }

  function admitVolleys() {
    while (pending.length && pulses.length + pending[0].lanes.length <= MAX_PULSES) {
      const { lanes, speed, start, ambient } = pending.shift();
      for (const lane of lanes) {
        pulses.push({ lane, speed, start, phase: start, arrived: start === ARRIVAL, ambient });
        if (start === ARRIVAL) dispatch(lane);
      }
    }
  }

  function fire(chord = false) {
    burstStreak = time - lastUser <= 0.5 ? Math.min(8, burstStreak + 1) : 0;
    lastUser = time;
    nextAmbient = time + 3.6;
    recoil = Math.min(1, recoil + 0.35 + burstStreak * 0.045);
    const lanes = chord ? LANES : [LANES[nextLane++ % LANES.length]];
    pending.push({ lanes, speed: 0.40 + Math.min(0.14, burstStreak * 0.022), start: chord ? ARRIVAL : 0, ambient: false });
    admitVolleys();
    if (chord) {
      pulseDisc(2);
      focus.vx = Math.min(0.22, focus.vx + 0.11);
    }
  }

  function advanceSignals(dt) {
    for (let i = 0; i < laneGlow.length; i++) laneGlow[i] *= Math.exp(-dt * 2.8);
    burstStreak *= Math.exp(-dt * 0.65);
    recoil *= Math.exp(-dt * 4.5);
    glint += (recoil - glint) * (1 - Math.exp(-dt * 18));
    for (const p of pulses) {
      p.phase += dt * p.speed;
      if (!p.arrived && p.phase >= ARRIVAL) {
        p.arrived = true;
        dispatch(p.lane);
        focus.vx = Math.min(0.18, focus.vx + (p.ambient ? 0.018 : 0.033));
        if (time - lastArrival >= 0.38) {
          pulseDisc(1);
          lastArrival = time;
        }
      }
      const progress = (p.phase - ARRIVAL) / (1 - ARRIVAL);
      const nearPort = Math.max(0, 1 - Math.abs(progress - WAYPOINT) / 0.19);
      laneGlow[p.lane + 1] = Math.max(laneGlow[p.lane + 1], nearPort ** 2 * (p.ambient ? 0.48 : 1));
    }
    for (let i = pulses.length - 1; i >= 0; i--) {
      if (pulses[i].phase >= 1) pulses.splice(i, 1);
    }
    admitVolleys();
    if (time >= nextAmbient && !pending.length && pulses.length < 2) {
      pending.push({ lanes: [LANES[ambientLane++ % LANES.length]], speed: 0.25, start: 0, ambient: true });
      admitVolleys();
      nextAmbient = time + 3.6;
    }
    const count = pulses.reduce((n, p) => n + Number(!p.ambient), 0);
    if (count) rhythmCount = count;
    rhythm += ((count ? 0.92 : 0) - rhythm) * (1 - Math.exp(-dt * 7));
    telemetry.opacity += ((time < telemetry.until ? 0.90 : 0) - telemetry.opacity) * (1 - Math.exp(-dt * 5));
  }

  function updateTurn(now) {
    if (flipProgress === flipTarget) return;
    const t = clamp((now - flipStarted) / (1000 * FLIP_SECONDS * Math.abs(flipTarget - flipFrom)), 0, 1);
    flipProgress = t === 1 ? flipTarget : mix(flipFrom, flipTarget, t * t * (3 - 2 * t));
  }

  function selectFace(next) {
    if (next === face) return;
    const now = performance.now();
    updateTurn(now);
    face = next;
    flipFrom = flipProgress;
    flipStarted = now;
    flipTarget = face === "agent" ? 1 : 0;
    if (reducedMotion) flipProgress = flipTarget;
    for (const button of buttons) button.setAttribute("aria-pressed", String(button.dataset.coverFace === face));
    canvas.setAttribute("aria-label", copy[face + "Label"]);
    const live = document.getElementById("live-announcer");
    clearTimeout(announceTimer);
    announcement?.remove();
    if (live) announceTimer = setTimeout(() => {
      announcement = document.createTextNode(copy[face + "Folio"]);
      live.replaceChildren(announcement);
    }, 100);
    draw();
    start();
  }

  for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel"]) {
    switcher.addEventListener(type, event => event.stopPropagation(), listen);
  }
  switcher.addEventListener("click", event => {
    event.stopPropagation();
    const button = event.target.closest("button[data-cover-face]");
    if (button) selectFace(button.dataset.coverFace);
  }, listen);
  switcher.addEventListener("keydown", event => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const button = buttons[1 - buttons.indexOf(event.target)];
    if (button) {
      button.focus();
      selectFace(button.dataset.coverFace);
    }
  }, listen);

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
    const dragging = press?.drag && press.moved;
    let tx = 0;
    let ty = 0;
    if (hovering || dragging) {
      const gain = dragging ? 0.82 : 0.082;
      const limit = dragging ? 0.19 : 0.042;
      const point = platePoint((1 + aim.x) * g.cx, (1 + aim.y) * g.cy);
      const dx = (dragging ? point.x - g.anchorX - press.offsetX : (1 + pointer.x) * g.cx - g.anchorX) / g.sx;
      const dy = (dragging ? point.y - g.cy - press.offsetY : pointer.y * g.cy) / g.size;
      const scale = gain / Math.hypot(1, dx * gain / limit, dy * gain / limit);
      tx = Math.max(-0.105, dx * scale);
      ty = dy * scale;
    }
    advanceSpring(focus, tx, ty, dragging ? 220 : 145, dragging ? 19 : 12, dt);
    advanceSignals(dt);
    for (let i = waves.length - 1; i >= 0; i--) {
      const wave = waves[i];
      wave.age += dt / (wave.fromDisc ? 1.55 : 1.85);
      if (wave.age >= 1) {
        waves.splice(i, 1);
        continue;
      }
      const travel = 1 - (1 - wave.age) ** 2;
      wave.radius = (wave.fromDisc ? g.dot : 0) + g.size * (wave.fromDisc ? 0.27 : 0.94) * travel;
      wave.opacity = 0.46 * Math.min(1, wave.age / 0.09) * (1 - wave.age) ** 1.4;
    }
  }

  function draw() {
    if (!g || document.hidden) return;
    const nx = Math.max(-1, Math.min(1, pointer.x));
    const ny = Math.max(-1, Math.min(1, pointer.y));
    const angle = clamp(Math.sin(time * 0.48) * 0.016 + nx * 0.019 + ny * 0.010 + glint * 0.009, -0.04, 0.04);
    const spread = 1 + Math.sin(time * 0.43) * 0.012 + nx * 0.025;
    const tip = 0.519 + focus.x * 0.61 + glint * 0.008;
    const tilt = focus.y * 0.34 + ny * 0.008;
    const tipX = g.cx + g.sx * spread * tip;
    const tipY = g.cy + g.size * tilt;
    const fx = g.anchorX + focus.x * g.sx;
    const fy = g.cy + focus.y * g.size;
    ctx.clearRect(0, 0, g.width, g.height);
    stroke(ctx, g.grid, colors.rule, 1, 0.9);
    stroke(ctx, g.diagonals, colors.muted, 0.26, 0.7);
    drawCompass(ctx, g, colors, time);
    stroke(ctx, g.ruler, colors.secondary, 0.51, 0.75);
    drawField(ctx, g, colors, pointer, presence, waves);
    drawWaves(ctx, g, colors, waves, false);
    fadeEdges(ctx, g);

    const agent = flipProgress >= 0.5;
    const theta = flipProgress * PI;
    const turn = Math.sin(theta);
    scaleX = Math.max(0.025, Math.abs(Math.cos(theta)));
    scaleY = 1 - 0.045 * turn;
    shear = 0.035 * Math.min(1, 2 * g.height / g.width) * turn;
    ctx.save();
    ctx.translate(g.cx, g.cy);
    ctx.transform(scaleX, shear, 0, scaleY, 0, 0);
    ctx.translate(-g.cx, -g.cy);
    const apex = { x: tipX, y: tipY };
    const rails = LANES.map(lane => makeRail(g, fx, fy, lane, agent));
    drawRails(ctx, g, colors, rails, agent, apex);
    drawWaves(ctx, g, colors, waves, true);
    const coreGlow = pulses.reduce((peak, p) => Math.max(peak, 1 - Math.abs(p.phase - 0.46) / 0.09), 0);
    ctx.save();
    ctx.translate(g.cx, g.cy);
    ctx.scale(g.sx, g.size);
    drawOptics(ctx, optics, colors, angle, agent, g.size);
    ctx.scale(spread, 1);
    drawPrism(ctx, g, colors, Math.sin(time * 0.51) * 0.003 + nx * 0.01, tip, tilt, agent, coreGlow);
    ctx.restore();
    if (agent) drawDiscovery(ctx, g, colors, optics, angle);
    drawStory(ctx, g, colors, copy, agent, rails, laneGlow, rhythmCount, rhythm, telemetry);
    if (glint > 0.01) {
      const intake = new Path2D();
      intake.arc(g.cx - g.sx * 0.421, g.cy - g.size * 0.01, 2 + 4 * glint, 0, TAU);
      stroke(ctx, intake, colors.accent, glint * 0.48, 1);
    }
    const leader = pulses.reduce((best, p) => !best || p.phase > best.phase ? p : best, null);
    for (const p of pulses) drawSignal(ctx, g, colors, p, rails[p.lane + 1], apex, agent, p === leader);
    drawGate(ctx, g, colors, fx, fy, agent, press?.drag && press.moved);
    ctx.restore();
    if (turn > 0.001) {
      const crease = new Path2D();
      line(crease, g.cx, g.folioY, g.cx, g.height - 40);
      stroke(ctx, crease, colors.accent, turn * 0.74, 1);
    }
    const screenX = g.cx + (fx - g.cx) * scaleX;
    const screenY = g.cy + (fy - g.cy) * scaleY + (fx - g.cx) * shear;
    const position = `translate(${(screenX - handleSize / 2).toFixed(2)}px,${(screenY - handleSize / 2).toFixed(2)}px)`;
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
    updateTurn(now);
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
    const style = getComputedStyle(hud);
    const margin = (width - hud.offsetWidth) / 2 + parseFloat(style.paddingLeft);
    g = makeLayout(ctx, width, height, margin, style.getPropertyValue("--font-mono").trim());
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

  function platePoint(x, y) {
    const dx = (x - g.cx) / scaleX;
    return { x: g.cx + dx, y: g.cy + (y - g.cy - shear * dx) / scaleY };
  }

  function release(keepHover = false) {
    const held = press;
    press = null;
    hovering = keepHover;
    if (held?.surface.hasPointerCapture(held.id)) held.surface.releasePointerCapture(held.id);
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
    const point = platePoint(x, y);
    const offsetX = point.x - g.anchorX - focus.x * g.sx;
    const offsetY = point.y - g.cy - focus.y * g.size;
    const drag = event.target === handle;
    const surface = drag ? handle : canvas;
    press = { id: event.pointerId, surface, drag, x, y, offsetX, offsetY, moved: false };
    surface.setPointerCapture(event.pointerId);
  }, listen);
  stage.addEventListener("pointerup", event => {
    if (!g || press?.id !== event.pointerId) return;
    const { x, y } = track(event);
    const keepHover = event.pointerType !== "touch" && !press.drag;
    const tapped = !press.moved && Math.hypot(x - press.x, y - press.y) <= 8;
    if (press.drag && tapped) {
      fire(true);
    } else if (press.drag) {
      pulseDisc(2);
      focus.vx -= focus.x;
      focus.vy -= focus.y;
    } else if (tapped) {
      emit(x, y, false, 2);
      fire();
    }
    release(keepHover);
  }, listen);
  stage.addEventListener("pointercancel", event => {
    if (event.isPrimary && (!press || press.id === event.pointerId)) release();
  }, listen);
  stage.addEventListener("lostpointercapture", event => {
    if (press?.id === event.pointerId) release();
  }, listen);
  handle.addEventListener("click", event => {
    // Native button activation from the keyboard or assistive technology.
    if (event.detail === 0 && g && !reducedMotion) {
      fire(true);
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
    waves.length = pulses.length = pending.length = 0;
    laneGlow.fill(0);
    time = 0;
    nextAmbient = time + 3.6;
    lastUser = lastArrival = telemetry.until = -Infinity;
    burstStreak = recoil = glint = presence = rhythm = telemetry.opacity = 0;
    flipProgress = flipTarget;
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
    revealFrame = window.requestAnimationFrame(() => {
      if (!destroyed) {
        hostEl.dataset.canvasLive = "true";
        stage.inert = false;
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
      cancelAnimationFrame(revealFrame);
      clearTimeout(announceTimer);
      announcement?.remove();
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
