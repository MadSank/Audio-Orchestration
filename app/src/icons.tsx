import Svg, { Circle, Path } from "react-native-svg";

import { color } from "./theme/tokens";

type P = { size?: number; c?: string };

/** The design's 2 px line icons (paths from design/design/screens). */
const line = (d: string, sw = 2) =>
  function Icon({ size = 22, c = color.text }: P) {
    return (
      <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round">
        <Path d={d} />
      </Svg>
    );
  };
const solid = (d: string) =>
  function Icon({ size = 22, c = color.text }: P) {
    return (
      <Svg width={size} height={size} viewBox="0 0 24 24" fill={c}>
        <Path d={d} />
      </Svg>
    );
  };

export const ChevronDown = line("M6 9l6 6 6-6", 2.2);
export const ChevronRight = line("M9 6l6 6-6 6", 2.2);
export const Back = line("M15 6l-6 6 6 6", 2.2);
export const Close = line("M6 6l12 12M18 6L6 18", 2.4);
export const Infinity_ = line("M7 8c-2.2 0-4 1.8-4 4s1.8 4 4 4c4 0 6-8 10-8 2.2 0 4 1.8 4 4s-1.8 4-4 4c-4 0-6-8-10-8z");
export const ListIcon = line("M4 7h16M4 12h16M4 17h10");
export const Moon = line("M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z");
export const HeartLine = line("M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z");
export const Heart = solid("M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z");
export const Folder = line("M3 7h6l2 2h10v10H3z");
export const LibraryIcon = line("M5 4v16M10 4v16M15 4l4 16");
export const Helmet = line("M3.5 17a8.5 8.5 0 0 1 17 0v2h-17zM11 13h9", 2.2);
export const Play = solid("M8 5v14l11-7z");
export const Pause = solid("M7 5h4v14H7zM13 5h4v14h-4z");
export const Prev = solid("M6 5h2v14H6zM20 5v14L9 12z");
export const Next = solid("M16 5h2v14h-2zM4 5v14l11-7z");

export function Search({ size = 18, c = color.textMuted }: P) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth={2} strokeLinecap="round">
      <Circle cx={11} cy={11} r={7} />
      <Path d="M20 20l-3.5-3.5" />
    </Svg>
  );
}

export function Sliders({ size = 20, c = color.text }: P) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth={2} strokeLinecap="round">
      <Path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
      <Circle cx={16} cy={7} r={2} />
      <Circle cx={10} cy={17} r={2} />
    </Svg>
  );
}

export function StationsIcon({ size = 22, c = color.text }: P) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth={2}>
      <Circle cx={12} cy={12} r={9} />
      <Circle cx={12} cy={12} r={3} />
    </Svg>
  );
}

export function VinylIcon({ size = 28, c = color.amber }: P) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth={2}>
      <Circle cx={12} cy={12} r={9} />
      <Circle cx={12} cy={12} r={5} />
      <Circle cx={12} cy={12} r={1.2} fill={c} />
    </Svg>
  );
}

/** The app logo (design 01). */
export function Logo({ size = 28 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 28 28">
      <Circle cx={14} cy={14} r={13} fill={color.surface} stroke={color.border} />
      <Circle cx={14} cy={14} r={9} fill="none" stroke={color.border} />
      <Circle cx={14} cy={14} r={5} fill={color.amber} />
      <Circle cx={14} cy={14} r={1.4} fill={color.bg} />
    </Svg>
  );
}

/** The small record used as list art and mini-player art. */
export function Disc({ size = 44, label = color.amber, plate = color.surface }: { size?: number; label?: string; plate?: string | null }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 44 44">
      {plate ? <Path d="M12 0h20a12 12 0 0 1 12 12v20a12 12 0 0 1-12 12H12A12 12 0 0 1 0 32V12A12 12 0 0 1 12 0z" fill={plate} /> : null}
      <Circle cx={22} cy={22} r={16} fill={color.bg} />
      <Circle cx={22} cy={22} r={6.5} fill={label} />
    </Svg>
  );
}
