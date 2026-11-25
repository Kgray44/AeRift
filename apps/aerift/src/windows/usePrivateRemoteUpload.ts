import { Channel } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef } from "react";
import type { TransferIslandReceipt } from "@aerift/ui";
import { projectPrivateRemoteUpload, type UploadKind } from "./private-remote-upload";

const ignore = () => {};

/** One command-owned channel and one active projection, no global listeners or polling. */
export function usePrivateRemoteUpload(
  kind: UploadKind, publish: (receipt: TransferIslandReceipt | undefined) => void,
) {
  const current = useRef<Channel<unknown> | undefined>(undefined);
  const stopListening = useCallback((expected?: Channel<unknown>) => {
    const active = current.current;
    if (!active || (expected && active !== expected)) return false;
    current.current = undefined;
    active.onmessage = ignore;
    return true;
  }, []);
  useEffect(() => () => { stopListening(); }, [stopListening]);

  const close = useCallback(() => {
    if (stopListening()) publish(undefined);
  }, [publish, stopListening]);

  function begin() {
    close();
    let observed: TransferIslandReceipt | undefined;
    const channel = new Channel<unknown>(message => {
      if (current.current !== channel) return;
      const next = projectPrivateRemoteUpload(kind, observed, message);
      if (next !== observed) {
        observed = next;
        publish(next);
      }
    });
    current.current = channel;
    return {
      updates: channel,
      close() { if (stopListening(channel)) publish(undefined); },
    };
  }

  return { begin, close };
}
