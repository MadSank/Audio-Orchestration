import fs from "node:fs";
import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type Plugin } from "vite";

/**
 * Development only: serves the music folder named by SAICS_MUSIC read-only at /__music/, so the
 * app can be tried without the browser's folder picker. Never part of the built app, and it only
 * answers GET requests for files inside that folder.
 */
function devMusic(folder?: string): Plugin {
  const root = folder ? path.resolve(folder) : null;
  return {
    name: "saics-dev-music",
    apply: "serve",
    configureServer(server) {
      if (!root) return;
      server.middlewares.use("/__music", (req, res) => {
        if (req.method !== "GET") return void res.writeHead(405).end();
        const rel = decodeURIComponent((req.url ?? "/").split("?")[0]).replace(/^\/+/, "");
        const full = path.resolve(root, rel);
        if (full !== root && !full.startsWith(root + path.sep)) return void res.writeHead(403).end();
        if (rel === "" || rel.endsWith("/")) {
          // A listing: every audio file under the folder, relative paths, one per line.
          const out: string[] = [];
          const walk = (dir: string) => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
              if (e.name.startsWith(".") || e.name === "_set_aside") continue;
              const p = path.join(dir, e.name);
              if (e.isDirectory()) walk(p);
              else if (/\.(mp3|m4a|flac|wav|ogg|opus|aac|mpeg)$/i.test(e.name)) out.push(path.relative(root, p).split(path.sep).join("/"));
            }
          };
          walk(full);
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          return void res.end(out.join("\n"));
        }
        if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return void res.writeHead(404).end();
        fs.createReadStream(full).pipe(res);
      });
    },
  };
}

export default defineConfig(({ mode }) => ({
  // SAICS_MUSIC from the environment or desktop/.env.local (never committed).
  plugins: [react(), devMusic(process.env.SAICS_MUSIC ?? loadEnv(mode, process.cwd(), "SAICS_").SAICS_MUSIC)],
  base: "./", // works at any address: the PC, or a GitHub Pages sub-folder
  server: { port: 5190 },
  test: { environment: "node" },
}) as never);
