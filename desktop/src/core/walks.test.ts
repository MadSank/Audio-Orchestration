// Ports of ForeverWalkTest.kt and MixWalkTest.kt: the desktop walks follow the phone's rules.
import { describe, expect, it } from "vitest";
import { barAt, barTimes, parseBundle, type Bundle, type Jump, type Section } from "./bundle";
import { AVOID_MAX_USES, ForeverWalk } from "./foreverWalk";
import { makeTrack, MixWalk, MIN_DWELL_S, parseGraph, Seams, type Edge, type GraphTrack, type Move, type PortalGraph } from "./mixWalk";
import { Rng } from "./rng";

const jump = (fromBar: number, toBar: number, score: number, label: string, kind = "repeat"): Jump => ({ fromBar, toBar, score, kind, label });

describe("ForeverWalk", () => {
  // 80 bars of 2 s: intro A(0-8) B1(8-24) C1(24-40) B2(40-56) C2(56-72) outro D(72-80).
  const barT = Array.from({ length: 81 }, (_, i) => i * 2);
  const sections: Section[] = [
    { startBar: 0, endBar: 8, group: 0 }, { startBar: 8, endBar: 24, group: 1 }, { startBar: 24, endBar: 40, group: 2 },
    { startBar: 40, endBar: 56, group: 1 }, { startBar: 56, endBar: 72, group: 2 }, { startBar: 72, endBar: 80, group: 3 },
  ];
  const jumps = [jump(44, 12, 0.92, "B2:5 → B1:5"), jump(14, 46, 0.9, "B1:7 → B2:7"), jump(60, 28, 0.88, "C2:5 → C1:5"), jump(30, 62, 0.86, "C1:7 → C2:7")];
  const forever = (seed: number, loopable = true) => new ForeverWalk(barT, sections, jumps, 72, loopable, seed);

  type Taken = { atS: number; from: number; to: number; why: string };
  function walk(w: ForeverWalk, seconds: number): [Taken[], boolean] {
    const taken: Taken[] = [];
    let t = 0;
    let bar = -1;
    while (t < seconds) {
      const next = bar + 1;
      const s = w.step(next);
      if (s.kind === "end") return [taken, true];
      if (s.jump) taken.push({ atS: t, from: next, to: s.bar, why: s.why });
      bar = s.bar;
      t += barT[bar + 1] - barT[bar];
    }
    return [taken, false];
  }

  it("takes the last backward jump before the outro as the last chance", () => {
    expect(forever(1).lastBack).toBe(60);
  });

  it("never takes a jump twice in one visit", () => {
    for (let seed = 0; seed < 20; seed++) {
      const pairs = walk(forever(seed), 3600)[0].map((j) => `${j.from}>${j.to}`);
      expect(new Set(pairs).size).toBe(pairs.length);
    }
  });

  it("gives the jumps back on a new visit or a restart", () => {
    const w = forever(3);
    const [first, ended] = walk(w, 3600);
    expect(first.length > 0 && ended).toBe(true);
    w.repeatOne();
    expect(walk(w, 3600)[0].length).toBeGreaterThan(0);
    const v = forever(4);
    walk(v, 3600);
    v.newVisit();
    expect(walk(v, 3600)[0].length).toBeGreaterThan(0);
  });

  it("avoids the ending once, then lets it arrive", () => {
    for (let seed = 0; seed < 10; seed++) {
      const [taken, ended] = walk(forever(seed), 3600);
      const avoid = taken.filter((j) => j.why === "avoid the ending");
      expect(avoid.length).toBeGreaterThan(0);
      const counts = new Map<string, number>();
      for (const j of avoid) counts.set(`${j.from}>${j.to}`, (counts.get(`${j.from}>${j.to}`) ?? 0) + 1);
      expect([...counts.values()].every((c) => c <= AVOID_MAX_USES)).toBe(true);
      expect(ended).toBe(true);
    }
  });

  it("never lands a paced jump within a minute of the last chance, and waits a minute first", () => {
    for (let seed = 0; seed < 20; seed++) {
      const taken = walk(forever(seed), 3600)[0];
      for (const j of taken.filter((x) => x.why === "pacing")) expect(barT[60] - barT[j.to]).toBeGreaterThanOrEqual(60);
      const first = taken.find((x) => x.why === "pacing");
      if (first) expect(first.atS).toBeGreaterThanOrEqual(60);
    }
  });

  it("sends songs that aren't loopable straight to the ending", () => {
    const w = forever(1, false);
    expect(w.lastBack).toBeNull();
    const [taken, ended] = walk(w, 3600);
    expect(ended).toBe(true);
    expect(taken.some((j) => j.why === "avoid the ending")).toBe(false);
  });
});

