import { useState, useCallback } from "react";
import { useDropzone } from "react-dropzone";

const ACCEPTED = { "audio/*": [".mp3", ".wav", ".flac", ".ogg", ".aac", ".aiff", ".m4a"] };

function ComingSoonBadge() {
  return (
    <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-widest
      bg-amber-500/10 text-amber-400 border border-amber-500/25 px-2.5 py-1 rounded-full">
      <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse block" />
      Coming soon
    </span>
  );
}

function TrackRow({ file, index, onRemove }) {
  return (
    <div className="flex items-center gap-3 bg-[#080c10] border border-white/[0.05] rounded-xl px-4 py-3 group">
      <span className="w-6 h-6 rounded-md bg-gray-800 text-gray-600 text-[10px] font-mono flex items-center justify-center shrink-0">
        {String(index + 1).padStart(2, "0")}
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-sm text-gray-300 truncate">{file.name}</p>
        <p className="text-[10px] text-gray-600 mt-0.5">{(file.size / 1e6).toFixed(1)} MB</p>
      </div>
      {/* Drag handle placeholder */}
      <div className="flex flex-col gap-0.5 opacity-30 cursor-grab">
        {[0,1,2].map(i => <span key={i} className="w-3.5 h-px bg-gray-500 block"/>)}
      </div>
      <button
        onClick={() => onRemove(index)}
        className="opacity-0 group-hover:opacity-100 text-gray-600 hover:text-red-400 transition-all ml-1"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>
  );
}

export default function AutoMixMaker() {
  const [tracks, setTracks] = useState([]);

  const onDrop = useCallback((accepted) => {
    setTracks(prev => [...prev, ...accepted]);
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop, accept: ACCEPTED, multiple: true,
  });

  const removeTrack = (i) => setTracks(prev => prev.filter((_, idx) => idx !== i));

  return (
    <div className="max-w-2xl mx-auto space-y-8">

      {/* Hero */}
      <div className="space-y-3">
        <ComingSoonBadge />
        <h2 className="text-xl font-semibold text-gray-100">Auto Mix Maker</h2>
        <p className="text-sm text-gray-500 leading-relaxed max-w-lg">
          Assemble a playlist of tracks. SAICS will act as your AI DJ — analyzing
          each song's structure, finding optimal transition windows, and rendering
          one continuous mix with smooth transitions throughout.
        </p>
      </div>

      {/* Multi-file drop zone */}
      <div
        {...getRootProps()}
        className={`
          relative rounded-xl border-2 border-dashed p-8 cursor-pointer text-center
          flex flex-col items-center gap-3 transition-all duration-200
          ${isDragActive
            ? "border-amber-400 bg-amber-400/5"
            : "border-gray-800 hover:border-gray-600 hover:bg-white/[0.01]"}
        `}
      >
        <input {...getInputProps()} />
        <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="1.5" strokeLinecap="round" className={isDragActive ? "text-amber-400" : "text-gray-700"}>
          <path d="M12 5v14M5 12l7-7 7 7"/>
        </svg>
        <p className="text-sm text-gray-400">
          {isDragActive ? "Drop tracks here" : "Add tracks to your playlist"}
        </p>
        <p className="text-xs text-gray-700">Multiple files allowed · drag to reorder</p>
      </div>

      {/* Playlist */}
      {tracks.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between mb-1">
            <p className="text-xs text-gray-600 uppercase tracking-wider">
              Playlist · {tracks.length} track{tracks.length !== 1 ? "s" : ""}
            </p>
            <button onClick={() => setTracks([])} className="text-[11px] text-gray-700 hover:text-gray-400 transition-colors">
              Clear all
            </button>
          </div>
          {tracks.map((f, i) => (
            <TrackRow key={`${f.name}-${i}`} file={f} index={i} onRemove={removeTrack} />
          ))}
        </div>
      )}

      {/* Disabled action */}
      <div className="flex items-center gap-3">
        <button
          disabled={tracks.length < 2}
          className={`px-5 py-2.5 rounded-xl text-sm font-medium border transition-colors
            ${tracks.length >= 2
              ? "bg-amber-500/10 border-amber-700 text-amber-400 cursor-not-allowed"
              : "bg-gray-800 border-gray-700 text-gray-600 cursor-not-allowed"}`}
        >
          Generate DJ Mix
        </button>
        {tracks.length < 2 && (
          <p className="text-xs text-gray-700">Add at least 2 tracks to enable</p>
        )}
        {tracks.length >= 2 && (
          <p className="text-xs text-gray-700">
            Will call <code className="text-gray-500 bg-gray-900 px-1 py-0.5 rounded">POST /automix</code> — not yet wired
          </p>
        )}
      </div>

      {/* Road-map card */}
      <div className="bg-[#0f1620] border border-white/[0.06] rounded-2xl p-6 space-y-4">
        <p className="text-xs text-gray-500 uppercase tracking-wider font-medium">Planned implementation</p>
        <ol className="space-y-3 text-sm text-gray-500">
          {[
            "Analyze each track: beats, tempo, key, energy profile",
            "Sort playlist by BPM proximity and key compatibility (Camelot wheel)",
            "Compute cross-track transition matrices for each consecutive pair",
            "Select optimal exit + entry beat for each transition",
            "Render full mix with per-transition crossfades; stream back as one WAV",
          ].map((step, i) => (
            <li key={i} className="flex gap-3">
              <span className="shrink-0 w-5 h-5 rounded-full bg-gray-800 border border-gray-700 text-gray-600 text-[10px] flex items-center justify-center font-mono">
                {i + 1}
              </span>
              <span>{step}</span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
