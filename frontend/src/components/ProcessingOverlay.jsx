import { useEffect, useRef, useState } from "react";

const COLORS = {
  emerald: "#10b981",
  violet:  "#8b5cf6",
  blue:    "#3b82f6",
  amber:   "#f59e0b",
};

function Spinner({ color }) {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none"
      style={{ animation: "aoe-spin 0.75s linear infinite", flexShrink: 0 }}>
      <circle cx="12" cy="12" r="9" stroke={color} strokeWidth="2" strokeOpacity="0.15"/>
      <path d="M12 3a9 9 0 0 1 9 9" stroke={color} strokeWidth="2" strokeLinecap="round"/>
      <style>{`@keyframes aoe-spin { to { transform: rotate(360deg); } }`}</style>
    </svg>
  );
}

export default function ProcessingOverlay({ stages, intervalMs = 3800, accentColor = "emerald" }) {
  const [idx, setIdx] = useState(0);
  const keyRef = useRef(stages.join("|"));

  useEffect(() => {
    const key = stages.join("|");
    if (keyRef.current !== key) { keyRef.current = key; setIdx(0); }
    const t = setInterval(() => setIdx(p => Math.min(p + 1, stages.length - 1)), intervalMs);
    return () => clearInterval(t);
  }, [stages.join("|"), intervalMs]); // eslint-disable-line

  const color = COLORS[accentColor] ?? COLORS.emerald;
  const pct   = Math.round(((idx + 1) / stages.length) * 91);

  return (
    <div style={{
      display: "flex", flexDirection: "column", alignItems: "center",
      gap: "18px", padding: "20px 0", maxWidth: "340px", margin: "0 auto",
    }}>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "8px" }}>
        <Spinner color={color} />
        <span style={{
          fontSize: "11px", color: "#6b7280", letterSpacing: "0.08em",
          textTransform: "uppercase",
          animation: "aoe-pulse 2s ease-in-out infinite",
        }}>
          {stages[idx]}
          <style>{`@keyframes aoe-pulse { 0%,100%{opacity:1} 50%{opacity:0.5} }`}</style>
        </span>
      </div>

      <div style={{ width: "100%" }}>
        <div style={{
          display: "flex", justifyContent: "space-between",
          fontSize: "10px", color: "#374151", marginBottom: "5px",
        }}>
          <span>{stages[idx]}</span>
          <span>{pct}%</span>
        </div>
        <div style={{
          height: "3px", background: "rgba(255,255,255,0.07)",
          borderRadius: "9999px", overflow: "hidden",
        }}>
          <div style={{
            height: "100%", width: `${pct}%`,
            background: color, borderRadius: "9999px",
            transition: "width 3.5s ease-out",
            boxShadow: `0 0 8px ${color}50`,
          }}/>
        </div>
      </div>

      <ol style={{ width: "100%", listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: "7px" }}>
        {stages.map((s, i) => (
          <li key={s} style={{
            display: "flex", alignItems: "center", gap: "9px",
            fontSize: "12px",
            color: i < idx ? color : i === idx ? "#e5e7eb" : "#1f2937",
            transition: "color 0.3s",
          }}>
            <span style={{
              width: "16px", height: "16px", borderRadius: "50%", flexShrink: 0,
              display: "flex", alignItems: "center", justifyContent: "center",
              background: i < idx ? `${color}18` : i === idx ? "rgba(255,255,255,0.06)" : "transparent",
              border: `1px solid ${i < idx ? `${color}40` : i === idx ? "rgba(255,255,255,0.1)" : "rgba(255,255,255,0.05)"}`,
            }}>
              {i < idx ? (
                <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12"/>
                </svg>
              ) : i === idx ? (
                <span style={{ width: "5px", height: "5px", borderRadius: "50%", background: color, boxShadow: `0 0 5px ${color}` }}/>
              ) : (
                <span style={{ width: "3px", height: "3px", borderRadius: "50%", background: "rgba(255,255,255,0.12)" }}/>
              )}
            </span>
            {s}
          </li>
        ))}
      </ol>
    </div>
  );
}
