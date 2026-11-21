// Two short original songs, synthesised here so the page carries no recording, and the same test
// the engine runs on a real song (engine/saics/jumps.py), cut down to what fits in a browser.

export const SR = 32000;
const BEATS = 4;
const midi = (n) => 440 * 2 ** ((n - 69) / 12);

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296 - 0;
  };
}

// Sections are in eight-bar phrases, so a phrase that comes back sits straight across the grooves.
export const SONGS = [
  {
    name: "First demo song",
    bpm: 116,
    key: "8A",
    seed: 7,
    plan: ["intro", "verse", "verse2", "chorus", "chorus2", "break", "verse", "verse2", "chorus", "chorus2", "outro"],
    chords: {
      intro: [[57, 60, 64, 67], [53, 57, 60, 64], [48, 52, 55, 59], [55, 59, 62, 65]],
      verse: [[57, 60, 64, 67], [53, 57, 60, 64], [48, 52, 55, 59], [55, 59, 62, 65]],
      verse2: [[57, 60, 64, 67], [53, 57, 60, 64], [50, 53, 57, 60], [52, 56, 59, 62]],
      chorus: [[53, 57, 60, 64], [55, 59, 62, 65], [52, 55, 59, 62], [57, 60, 64, 67]],
      chorus2: [[53, 57, 60, 64], [55, 59, 62, 65], [48, 52, 55, 59], [52, 56, 59, 62]],
      break: [[50, 53, 57, 60], [48, 52, 55, 59], [53, 57, 60, 64], [52, 56, 59, 62]],
      outro: [[57, 60, 64, 67], [53, 57, 60, 64], [48, 52, 55, 59], [57, 60, 64, 67]],
    },
    lead: [76, 72, 69, 72, 74, 72, 67, 64],
    swing: 0,
  },
  {
    name: "Second demo song",
    bpm: 116,
    key: "8B",
    seed: 23,
    plan: ["intro", "verse", "verse2", "chorus", "chorus2", "verse", "verse2", "chorus", "chorus2", "outro"],
    chords: {
      intro: [[48, 52, 55, 59], [45, 48, 52, 55], [41, 45, 48, 52], [43, 47, 50, 53]],
      verse: [[48, 52, 55, 59], [45, 48, 52, 55], [41, 45, 48, 52], [43, 47, 50, 53]],
      verse2: [[48, 52, 55, 59], [52, 55, 59, 62], [45, 48, 52, 55], [43, 47, 50, 53]],
      chorus: [[41, 45, 48, 52], [48, 52, 55, 59], [43, 47, 50, 53], [45, 48, 52, 55]],
      chorus2: [[41, 45, 48, 52], [48, 52, 55, 59], [43, 47, 50, 53], [48, 52, 55, 59]],
      outro: [[48, 52, 55, 59], [45, 48, 52, 55], [41, 45, 48, 52], [48, 52, 55, 59]],
    },
    lead: [79, 76, 72, 76, 74, 72, 74, 79],
    swing: 0.06,
  },
];

const PHRASE = 8;

/** Where each bar sits in the song, one name per bar. */
export function barsOf(song) {
  return song.plan.flatMap((name) => Array(PHRASE).fill(name));
}

function add(out, at, n, fn) {
  const s = Math.round(at * SR);
  const end = Math.min(out.length, s + n);
  for (let i = Math.max(0, s); i < end; i++) out[i] += fn((i - s) / SR, i - s);
}

