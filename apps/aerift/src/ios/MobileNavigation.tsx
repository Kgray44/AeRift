import { GlassSurface } from "@aerift/ui";
import { mobileDestinations, type MobileDestination } from "./mobile-experience";

import { DESTINATIONS } from "@aerift/app-contract/experience";

const icons: Record<MobileDestination, string> = {
  home: "⌂", workspace: "▤", rift: "⟷", devices: "▣", activity: "≋",
};

export function MobileNavigation({ destination, navigate, attention }: {
  destination: MobileDestination;
  navigate: (destination: MobileDestination) => void;
  attention: { devices: boolean; activity: boolean };
}) {
  return <GlassSurface material="chrome" className="ios-dock">
    <nav aria-label="AeRift destinations">
      {mobileDestinations.map(item => <button key={item} type="button"
        aria-current={destination === item ? "page" : undefined}
        onClick={() => navigate(item)}>
        <span className="ios-nav-icon" aria-hidden="true">{icons[item]}</span>
        <span>{DESTINATIONS[item].label}</span>
        {((item === "devices" && attention.devices) || (item === "activity" && attention.activity)) &&
          <span className="ios-attention"><span className="ios-sr-only">Needs attention</span></span>}
      </button>)}
    </nav>
  </GlassSurface>;
}
