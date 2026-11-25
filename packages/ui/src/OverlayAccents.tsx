import { useReducedMotion } from "motion/react";
import * as m from "motion/react-m";
import { MotionFeedbackProvider } from "./MotionAffordance";
import { useAppearanceMotion } from "./theme";
import "./overlay-motion.css";

type OverlayKind = "sheet" | "popover";
const sweep = [0.21, 0.69, 0.29, 1] as const;

/** The native top layer owns motion of the surface and closing/focus. This
 * short, expendable reflection only follows the physical opening. */
export function OverlayAccents({ active, kind }: { active: boolean; kind: OverlayKind }) {
  const appReduced = useAppearanceMotion() === "reduce";
  const osReduced = useReducedMotion();
  if (!active || appReduced || osReduced) return null;

  const duration = kind === "sheet" ? .52 : .36;
  return <MotionFeedbackProvider>
    <span className="ae-overlay-accents" data-overlay-kind={kind} aria-hidden="true">
      <m.span className="ae-overlay-glint"
        initial={{ x: "-105%", opacity: 0 }}
        animate={{ x: "105%", opacity: [0, .85, .46, 0] }}
        transition={{ x: { duration, ease: sweep }, opacity: { duration, ease: "linear", times: [0, .34, .68, 1] } }} />
    </span>
  </MotionFeedbackProvider>;
}
