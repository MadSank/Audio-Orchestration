import { createContext, useContext, useState, useCallback } from "react";

const Ctx = createContext(null);

export function LibraryProvider({ children }) {
  const [tracks, setTracks] = useState([]);

  const addTracks = useCallback((files) => {
    const next = files.map(f => ({
      id:       crypto.randomUUID(),
      file:     f,
      url:      URL.createObjectURL(f),
      name:     f.name.replace(/\.[^.]+$/, ""),
      ext:      (f.name.split(".").pop() ?? "").toUpperCase(),
      size:     f.size,
      duration: null,
      bpm:      null,
      error:    null,
    }));
    setTracks(prev => [...prev, ...next]);
    return next;
  }, []);

  const removeTrack = useCallback((id) => {
    setTracks(prev => {
      const t = prev.find(x => x.id === id);
      if (t?.url) URL.revokeObjectURL(t.url);
      return prev.filter(x => x.id !== id);
    });
  }, []);

  const updateTrack = useCallback((id, patch) => {
    setTracks(prev => prev.map(t => t.id === id ? { ...t, ...patch } : t));
  }, []);

  return (
    <Ctx.Provider value={{ tracks, addTracks, removeTrack, updateTrack }}>
      {children}
    </Ctx.Provider>
  );
}

export function useLibrary() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useLibrary must be used inside LibraryProvider");
  return ctx;
}