describe("Bundle", () => {
  it("runs the last bar to the end of the audio", () => {
    const b = { beats: [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5], downbeats: [0, 4, 8] } as Bundle;
    expect(barTimes(b, 5.2)).toEqual([0.5, 2.5, 5.2]);
    expect(barAt([0.5, 2.5, 5.2], 3)).toBe(1);
    expect(barAt([0.5, 2.5, 5.2], 0.1)).toBe(-1);
  });

  it("ignores older schemas", () => {
    expect(parseBundle('{"schema": "saics.analysis/8", "beats": [], "downbeats": []}')).toBeNull();
  });
});

describe("MixWalk", () => {
  const secs: Section[] = Array.from({ length: 5 }, (_, i) => ({ startBar: i * 16, endBar: i * 16 + 16, group: i }));
  const kinds = Array.from({ length: 5 }, (_, i) => (i % 2 === 1 ? "chorus" : "verse"));
  const barT = Array.from({ length: 81 }, (_, i) => i * 2);
  const edge = (fromBar: number, to: string, toBar: number, sameGroup = false, score = 0.9, offsetMs = 0): Edge => ({
    fromBar, to, toBar, score, pair: "chorus → chorus", sameGroup, offsetMs,
  });
  const track = (id: string, group = id, portals: Edge[] = [], walkable = true): GraphTrack =>
    makeTrack({ id, file: `${id}.mp3`, group, bpm: 120, camelot: "8A", sections: kinds, bars: 80, entries: [8, 0], breakExits: new Set(), portals, walkable });
  const graph = (...t: GraphTrack[]): PortalGraph => new Map(t.map((x) => [x.id, x]));
  const go = (w: MixWalk, g: PortalGraph, id: string, jumps: Jump[] = [], came: [string, number, number] | null = null) =>
    w.enter(g.get(id)!, barT, secs, jumps, null, true, 0, came);
  function playUntilLeave(w: MixWalk, from = 0, limit = 4000): Move | null {
    let bar = from;
    for (let i = 0; i < limit; i++) {
      const d = w.step(bar);
      if (d.kind === "carry") bar++;
      else if (d.kind === "jump") bar = d.jump.toBar + 1;
      else return d.move;
    }
    return null;
  }

  it("waits for the dwell before a portal", () => {
    const g = graph(track("a", "a", [edge(4, "b", 8), edge(40, "b", 8)]), track("b"));
    const w = new MixWalk(g, new Rng(1));
    go(w, g, "a");
    const m = playUntilLeave(w)!;
    expect(m.at).toBe(40);
    expect(m.kind).toBe("portal");
    expect(w.t).toBeGreaterThanOrEqual(MIN_DWELL_S);
  });

  it("goes to another version only with Forever", () => {
    const g = graph(track("a", "song", [edge(40, "b", 40, true), edge(48, "c", 8)]), track("b", "song"), track("c"));
    const w = new MixWalk(g, new Rng(1));
    go(w, g, "a");
    expect(playUntilLeave(w)!.to).toBe("c");
    const f = new MixWalk(g, new Rng(1));
    f.forever = true;
    go(f, g, "a");
    expect(playUntilLeave(f)!.to).toBe("b");
  });

  it("doesn't go straight back to a song it just left", () => {
    const g = graph(track("a", "a", [edge(40, "b", 8)]), track("b", "b", [edge(40, "a", 8), edge(48, "c", 8)]), track("c"));
    const w = new MixWalk(g, new Rng(1));
    go(w, g, "a");
    expect(playUntilLeave(w)!.to).toBe("b");
    w.left();
    go(w, g, "b");
    expect(playUntilLeave(w)!.to).toBe("c");
  });

  it("leaves a dead end back through the portal it came in by", () => {
    const g = graph(track("a", "a", [edge(40, "b", 8)]), track("b"), track("c"));
    const w = new MixWalk(g, new Rng(3));
    go(w, g, "a");
    w.left();
    go(w, g, "b", [jump(40, 8, 0.9, "loop")], ["a", 40, 8]);
    const m = playUntilLeave(w, 8)!;
    expect(m.kind).toBe("back");
    expect(m.to).toBe("a");
    expect(m.toBar - 40).toBe(m.at - 8);
    expect(m.at - 8).toBeLessThanOrEqual(3);
  });

  it("is never trapped", () => {
    const g = graph(track("a"), track("b"), track("c"));
    for (let seed = 0; seed < 20; seed++) {
      const w = new MixWalk(g, new Rng(seed));
      go(w, g, "a", [jump(70, 20, 0.9, "loop")]);
      expect(playUntilLeave(w)).not.toBeNull();
    }
  });

  it("repeats the only song in the pool", () => {
    const g = graph(track("a"));
    const w = new MixWalk(g, new Rng(1));
    go(w, g, "a");
    expect(playUntilLeave(w)!.kind).toBe("end");
  });

  it("never cuts to another song in Forever", () => {
    const g = graph(track("a", "song"), track("c", "other"));
    const w = new MixWalk(g, new Rng(1));
    w.forever = true;
    go(w, g, "a");
    expect(playUntilLeave(w)!.kind).toBe("end");
    expect(w.nextNow(10)).toBeNull();
  });

  it("drops an offer on Stay and holds the fallbacks", () => {
    const g = graph(track("a", "a", [edge(60, "b", 8)]), track("b"));
    const w = new MixWalk(g, new Rng(1));
    go(w, g, "a");
    for (let b = 0; b < 50; b++) expect(w.step(b).kind).toBe("carry");
    const offer = w.peek(50)!;
    expect(offer.at).toBe(60);
    w.stay(offer);
    expect(w.peek(50)).toBeNull();
    for (let b = 50; b < 62; b++) expect(w.step(b).kind).toBe("carry");
  });

  it("takes a close portal on Next, else cuts on the phrase", () => {
    const g = graph(track("a", "a", [edge(40, "b", 8), edge(72, "c", 8)]), track("b"), track("c"));
    const w = new MixWalk(g, new Rng(1));
    go(w, g, "a");
    const near = w.nextNow(38)!;
    expect([near.kind, near.at]).toEqual(["portal", 40]);
    expect(w.nextNow(35)!.kind).toBe("cut");
    const far = w.nextNow(50)!;
    expect([far.kind, far.at, far.to]).toEqual(["cut", 52, "c"]);
  });

  it("goes to a different song on a double Next in Forever", () => {
    const g = graph(track("a", "song", [edge(40, "v", 8, true), edge(40, "c", 8), edge(70, "d", 16)]), track("v", "song"), track("c"), track("d"), track("e"));
    const w = new MixWalk(g, new Rng(3));
    w.forever = true;
    go(w, g, "a");
    const close = w.newSong(38)!;
    expect([close.kind, close.at, close.to]).toEqual(["portal", 40, "c"]);
    const far = w.newSong(10)!;
    expect([far.kind, far.at]).toEqual(["cut", 11]);
    expect(["c", "d"]).toContain(far.to);
    const lone = graph(track("a", "song"), track("v", "song"), track("e"));
    const l = new MixWalk(lone, new Rng(3));
    l.forever = true;
    go(l, lone, "a");
    expect(l.newSong(10)!.to).toBe("e");
  });

  it("never walks into a song that won't play, or an unwalkable one", () => {
    const g = graph(track("a", "a", [edge(40, "b", 8), edge(48, "c", 8)]), track("b"), track("c"));
    const w = new MixWalk(g, new Rng(1));
    go(w, g, "a");
    w.markBad("b");
    expect(playUntilLeave(w)!.to).toBe("c");
    expect(w.fallback).not.toBe("b");
    const g2 = graph(track("a", "a", [edge(40, "lofi", 8), edge(48, "b", 8)]), track("b"), track("lofi", "lofi", [], false));
    const w2 = new MixWalk(g2, new Rng(1));
    go(w2, g2, "a");
    expect(playUntilLeave(w2)!.to).toBe("b");
    expect(w2.fallback).not.toBe("lofi");
  });

  it("moves only a portal's seam early, into a song's middle", () => {
    expect(Seams.earlyMs("portal", 8)).toBe(Seams.EARLY_MS);
    expect(Seams.earlyMs("back", 8)).toBe(Seams.EARLY_MS);
    expect(Seams.earlyMs("portal", 0)).toBe(0);
    expect(Seams.earlyMs("cut", 8)).toBe(0);
  });

  it("carries a portal's nudge, and going back undoes it", () => {
    const g = graph(track("a", "a", [edge(40, "b", 8, false, 0.9, 12.5)]), track("b"));
    const w = new MixWalk(g, new Rng(1));
    go(w, g, "a");
    expect(playUntilLeave(w)!.offsetMs).toBe(12.5);
    w.enter(g.get("b")!, barT, secs, [jump(40, 8, 0.9, "loop")], null, true, 0, ["a", 40, 8], 12.5);
    const back = playUntilLeave(w, 8)!;
    expect(back.kind).toBe("back");
    expect(back.offsetMs).toBe(-12.5);
  });

  it("parses the graph", () => {
    const g = parseGraph(
      '{"schema":"saics.portals/2","generated":"x","tracks":{"a":{"file":"a.mp3","group":"g","bpm":120.0,"camelot":"8A","sections":["intro"],"bars":40,"entries":[8,0],"break_exits":[12],"walkable":false,"portals":[{"from_bar":8,"to":"b","to_bar":4,"score":0.8,"pair":"chorus → chorus","same_group":false,"offset_ms":-7.5}]}}}',
    )!;
    const a = g.get("a")!;
    expect(a.exits).toBe(1);
    expect(a.portals[0].fromBar).toBe(8);
    expect(a.portals[0].offsetMs).toBe(-7.5);
    expect(a.walkable).toBe(false);
    expect(a.file).toBe("a.mp3");
    expect(parseGraph('{"schema":"saics.portals/1","tracks":{}}')).toBeNull();
  });
});
