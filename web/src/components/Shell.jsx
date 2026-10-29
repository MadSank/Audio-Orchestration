/**
 * Shell.jsx — SAICS v5 Application Shell
 * ========================================
 * Dark sidebar navigation + main content area with routing.
 * Reactive background driven by AppContext audio analyzers.
 */

import { useState, useEffect, useRef } from "react";
import { Routes, Route, NavLink, Navigate, useLocation } from "react-router-dom";
import { Library as LibraryIcon, Infinity, ArrowLeftRight, ChevronLeft, ChevronRight, AudioLines } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { useApp } from "../context/AppContext";

import Library from "../pages/Library";
import InfiniteJukebox from "../pages/InfiniteJukebox";
import TrackTransitions from "../pages/TrackTransitions";

const NAV_ITEMS = [
  { to: "/library",     label: "Library",           icon: LibraryIcon },
  { to: "/jukebox",     label: "Infinite Jukebox",  icon: Infinity },
  { to: "/transitions", label: "Track Transitions", icon: ArrowLeftRight },
];

function ReactiveBackground() {
  const { globalMeter, globalFFT } = useApp();
  const bgRef = useRef(null);

  useEffect(() => {
    let rafId;
    const loop = () => {
      if (!globalMeter || !globalFFT || !bgRef.current) {
        rafId = requestAnimationFrame(loop);
        return;
      }

      // 1. Overall Volume (Meter)
      const db = globalMeter.getValue();
      // clamp between -60 and 0, normalize to 0..1
      const rawVol = typeof db === "number" && isFinite(db) ? db : -60;
      const volMap = Math.max(0, Math.min(1, (rawVol + 60) / 60));

      // 2. Bass Frequencies (FFT)
      const fftData = globalFFT.getValue();
      let bassAvg = -100;
      if (fftData && fftData.length > 0) {
        // Average first 4 bins (out of 32) for bass
        let sum = 0;
        for (let i = 0; i < 4; i++) {
          sum += (isFinite(fftData[i]) ? fftData[i] : -100);
        }
        bassAvg = sum / 4;
      }
      const bassMap = Math.max(0, Math.min(1, (bassAvg + 80) / 80));

      // 3. Smooth the values
      const currentVol = parseFloat(document.documentElement.style.getPropertyValue("--vol") || 0);
      const currentBass = parseFloat(document.documentElement.style.getPropertyValue("--bass") || 0);

      // Lerp for smoothness (faster rise, slower fall)
      const nextVol = currentVol + (volMap - currentVol) * (volMap > currentVol ? 0.4 : 0.1);
      const nextBass = currentBass + (bassMap - currentBass) * (bassMap > currentBass ? 0.5 : 0.15);

      document.documentElement.style.setProperty("--vol", nextVol);
      document.documentElement.style.setProperty("--bass", nextBass);

      rafId = requestAnimationFrame(loop);
    };

    rafId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafId);
  }, [globalMeter, globalFFT]);

  return (
    <div
      ref={bgRef}
      className="pointer-events-none fixed inset-0 z-0 overflow-hidden"
      style={{
        // Base dark background
        backgroundColor: "#000",
      }}
    >
      {/* Bass-driven deep ambient glow */}
      <div
        className="absolute inset-0"
        style={{
          background: "radial-gradient(ellipse at 50% 50%, rgba(139,92,246,0.15) 0%, transparent 60%)",
          opacity: "calc(0.3 + var(--bass) * 0.7)",
          transform: "scale(calc(1 + var(--bass) * 0.2))",
          transition: "transform 0.05s ease-out, opacity 0.05s ease-out",
        }}
      />
      {/* Volume-driven top glow */}
      <div
        className="absolute top-0 left-1/2 -translate-x-1/2 w-[80vw] h-[50vh]"
        style={{
          background: "radial-gradient(ellipse at 50% 0%, rgba(167,139,250,0.2) 0%, transparent 70%)",
          opacity: "calc(0.2 + var(--vol) * 0.8)",
          transform: "translateY(calc(var(--vol) * 10px))",
        }}
      />
      {/* Film grain / noise overlay for cinematic feel */}
      <div
        className="absolute inset-0 opacity-[0.03]"
        style={{
          backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noiseFilter'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noiseFilter)'/%3E%3C/svg%3E")`,
        }}
      />
    </div>
  );
}

