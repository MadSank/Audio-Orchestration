import { useEffect, useState } from "react";

import SaicsPlayer, { addListener, type PlayerState } from "../modules/saics-player";

/** Live player state from the native service (onState events + an initial fetch). */
export function usePlayerState(): PlayerState | null {
  const [state, setState] = useState<PlayerState | null>(null);
  useEffect(() => {
    let alive = true;
    SaicsPlayer.getState().then((s) => alive && setState(s)).catch(() => {});
    const sub = addListener("onState", (s) => setState(s));
    const timer = setInterval(() => {
      SaicsPlayer.getState().then((s) => alive && setState(s)).catch(() => {});
    }, 1000);
    return () => {
      alive = false;
      sub.remove();
      clearInterval(timer);
    };
  }, []);
  return state;
}
