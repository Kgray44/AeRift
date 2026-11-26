import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { createMotionBuild } from "./motion-provider-build.mjs";
import { validateMotionPresentation } from "../../packages/ui/src/motion-presentation-contract.ts";

const nativeDevHost = process.env.TAURI_DEV_HOST;

export default defineConfig(({ command }) => {
  const { plugin } = createMotionBuild({
    publicRoot: fileURLToPath(new URL("../../", import.meta.url)),
    validate: validateMotionPresentation,
    command,
    nativeDevHost,
  });
  return {
    ...(plugin ? { plugins: [plugin], build: { sourcemap: false } } : {}),
    server: {
      host: nativeDevHost ?? "127.0.0.1",
      port: 1420,
      strictPort: true,
      hmr: nativeDevHost ? { protocol: "ws", host: nativeDevHost, port: 1421 } : undefined,
    },
  };
});
