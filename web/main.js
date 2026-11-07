import { CONTEXT_BARS, findJumps, renderSong, SONGS, SR } from "./song.js";

const css = getComputedStyle(document.documentElement);
const tok = (n) => css.getPropertyValue(n).trim();
const C = { night: tok("--color-paper"), vinyl: tok("--color-paper-2"), groove: tok("--color-paper-3"), paper: tok("--color-ink"), red: tok("--color-accent") };
const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;
const $ = (s) => document.querySelector(s);

const FADE = 0.03; // the seam: 30 ms, centred on the downbeat
const BARS_A_TURN = 8; // an eight-bar phrase is one turn, so a repeat sits straight across the grooves
const NEEDLE = (-14 * Math.PI) / 180;
const MIN_GAP_BARS = 14; // about the app's 30 s between jumps
const REUSE_PENALTY = 0.3; // jumps.py: a jump gets less likely each time it's taken
const TAKE_MIN = 0.6;
const FIRST_MATCH_BAR = 10; // past the intro, for the buttons that are about jumping

// ── the two songs, pressed in the background ──────────────────────────
const yieldNow = () => new Promise((r) => setTimeout(r));
const songs = [];
let firstReadyResolve;
const pressed0 = new Promise((res) => {
  firstReadyResolve = res;
});
const pressed = SONGS.reduce(
  (before, song, i) =>
    before.then(async () => {
      const r = await renderSong(song, yieldNow);
      await yieldNow();
      songs[i] = { ...r, ...findJumps(r), song, uses: new Map(), layer: null };
      if (i === 0) firstReady();
    }),
  Promise.resolve(),
);

// ── audio ─────────────────────────────────────────────────────────────
let ctx = null;
let master = null;
let cur = 0; // which song
let live = null; // {src, gain, at, offset, song}
let queued = null; // the same, starting later
let started = false;
let playing = false;
let forever = true;
let want = false; // "jump at the next match"
let lastJumpBar = 0;
let jumpsTaken = 0;
let crossing = false;

function ensureAudio() {
  if (ctx) return;
  ctx = new AudioContext({ sampleRate: SR });
  master = ctx.createGain();
  // The songs are mono; a short delay on one side gives them some room.
  const merge = ctx.createChannelMerger(2);
  const delay = ctx.createDelay(0.05);
  delay.delayTime.value = 0.011;
  master.connect(merge, 0, 0);
  master.connect(delay);
  delay.connect(merge, 0, 1);
  merge.connect(ctx.destination);
}

function bufferOf(i) {
  const s = songs[i];
  if (!s.buffer) {
    s.buffer = ctx.createBuffer(1, s.samples.length, SR);
    s.buffer.copyToChannel(s.samples, 0);
  }
  return s.buffer;
}

function startAt(i, when, offset, fade) {
  const src = ctx.createBufferSource();
  src.buffer = bufferOf(i);
  const gain = ctx.createGain();
  src.connect(gain).connect(master);
  gain.gain.setValueAtTime(fade ? 0 : 1, when - fade / 2);
  if (fade) gain.gain.linearRampToValueAtTime(1, when + fade / 2);
  src.start(Math.max(ctx.currentTime, when - fade / 2), Math.max(0, offset - fade / 2));
  return { src, gain, at: when, offset, song: i };
}

/** Everything that moves the music goes through here: a seam at `when`, into `offset` of song `i`. */
function seam(i, when, offset, fade = FADE) {
  const old = live;
  if (fade) {
    old.gain.gain.setValueAtTime(1, when - fade / 2);
    old.gain.gain.linearRampToValueAtTime(0, when + fade / 2);
  } else {
    old.gain.gain.setValueAtTime(0, when);
  }
  old.src.stop(when + fade + 0.05);
  queued = startAt(i, when, offset, fade);
}

const posS = () => (live ? Math.max(0, live.offset + (ctx.currentTime - live.at)) : 0);

