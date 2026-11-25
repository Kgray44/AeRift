import type { ForwardedRef, ReactNode } from "react";
import { forwardRef, useSyncExternalStore } from "react";
import { LayoutGroup, LazyMotion, MotionConfig, type Variants } from "motion/react";
import * as m from "motion/react-m";
import { useAppearanceMotion } from "./theme";

// Keep gesture effects on the inner decoration. The actual hit target, focus
// ring, layout, and Glass surface stay stable throughout press and release.
const settle = { type: "spring", stiffness: 490, damping: 32, mass: 0.56 } as const;
const push = { type: "spring", stiffness: 670, damping: 42, mass: 0.44 } as const;
const accents: Record<"symbol" | "chevron", Variants> = {
  symbol: {
    idle: { scale: 1, y: 0, transition: settle },
    hover: { scale: 1.045, y: -2, transition: settle },
    press: { scale: 0.96, y: 0, transition: push },
  },
  chevron: {
    idle: { x: 0, transition: settle },
    hover: { x: 3, transition: settle },
    press: { x: 1, transition: push },
  },
};

const reduceQuery = "(prefers-reduced-motion: reduce)";
function subscribeQuietMotion(notify: () => void) {
  const preference = window.matchMedia(reduceQuery);
  preference.addEventListener("change", notify);
  document.addEventListener("visibilitychange", notify);
  return () => {
    preference.removeEventListener("change", notify);
    document.removeEventListener("visibilitychange", notify);
  };
}
const systemQuietMotion = () => document.hidden || window.matchMedia(reduceQuery).matches;
const quietDuringPrerender = () => true;

/** Keeps spatial feedback off in both reduction modes and when backgrounded. */
export function useQuietMotion() {
  const system = useSyncExternalStore(subscribeQuietMotion, systemQuietMotion, quietDuringPrerender);
  return useAppearanceMotion() === "reduce" || system;
}

const loadMotionFeatures = () => import("./react-motion-features").then(module => module.default);

export function MotionFeedbackProvider({ children, group }: { children: ReactNode; group?: string }) {
  const reduction = useAppearanceMotion();
  return <LazyMotion features={loadMotionFeatures} strict>
    <MotionConfig reducedMotion={reduction === "reduce" ? "always" : "user"}>
      {group ? <LayoutGroup id={group}>{children}</LayoutGroup> : children}
    </MotionConfig>
  </LazyMotion>;
}

type CardButtonProps = {
  label: string;
  className?: string;
  onClick: () => void;
  children: ReactNode;
};
export const MotionCardButton = forwardRef(function MotionCardButton(
  { label, className, onClick, children }: CardButtonProps,
  ref: ForwardedRef<HTMLButtonElement>,
) {
  const quiet = useQuietMotion();
  return <m.button ref={ref} type="button" aria-label={label} className={className} onClick={onClick}
    initial={false} animate="idle" whileHover={quiet ? undefined : "hover"} whileTap={quiet ? undefined : "press"}>{children}</m.button>;
});

export function MotionCardAccent({ role, className, children, layoutId }: {
  role: keyof typeof accents;
  layoutId?: string;
  className: string;
  children: ReactNode;
}) {
  const quiet = useQuietMotion();
  return <m.span className={className} variants={quiet ? undefined : accents[role]} layoutId={quiet ? undefined : layoutId} transition={{ layout: settle }}>{children}</m.span>;
}
