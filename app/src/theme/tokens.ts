/** Design tokens: design/design/README.md. Screens use these only, never raw values. */
export const color = {
  bg: "#0A0A0C",
  bgRide: "#000000",
  bgSheet: "#050506",
  surface: "#141417",
  surfaceRaised: "#1C1C21",
  border: "#2A2A31",
  divider: "#1C1C21",
  section: "#3A3A43", // non-chorus sections
  groove: "#18181D",
  disc: "#0E0E11",
  text: "#F3EFE7",
  textMuted: "#A9A6AE",
  textFaint: "#85828A",
  amber: "#FFB547", // playback, primary action, selected
  amberInk: "#1A1206",
  amberTint: "#2A1C0A",
  amberDim: "#7A5A2A", // chorus sections
  amberEdge: "#5A4520",
  cyan: "#6FD3FF", // jumps, transitions, "next" info
  cyanTint: "#102A35",
  pink: "#FF8FA3",
  lilac: "#C9B8FF",
  danger: "#FF6B6B",
} as const;

/** Embedded fonts (static instances; on Android the family is the file name). */
export const font = {
  regular: "Archivo-Regular",
  medium: "Archivo-Medium",
  semibold: "Archivo-SemiBold",
  bold: "Archivo-Bold",
  extrabold: "Archivo-ExtraBold",
  black: "Archivo-Black",
  displayXb: "ArchivoExpanded-ExtraBold", // font-stretch 125%, weight 800
  display: "ArchivoExpanded-Black", // font-stretch 125%, weight 900
  mono: "IBMPlexMono-Regular",
  monoMedium: "IBMPlexMono-Medium",
  monoBold: "IBMPlexMono-SemiBold",
} as const;

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 24 } as const;
export const radius = { list: 12, chip: 14, row: 16, tile: 20, card: 24, sheet: 28 } as const;
export const target = { min: 44 } as const;