function promote() {
  if (queued && ctx.currentTime >= queued.at) {
    const was = live.song;
    live = queued;
    queued = null;
    cur = live.song;
    if (was !== cur) lastJumpBar = live.offset / songs[cur].barS;
    updateObi();
  }
}

async function toggle(fromBar = 0) {
  ensureAudio();
  if (!started) {
    if (!songs[0]) {
      status("Pressing the demo song. It starts as soon as it's done.");
      playing = true;
      paintPlaying();
      await pressed0;
    }
    await ctx.resume();
    started = true;
    live = startAt(0, ctx.currentTime + 0.05, (typeof fromBar === "number" ? fromBar : 0) * songs[0].barS, 0);
    lastJumpBar = typeof fromBar === "number" ? fromBar : 0;
    playing = true;
  } else if (playing) {
    await ctx.suspend();
    playing = false;
  } else {
    await ctx.resume();
    playing = true;
  }
  paintPlaying();
  status();
}

function paintPlaying() {
  document.body.classList.toggle("playing", playing);
  document.querySelectorAll("[data-toggle]").forEach((b) => b.setAttribute("aria-label", playing ? "Pause the demo song" : "Play the demo song"));
}

function status(text) {
  const n = jumpsTaken === 1 ? "1 jump" : `${jumpsTaken} jumps`;
  const line = text ?? `${songs[cur].song.name}, ${forever ? "Forever" : "plays once"}, ${n}`;
  document.querySelectorAll("[data-status]").forEach((el) => {
    el.textContent = line;
  });
}

function firstReady() {
  firstReadyResolve();
  sizeDeck();
  paintMatrix();
  status(`${songs[0].song.name} is ready. Press play.`);
  updatePair();
}

// Forever: as a bar approaches, decide whether its downbeat is the moment to jump.
function eligible(s, to) {
  const n = s.names[to];
  return n !== "intro" && n !== "outro";
}

function pick(s, bar) {
  const best = s.jumps[bar]
    .filter((j) => eligible(s, j.to))
    .map((j) => ({ ...j, value: j.score - REUSE_PENALTY * (s.uses.get(`${bar}>${j.to}`) ?? 0) }))
    .sort((a, b) => b.value - a.value)[0];
  return best;
}

function plan() {
  if (!started || !playing || !songs[cur]) return;
  promote();
  if (queued) return;
  const s = songs[cur];
  const barNow = posS() / s.barS;
  const next = Math.ceil(barNow + 0.01);
  const until = (next - barNow) * s.barS;
  if (until > 1.8) return;

  if (next >= s.bars) {
    // Forever off: the song just ends, and the record stops.
    if (posS() > s.bars * s.barS + 1) restart(false);
    return;
  }
  if (crossing) return;

  if (!forever && !want) return;
  const lastChance = next >= s.bars - 12;
  const due = next - lastJumpBar >= MIN_GAP_BARS || want || lastChance;
  if (!due || !eligible(s, next)) return;
  const j = pick(s, next);
  if (!j || (j.value < TAKE_MIN && !want && !lastChance)) return;

  const when = ctx.currentTime + until;
  const key = `${next}>${j.to}`;
  s.uses.set(key, (s.uses.get(key) ?? 0) + 1);
  seam(cur, when, j.to * s.barS);
  want = false;
  lastJumpBar = j.to;
  jumpsTaken++;
  playFinger(until, next, j.to);
  setTimeout(() => status(), until * 1000 + 50);
}

function restart(play = true) {
  if (!started) return;
  if (live) live.src.stop();
  if (queued) queued.src.stop();
  queued = null;
  cur = 0;
  lastJumpBar = 0;
  live = startAt(0, ctx.currentTime + 0.05, 0, 0);
  if (!play) {
    ctx.suspend();
    playing = false;
    paintPlaying();
  }
  updateObi();
}

async function jumpGood() {
  if (!playing) await toggle(FIRST_MATCH_BAR);
  want = true;
  status("Waiting for the next match");
}

