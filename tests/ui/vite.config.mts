import { fileURLToPath, URL } from "node:url";
import { defineConfig, searchForWorkspaceRoot } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));
export default defineConfig({
  root,
  cacheDir: fileURLToPath(new URL("../../node_modules/.vite/aerift-showcase", import.meta.url)),
  server: { fs: { allow: [searchForWorkspaceRoot(root)] } },
  build: {
    rollupOptions: {
      input: {
        showcase: fileURLToPath(new URL("./index.html", import.meta.url)),
        orbit: fileURLToPath(new URL("./orbit.html", import.meta.url)),
      },
    },
  },
  esbuild: { jsx: "automatic" },
});
