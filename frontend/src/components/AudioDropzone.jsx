import { useDropzone } from "react-dropzone";

const AUDIO_ACCEPT = {
  "audio/*": [".mp3", ".wav", ".flac", ".ogg", ".aac", ".aiff", ".m4a"],
};

const ACCENTS = {
  emerald: { active: "#10b981", glow: "rgba(16,185,129,0.12)", pill: "rgba(16,185,129,0.1)", pillBorder: "rgba(16,185,129,0.2)" },
  violet:  { active: "#8b5cf6", glow: "rgba(139,92,246,0.12)", pill: "rgba(139,92,246,0.1)", pillBorder: "rgba(139,92,246,0.2)" },
  blue:    { active: "#3b82f6", glow: "rgba(59,130,246,0.12)",  pill: "rgba(59,130,246,0.1)",  pillBorder: "rgba(59,130,246,0.2)"  },
};

function WaveIcon({ color, active }) {
  const bars = [8, 14, 22, 30, 38, 30, 22, 14, 8];
  return (
    <svg width="48" height="36" viewBox="0 0 48 36" fill="none">
      {bars.map((h, i) => (
        <rect
          key={i}
          x={i * 5.5}
          y={(36 - h) / 2}
          width="3"
          height={h}
          rx="1.5"
          fill={color}
          opacity={active ? 0.9 : 0.3}
          style={{ transition: "opacity 0.2s" }}
        />
      ))}
    </svg>
  );
}

export default function AudioDropzone({ onFile, disabled = false, label = "Drop audio here", file = null, accentColor = "emerald" }) {
  const accent = ACCENTS[accentColor] ?? ACCENTS.emerald;

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop: (files) => { if (files[0]) onFile(files[0]); },
    accept: AUDIO_ACCEPT,
    maxFiles: 1,
    disabled,
  });

  return (
    <div
      {...getRootProps()}
      style={{
        position: "relative",
        border: `1.5px dashed ${isDragActive ? accent.active : "rgba(255,255,255,0.1)"}`,
        borderRadius: "12px",
        padding: "26px 20px",
        display: "flex", flexDirection: "column", alignItems: "center",
        gap: "10px", textAlign: "center",
        cursor: disabled ? "not-allowed" : "pointer",
        background: isDragActive ? accent.glow : "transparent",
        opacity: disabled ? 0.45 : 1,
        transition: "all 0.18s ease",
        boxShadow: isDragActive ? `0 0 0 3px ${accent.glow}` : "none",
        outline: "none",
      }}
      onMouseEnter={e => { if (!isDragActive && !disabled) e.currentTarget.style.background = "rgba(255,255,255,0.022)"; }}
      onMouseLeave={e => { if (!isDragActive) e.currentTarget.style.background = "transparent"; }}
    >
      <input {...getInputProps()} />

      <WaveIcon color={isDragActive ? accent.active : "#374151"} active={isDragActive} />

      <div>
        <p style={{ fontSize: "13px", fontWeight: 500, color: isDragActive ? "#f3f4f6" : "#9ca3af", margin: "0 0 3px" }}>
          {isDragActive ? "Drop to load" : label}
        </p>
        <p style={{ fontSize: "11px", color: "#374151", margin: 0 }}>
          MP3 · WAV · FLAC · OGG · AAC
        </p>
      </div>

      {file && !isDragActive && (
        <div style={{
          display: "flex", alignItems: "center", gap: "6px",
          padding: "4px 11px", borderRadius: "999px",
          background: accent.pill, border: `1px solid ${accent.pillBorder}`,
          fontSize: "11px", color: accent.active,
          maxWidth: "200px",
        }}>
          <svg width="11" height="11" viewBox="0 0 24 24" fill={accent.active}>
            <path d="M9 18V5l12-2v13M9 18c0 1.1-.9 2-2 2s-2-.9-2-2 .9-2 2-2 2 .9 2 2zm12-2c0 1.1-.9 2-2 2s-2-.9-2-2 .9-2 2-2 2 .9 2 2z"/>
          </svg>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {file.name}
          </span>
          <span style={{ opacity: 0.5, flexShrink: 0 }}>
            {(file.size / 1e6).toFixed(1)} MB
          </span>
        </div>
      )}
    </div>
  );
}
