import { useEffect, useId, useState } from "react";
import { useVisibleNativeRefresh } from "./useVisibleNativeRefresh";
import { invoke, type Channel } from "@tauri-apps/api/core";
import type { TransferIslandReceipt } from "@aerift/ui";
import { usePrivateRemoteUpload } from "./usePrivateRemoteUpload";
import type { IncomingRemoteFolder } from "./private-remote-island";

type FolderItem = IncomingRemoteFolder & {
  entries: number; destinationRetained: boolean; publishedTitle: string | null;
};
const noIncoming: readonly FolderItem[] = [];
const ignore = () => {};
type Reply = { incoming: FolderItem[]; outgoingReceipt: { state: string } | null; differentDestinationVolume?: boolean };

export function PrivateRemoteFolders({ peers, endpoint, onIncomingChange, onOutgoingChange = ignore }: {
  peers: readonly { id: string; name: string }[];
  endpoint: string;
  onIncomingChange?: (offers: readonly IncomingRemoteFolder[]) => void;
  onOutgoingChange?: (receipt: TransferIslandReceipt | undefined) => void;
}) {
  const recipientLabel = useId();
  const upload = usePrivateRemoteUpload("folder", onOutgoingChange);
  const [peerId, setPeerId] = useState("");
  const [incoming, setIncoming] = useState<readonly FolderItem[]>(noIncoming);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const command = (action: Record<string, string>, progress?: Channel<unknown>) =>
    invoke<Reply>("windows_remote_folder_command", progress ? { action, progress } : { action });
  function updateIncoming(offers: readonly FolderItem[]) {
    setIncoming(offers);
    onIncomingChange?.(offers);
  }

  useEffect(() => () => {
    onIncomingChange?.(noIncoming);
    onOutgoingChange(undefined);
  }, [onIncomingChange, onOutgoingChange]);

  const refresh = useVisibleNativeRefresh("windows_remote_folder_command:inspect", 1000,
    () => command({ action: "inspect" }),
    reply => updateIncoming(reply.incoming),
    () => updateIncoming(noIncoming),
    () => updateIncoming(noIncoming),
  );

  function run(action: Record<string, string>) {
    if (busy) return;
    setBusy(true);
    setMessage(action.action === "pick_send" ? "Choose a folder and wait for the other device to accept." : "");
    const transfer = action.action === "pick_send" ? upload.begin() : undefined;
    void command(action, transfer?.updates).then((reply) => {
      // A mutation result never races an earlier Inspect onto the screen.
      refresh();
      if (reply.differentDestinationVolume) {
        setMessage("The offer is still pending. Choose a folder on the same drive as your AeRift profile (usually C:) so AeRift can save it without copying a partial folder.");
      } else if (reply.outgoingReceipt) {
        setMessage(reply.outgoingReceipt.state === "completed"
          ? "The recipient verified the folder data. This is not confirmation that it was saved to their chosen location."
          : "Remote folder offer ended: " + reply.outgoingReceipt.state + ".");
      }
    }).catch((error: { code?: string } | undefined) => {
      setMessage(error?.code === "cancelled" ? "Cancelled."
        : "The folder action could not finish. No successful export was reported.");
    }).finally(() => { transfer?.close(); setBusy(false); });
  }

  return <section aria-labelledby="remote-folder-heading">
    <h2 id="remote-folder-heading">Folders</h2>
    <p>Choose an authorized device. The recipient must approve the folder before it transfers.</p>
    <label>
      <span id={recipientLabel}>Folder recipient</span>
      <select aria-labelledby={recipientLabel} value={peerId} onChange={(event) => setPeerId(event.target.value)}>
        <option value="">Select an authorized Remote device</option>
        {peers.map((peer) => <option key={peer.id} value={peer.id}>{peer.name} · {peer.id.slice(0, 12)}</option>)}
      </select>
    </label>
    <button disabled={busy || !endpoint.trim() || !peers.some((peer) => peer.id === peerId)}
      onClick={() => run({ action: "pick_send", peerId, endpoint: endpoint.trim() })}>Choose folder to send</button>
    {message && <p role="status">{message}</p>}
    {incoming.length === 0 && <p>No typed folder offers.</p>}
    <ul>{incoming.map((folder) => <li key={folder.peerId + ":" + folder.id}>
      <strong>{folder.title}</strong> · {folder.entries} entries · {folder.sizeBytes.toLocaleString()} bytes
      <p>From <code>{folder.peerId}</code></p>
      <p>{folder.publishedTitle ? "Saved to the destination you chose."
        : folder.status.state === "completed" ? "Folder data verified. Not exported yet." : folder.status.state}</p>
      {folder.status.state === "pending" && <>
        <button disabled={busy} onClick={() => run({ action: "approve", peerId: folder.peerId, id: folder.id })}>
          Accept folder and choose destination
        </button>
        <button disabled={busy} onClick={() => run({ action: "decline", peerId: folder.peerId, id: folder.id })}>
          Decline folder
        </button>
      </>}
      {folder.status.state === "completed" && folder.destinationRetained && !folder.publishedTitle &&
        <button disabled={busy} onClick={() => run({ action: "export", peerId: folder.peerId, id: folder.id })}>
          Save verified folder without replacing files
        </button>}
      {folder.publishedTitle && <button disabled={busy}
        onClick={() => run({ action: "dismiss", peerId: folder.peerId, id: folder.id })}>Dismiss receipt</button>}
    </li>)}</ul>
  </section>;
}
