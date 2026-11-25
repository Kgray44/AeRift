import { Button, ConnectionStatus, GlassSurface, IconAction, SpatialIcon } from "@aerift/ui";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import type { AppPort, AppSnapshot } from "@aerift/app-contract";
import { partitionDevices } from "@aerift/app-contract/friends";
import { nativeAppPort } from "./nativeAppPort";

const devicePlatform = {
  ios: ["iPhone", "phone"], android: ["Android", "phone"], windows: ["Windows", "desktop"],
  macos: ["Mac", "desktop"], linux: ["Linux", "desktop"],
} as const;

export function DeviceTrust({ snapshot, port = nativeAppPort, actions, compactActions = false }: {
  snapshot: AppSnapshot | undefined; port?: AppPort; actions?: ReactNode; compactActions?: boolean;
}) {
  const [selected, setSelected] = useState<string>();
  const [revoking, setRevoking] = useState(false);
  const [feedback, setFeedback] = useState<{ message: string; error: boolean }>();
  const { personal, nearby: devices } = partitionDevices(snapshot?.devices ?? [], snapshot?.friends, snapshot?.personalDeviceIds);

  const nearbyHeading = useRef<HTMLHeadingElement>(null);
  const focusAfterRemoval = useRef(false);
  const cancel = useRef<HTMLButtonElement>(null);
  const triggers = useRef(new Map<string, HTMLButtonElement>());
  const restore = useRef<string>(undefined);
  const visibleSelection = devices.some(device => device.id === selected && device.paired) ? selected : undefined;
  useLayoutEffect(() => {
    if (visibleSelection) cancel.current?.focus({ preventScroll: true });
    else if (focusAfterRemoval.current) {
      nearbyHeading.current?.focus({ preventScroll: true });
      focusAfterRemoval.current = false;
    } else if (restore.current) {
      triggers.current.get(restore.current)?.focus({ preventScroll: true });
      restore.current = undefined;
    }
  }, [visibleSelection]);

  async function revoke(deviceId: string) {
    setRevoking(true);
    setFeedback(undefined);
    try {
      const result = await port.pair({ action: "revoke", deviceId });
      if (result.ok) {
        focusAfterRemoval.current = true;
        setSelected(undefined);
        setFeedback({ message: "Device trust removed.", error: false });
      } else {
        setFeedback({ message: "AeRift could not remove device trust.", error: true });
      }
    } finally {
      setRevoking(false);
    }
  }

  function trackTrigger(deviceId: string, node: HTMLButtonElement | null) {
    if (node) triggers.current.set(deviceId, node);
    else triggers.current.delete(deviceId);
  }

  return (
    <section className="aerift-device-trust" aria-label="Nearby and trusted devices">
      {snapshot?.personalDeviceIds && <GlassSurface className="aerift-device-zone" material="content" role="region" aria-label="My Devices">
        <div className="aerift-device-zone-head">
          <div><h3>My Devices</h3><p>{compactActions ? "Your authorized devices." : "Devices authorized as yours. This is separate from nearby pairing."}</p></div>
        </div>
        {personal.length ? <ul className="aerift-devices">{personal.map(device => <li key={device.id}>
          <div className="aerift-device-id"><SpatialIcon name={devicePlatform[device.platform][1]} size={22} />
            <div><strong>{device.name}</strong><small>{devicePlatform[device.platform][0]}</small></div></div>
          <ConnectionStatus state={device.online ? "connected" : "offline"} label={device.online ? "Online" : "Offline"} />
        </li>)}</ul> : <p>No authorized personal devices.</p>}
      </GlassSurface>}
      <GlassSurface className="aerift-device-zone" material="content" role="region" aria-label="Nearby Devices">
      <div className="aerift-device-zone-head">
        <div><h3 ref={nearbyHeading} tabIndex={-1}>Nearby Devices</h3><p>{compactActions ? "Pair on this network. Remote access requires separate approval." :
          "Pair with a device you recognize on this network. Pairing alone does not grant remote access."}</p></div>
        {actions && <div className="ae-actions aerift-device-actions">{actions}</div>}
      </div>
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
              {device.paired && visibleSelection !== device.id && (compactActions ?
                <IconAction icon="unlink" disabled={revoking} label={`Unpair ${device.name}`}
                  ref={node => trackTrigger(device.id, node)} onClick={() => setSelected(device.id)} /> :
                <Button variant="quiet" disabled={revoking} aria-label={`Unpair ${device.name}`}
                  ref={node => trackTrigger(device.id, node)} onClick={() => setSelected(device.id)}>Unpair</Button>)}
              {device.paired && visibleSelection === device.id && <div className="aerift-device-confirm" data-ae-route-enter="neutral"
                role="group" aria-label={`Unpair ${device.name}?`} onKeyDown={event => {
                  if (event.key === "Escape" && !revoking) {
                    event.stopPropagation();
                    restore.current = device.id;
                    setSelected(undefined);
                  }
                }}>
                <p>Unpair <strong>{device.name}</strong>? Future nearby transfers require pairing again.</p>
                <div className="ae-actions">
                  <Button variant="quiet" ref={cancel} disabled={revoking} onClick={() => {
                    restore.current = device.id;
                    setSelected(undefined);
                  }}>Keep paired</Button>
                  <Button variant="danger" onClick={() => void revoke(device.id)}
                    loading={revoking} loadingLabel="Removing trust">Confirm unpair</Button>
                </div>
              </div>}
            </li>
          ))}
        </ul>
      ) : <div className="aerift-devices-empty">
        <SpatialIcon name="desktop" size={22} />
        <p>{snapshot ? "Searching the local network…" : "Disconnected"}</p>
      </div>}
      {feedback && <p role={feedback.error ? "alert" : "status"}>{feedback.message}</p>}
      </GlassSurface>
    </section>
  );
}