async function jumpBad() {
  if (!playing) await toggle(FIRST_MATCH_BAR);
  if (queued) return;
  const s = songs[cur];
  const bar = Math.floor(posS() / s.barS);
  // A place that doesn't match, deliberately off the beat, with no overlap.
  let to = (bar + 27) % (s.bars - 10);
  while (s.names[to] === s.names[bar] || s.names[to] === "intro") to = (to + 3) % (s.bars - 10);
  seam(cur, ctx.currentTime + 0.04, (to + 0.37) * s.barS, 0);
  lastJumpBar = to;
  status("That was a bad jump. The next one is a real match.");
  want = false;
  setTimeout(() => {
    want = playing;
  }, 3500);
}

async function cross() {
  if (!songs[1]) {
    status("Still pressing the second song. Try again in a moment.");
    await pressed;
  }
  if (!playing) await toggle();
  if (queued || crossing) return;
  crossing = true;
  const s = songs[cur];
  const other = 1 - cur;
  const o = songs[other];
  const barNow = posS() / s.barS;
  // On an even bar, so the chords move at the same moment on both sides.
  let next = Math.ceil(barNow + 0.2);
  if (next % 2) next++;
  if (next >= s.bars) next = s.bars - 2;
  const name = s.names[next].startsWith("chorus") ? "chorus" : "verse";
  let to = o.names.indexOf(name);
  to += next % 8;
  const when = ctx.currentTime + (next - barNow) * s.barS;
  seam(other, when, to * o.barS);
  $("#stage").dataset.at = String(other);
  animateGrips();
  setTimeout(() => {
    crossing = false;
    status();
  }, (when - ctx.currentTime) * 1000 + 100);
}

function updateObi() {
  if (songs[cur]) $("#obi-key").textContent = songs[cur].song.key;
}

// ── drawing the record ────────────────────────────────────────────────
const canvas = $("#record");
const g = canvas.getContext("2d");
const deck = $("#deck");
let W = 0;
let H = 0;
let dpr = 1;
let geo = { cx: 0, cy: 0, R: 0 };
let rotExtra = 0; // an eased correction when a jump isn't straight across
let shownR = null;
let mode = "hero";

function sizeDeck() {
  const box = deck.getBoundingClientRect();
  W = box.width;
  H = box.height;
  dpr = Math.min(2, devicePixelRatio || 1);
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  const wide = W > 680;
  geo = wide
    ? { cx: W * 0.31, cy: H * 0.3, R: Math.min(H * 0.68, W * 0.5) }
    : { cx: W * 0.36, cy: H * 0.5, R: Math.max(W * 0.62, H * 0.58) };
  songs.forEach((s) => s && (s.layer = null));
}

const rOf = (s, p) => geo.R * (0.97 - (0.97 - 0.34) * (p / s.bars));
const thOf = (p) => (-2 * Math.PI * p) / BARS_A_TURN;

