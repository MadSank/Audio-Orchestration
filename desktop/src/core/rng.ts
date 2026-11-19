/** A small seeded random source (mulberry32), so the walks can be tested with fixed seeds. */
export class Rng {
  private s: number;

  constructor(seed: number = Date.now()) {
    this.s = seed >>> 0;
  }

  /** In [0, 1). */
  nextDouble(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** In [0, n). */
  nextInt(n: number): number {
    return Math.floor(this.nextDouble() * n);
  }

  /** A seed for a child walk. */
  nextSeed(): number {
    return Math.floor(this.nextDouble() * 4294967296);
  }
}
