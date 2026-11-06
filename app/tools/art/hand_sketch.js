function handFrame(seed, pose) {
  const grip = pose === 'grip';
  let s = seed >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const j = (a) => (rnd() - 0.5) * 2 * a;
  const PAPER = '#ECEBEF', LEAD = '#22222C', out = [];
  const curve = (pts, jit) => {
    const p = pts.map(([x, y]) => [x + j(jit), y + j(jit)]);
    let d = `M${p[0][0].toFixed(1)} ${p[0][1].toFixed(1)}`;
    for (let i = 1; i < p.length - 1; i++) {
      const mx = (p[i][0] + p[i + 1][0]) / 2, my = (p[i][1] + p[i + 1][1]) / 2;
      d += `Q${p[i][0].toFixed(1)} ${p[i][1].toFixed(1)} ${mx.toFixed(1)} ${my.toFixed(1)}`;
    }
    const e = p[p.length - 1];
    return d + `L${e[0].toFixed(1)} ${e[1].toFixed(1)}`;
  };
  const line = (d, w, o) => out.push({ d, fill: 'none', stroke: LEAD, w, o });
  const fill = (pts, c) => out.push({ d: curve(pts, 0) + 'Z', fill: c || PAPER, stroke: 'none', w: 0, o: 1 });
  // A contour is several quick passes that never quite agree.
  const sketch = (pts, weight) => {
    line(curve(pts, 0.8), 1.5 * weight + j(0.3), 0.92);
    line(curve(pts, 1.6), 0.9 * weight, 0.6);
    const a = Math.floor(rnd() * pts.length * 0.4), b = a + Math.floor(pts.length * 0.45);
    line(curve(pts.slice(a, Math.max(a + 2, b)), 2.2), 0.7 * weight, 0.45);
  };
  const hatch = (x0, y0, x1, y1, dx, dy, n, w, o) => {
    for (let i = 0; i < n; i++) {
      const t = (i + rnd() * 0.6) / n, x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t, k = 0.55 + rnd() * 0.6;
      line(`M${(x + j(1.5)).toFixed(1)} ${(y + j(1.5)).toFixed(1)}Q${(x + dx * k * 0.5 + j(2)).toFixed(1)} ${(y + dy * k * 0.5 + j(2)).toFixed(1)} ${(x + dx * k).toFixed(1)} ${(y + dy * k).toFixed(1)}`, w * (0.7 + rnd() * 0.7), o);
    }
  };
  const digit = (x0, y0, x1, y1, bend, w0, w1, nail) => {
    const mx = (x0 + x1) / 2 + (y1 - y0) / Math.hypot(x1 - x0, y1 - y0) * -bend, my = (y0 + y1) / 2 + (x1 - x0) / Math.hypot(x1 - x0, y1 - y0) * bend;
    const at = (t) => [(1 - t) ** 2 * x0 + 2 * t * (1 - t) * mx + t * t * x1, (1 - t) ** 2 * y0 + 2 * t * (1 - t) * my + t * t * y1];
    const nrm = (t) => { const a = at(Math.max(0, t - 0.02)), b = at(Math.min(1, t + 0.02)), n = Math.hypot(b[0] - a[0], b[1] - a[1]); return [-(b[1] - a[1]) / n, (b[0] - a[0]) / n]; };
    const wid = (t) => (w0 + (w1 - w0) * t) * (1 + 0.07 * Math.exp(-(((t - 0.42) / 0.07) ** 2)) + 0.05 * Math.exp(-(((t - 0.72) / 0.06) ** 2))) / 2;
    const side = (sg) => { const r = []; for (let i = 0; i <= 12; i++) { const t = i / 12, p = at(t), q = nrm(t), w = wid(t); r.push([p[0] + sg * q[0] * w, p[1] + sg * q[1] * w]); } return r; };
    const L = side(1), R = side(-1), tip = at(1), q = nrm(1), ux = q[1], uy = -q[0], r = wid(1);
    const cap = [[tip[0] + q[0] * r * 0.7 + ux * r * 0.7, tip[1] + q[1] * r * 0.7 + uy * r * 0.7], [tip[0] + ux * r, tip[1] + uy * r], [tip[0] - q[0] * r * 0.7 + ux * r * 0.7, tip[1] - q[1] * r * 0.7 + uy * r * 0.7]];
    const shape = [...L, ...cap, ...R.slice().reverse()];
    fill(shape);
    sketch(shape, 1);
    // creases, and shading down the side away from the light
    for (const t of [0.42, 0.72]) {
      const p = at(t), n = nrm(t), w = wid(t) * 0.62;
      for (let c = 0; c < 2; c++) line(curve([[p[0] + n[0] * w, p[1] + n[1] * w + c * 3], [p[0] + ux * 3, p[1] + uy * 3 + c * 3], [p[0] - n[0] * w, p[1] - n[1] * w + c * 3]], 0.8), 0.9, 0.7);
    }
    const a = at(0.08), b = at(0.92), n0 = nrm(0.5), w5 = wid(0.5);
    hatch(a[0] - n0[0] * w5 * 0.95, a[1] - n0[1] * w5 * 0.95, b[0] - n0[0] * w5 * 0.7, b[1] - n0[1] * w5 * 0.7, n0[0] * w5 * 0.75 + ux * 5, n0[1] * w5 * 0.75 + uy * 5, 13, 1, 0.62);
    if (nail) {
      const c = at(0.9), w = wid(0.9) * 0.62;
      line(curve([[c[0] + q[0] * w - ux * 7, c[1] + q[1] * w - uy * 7], [c[0] + q[0] * w, c[1] + q[1] * w], [c[0] + q[0] * w * 0.6 + ux * 8, c[1] + q[1] * w * 0.6 + uy * 8], [c[0] - q[0] * w * 0.6 + ux * 8, c[1] - q[1] * w * 0.6 + uy * 8], [c[0] - q[0] * w, c[1] - q[1] * w], [c[0] - q[0] * w - ux * 7, c[1] - q[1] * w - uy * 7]], 0.6), 1, 0.8);
    }
  };

  // the sleeve: pale cloth under heavy charcoal folds
  const sleeve = [[114, 368], [160, 362], [206, 366], [222, 430], [246, 520], [290, 680], [350, 860], [420, 1060], [300, 1100], [230, 880], [176, 700], [136, 540], [120, 440], [114, 368]];
  fill(sleeve);
  sketch(sleeve, 1.3);
  hatch(208, 376, 400, 1040, -44, 9, 90, 3.6, 0.88);
  hatch(212, 392, 390, 1040, -26, 12, 70, 3, 0.92);
  for (let k = 0; k < 7; k++) line(curve([[136 + k * 5, 378 + k * 8], [150 + k * 7, 500 + j(8)], [190 + k * 9, 700 + j(8)], [250 + k * 11, 1000]], 2), 2.6 + rnd() * 2.2, 0.5 + rnd() * 0.35);
  hatch(120, 380, 240, 900, 16, 5, 50, 1.6, 0.55);
  // thumb, palm
  digit(140, 318, 62, 236, 12, 50, 33, false); // the thumb, tucked against the fist
  const palm = [[80, 186], [92, 170], [120, 160], [150, 160], [180, 164], [198, 180], [201, 210], [205, 250], [203, 300], [197, 338], [160, 342], [122, 340], [117, 320], [106, 304], [94, 288], [80, 262], [76, 222], [80, 186]];
  fill(palm);
  sketch(palm.slice(5).concat(palm.slice(0, 1)), 1.15);
  hatch(84, 214, 112, 322, 34, 8, 24, 1.2, 0.6);
  hatch(194, 210, 198, 332, -30, 12, 30, 1.7, 0.8);
  hatch(188, 240, 190, 332, -18, 14, 16, 2.6, 0.72);
  // tendons on the back of the hand
  for (const [x, y] of [[98, 196], [126, 182], [154, 186], [178, 206]]) line(curve([[x, y], [(x + 150) / 2 + j(3), 260], [146 + (x - 140) * 0.25, 322]], 1.2), 1, 0.38);
  // fingers over it, open at the base so that they grow out of the palm
  if (grip) {
    // all four draped over the record's edge, spread a little, holding it from the front
    digit(98, 196, 42, 92, -8, 37, 29, true);
    digit(126, 180, 92, 62, -6, 38, 30, true);
    digit(154, 184, 138, 70, -2, 36, 28, true);
    digit(179, 204, 182, 112, 3, 31, 24, true);
  } else {
    digit(98, 192, 50, 40, -9, 37, 27, true);
    // the other three curled into the fist: only the first joint shows
    digit(132, 214, 126, 138, -2, 38, 32, false);
    digit(160, 218, 156, 146, 0, 36, 30, false);
    digit(184, 230, 182, 164, 2, 31, 26, false);
  }
  // hide the finger bases, then draw the knuckles
  fill([[84, 214], [100, 196], [130, 190], [160, 196], [190, 214], [196, 244], [90, 244], [84, 214]]);
  if (!grip) hatch(112, 140, 190, 172, 3, 22, 18, 1.5, 0.72);
  for (const [x, y] of [[96, 190], [128, 172], [157, 178], [183, 194]]) {
    line(curve([[x - 12, y + 7], [x, y - 3], [x + 12, y + 6]], 1), 1.5, 0.85);
    line(curve([[x - 8, y + 13], [x, y + 7], [x + 8, y + 12]], 1), 1, 0.6);
    hatch(x + 4, y + 2, x + 13, y + 10, -4, 8, 5, 1, 0.5);
  }
  // tone on the back of the hand, darkest towards the little finger
  hatch(96, 208, 130, 236, 24, 5, 11, 1, 0.42);
  hatch(190, 204, 196, 250, -36, 12, 16, 2.2, 0.82);
  // the cuff, pushed up in folds
  const cuff = [[118, 338], [160, 330], [202, 332], [209, 372], [160, 376], [112, 380], [118, 338]];
  fill(cuff);
  sketch(cuff, 1.25);
  hatch(182, 338, 204, 372, 3, 26, 12, 2.6, 0.82);
  hatch(122, 344, 150, 372, 2, 22, 8, 1.4, 0.55);
  return out;
}