function buildLayer(s) {
  const size = Math.min(2048, Math.ceil(geo.R * 2 * dpr));
  const k = size / (geo.R * 2);
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const x = c.getContext("2d");
  x.scale(k, k);
  x.translate(geo.R, geo.R);
  const R = geo.R;
  x.fillStyle = C.vinyl;
  x.beginPath();
  x.arc(0, 0, R, 0, Math.PI * 2);
  x.fill();
  // The two soft bands of light from the app's record.
  x.fillStyle = C.paper;
  x.globalAlpha = 0.045;
  for (const a of [-2.2, 0.94]) {
    x.beginPath();
    x.moveTo(0, 0);
    x.arc(0, 0, R, a, a + 1.05);
    x.closePath();
    x.fill();
  }
  x.globalAlpha = 1;
  // One groove, spiralling in, the whole song.
  x.strokeStyle = C.groove;
  x.lineWidth = 1.25;
  x.beginPath();
  for (let p = 0; p <= s.bars; p += 0.1) {
    const r = rOf(s, p);
    const th = thOf(p);
    x.lineTo(r * Math.cos(th), r * Math.sin(th));
  }
  x.stroke();
  const lr = R * 0.27;
  x.fillStyle = s === songs[0] ? C.red : C.paper;
  x.beginPath();
  x.arc(0, 0, lr, 0, Math.PI * 2);
  x.fill();
  x.fillStyle = C.night;
  x.beginPath();
  x.arc(0, 0, lr * 0.09, 0, Math.PI * 2);
  x.fill();
  // The label's text runs round the edge of it.
  const text = `${s.song.name}  ${s.song.bpm}  ${s.song.key}  ${s.song.name}  ${s.song.bpm}  ${s.song.key}  `;
  x.font = `600 ${Math.max(12, lr * 0.15)}px "Archivo Narrow", sans-serif`;
  x.textAlign = "center";
  x.textBaseline = "middle";
  const step = (Math.PI * 2) / text.length;
  [...text].forEach((ch, i) => {
    x.save();
    x.rotate(i * step);
    x.translate(0, -lr * 0.78);
    x.fillText(ch, 0, 0);
    x.restore();
  });
  s.layer = c;
}

function pathBar(s, rot, from, to) {
  g.beginPath();
  const n = Math.max(2, Math.ceil((to - from) * 14));
  for (let i = 0; i <= n; i++) {
    const p = from + ((to - from) * i) / n;
    const r = rOf(s, p);
    const a = thOf(p) + rot;
    g.lineTo(geo.cx + r * Math.cos(a), geo.cy + r * Math.sin(a));
  }
}

let played = [new Set(), new Set()];
const handState = { until: 0, from: 0, to: 0 };

function focusBar(s, p) {
  // The bar these views talk about: here, or the next one with a jump.
  const b = Math.floor(p);
  for (let i = 0; i < s.bars; i++) {
    const q = (b + i) % s.bars;
    if (s.jumps[q].some((j) => eligible(s, j.to)) && eligible(s, q)) return q;
  }
  return b;
}

function frame() {
  requestAnimationFrame(frame);
  if (!W || !songs[cur]) return;
  if (started && ctx) promote();
  const s = songs[cur];
  if (!s.layer) buildLayer(s);
  const p = posS() / s.barS;
  const target = NEEDLE - thOf(p);
  const rot = calm ? 0 : target + rotExtra;
  rotExtra *= 0.86;

  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.fillStyle = C.night;
  g.fillRect(0, 0, W, H);
  g.save();
  g.translate(geo.cx, geo.cy);
  g.rotate(rot);
  g.drawImage(s.layer, -geo.R, -geo.R, geo.R * 2, geo.R * 2);
  g.restore();

  const bar = Math.floor(p);
  const set = played[cur];
  if (started) set.add(bar);

  // Where it has been.
  g.strokeStyle = C.paper;
  g.globalAlpha = 0.34;
  g.lineWidth = 1.5;
  for (const b of set) {
    pathBar(s, rot, b, b === bar ? p : b + 1);
    g.stroke();
  }
  g.globalAlpha = 1;

  const f = focusBar(s, started ? p : 24);
  const j = pick(s, f);

  if (mode === "beats") {
    g.strokeStyle = C.paper;
    for (let q = 0; q < s.bars; q += 0.25) {
      const down = q % 1 === 0;
      const r = rOf(s, q);
      const a = thOf(q) + rot;
      const t = down ? geo.R * 0.022 : geo.R * 0.009;
      g.globalAlpha = down ? 0.95 : 0.42;
      g.lineWidth = down ? 2 : 1;
      g.beginPath();
      g.moveTo(geo.cx + (r - t) * Math.cos(a), geo.cy + (r - t) * Math.sin(a));
      g.lineTo(geo.cx + (r + t) * Math.cos(a), geo.cy + (r + t) * Math.sin(a));
      g.stroke();
    }
    g.globalAlpha = 1;
  }
  if ((mode === "compare" || mode === "jump") && j) {
    g.lineWidth = 3;
    g.strokeStyle = C.paper;
    pathBar(s, rot, f, f + 1);
    g.stroke();
    g.strokeStyle = C.red;
    for (const m of s.jumps[f].filter((x) => eligible(s, x.to)).slice(0, 3)) {
      pathBar(s, rot, m.to, m.to + 1);
      g.stroke();
    }
  }
  if (mode === "context" && j) {
    g.lineWidth = 3;
    g.strokeStyle = C.paper;
    pathBar(s, rot, f - CONTEXT_BARS, f + CONTEXT_BARS);
    g.stroke();
    g.strokeStyle = C.red;
    pathBar(s, rot, j.to - CONTEXT_BARS, j.to + CONTEXT_BARS);
    g.stroke();
  }

  // The needle's place, eased a little across the grooves when the song jumps.
  const r = rOf(s, p);
  shownR = shownR === null || calm ? r : shownR + (r - shownR) * 0.2;
  const na = calm ? thOf(p) : NEEDLE;
  const nx = geo.cx + shownR * Math.cos(na);
  const ny = geo.cy + shownR * Math.sin(na);
  g.fillStyle = C.red;
  g.beginPath();
  g.arc(nx, ny, Math.max(5, geo.R * 0.012), 0, Math.PI * 2);
  g.fill();

  driveFinger(nx, ny, s);

  if (bar !== frame.bar) {
    frame.bar = bar;
    $("#obi-bar").textContent = `bar ${bar + 1}`;
    updatePair();
  }
}

