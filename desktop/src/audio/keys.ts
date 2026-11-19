import type { Player } from "./player";

/**
 * Media keys (keyboard keys, headset buttons, Windows' media flyout) and the keyboard, mapped like
 * the helmet: Next x1 next portal or song, x2 a new song now; Previous x1 restart or the song
 * before, x2 Forever on or off. Presses within the window count together (HelmetButtons.kt).
 */
const WINDOW_MS = 700;

export function bindKeys(player: Player): () => void {
  const counts: Record<string, { n: number; timer: number }> = {};
  const press = (key: "next" | "previous") => {
    const c = (counts[key] ??= { n: 0, timer: 0 });
    c.n++;
    clearTimeout(c.timer);
    c.timer = window.setTimeout(() => {
      const n = c.n;
      c.n = 0;
      if (key === "next") player.next(n >= 2);
      else if (n >= 2) player.toggleForever();
      else player.previous();
    }, WINDOW_MS);
  };

  if ("mediaSession" in navigator) {
    navigator.mediaSession.setActionHandler("play", () => void player.togglePlay());
    navigator.mediaSession.setActionHandler("pause", () => void player.togglePlay());
    navigator.mediaSession.setActionHandler("nexttrack", () => press("next"));
    navigator.mediaSession.setActionHandler("previoustrack", () => press("previous"));
  }

  const onKey = (e: KeyboardEvent) => {
    const el = e.target as HTMLElement;
    if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.getAttribute?.("role") === "slider")) return;
    if (e.code === "Space" || e.key === "k") {
      e.preventDefault();
      void player.togglePlay();
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      if (e.shiftKey) player.next(true);
      else press("next");
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      press("previous");
    } else if (e.key === "f") player.toggleForever();
  };
  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
}
