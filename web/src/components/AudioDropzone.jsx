/**
 * AudioDropzone.jsx — File Upload Zone
 * ======================================
 * Dashed-border drag-and-drop zone for audio files.
 * Purple accent only. Uses react-dropzone.
 */

import { useDropzone } from "react-dropzone";
import { Upload, Music } from "lucide-react";

const AUDIO_ACCEPT = {
  "audio/*": [".mp3", ".wav", ".flac", ".ogg", ".aac", ".aiff", ".m4a"],
};

export default function AudioDropzone({ onFile, disabled = false, label = "Drop audio here", file = null }) {
  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop: (files) => {
      if (files.length > 0) onFile(files.length === 1 ? files[0] : files);
    },
    accept: AUDIO_ACCEPT,
    disabled,
  });

  return (
    <div
      {...getRootProps()}
      className={`
        relative rounded-xl p-6 flex flex-col items-center gap-3
        text-center cursor-pointer transition-all duration-200 outline-none
        ${isDragActive
          ? "border-2 border-dashed border-purple-500/60 bg-purple-500/[0.06] shadow-[0_0_0_3px_rgba(139,92,246,0.08)]"
          : "border-2 border-dashed border-white/[0.06] hover:border-white/[0.1] hover:bg-white/[0.01]"
        }
        ${disabled ? "opacity-40 cursor-not-allowed" : ""}
      `}
    >
      <input {...getInputProps()} />

      <div className={`
        w-10 h-10 rounded-lg flex items-center justify-center
        transition-colors duration-200
        ${isDragActive ? "bg-purple-500/15 text-purple-400" : "bg-zinc-900 text-zinc-600"}
      `}>
        <Upload className="w-5 h-5" />
      </div>

      <div>
        <p className={`text-[13px] font-medium mb-1 transition-colors ${isDragActive ? "text-zinc-200" : "text-zinc-500"}`}>
          {isDragActive ? "Drop to load" : label}
        </p>
        <p className="text-[10px] text-zinc-700">
          MP3 · WAV · FLAC · OGG · AAC · AIFF
        </p>
      </div>

      {file && !isDragActive && (
        <div className="
          flex items-center gap-1.5 px-3 py-1 rounded-full
          bg-purple-500/10 border border-purple-500/20
          text-[11px] text-purple-400 max-w-[200px]
        ">
          <Music className="w-3 h-3 shrink-0" />
          <span className="truncate">{file.name}</span>
          <span className="text-purple-500/50 shrink-0 ml-1">
            {(file.size / 1e6).toFixed(1)} MB
          </span>
        </div>
      )}
    </div>
  );
}
