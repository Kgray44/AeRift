import { useLayoutEffect, type ReactNode } from "react";
import { AnimatePresence, useIsPresent, usePresence, type Variants } from "motion/react";
import * as m from "motion/react-m";
import { MotionFeedbackProvider, useQuietMotion } from "./MotionAffordance";

type Handoff = { direction: 1 | -1; suppressed: boolean };
const shown = { x: 0, opacity: 1, transition: { duration: 0 } } as const;
const paneVariants: Variants = {
  enter: ({ direction, suppressed }: Handoff) => suppressed ? shown : { x: 24 * direction, opacity: 0.86 },
  center: { x: 0, opacity: 1, transition: { duration: 0.24, ease: [0.2, 0.72, 0.28, 1] } },
  exit: ({ direction, suppressed }: Handoff) => ({
    x: suppressed ? 0 : -14 * direction, opacity: 0,
    transition: { duration: suppressed ? 0 : 0.16, ease: [0.43, 0, 0.78, 0.29] },
  }),
};

function Pane({ children, handoff }: { children: ReactNode; handoff: Handoff }) {
  const present = useIsPresent();
  const [, safeToRemove] = usePresence();
  const suppressed = useQuietMotion();
  // This can change during an exit (OS override, app setting, backgrounding).
  useLayoutEffect(() => {
    if (suppressed && !present) safeToRemove?.();
  }, [present, suppressed, safeToRemove]);
  return <m.div className="ae-mobile-presence-pane" data-present={present}
    data-motion-suppressed={suppressed || undefined} aria-hidden={!present || undefined} inert={!present}
    initial={suppressed ? false : "enter"} animate={suppressed ? shown : "center"} exit="exit"
    custom={handoff} variants={paneVariants}
    onAnimationComplete={definition => { if (!present && definition === "exit") safeToRemove?.(); }}>
    {children}
  </m.div>;
}

export function MobileRoutePresence({ children, routeKey, direction }: {
  children: ReactNode; routeKey: string; direction: 1 | -1;
}) {
  const suppressed = useQuietMotion();
  const handoff = { direction, suppressed };
  return <MotionFeedbackProvider>
    <div className="ae-mobile-presence">
      <AnimatePresence initial={false} custom={handoff} mode="sync">
        <Pane key={routeKey} handoff={handoff}>{children}</Pane>
      </AnimatePresence>
    </div>
  </MotionFeedbackProvider>;
}
