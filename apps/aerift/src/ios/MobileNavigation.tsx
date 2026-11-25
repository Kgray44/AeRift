import { Button, GlassSurface, MobileDockMotion, SpatialIcon } from "@aerift/ui";
import { DESTINATIONS } from "@aerift/app-contract/experience";
import type { CSSProperties } from "react";
import { mobileDestinations, type MobileDestination } from "./mobile-experience";

const icons = {
  friends: "friends", home: "home", workspace: "workspace", rift: "send", devices: "desktop", activity: "activity",
} as const;

export function MobileNavigation({ destination, navigate, attention, destinations = mobileDestinations }: {
  destination: MobileDestination;
  destinations?: readonly MobileDestination[];
  navigate: (destination: MobileDestination) => void;
  attention: { devices: boolean; activity: boolean };
}) {
  const activeIndex = destinations.indexOf(destination);
  const position = { "--ios-route": Math.max(0, activeIndex), "--ios-route-count": destinations.length || 1 } as CSSProperties;
  return <GlassSurface material="chrome" className="ae-nav-destinations ios-dock af-liquid-dock" style={position}>
    <MobileDockMotion label="AeRift destinations" index={activeIndex} count={destinations.length}>
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
    </MobileDockMotion>
  </GlassSurface>;
}
