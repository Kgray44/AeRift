import { Button, GlassSurface, MobileDockMotion, SpatialIcon } from "@aerift/ui";
import { DESTINATIONS } from "@aerift/app-contract/experience";
import type { CSSProperties } from "react";
import { mobileDestinations, type MobileDestination } from "./mobile-experience";

const icons = {
  friends: "friends", home: "home", workspace: "workspace", rift: "send", devices: "desktop", activity: "activity",
} as const;

export function MobileNavigation({ destination, navigate, attention, settingsOpen, openSettings, destinations = mobileDestinations }: {
  destination: MobileDestination;
  destinations?: readonly MobileDestination[];
  navigate: (destination: MobileDestination) => void;
  settingsOpen?: boolean;
  openSettings?: () => void;
  attention: { devices: boolean; activity: boolean };
}) {
  const activeIndex = destinations.indexOf(destination);
  const count = destinations.length + Number(!!openSettings);
  const position = { "--ios-route": Math.max(0, activeIndex), "--ios-route-count": count || 1 } as CSSProperties;
  return <GlassSurface material="chrome" className="ae-nav-destinations ios-dock af-liquid-dock" style={position} data-compact-dock={count >= 7}>
    <MobileDockMotion label="AeRift destinations" index={activeIndex} count={count}>
      {destinations.map(item => <Button key={item} variant="quiet"
        aria-current={destination === item ? "page" : undefined}
        onClick={() => navigate(item)}>
        <SpatialIcon name={icons[item]} size={21} />
        <span className="af-dock-label" aria-hidden="true">
          <span className="af-label-standard">{DESTINATIONS[item].label}</span>
          <span className="af-label-compact">{item === "workspace" ? "Space" : DESTINATIONS[item].label}</span>
        </span>
        <span className="ios-sr-only">{DESTINATIONS[item].label}</span>
        {((item === "devices" && attention.devices) || (item === "activity" && attention.activity)) &&
          <span className="ios-attention"><span className="ios-sr-only">{item === "activity" ? "Transfers active" : "Pairing requests"}</span></span>}
      </Button>)}
      {openSettings && <Button variant="quiet" aria-haspopup="dialog" aria-expanded={!!settingsOpen}
        onClick={openSettings}>
        <SpatialIcon name="settings" size={21} />
        <span className="af-dock-label">Settings</span>
      </Button>}
    </MobileDockMotion>
  </GlassSurface>;
}
