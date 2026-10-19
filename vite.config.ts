import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import process from "node:process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { Plugin } from "vite";

/**
 * Ships the OFL license of the bundled JetBrains Mono (imported in src/main.tsx) next to
 * the font files: dist/licenses/JetBrainsMono-OFL.txt, embedded in the app with dist/.
 */
function fontLicense(): Plugin {
  const require = createRequire(import.meta.url);
  return {
    name: "tablemax-font-license",
    apply: "build",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "licenses/JetBrainsMono-OFL.txt",
        source: readFileSync(require.resolve("@fontsource/jetbrains-mono/LICENSE"), "utf8"),
      });
    },
  };
}

const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react(), tailwindcss(), fontLicense()],

  // Do not obscure Rust errors
  clearScreen: false,
  // Tauri expects a fixed port
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
}));