export default function Shell() {
  const [collapsed, setCollapsed] = useState(false);
  const location = useLocation();

  return (
    <div className="flex h-screen w-screen bg-black overflow-hidden relative">

      <ReactiveBackground />

      {/* ── Sidebar ── */}
      <aside
        className={`
          relative z-20 flex flex-col shrink-0 h-full
          bg-zinc-950/80 backdrop-blur-xl border-r border-white/[0.06]
          transition-all duration-300 ease-in-out
          ${collapsed ? "w-[64px]" : "w-[220px]"}
        `}
      >
        {/* Logo */}
        <div className="flex items-center gap-3 px-4 h-[60px] border-b border-white/[0.06]">
          <div className="w-8 h-8 rounded-lg bg-purple-600/20 border border-purple-500/30 flex items-center justify-center shrink-0">
            <AudioLines className="w-4 h-4 text-purple-400" />
          </div>
          {!collapsed && (
            <motion.div
              initial={{ opacity: 0 }} animate={{ opacity: 1 }}
              className="overflow-hidden"
            >
              <div className="text-[13px] font-bold text-white tracking-wide">SAICS</div>
              <div className="text-[9px] text-zinc-600 uppercase tracking-[0.15em] font-medium">Audio Engine</div>
            </motion.div>
          )}
        </div>

        {/* Nav Items */}
        <nav className="flex flex-col gap-1 px-2 pt-4 flex-1">
          {NAV_ITEMS.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) => `
                relative group flex items-center gap-3 px-3 py-2.5 rounded-lg
                transition-all duration-150 no-underline overflow-hidden
                ${isActive
                  ? "bg-purple-500/10 text-white border border-purple-500/20"
                  : "text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.03] border border-transparent"
                }
              `}
            >
              {({ isActive }) => (
                <>
                  {/* Subtle pulsing glow for active item */}
                  {isActive && (
                    <motion.div
                      layoutId="activeNav"
                      className="absolute inset-0 bg-gradient-to-r from-purple-500/10 to-transparent z-0"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      transition={{ duration: 0.3 }}
                    />
                  )}
                  <Icon className={`relative z-10 w-[18px] h-[18px] shrink-0 transition-colors ${isActive ? "text-purple-400" : "text-zinc-600 group-hover:text-zinc-400"}`} />
                  {!collapsed && (
                    <span className="relative z-10 text-[12px] font-medium truncate">{label}</span>
                  )}
                </>
              )}
            </NavLink>
          ))}
        </nav>

        {/* Collapse Toggle */}
        <button
          onClick={() => setCollapsed(c => !c)}
          className="
            flex items-center justify-center h-10
            border-t border-white/[0.06]
            text-zinc-600 hover:text-zinc-400
            transition-colors cursor-pointer bg-transparent
          "
        >
          {collapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
        </button>
      </aside>

      {/* ── Main Content ── */}
      <main className="flex-1 h-full overflow-y-auto overflow-x-hidden relative z-10">
        <AnimatePresence mode="wait">
          <Routes location={location} key={location.pathname}>
            <Route
              path="/library"
              element={
                <PageWrapper>
                  <Library />
                </PageWrapper>
              }
            />
            <Route
              path="/jukebox"
              element={
                <PageWrapper>
                  <InfiniteJukebox />
                </PageWrapper>
              }
            />
            <Route
              path="/transitions"
              element={
                <PageWrapper>
                  <TrackTransitions />
                </PageWrapper>
              }
            />
            <Route path="*" element={<Navigate to="/library" replace />} />
          </Routes>
        </AnimatePresence>
      </main>
    </div>
  );
}

// Wrapper for page transitions
function PageWrapper({ children }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 15 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -15 }}
      transition={{ type: "spring", stiffness: 300, damping: 30 }}
      className="h-full w-full"
    >
      {children}
    </motion.div>
  );
}
