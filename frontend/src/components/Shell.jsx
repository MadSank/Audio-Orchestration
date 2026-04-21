import { NavLink, Outlet, useLocation } from "react-router-dom";

function Logo() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
      <rect x="0"  y="7"  width="3" height="10" rx="1.5" fill="currentColor" opacity="0.2"/>
      <rect x="5"  y="3"  width="3" height="18" rx="1.5" fill="currentColor" opacity="0.5"/>
      <rect x="10" y="0"  width="4" height="24" rx="2"   fill="currentColor"/>
      <rect x="17" y="3"  width="3" height="18" rx="1.5" fill="currentColor" opacity="0.5"/>
      <rect x="22" y="7"  width="2" height="10" rx="1"   fill="currentColor" opacity="0.2"/>
    </svg>
  );
}

const navItems = [
  {
    to: "/library",
    label: "Library",
    icon: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 6h18M3 12h18M3 18h18"/>
        <circle cx="7" cy="6" r="1.5" fill="currentColor" stroke="none"/>
        <circle cx="7" cy="12" r="1.5" fill="currentColor" stroke="none"/>
        <circle cx="7" cy="18" r="1.5" fill="currentColor" stroke="none"/>
      </svg>
    ),
    accent: { color: "#3b82f6", bg: "rgba(59,130,246,0.08)", border: "rgba(59,130,246,0.2)" },
  },
  {
    to: "/jukebox",
    label: "Infinite Jukebox",
    icon: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="3"/>
        <circle cx="12" cy="12" r="9"/>
        <path d="M12 3v2M12 19v2M3 12h2M19 12h2"/>
      </svg>
    ),
    accent: { color: "#10b981", bg: "rgba(16,185,129,0.08)", border: "rgba(16,185,129,0.2)" },
  },
  {
    to: "/transitions",
    label: "Transitions",
    icon: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M5 8h14M5 16h14"/>
        <path d="M14 4l4 4-4 4"/>
        <path d="M10 12l-4 4 4 4"/>
      </svg>
    ),
    accent: { color: "#8b5cf6", bg: "rgba(139,92,246,0.08)", border: "rgba(139,92,246,0.2)" },
  },
];

const pageMeta = {
  "/library":     { title: "Library",          subtitle: "Local playback",                          glow: "rgba(59,130,246,0.06)" },
  "/jukebox":     { title: "Infinite Jukebox", subtitle: "Beat analysis & infinite looping",        glow: "rgba(16,185,129,0.06)" },
  "/transitions": { title: "Transitions",      subtitle: "Find the perfect crossfade between tracks", glow: "rgba(139,92,246,0.06)" },
};

