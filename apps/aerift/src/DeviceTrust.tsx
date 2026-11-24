import { Button, ConnectionStatus, SpatialIcon } from "@aerift/ui";
import { useState } from "react";
import type { AppPort, AppSnapshot } from "@aerift/app-contract";
import { nativeAppPort } from "./nativeAppPort";

const devicePlatform = {
  ios: ["iPhone", "phone"], android: ["Android", "phone"], windows: ["Windows", "desktop"],
  macos: ["Mac", "desktop"], linux: ["Linux", "desktop"],
} as const;

export function DeviceTrust({ snapshot, port = nativeAppPort }: { snapshot: AppSnapshot | undefined; port?: AppPort }) {
  const [selected, setSelected] = useState<string>();
  const [revoking, setRevoking] = useState(false);
  const [feedback, setFeedback] = useState<{ message: string; error: boolean }>();
  const devices = snapshot?.devices ?? [];

  async function revoke(deviceId: string) {
    setRevoking(true);
    setFeedback(undefined);
    try {
      const result = await port.pair({ action: "revoke", deviceId });
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
    <section className="aerift-device-trust" aria-label="Nearby and trusted devices">
      {devices.length ? (
        <ul className="aerift-devices">
          {devices.map((device) => (
            <li key={device.id}>
              <div className="aerift-device-id">
                <span className="aerift-device-symbol" aria-hidden="true">
                  <SpatialIcon name={devicePlatform[device.platform][1]} size={22} />
                </span>
                <div><strong>{device.name}</strong><small>{devicePlatform[device.platform][0]} · {device.paired ? "Paired" : "Unpaired"}</small></div>
              </div>
              <ConnectionStatus state={device.online ? "connected" : "offline"} label={device.online ? "Online" : "Offline"} />
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
      ) : <div className="aerift-devices-empty">
        <SpatialIcon name="desktop" size={22} />
        <p>{snapshot ? "Searching the local network…" : "Disconnected"}</p>
      </div>}
      {feedback && <p role={feedback.error ? "alert" : "status"}>{feedback.message}</p>}
    </section>
  );
}
