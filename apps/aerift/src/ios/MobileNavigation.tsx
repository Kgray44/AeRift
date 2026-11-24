import { Button, GlassSurface, SpatialIcon } from "@aerift/ui";
import { DESTINATIONS } from "@aerift/app-contract/experience";
import { useLayoutEffect, useRef, type CSSProperties } from "react";
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
  const lens = useRef<HTMLSpanElement>(null);
  const previous = useRef(destination);
  const activeIndex = destinations.indexOf(destination);
  const position = { "--ios-route": Math.max(0, activeIndex), "--ios-route-count": destinations.length || 1 } as CSSProperties;
  useLayoutEffect(() => {
    const changed = previous.current !== destination;
    previous.current = destination;
    const element = lens.current;
    if (!changed || activeIndex < 0 || !element?.animate || !element.getClientRects().length || document.hidden ||
        element.closest('[data-motion="reduce"]')) return;
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (preference.matches) return;
    const style = getComputedStyle(element);
    const cssDuration = style.getPropertyValue("--ae-motion-route").trim();
    const duration = cssDuration.endsWith("ms") ? parseFloat(cssDuration) : parseFloat(cssDuration) * 1000;
    if (!Number.isFinite(duration) || duration <= 0) return;
    // Scale lives on the inside of the lens; its track owns translation.
    // Cancelling this impulse never changes the selected tab or its focus.
    const animation = element.animate([
      { transform: "scale3d(.94,.94,1)", offset: 0 },
      { transform: "scale3d(1.14,.88,1)", offset: .43 },
      { transform: "scale3d(1.02,1.018,1)", offset: .77 },
      { transform: "scale3d(1,1,1)", offset: 1 },
    ], { duration, easing: style.getPropertyValue("--ae-motion-out").trim() || "ease-out" });
    const settle = () => animation.cancel();
    const onVisibility = () => { if (document.hidden) settle(); };
    const onPreference = () => { if (preference.matches) settle(); };
    document.addEventListener("visibilitychange", onVisibility);
    preference.addEventListener("change", onPreference);
    const theme = element.closest("[data-motion]");
    const scope = new MutationObserver(() => { if (theme?.getAttribute("data-motion") === "reduce") settle(); });
    if (theme) scope.observe(theme, { attributes: true, attributeFilter: ["data-motion"] });
    return () => {
      settle();
      scope.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      preference.removeEventListener("change", onPreference);
    };
  }, [destination, activeIndex]);
  return <GlassSurface material="chrome" className="ae-nav-destinations ios-dock af-liquid-dock" style={position}>
    <nav aria-label="AeRift destinations">
      {activeIndex >= 0 && <span className="af-dock-fluid" aria-hidden="true"><span ref={lens} className="af-dock-bead"/></span>}
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
    </nav>
  </GlassSurface>;
}