// ── the pencil finger ─────────────────────────────────────────────────
const finger = $("#finger");
const FRAMES = [0, 1, 2].map((i) => `assets/hand/hand${i}.webp`);
const GRIPS = [0, 1, 2].map((i) => `assets/hand/grip${i}.webp`);
[...FRAMES, ...GRIPS].forEach((u) => {
  new Image().src = u;
});
const TWOS = 1000 / 12; // hand-drawn motion moves on twos
const ARRIVE = 1000;
const LEAVE = 650;
let fingerRun = null;

function playFinger(untilS, from, to) {
  if (calm) return;
  const s = songs[cur];
  fingerRun = {
    t0: performance.now(),
    arrive: Math.min(ARRIVE, untilS * 1000 - 100),
    seam: untilS * 1000,
    fromR: rOf(s, from),
    toR: rOf(s, to),
  };
  finger.hidden = false;
}

function driveFinger(nx, ny, s) {
  if (!fingerRun) return;
  const now = performance.now();
  const t = Math.floor((now - fingerRun.t0) / TWOS) * TWOS;
  const width = Math.max(220, H * 0.56);
  const scale = width / 537;
  // The tip of the finger, measured on the drawing; the arm runs away towards the right-hand edge.
  const tipX = 0.116 * 537 * scale;
  const tipY = 0.03 * 1125 * scale;
  const armA = (-52 * Math.PI) / 180;
  const dirX = Math.cos(armA + 1.26);
  const dirY = Math.sin(armA + 1.26);
  const away = Math.max(W, H) * 0.9;
  let dist = 0;
  const { arrive, seam: atSeam } = fingerRun;
  const dragStart = atSeam - 280;
  const leaveStart = atSeam + 260;
  if (t < arrive) {
    const x = 1 - t / arrive;
    dist = away * x * x;
  } else if (t > leaveStart) {
    const x = (t - leaveStart) / LEAVE;
    dist = away * x * x;
    if (x >= 1) {
      fingerRun = null;
      finger.hidden = true;
      return;
    }
  }
  // Before the seam the finger rests where the needle is; through the seam it pushes it across.
  let radius = fingerRun.fromR;
  if (t >= dragStart) radius = fingerRun.fromR + (fingerRun.toR - fingerRun.fromR) * Math.min(1, (t - dragStart) / (leaveStart - dragStart));
  const x = geo.cx + radius * Math.cos(NEEDLE) + dirX * dist;
  const y = geo.cy + radius * Math.sin(NEEDLE) + dirY * dist;
  const c = Math.cos(armA);
  const sn = Math.sin(armA);
  finger.style.width = `${width}px`;
  finger.style.height = "auto";
  finger.style.transform = `translate(${x - (tipX * c - tipY * sn)}px, ${y - (tipX * sn + tipY * c)}px) rotate(${armA}rad)`;
  const fr = Math.floor(t / (TWOS * 2)) % 3;
  if (finger.dataset.f !== String(fr)) {
    finger.dataset.f = String(fr);
    finger.src = FRAMES[fr];
  }
}

