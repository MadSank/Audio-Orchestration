/**
 * ProcessingOverlay.jsx — Staged Processing Indicator
 * =====================================================
 * Animated multi-stage progress indicator. Purple accent only.
 */

import { useEffect, useRef, useState } from "react";
import { Loader2, Check } from "lucide-react";

export default function ProcessingOverlay({ stages, intervalMs = 3800, accentColor = "violet" }) {
  const [idx, setIdx] = useState(0);
  const keyRef = useRef(stages.join("|"));

  useEffect(() => {
    const key = stages.join("|");
    if (keyRef.current !== key) { keyRef.current = key; setIdx(0); }
    const t = setInterval(() => setIdx(p => Math.min(p + 1, stages.length - 1)), intervalMs);
    return () => clearInterval(t);
  }, [stages.join("|"), intervalMs]); // eslint-disable-line

  const pct = Math.round(((idx + 1) / stages.length) * 91);

  return (
    <div className="flex flex-col items-center gap-5 py-5 max-w-[340px] mx-auto">
      {/* Spinner + label */}
      <div className="flex flex-col items-center gap-2">
        <Loader2 className="w-7 h-7 text-purple-500 animate-spin" />
        <span
          className="text-[11px] text-zinc-500 uppercase tracking-[0.08em]"
          style={{ animation: "saics-pulse 2s ease-in-out infinite" }}
        >
          {stages[idx]}
        </span>
      </div>

      {/* Progress bar */}
      <div className="w-full">
        <div className="flex justify-between text-[10px] text-zinc-700 mb-1.5">
          <span>{stages[idx]}</span>
          <span className="font-mono">{pct}%</span>
        </div>
        <div className="h-[3px] bg-white/[0.04] rounded-full overflow-hidden">
          <div
            className="h-full bg-purple-500 rounded-full transition-all duration-[3.5s] ease-out"
            style={{
              width: `${pct}%`,
              boxShadow: "0 0 8px rgba(139,92,246,0.4)",
            }}
          />
        </div>
      </div>

      {/* Stage list */}
      <ol className="w-full flex flex-col gap-2 list-none p-0 m-0">
        {stages.map((s, i) => (
          <li key={s} className="flex items-center gap-2.5 text-[12px] transition-colors duration-300">
            <span className={`
              w-4 h-4 rounded-full shrink-0 flex items-center justify-center
              border transition-all duration-300
              ${i < idx
                ? "bg-purple-500/15 border-purple-500/30"
                : i === idx
                  ? "bg-white/[0.04] border-white/[0.08]"
                  : "border-white/[0.04]"
              }
            `}>
              {i < idx ? (
                <Check className="w-2.5 h-2.5 text-purple-400" />
              ) : i === idx ? (
                <span className="w-1.5 h-1.5 rounded-full bg-purple-500 shadow-[0_0_5px_rgba(139,92,246,0.6)]" />
              ) : (
                <span className="w-1 h-1 rounded-full bg-white/[0.08]" />
              )}
            </span>
            <span className={
              i < idx ? "text-purple-400" :
              i === idx ? "text-zinc-200" :
              "text-zinc-800"
            }>
              {s}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
