import { defineConfig } from "vite";

const nativeDevHost = process.env.TAURI_DEV_HOST;

export default defineConfig({
  server: {
    host: nativeDevHost ?? "127.0.0.1",
    port: 1420,
    strictPort: true,
    hmr: nativeDevHost ? { protocol: "ws", host: nativeDevHost, port: 1421 } : undefined,
  },
});
