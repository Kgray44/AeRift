import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const MOTION_PROVIDER_ID = "\0aerift:motion-presentation:premium";
const MAX_MANIFEST_BYTES = 8192;
const loopback = new Set(["127.0.0.1", "::1", "localhost"]);

function within(root, path) {
  const child = relative(root, path);
  return child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith(".." + sep));
}

function readProvider(manifest, root) {
  let fd;
  try {
    const resolved = realpathSync(manifest);
    if (within(root, resolved) || within(root, resolve(manifest))) {
      throw new Error("Motion provider manifest must be outside the public checkout.");
    }
    const pathStat = lstatSync(manifest);
    if (!pathStat.isFile() || pathStat.size > MAX_MANIFEST_BYTES || pathStat.size === 0) {
      throw new Error("Motion provider manifest must be a bounded, regular JSON file.");
    }
    fd = openSync(manifest, "r");
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.dev !== pathStat.dev || stat.ino !== pathStat.ino ||
        stat.size !== pathStat.size) {
      throw new Error("Motion provider manifest changed while it was being opened.");
    }
    const buffer = Buffer.alloc(MAX_MANIFEST_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const count = readSync(fd, buffer, size, buffer.length - size, null);
      if (count === 0) break;
      size += count;
    }
    if (size !== stat.size || size > MAX_MANIFEST_BYTES) throw new Error("Motion provider manifest changed while it was read.");
    return JSON.parse(buffer.subarray(0, size).toString("utf8"));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Motion provider manifest")) throw error;
    throw new Error("Motion provider manifest is missing, unreadable or invalid JSON.");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** v1 loads only presentation values, not executable code from another tree. */
export function createMotionBuild({ env = process.env, publicRoot, validate, command, nativeDevHost } = {}) {
  const profile = env.AERIFT_MOTION_PROFILE ?? "public";
  const manifest = env.AERIFT_MOTION_PROVIDER;
  if (profile === "public") {
    if (manifest) throw new Error("Select premium explicitly to use a motion provider manifest.");
    return {};
  }
  if (profile !== "premium") throw new Error("Unknown AeRift motion build profile.");
  if (env.CI || env.GITHUB_ACTIONS) throw new Error("Private motion inputs must never enter public CI.");
  if (!manifest || !isAbsolute(manifest) || !manifest.toLowerCase().endsWith(".json")) {
    throw new Error("Premium requires an absolute, local JSON provider manifest.");
  }
  if (command === "serve" && nativeDevHost && !loopback.has(nativeDevHost)) {
    throw new Error("Premium development must bind to loopback. Do not serve private assets over the LAN.");
  }
  let root;
  try { root = realpathSync(publicRoot); } catch { root = resolve(publicRoot); }
  const value = validate(readProvider(manifest, root));
  if (value === undefined) throw new Error("Premium motion provider contract is incompatible or invalid.");
  const output = 'export default ' + JSON.stringify(value) + ';';
  const exactImporter = resolve(root, "packages/ui/src/MotionAffordance.tsx");
  return {
    plugin: {
      name: "aerift-private-motion-presentation",
      enforce: "pre",
      configResolved(config) {
        if (config.build.sourcemap) throw new Error("Premium motion builds cannot emit source maps.");
        if (config.command === "serve" && !loopback.has(config.server.host)) {
          throw new Error("Premium development must bind to loopback.");
        }
      },
      resolveId(source, importer) {
        if (source === "./motion-presentation-provider" && importer && relative(exactImporter, importer) === "") {
          return MOTION_PROVIDER_ID;
        }
      },
      load(id) {
        if (id === MOTION_PROVIDER_ID) return output;
      },
    },
  };
}