export default function Shell() {
  const location = useLocation();
  const meta = Object.entries(pageMeta).find(([k]) => location.pathname.startsWith(k))?.[1]
    ?? { title: "Audio Orchestration Engine", subtitle: "", glow: "rgba(16,185,129,0.06)" };

  return (
    <div style={{
      display: "flex", height: "100vh",
      background: "#060810", color: "#f3f4f6", overflow: "hidden",
      fontFamily: "'Inter', system-ui, sans-serif",
    }}>

      <aside style={{
        width: "210px", flexShrink: 0,
        display: "flex", flexDirection: "column",
        background: "linear-gradient(180deg, #0c0f18 0%, #090c14 100%)",
        borderRight: "1px solid rgba(255,255,255,0.055)",
      }}>
        <div style={{
          padding: "18px 20px 16px",
          display: "flex", alignItems: "center", gap: "11px",
          borderBottom: "1px solid rgba(255,255,255,0.05)",
        }}>
          <span style={{ color: "#10b981" }}><Logo /></span>
          <div>
            <div style={{
              fontSize: "11px", fontWeight: 700, letterSpacing: "0.16em",
              color: "#f9fafb", textTransform: "uppercase",
            }}>
              Audio Orchestration
            </div>
            <div style={{ fontSize: "10px", color: "#374151", marginTop: "2px" }}>
              Engine
            </div>
          </div>
        </div>

        <nav style={{ flex: 1, padding: "14px 10px" }}>
          <div style={{
            fontSize: "10px", fontWeight: 600, color: "#1f2937",
            textTransform: "uppercase", letterSpacing: "0.14em",
            padding: "0 8px", marginBottom: "8px",
          }}>
            Tools
          </div>

          {navItems.map(({ to, label, icon, tag, accent }) => (
            <NavLink key={to} to={to} style={{ textDecoration: "none", display: "block", marginBottom: "2px" }}>
              {({ isActive }) => (
                <div
                  style={{
                    display: "flex", alignItems: "center", gap: "9px",
                    padding: "8px 10px", borderRadius: "8px",
                    cursor: "pointer",
                    background: isActive ? accent.bg : "transparent",
                    border: `1px solid ${isActive ? accent.border : "transparent"}`,
                    transition: "background 0.12s, border-color 0.12s",
                  }}
                  onMouseEnter={e => { if (!isActive) e.currentTarget.style.background = "rgba(255,255,255,0.04)"; }}
                  onMouseLeave={e => { if (!isActive) e.currentTarget.style.background = "transparent"; }}
                >
                  <span style={{ color: isActive ? accent.color : "#4b5563", flexShrink: 0 }}>
                    {icon}
                  </span>
                  <span style={{
                    flex: 1, fontSize: "13px", fontWeight: 500,
                    color: isActive ? "#f9fafb" : "#6b7280",
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                  }}>
                    {label}
                  </span>
                  {tag && (
                    <span style={{
                      fontSize: "9px", fontWeight: 700, textTransform: "uppercase",
                      letterSpacing: "0.08em", padding: "2px 6px", borderRadius: "999px",
                      background: isActive ? `${accent.color}18` : "rgba(255,255,255,0.04)",
                      color: isActive ? accent.color : "#374151",
                      border: `1px solid ${isActive ? accent.border : "rgba(255,255,255,0.06)"}`,
                    }}>
                      {tag}
                    </span>
                  )}
                </div>
              )}
            </NavLink>
          ))}
        </nav>

        <div style={{
          padding: "12px 20px 16px",
          borderTop: "1px solid rgba(255,255,255,0.05)",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "4px" }}>
            <span style={{
              width: "6px", height: "6px", borderRadius: "50%",
              background: "#10b981", boxShadow: "0 0 6px #10b981", flexShrink: 0,
            }}/>
            <span style={{ fontSize: "10px", color: "#059669", fontWeight: 500 }}>
              Backend running
            </span>
          </div>
          <div style={{ fontSize: "10px", color: "#1f2937" }}>
            Python · librosa · FastAPI
          </div>
        </div>
      </aside>

      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <header style={{
          flexShrink: 0,
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "0 32px", height: "54px",
          background: "rgba(6,8,16,0.92)",
          backdropFilter: "blur(12px)",
          borderBottom: "1px solid rgba(255,255,255,0.05)",
        }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: "10px" }}>
            <span style={{ fontSize: "14px", fontWeight: 600, color: "#f9fafb" }}>
              {meta.title}
            </span>
            {meta.subtitle && (
              <span style={{ fontSize: "11px", color: "#374151" }}>
                {meta.subtitle}
              </span>
            )}
          </div>
          <div style={{
            display: "flex", alignItems: "center", gap: "6px",
            padding: "4px 12px", borderRadius: "999px",
            background: "rgba(255,255,255,0.04)",
            border: "1px solid rgba(255,255,255,0.07)",
            fontSize: "11px", color: "#4b5563",
          }}>
            <span style={{
              width: "5px", height: "5px", borderRadius: "50%",
              background: "#10b981", boxShadow: "0 0 5px #10b981",
            }}/>
            v2.0
          </div>
        </header>

        <main style={{ flex: 1, overflowY: "auto", position: "relative" }}>
          <div style={{
            position: "absolute", inset: 0, pointerEvents: "none",
            backgroundImage: [
              "linear-gradient(rgba(255,255,255,0.014) 1px, transparent 1px)",
              "linear-gradient(90deg, rgba(255,255,255,0.014) 1px, transparent 1px)",
            ].join(","),
            backgroundSize: "48px 48px",
          }}/>
          <div style={{
            position: "absolute", top: 0, left: "50%",
            transform: "translateX(-50%)",
            width: "700px", height: "300px",
            pointerEvents: "none",
            background: `radial-gradient(ellipse at 50% 0%, ${meta.glow} 0%, transparent 70%)`,
          }}/>
          <div style={{ position: "relative", padding: "32px" }}>
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