/** Renders a song a few bars at a time, so the page never freezes while it does. */
export async function renderSong(song, onYield = () => new Promise((r) => setTimeout(r))) {
  const barS = (60 / song.bpm) * BEATS;
  const beat = barS / BEATS;
  const names = barsOf(song);
  const len = Math.ceil((names.length * barS + 3) * SR);
  const dry = new Float32Array(len);
  const wet = new Float32Array(len);
  const noise = new Float32Array(SR);
  const r = rng(song.seed);
  for (let i = 0; i < noise.length; i++) noise[i] = r() * 2 - 1;

  const kick = (t) => {
    add(dry, t, SR * 0.22, (x) => Math.sin(2 * Math.PI * (48 * x + (110 / 34) * (1 - Math.exp(-34 * x)))) * Math.exp(-13 * x) * 0.9);
  };
  const snare = (t, v = 1) => {
    let lp = 0;
    add(dry, t, SR * 0.2, (x, i) => {
      lp += 0.5 * (noise[i % SR] - lp);
      return v * (0.32 * (noise[i % SR] - lp) * Math.exp(-17 * x) + 0.16 * Math.sin(2 * Math.PI * 186 * x) * Math.exp(-26 * x));
    });
  };
  const hat = (t, v) => {
    let lp = 0;
    add(dry, t, SR * 0.05, (x, i) => {
      const n = noise[(i * 7) % SR];
      lp += 0.72 * (n - lp);
      return (n - lp) * v * Math.exp(-85 * x);
    });
  };
  const bass = (t, note, d) => {
    const f = midi(note);
    add(dry, t, SR * d, (x) => {
      const p = 2 * Math.PI * f * x;
      const e = Math.min(1, x * 180) * Math.min(1, (d - x) * 40);
      return (Math.sin(p) + 0.3 * Math.sin(2 * p) + 0.1 * Math.sin(3 * p)) * e * 0.32;
    });
  };
  const keys = (t, notes, d, v) => {
    for (const note of notes) {
      const f = midi(note);
      add(dry, t, SR * d, (x) => {
        const p = 2 * Math.PI * f * x;
        const e = Math.min(1, x * 120) * Math.exp(-3.1 * x) * Math.min(1, (d - x) * 30);
        return (Math.sin(p) + 0.32 * Math.sin(2 * p) * Math.exp(-5 * x) + 0.12 * Math.sin(4 * p) * Math.exp(-11 * x)) * e * v;
      });
    }
  };
  const pad = (t, notes, d, v) => {
    for (const note of notes) {
      const f = midi(note);
      add(dry, t, SR * d, (x) => {
        const e = Math.min(1, x * 3) * Math.min(1, (d - x) * 3);
        return (Math.sin(2 * Math.PI * f * x) + Math.sin(2 * Math.PI * f * 1.004 * x) + 0.3 * Math.sin(4 * Math.PI * f * x)) * e * v;
      });
    }
  };
  const lead = (t, note, d, v) => {
    const f = midi(note);
    add(wet, t, SR * d, (x) => {
      const vib = 1 + 0.003 * Math.sin(2 * Math.PI * 5.2 * x) * Math.min(1, x * 3);
      const p = 2 * Math.PI * f * vib * x;
      const e = Math.min(1, x * 150) * Math.exp(-2.6 * x) * Math.min(1, (d - x) * 30);
      return (Math.sin(p) + 0.45 * Math.sin(2 * p) * Math.exp(-3 * x) + 0.2 * Math.sin(3 * p) * Math.exp(-6 * x)) * e * v;
    });
  };

  for (let bar = 0; bar < names.length; bar++) {
    const name = names[bar];
    const inPhrase = bar % PHRASE;
    const t0 = bar * barS;
    const chord = song.chords[name][Math.floor(inPhrase / 2)];
    const root = chord[0] - 12 * (chord[0] >= 52 ? 2 : 1);
    const at = (b) => t0 + (b + (b % 1 ? song.swing : 0)) * beat;
    const full = name.startsWith("verse") || name.startsWith("chorus");
    const chorus = name.startsWith("chorus");

    if (name === "intro" || name === "break" || name === "outro") pad(t0, chord, barS, name === "break" ? 0.045 : 0.05);
    if (full || name === "outro") {
      kick(at(0));
      kick(at(2));
      if (inPhrase % 2 === 1) kick(at(2.5));
      snare(at(1));
      snare(at(3));
    }
    if (name !== "break") for (let b = 0; b < 4; b += 0.5) hat(at(b), (b % 1 ? 0.13 : 0.2) * (chorus ? 1.25 : 1));
    if (name === "break") for (const b of [0, 1.5, 3]) hat(at(b), 0.16);
    if (name !== "intro") {
      bass(at(0), root, beat * 1.4);
      bass(at(1.5), root, beat * 0.45);
      bass(at(2), root + 12, beat * 0.45);
      bass(at(2.5), root + (inPhrase % 2 ? 7 : 0), beat * 1.3);
    }
    for (const b of chorus ? [0, 0.5, 1.5, 2.5, 3.5] : [0.5, 1.5, 3]) keys(at(b), chord, beat * 1.1, chorus ? 0.05 : 0.055);
    if (chorus) {
      const off = name === "chorus2" ? 2 : 0;
      for (let i = 0; i < 4; i++) lead(at(i), song.lead[(inPhrase * 2 + i + off) % song.lead.length], beat * 1.2, 0.12);
    } else if (name === "verse2" && inPhrase % 2) {
      lead(at(1), song.lead[inPhrase % song.lead.length] - 12, beat * 2.2, 0.1);
    } else if (name === "verse" && inPhrase % 4 === 3) {
      lead(at(2), song.lead[3] - 12, beat * 1.6, 0.09);
    }
    if (inPhrase === PHRASE - 1 && full) for (const b of [3, 3.25, 3.5, 3.75]) snare(at(b), 0.75);
    if (bar % 6 === 5) await onYield();
  }

  // A dotted echo for the lead, then the two buses together with a gentle limit.
  const gap = Math.round(beat * 0.75 * SR);
  for (let i = gap; i < len; i++) wet[i] += wet[i - gap] * 0.32;
  await onYield();
  let peak = 0;
  for (let i = 0; i < len; i++) {
    const v = Math.tanh((dry[i] + wet[i]) * 1.15);
    dry[i] = v;
    if (Math.abs(v) > peak) peak = Math.abs(v);
  }
  const g = 0.86 / (peak || 1);
  const fadeAt = (names.length - PHRASE) * barS * SR;
  const fadeLen = PHRASE * barS * SR;
  for (let i = 0; i < len; i++) {
    const f = i > fadeAt ? Math.max(0, 1 - (i - fadeAt) / fadeLen) : 1;
    dry[i] *= g * f;
  }
  return { samples: dry, barS, bars: names.length, names };
}

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const a = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const c = Math.cos(a * k);
        const s = Math.sin(a * k);
        const p = i + k;
        const q = p + len / 2;
        const tr = re[q] * c - im[q] * s;
        const ti = re[q] * s + im[q] * c;
        re[q] = re[p] - tr;
        im[q] = im[p] - ti;
        re[p] += tr;
        im[p] += ti;
      }
    }
  }
}

