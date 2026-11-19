/**
 * Where the music comes from. The installed app reads a folder the owner picks (the browser's File
 * System Access API, read-only: the songs are never changed). In development the dev server can
 * also serve a folder over HTTP (vite.config.ts), so the app can be tried without the picker.
 */
export interface Source {
  name: string;
  /** A text file relative to the music folder, or null when it isn't there. */
  text(path: string): Promise<string | null>;
  bytes(path: string): Promise<ArrayBuffer>;
  /** Every audio file in the folder (skipping .saics and _set_aside), relative paths. */
  listAudio(): Promise<string[]>;
}

const AUDIO = /\.(mp3|m4a|flac|wav|ogg|opus|aac|mpeg)$/i;

export class FolderSource implements Source {
  constructor(private root: FileSystemDirectoryHandle) {}

  get name(): string {
    return this.root.name;
  }

  private async file(path: string): Promise<File | null> {
    const parts = path.split("/").filter(Boolean);
    let dir = this.root;
    try {
      for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p);
      return await (await dir.getFileHandle(parts[parts.length - 1])).getFile();
    } catch {
      return null;
    }
  }

  async text(path: string): Promise<string | null> {
    const f = await this.file(path);
    return f ? f.text() : null;
  }

  async bytes(path: string): Promise<ArrayBuffer> {
    const f = await this.file(path);
    if (!f) throw new Error(`not found: ${path}`);
    return f.arrayBuffer();
  }

  async listAudio(): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dir: FileSystemDirectoryHandle, prefix: string) => {
      for await (const [name, h] of dir as unknown as AsyncIterable<[string, FileSystemHandle]>) {
        if (name.startsWith(".") || name === "_set_aside") continue;
        if (h.kind === "directory") await walk(h as FileSystemDirectoryHandle, `${prefix}${name}/`);
        else if (AUDIO.test(name)) out.push(prefix + name);
      }
    };
    await walk(this.root, "");
    return out;
  }
}

export class DevSource implements Source {
  name = "dev server";

  private url(path: string): string {
    return "/__music/" + path.split("/").map(encodeURIComponent).join("/");
  }

  async text(path: string): Promise<string | null> {
    const r = await fetch(this.url(path));
    return r.ok ? r.text() : null;
  }

  async bytes(path: string): Promise<ArrayBuffer> {
    const r = await fetch(this.url(path));
    if (!r.ok) throw new Error(`not found: ${path}`);
    return r.arrayBuffer();
  }

  async listAudio(): Promise<string[]> {
    const r = await fetch("/__music/");
    return r.ok ? (await r.text()).split("\n").filter(Boolean) : [];
  }
}

// ── remembering the picked folder (IndexedDB holds the handle; the browser asks again for access) ──

const DB = "saics";
const STORE = "handles";

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export async function rememberFolder(h: FileSystemDirectoryHandle): Promise<void> {
  const d = await db();
  await new Promise<void>((resolve, reject) => {
    const tx = d.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(h, "music");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function rememberedFolder(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const d = await db();
    return await new Promise((resolve) => {
      const r = d.transaction(STORE).objectStore(STORE).get("music");
      r.onsuccess = () => resolve((r.result as FileSystemDirectoryHandle) ?? null);
      r.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

type Permissioned = FileSystemDirectoryHandle & {
  queryPermission(o: { mode: string }): Promise<PermissionState>;
  requestPermission(o: { mode: string }): Promise<PermissionState>;
};

/** True when the remembered folder can be read; asks the owner if needed (needs a click). */
export async function canRead(h: FileSystemDirectoryHandle, ask: boolean): Promise<boolean> {
  const p = h as Permissioned;
  if ((await p.queryPermission({ mode: "read" })) === "granted") return true;
  return ask && (await p.requestPermission({ mode: "read" })) === "granted";
}

export async function pickFolder(): Promise<FileSystemDirectoryHandle | null> {
  const w = window as unknown as { showDirectoryPicker?: (o: object) => Promise<FileSystemDirectoryHandle> };
  if (!w.showDirectoryPicker) return null;
  try {
    return await w.showDirectoryPicker({ id: "saics-music", mode: "read" });
  } catch {
    return null; // cancelled
  }
}