// ── the map of the song ───────────────────────────────────────────────
function paintMatrix() {
  const s = songs[0];
  const m = $("#matrix");
  m.width = m.height = s.bars;
  const x = m.getContext("2d");
  const img = x.createImageData(s.bars, s.bars);
  const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [a, b] = [rgb(C.vinyl), rgb(C.paper)];
  for (let i = 0; i < s.bars; i++) {
    for (let j = 0; j < s.bars; j++) {
      const v = i === j ? 1 : Math.min(1, s.lines[i][j] * 3.5);
      const o = (i * s.bars + j) * 4;
      for (let c = 0; c < 3; c++) img.data[o + c] = a[c] + (b[c] - a[c]) * v;
      img.data[o + 3] = 255;
    }
  }
  x.putImageData(img, 0, 0);
}

function updatePair() {
  const s = songs[cur];
  if (!s) return;
  const f = focusBar(s, started ? posS() / s.barS : 24);
  const j = pick(s, f);
  if (j) $("#pair").textContent = `Bars ${f + 1} and ${j.to + 1} match, ${j.score.toFixed(2)} out of 1`;
}

// ── the sections that play along ──────────────────────────────────────
const watcher = new IntersectionObserver(
  (entries) => {
    for (const e of entries) if (e.isIntersecting) mode = e.target.dataset.mode ?? "hero";
  },
  { rootMargin: "-45% 0px -45% 0px" },
);
document.querySelectorAll(".step, .hero").forEach((n) => watcher.observe(n));

let gripTimer = 0;
function animateGrips() {
  if (calm) return;
  const grips = document.querySelectorAll(".grip");
  let i = 0;
  clearInterval(gripTimer);
  gripTimer = setInterval(() => {
    i++;
    grips.forEach((g2, k) => {
      g2.src = GRIPS[(i + k) % 3];
    });
    if (i > 12) clearInterval(gripTimer);
  }, TWOS * 2);
}

// ── rings: the versions ───────────────────────────────────────────────
const RINGS = [
  ["Original", "#2C261E", "The file as it is, levelled to -14 LUFS like everything else."],
  ["Vinyl", "#3A281D", "Band-passed and warmed, with hiss, pops and a slow wow. The owner picked it blind."],
  ["Slowed + reverb", "#272139", "0.8 times the speed, in a large reverb."],
  ["Nightcore", "#25303F", "1.3 times the speed, so the pitch rises with it, and a little extra top."],
  ["Sped up", "#23312A", "Faster and higher."],
];
function buildRings() {
  const host = $("#rings");
  const size = 560;
  const c = size / 2;
  const band = 42;
  const outer = 262;
  let on = 1;
  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
  svg.setAttribute("role", "group");
  svg.setAttribute("aria-label", "Versions of one song, each a ring of a record");
  const el = (n, a, parent = svg) => {
    const e = document.createElementNS(svgNS, n);
    Object.entries(a).forEach(([k, v]) => e.setAttribute(k, v));
    parent.appendChild(e);
    return e;
  };
  el("circle", { cx: c, cy: c, r: c - 2, fill: C.vinyl });
  const paints = [];
  RINGS.forEach(([name, tone, note], i) => {
    const r = outer - i * band;
    const ring = el("circle", { cx: c, cy: c, r, class: "ring", "stroke-width": band - 4, stroke: tone, tabindex: 0, role: "button", "aria-label": name });
    const id = `ring-path-${i}`;
    const tr = r - 6;
    el("path", { id, d: `M${c - tr} ${c} A${tr} ${tr} 0 0 1 ${c + tr} ${c}`, fill: "none" });
    const text = el("text", { "text-anchor": "middle" });
    const tp = el("textPath", { href: `#${id}`, startOffset: "50%" }, text);
    tp.textContent = name;
    const choose = () => {
      on = i;
      paint();
    };
    ring.addEventListener("click", choose);
    ring.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        choose();
      }
    });
    paints.push({ ring, text, tone, note });
  });
  el("circle", { cx: c, cy: c, r: outer - RINGS.length * band + band / 2 - 8, fill: C.red });
  el("circle", { cx: c, cy: c, r: 8, fill: C.night });
  function paint() {
    paints.forEach((p, i) => {
      p.ring.setAttribute("stroke", i === on ? C.paper : p.tone);
      p.text.setAttribute("fill", i === on ? C.night : C.paper);
    });
    $("#ring-note").textContent = paints[on].note;
  }
  paint();
  host.appendChild(svg);
}

