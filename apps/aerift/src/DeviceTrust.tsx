import { Button, ConnectionStatus } from "@aerift/ui";
import { useState } from "react";
import type { AppSnapshot } from "@aerift/app-contract";
import { nativeAppPort } from "./nativeAppPort";

export function DeviceTrust({ snapshot }: { snapshot: AppSnapshot | undefined }) {
  const [selected, setSelected] = useState<string>();
  const [revoking, setRevoking] = useState(false);
  const [feedback, setFeedback] = useState<{ message: string; error: boolean }>();
  const devices = snapshot?.devices ?? [];

  async function revoke(deviceId: string) {
    setRevoking(true);
    setFeedback(undefined);
    try {
      const result = await nativeAppPort.pair({ action: "revoke", deviceId });
      if (result.ok) {
        setSelected(undefined);
        setFeedback({ message: "Device trust removed.", error: false });
      } else {
        setFeedback({ message: "AeRift could not remove device trust.", error: true });
      }
    } finally {
      setRevoking(false);
    }
  }

  return (
    <section aria-label="Nearby and trusted devices">
      {devices.length ? (
        <ul className="aerift-devices">
          {devices.map((device) => (
            <li key={device.id}>
              <strong>{device.name}</strong>
              <span>{device.paired ? "Paired" : "Unpaired"}</span>
              <ConnectionStatus state={device.online ? "connected" : "offline"}
                label={device.online ? "Online" : "Offline"} />
              {device.paired && (selected === device.id ? (
                <>
                  <Button variant="danger" onClick={() => void revoke(device.id)}
                    loading={revoking} loadingLabel="Removing trust">Confirm unpair</Button>
                  <Button variant="quiet" disabled={revoking} onClick={() => setSelected(undefined)}>Keep paired</Button>
                </>
              ) : <Button variant="quiet" disabled={revoking} onClick={() => setSelected(device.id)}>Unpair</Button>)}
            </li>
          ))}
        </ul>
      ) : <p>{snapshot ? "Searching the local network…" : "Disconnected"}</p>}
      {feedback && <p role={feedback.error ? "alert" : "status"}>{feedback.message}</p>}
    </section>
  );
}
