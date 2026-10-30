/**
 * Design tokens (CLAUDE.md "Design"). The design canvas export is not in the repo yet, so
 * these follow the written spec; screens must use tokens only, never raw values.
 */
export const color = {
  bg: "#0A0A0C",
  bgRide: "#000000",
  surface: "#15151A",
  surfaceHi: "#1E1E25",
  line: "#2A2A31",
  text: "#F3EFE7",
  textMuted: "#8E8A82",
  amber: "#FFB547", // playback + primary actions
  cyan: "#6FD3FF", // jumps + transitions
  danger: "#FF6B6B",
} as const;

export const font = {
  display: "sans-serif-condensed", // Archivo (expanded) once the font files are bundled
  body: "sans-serif",
  mono: "monospace", // IBM Plex Mono once bundled
} as const;

export const type = {
  display: { fontSize: 32, lineHeight: 36, fontWeight: "700" as const, letterSpacing: 0.5 },
  title: { fontSize: 22, lineHeight: 28, fontWeight: "700" as const },
  body: { fontSize: 16, lineHeight: 22 },
  label: { fontSize: 13, lineHeight: 18, letterSpacing: 0.6 },
  mono: { fontSize: 13, lineHeight: 18 },
} as const;

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
export const radius = { sm: 8, md: 12, lg: 16, pill: 999 } as const;

/** Ride mode: giant targets only (PLAN "Riding and safety rules"). */
export const ride = { minTarget: 96 } as const;