// ── the helmet buttons ────────────────────────────────────────────────
const WINDOW_MS = 420;
const KEYS = { play: { n: 0, t: 0 }, next: { n: 0, t: 0 }, prev: { n: 0, t: 0 } };

function beep(count) {
  ensureAudio();
  const go = () => {
    const o = ctx.createOscillator();
    const v = ctx.createGain();
    o.frequency.value = count > 1 ? 1100 : 880;
    v.gain.setValueAtTime(0.0001, ctx.currentTime);
    v.gain.exponentialRampToValueAtTime(0.12, ctx.currentTime + 0.008);
    v.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.09);
    o.connect(v).connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.1);
  };
  if (ctx.state === "running") go();
  else ctx.resume().then(() => { go(); if (!playing) setTimeout(() => ctx.suspend(), 150); });
}

function act(key, n) {
  const say = (t) => {
    $("#press").textContent = t;
  };
  beep(n);
  if (key === "play") {
    if (n === 1) {
      toggle();
      return say(`×1: ${playing ? "pause" : "play"}`);
    }
    return say(n === 2 ? "×2: Vinyl, on the phone. This page only plays it straight." : "×3: Next station, on the phone. This page has no stations.");
  }
  if (key === "next") {
    cross();
    return say(n === 1 ? "×1: to the next portal" : "×2: a new song now");
  }
  if (n === 1) {
    if (started) restart();
    return say("×1: from the top");
  }
  setForever(!forever);
  return say(`×2: Forever ${forever ? "on" : "off"}`);
}

document.querySelectorAll("[data-key]").forEach((b) => {
  b.addEventListener("click", () => {
    const k = KEYS[b.dataset.key];
    k.n++;
    clearTimeout(k.t);
    k.t = setTimeout(() => {
      const n = k.n;
      k.n = 0;
      act(b.dataset.key, n);
    }, WINDOW_MS);
  });
});

function setForever(on) {
  forever = on;
  const b = $("#forever");
  b.classList.toggle("on", on);
  b.setAttribute("aria-pressed", String(on));
  if (songs[cur]) status();
}

// ── wiring ────────────────────────────────────────────────────────────
document.querySelectorAll("[data-toggle]").forEach((b) => b.addEventListener("click", toggle));
$("#forever").addEventListener("click", () => setForever(!forever));
$("#jump-good").addEventListener("click", jumpGood);
$("#jump-bad").addEventListener("click", jumpBad);
$("#cross").addEventListener("click", cross);
new ResizeObserver(sizeDeck).observe(deck);
setInterval(plan, 120);
buildRings();
sizeDeck();
document.fonts?.ready.then(() => songs.forEach((s) => s && (s.layer = null)));
requestAnimationFrame(frame);
