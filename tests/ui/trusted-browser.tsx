import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "@aerift/ui";
import { TrustedWorkspaceBrowserChrome } from "../../apps/aerift/src/windows/TrustedWorkspaceBrowserChrome";
import type { NativeBrowserLifecycle, NativeBrowserRequest, NativeBrowserReply } from "../../apps/aerift/src/windows/trusted-browser-session";
import "@aerift/ui/styles.css";
import "../../apps/aerift/src/workspace-library.css";

const mode = new URLSearchParams(location.search).get("mode");
const record: (NativeBrowserRequest | { kind: "default-browser"; address: string })[] = [];
const allowedOrigin = "https://workspace.fixture.invalid";
const native: NativeBrowserLifecycle = {
  witness: mode === "unverified" ? { state: "fixture-only" } : { state: "verified", boundary: "isolated-native-host" },
  async request(command): Promise<NativeBrowserReply> {
    record.push(command);
    if (command.kind === "close") return { kind: "closed" };
    if ("address" in command && new URL(command.address).origin !== allowedOrigin) return { kind: "denied" };
    if (mode === "queued") return { kind: "accepted" };
    return { kind: "presented", viewport: { widthPx: mode === "malformed" ? 16385 : 640, heightPx: 480 },
      canBack: command.kind === "navigate", canForward: command.kind === "back" };
  },
};
const categories = [{ id: "research", label: "Research" }, { id: "personal", label: "Personal" }];
const original = [
  { id: "saved-1", title: "Team handbook", url: allowedOrigin + "/handbook", categoryId: "research" },
  { id: "saved-2", title: "Personal reference", url: allowedOrigin + "/personal", categoryId: "personal" },
];
const recents = [{ id: "recent-1", title: "Recent fixture", url: allowedOrigin + "/recent" }];
function Fixture() {
  const [saved, setSaved] = useState(original);
  const [out, setOut] = useState("");
  const snapshot = () => queueMicrotask(() => setOut(JSON.stringify(record)));
  const recording = useMemo(() => ({
    witness: native.witness,
    request: (request: NativeBrowserRequest) => { const reply = native.request(request); snapshot(); return reply; },
  } satisfies NativeBrowserLifecycle), []);
  return <ThemeProvider theme="glass" scheme="dark">
    <main aria-label="Workspace browser fixture" style={{ width: "min(56rem, calc(100% - 2rem))", margin: "1rem auto" }}>
      <TrustedWorkspaceBrowserChrome native={recording} saved={saved} recents={recents}
        categories={categories} openDefault={async address => { record.push({ kind: "default-browser", address }); snapshot(); return true; }}
        saveLink={({ url, categoryId }) => {
          setSaved(items => [...items, { id: String(items.length), title: new URL(url).pathname, url, categoryId: categoryId ?? "" }]);
          return true;
        }} />
      <pre aria-label="Fixture requests" hidden>{out}</pre>
    </main>
  </ThemeProvider>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