/** One fingerprint per bar: which notes sound (harmony), and how bright it is (timbre). */
function fingerprints({ samples, barS, bars }) {
  const N = 2048;
  const hann = Float32Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
  const re = new Float32Array(N);
  const im = new Float32Array(N);
  const out = [];
  for (let b = 0; b < bars; b++) {
    const chroma = new Float64Array(12);
    const bands = new Float64Array(14);
    const start = Math.round(b * barS * SR);
    const end = Math.round((b + 1) * barS * SR);
    for (let s = start; s + N <= end; s += N * 2) {
      for (let i = 0; i < N; i++) {
        re[i] = samples[s + i] * hann[i];
        im[i] = 0;
      }
      fft(re, im);
      for (let k = 2; k < N / 2; k++) {
        const f = (k * SR) / N;
        const m = re[k] * re[k] + im[k] * im[k];
        if (f > 80 && f < 2000) {
          const pc = ((Math.round(12 * Math.log2(f / 440)) % 12) + 12) % 12;
          chroma[pc] += m;
        }
        bands[Math.min(13, Math.floor(2 * Math.log2(f / 50)) < 0 ? 0 : Math.floor(2 * Math.log2(f / 50)))] += m;
      }
    }
    const c = Math.sqrt(chroma.reduce((a, v) => a + v * v, 0)) || 1;
    out.push({
      chroma: Array.from(chroma, (v) => v / c),
      bands: Array.from(bands, (v) => Math.log10(v + 1e-6)),
    });
  }
  return out;
}

const cos = (a, b) => {
  let ab = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i++) {
    ab += a[i] * b[i];
    aa += a[i] * a[i];
    bb += b[i] * b[i];
  }
  return aa && bb ? ab / Math.sqrt(aa * bb) : 0;
};

// The engine's own numbers (jumps.py).
export const CONTEXT_BARS = 4;
export const MIN_JUMP_BARS = 16;
const CTX_MEAN = 0.55;
const CTX_MIN = 0.2;
const ALIGN_MARGIN = 0.04;

/** Compares every bar with every other, then keeps the pairs whose neighbours also match. */
export function findJumps(rendered) {
  const fp = fingerprints(rendered);
  const n = fp.length;
  const mean = fp[0].bands.map((_, i) => fp.reduce((a, f) => a + f.bands[i], 0) / n);
  const tim = fp.map((f) => f.bands.map((v, i) => v - mean[i]));
  const sim = Array.from({ length: n }, () => new Float32Array(n));
  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      // Harmony alone sits close to 1 for any two bars in a key, so it's stretched before use.
      const h = Math.max(0, (cos(fp[i].chroma, fp[j].chroma) - 0.5) * 2);
      const t = cos(tim[i], tim[j]);
      sim[i][j] = sim[j][i] = 0.6 * h + 0.4 * t;
    }
  }
  const stripe = (i, j) => {
    if (i < CONTEXT_BARS || j < CONTEXT_BARS || i + CONTEXT_BARS > n || j + CONTEXT_BARS > n) return { m: -1, low: -1 };
    let sum = 0;
    let low = 1;
    for (let d = -CONTEXT_BARS; d < CONTEXT_BARS; d++) {
      const v = sim[i + d][j + d];
      sum += v;
      if (v < low) low = v;
    }
    return { m: sum / (2 * CONTEXT_BARS), low };
  };
  const jumps = Array.from({ length: n }, () => []);
  for (let i = CONTEXT_BARS; i < n - CONTEXT_BARS; i++) {
    for (let j = CONTEXT_BARS; j < n - CONTEXT_BARS; j++) {
      if (Math.abs(i - j) < MIN_JUMP_BARS) continue;
      const { m, low } = stripe(i, j);
      if (m < CTX_MEAN || low < CTX_MIN) continue;
      // A bar or two off also scores well in a steady song; the true line has to stand out.
      const near = Math.max(...[-2, -1, 1, 2].map((d) => stripe(i, j + d).m));
      if (m >= near + ALIGN_MARGIN) jumps[i].push({ to: j, score: m, low });
    }
    jumps[i].sort((a, b) => b.score - a.score);
  }
  // The map on the page: how far each pair stands out from the bars just beside it, so repeats
  // read as lines and not as blocks of similar sound.
  const lines = Array.from({ length: n }, () => new Float32Array(n));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const { m } = stripe(i, j);
      if (m < 0) continue;
      lines[i][j] = Math.max(0, m - Math.max(stripe(i, j - 2).m, stripe(i, j + 2).m));
    }
  }
  return { sim, jumps, lines };
}
