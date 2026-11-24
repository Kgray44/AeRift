import { Button, GlassSurface, SpatialIcon } from "@aerift/ui";
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
  const position = { "--ios-route": destinations.indexOf(destination), "--ios-route-count": destinations.length } as CSSProperties;
  return <GlassSurface material="chrome" className="ae-nav-destinations ios-dock" style={position}>
    <nav aria-label="AeRift destinations">
      <span className="ae-nav-indicator" aria-hidden="true" />
      {destinations.map(item => <Button key={item} variant="quiet"
        aria-current={destination === item ? "page" : undefined}
        onClick={() => navigate(item)}>
        <SpatialIcon name={icons[item]} size={19} />
        <span>{DESTINATIONS[item].label}</span>
        {((item === "devices" && attention.devices) || (item === "activity" && attention.activity)) &&
          <span className="ios-attention"><span className="ios-sr-only">{item === "activity" ? "Transfers active" : "Pairing requests"}</span></span>}
      </Button>)}
    </nav>
  </GlassSurface>;
}
