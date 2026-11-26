// Read-only DOM witness for a debug APK in the owned CI emulator. This neither
// clicks controls nor calls application IPC and never sees a native image path.
const [port, phase, fixtureId, nameMode] = process.argv.slice(2);
if (!/^[0-9]{1,5}$/.test(port ?? "") || Number(port) < 1024 || Number(port) > 65535 ||
    !["target", "preview", "imported", "removed"].includes(phase) || !/^[0-9]{1,19}$/.test(fixtureId ?? "") ||
    !["original", "picker"].includes(nameMode)) throw new Error("Invalid emulator observation request");

const fixtureName = nameMode === "original" ? "AeRift-Android-photo-smoke.png" : fixtureId + ".png";
const embedded = new Set(["http://tauri.localhost", "https://tauri.localhost"]);
const host = "127.0.0.1:" + port;
const deadline = Date.now() + (phase === "target" ? 4000 : 22_000);
const pause = () => new Promise(resolve => setTimeout(resolve, 350));
const expression = `(() => {
  const gallery = document.querySelector('.aw-photos-main[aria-label="Photo gallery"]');
  const tiles = [...(gallery?.querySelectorAll(".aw-photo-tile") ?? [])];
  const matches = tiles.filter(node => node.getAttribute("aria-label") === ${JSON.stringify("Open " + fixtureName)});
  const tile = matches.length === 1 ? matches[0] : null;
  const image = tile?.querySelector('img');
  const viewer = document.querySelector('.aw-photo-viewer[open]');
  const closeButtons = [...(viewer?.querySelectorAll('button[aria-label="Close photo"]') ?? [])]
    .filter(button => !button.disabled && button.getClientRects().length > 0);
  const rect = tile?.getBoundingClientRect();
  const tileAtCenter = !!rect && !!tile?.contains(document.elementFromPoint(
    (rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2));
  const midY = rect ? (rect.top + rect.bottom) / 2 : 0;
  const target = !tile || !rect?.width || !rect.height || viewer ? 'blocked' :
    midY > innerHeight * 0.8 ? 'below' :
    midY < innerHeight * 0.2 ? 'above' : tileAtCenter ? 'ready' : 'blocked';
  return { target, exactPreview: viewer?.getAttribute('aria-label') === ${JSON.stringify("Viewing " + fixtureName)},
    closes: closeButtons.length, tileAtCenter,
    confirm: !!viewer?.querySelector('[role="group"][aria-label="Confirm remove imported copy"]'),
    viewerError: !!viewer?.querySelector('[role="alert"]'),
    gallery: !!gallery && gallery.getClientRects().length > 0,
    count: tiles.length, matches: matches.length, tile: !!tile, modal: !!document.querySelector('.aw-photo-viewer[open]'),
    width: image?.naturalWidth ?? 0, height: image?.naturalHeight ?? 0,
    derived: !!image?.currentSrc.startsWith('blob:' + location.origin + '/') };
})()`;

async function probe(address) {
  const socket = new WebSocket(address);
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out observing owned WebView")), 1800);
      const finish = handler => value => { clearTimeout(timer); handler(value); };
      socket.addEventListener("error", finish(reject), { once: true });
      socket.addEventListener("open", () => socket.send(JSON.stringify({
        id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true },
      })), { once: true });
      socket.addEventListener("message", event => {
        const data = JSON.parse(event.data);
        if (data.id === 1) finish(resolve)(data.result?.result?.value);
      });
    });
  } finally { socket.close(); }
}

let last;
while (Date.now() < deadline) {
  try {
    const response = await fetch("http://" + host + "/json/list", {
      signal: AbortSignal.timeout(1600), redirect: "error",
    });
    const targets = (await response.json()).filter(item => {
      if (item.type !== "page") return false;
      const doc = new URL(item.url);
      return embedded.has(doc.origin) && (doc.pathname === "/" || doc.pathname === "/index.html");
    });
    if (targets.length === 1) {
      const endpoint = new URL(targets[0].webSocketDebuggerUrl);
      if (endpoint.protocol !== "ws:" || endpoint.host !== host ||
          !/^\/devtools\/page\/[A-Za-z0-9_-]+$/.test(endpoint.pathname)) {
        throw new Error("Unowned WebView debugger");
      }
      last = await probe(endpoint);
      if (phase === "target") {
        if (["ready", "above", "below", "blocked"].includes(last?.target)) {
          console.log(last.target);
          process.exit(0);
        }
        throw new Error("Unknown installed Photos target state");
      }
      const witnessed = phase === "preview"
        ? last?.modal && last.exactPreview && last.closes === 1
        : last?.gallery && !last.modal && (phase === "imported"
          ? last.tile && last.derived && last.width === 256 && last.height === 160
          : last.matches === 0 && last.count === 0);
      if (witnessed) {
        console.log("Android installed Photos witness:", JSON.stringify({ phase, ...last }));
        process.exit(0);
      }
    }
  } catch {
    // Fresh debug WebView may not have registered on its app-owned ADB socket yet.
  }
  await pause();
}
throw new Error("Installed Photos did not show the expected " + phase + " state: " + JSON.stringify(last));
