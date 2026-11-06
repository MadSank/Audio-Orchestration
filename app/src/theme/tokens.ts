/** Design tokens: the "Final" page of the design canvas. Screens use these only, never raw values. */
export const color = {
  night: "#0E0C0A",
  ride: "#000000",
  vinyl: "#16130F",
  groove: "#2E2922",
  grooveLit: "#3A332A",
  paper: "#EEE5D3",
  paperDim: "#CFC5B0",
  vermilion: "#E8452A",
  unread: "#5C5548",
} as const;

/** Embedded fonts (static instances; on Android the family is the file name). */
export const font = {
  serif: "ShipporiMincho-ExtraBold", // titles and anything you tap to choose
  narrow: "ArchivoNarrow-Regular", // sentences
  narrowSemi: "ArchivoNarrow-SemiBold",
  narrowBold: "ArchivoNarrow-Bold", // labels
  mono: "IBMPlexMono-Regular", // readings only
} as const;

export const target = { min: 48 } as const;
export const OBI_WIDTH = 86;
