import type { TurntableRefs } from "./Turntable";

/**
 * The record: two soft bands of light, a vermilion label with the title round it, and grooves.
 * With `turntable`, the grooves are the song itself (one spiral, rim to label), the stretch already
 * heard is drawn in paper, and the turntable turns it; without, plain grooves spin on their own.
 */
export function Record({ title, playing, turntable }: { title: string; playing: boolean; turntable?: TurntableRefs }) {
  const text = `${title} · ${title} · `.slice(0, 90);
  const grooves = Array.from({ length: 22 }, (_, i) => 290 - i * 8);
  const t = turntable;
  return (
    <svg viewBox="0 0 600 600" role="img" aria-label={`Record: ${title}`}>
      <g className={t ? undefined : `spin${playing ? " playing" : ""}`} ref={t ? (e) => void (t.group = e) : undefined}>
        <circle cx="300" cy="300" r="298" fill="var(--vinyl)" />
        <path d="M300 300 L300 2 A298 298 0 0 1 560 160 Z" fill="var(--paper)" opacity="0.045" />
        <path d="M300 300 L300 598 A298 298 0 0 1 40 440 Z" fill="var(--paper)" opacity="0.045" />
        {t ? (
          <>
            <path ref={(e) => void (t.spiral = e)} fill="none" stroke="var(--groove)" strokeWidth="1.4" />
            <path ref={(e) => void (t.played = e)} fill="none" stroke="var(--paper)" strokeWidth="2.6" strokeLinecap="round" opacity="0.85" />
            <path ref={(e) => void (t.portal = e)} fill="none" stroke="var(--vermilion)" strokeWidth="5" strokeLinecap="round" />
          </>
        ) : (
          grooves.map((r) => <circle key={r} cx="300" cy="300" r={r} fill="none" stroke="var(--groove)" strokeWidth="1.2" />)
        )}
        <circle cx="300" cy="300" r="108" fill="var(--vermilion)" />
        <defs>
          <path id="label-ring" d="M300 300 m-84 0 a84 84 0 1 1 168 0 a84 84 0 1 1 -168 0" />
        </defs>
        <text fill="var(--night)" fontFamily="var(--narrow)" fontWeight="600" fontSize="17" letterSpacing="1">
          <textPath href="#label-ring">{text}</textPath>
        </text>
        <circle cx="300" cy="300" r="9" fill="var(--night)" />
      </g>
    </svg>
  );
}
