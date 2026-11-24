import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type FolderItem = {
  peerId: string; id: string; title: string; entries: number; sizeBytes: number;
  status: { state: string; bytesTransferred: number };
  destinationRetained: boolean; publishedTitle: string | null;
};
type Reply = { incoming: FolderItem[]; outgoingReceipt: { state: string } | null };

export function PrivateRemoteFolders({ peers, endpoint }: {
  peers: readonly { id: string; name: string }[];
  endpoint: string;
}) {
  const [peerId, setPeerId] = useState("");
  const [incoming, setIncoming] = useState<FolderItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const command = (action: Record<string, string>) =>
    invoke<Reply>("windows_remote_folder_command", { action });
  useEffect(() => {
    let live = true;
    const poll = () => {
      void command({ action: "inspect" })
        .then((reply) => { if (live) setIncoming(reply.incoming); })
        .catch(() => { if (live) setIncoming([]); });
    };
    poll();
    const timer = window.setInterval(poll, 1000);
    return () => { live = false; window.clearInterval(timer); };
  }, []);

  function run(action: Record<string, string>) {
    if (busy) return;
    setBusy(true);
    setMessage(action.action === "pick_send" ? "Choose a folder and wait for the other device to accept." : "");
    void command(action).then((reply) => {
      setIncoming(reply.incoming);
      if (reply.outgoingReceipt) {
        setMessage(reply.outgoingReceipt.state === "completed"
          ? "The recipient verified the folder data. This is not confirmation that it was saved to their chosen location."
          : "Remote folder offer ended: " + reply.outgoingReceipt.state + ".");
      }
    }).catch((error: { code?: string } | undefined) => {
      setMessage(error?.code === "cancelled" ? "Cancelled."
        : "The folder action could not finish. No successful export was reported.");
    }).finally(() => setBusy(false));
  }

  return <section aria-labelledby="remote-folder-heading">
    <h2 id="remote-folder-heading">Private Remote folders (qualification)</h2>
    <p>Folder decisions are separate from file decisions. Send only synthetic test folders.</p>
    <label>Folder recipient <select value={peerId} onChange={(event) => setPeerId(event.target.value)}>
      <option value="">Select an authorized Remote device</option>
      {peers.map((peer) => <option key={peer.id} value={peer.id}>{peer.name} · {peer.id.slice(0, 12)}</option>)}
    </select></label>
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
