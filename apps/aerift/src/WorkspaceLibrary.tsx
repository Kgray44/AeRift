import { Button, GlassSurface, IconAction, MotionCardButton, MotionCardAccent, SpatialIcon } from "@aerift/ui";
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { ModuleId } from "@aerift/app-contract/experience";
import { workspaceSections, type WorkspaceSection, type WorkspaceSectionId } from "./workspace-categories";
import "./workspace-library.css";
import { useQuietMotion } from "@aerift/ui";
import { WorkspacePanelMotion, workspacePanelBox, type PanelHandoff } from "@aerift/ui";

export function useWorkspaceLibrary(enabled: (module: ModuleId) => boolean) {
  const [selected, setSelected] = useState<WorkspaceSectionId>();
  const cards = useRef(new Map<WorkspaceSectionId, HTMLButtonElement>());
  const returnTo = useRef<WorkspaceSectionId>(undefined);
  const heading = useRef<HTMLHeadingElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const quiet = useQuietMotion();
  const [handoff, setHandoff] = useState<PanelHandoff>();
  const pending = useRef<Omit<PanelHandoff, "to" | "host"> & { card: WorkspaceSectionId }>(undefined);
  const serial = useRef(0);
  const sections = workspaceSections.filter(section => enabled(section.module));
  const section = sections.find(item => item.id === selected);
  useLayoutEffect(() => {
    if (section) heading.current?.focus();
    else if (returnTo.current) {
      const target = cards.current.get(returnTo.current) ?? cards.current.values().next().value;
      target?.focus();
      returnTo.current = undefined;
    }
  }, [section?.id]);
  useLayoutEffect(() => {
    const request = pending.current;
    pending.current = undefined;
    if (!request || quiet) return;
    const destination = request.direction === "back"
      ? workspacePanelBox(cards.current.get(request.card)?.closest(".aw-card"))
      : workspacePanelBox(host.current);
    const scene = host.current?.getBoundingClientRect();
    if (destination && scene) setHandoff({ ...request, to: destination, host: scene });
  }, [section?.id, quiet]);
  useLayoutEffect(() => { if (quiet) setHandoff(undefined); }, [quiet]);
  useEffect(() => {
    if (!handoff) return;
    const cancel = () => setHandoff(undefined);
    window.addEventListener("resize", cancel);
    return () => window.removeEventListener("resize", cancel);
  }, [handoff]);
  function queue(id: WorkspaceSectionId, direction: "forward" | "back") {
    pending.current = undefined;
    setHandoff(undefined);
    if (quiet || !host.current?.closest('.ae-theme[data-ae-theme="glass"]')
      || host.current.closest('[data-transparency="reduce"], [data-contrast="increase"]')) return;
    const movingRim = host.current?.querySelector(".aw-handoff-rim rect");
    const from = workspacePanelBox(movingRim) ?? (direction === "forward"
      ? workspacePanelBox(cards.current.get(id)?.closest(".aw-card"))
      : workspacePanelBox(host.current));
    const tint = sections.find(candidate => candidate.id === id)?.tint;
    if (from && tint) pending.current = { id: ++serial.current, from, tint, direction, card: id };
  }
  return {
    sections, section, heading, host, handoff,
    settle: (id: number) => setHandoff(current => current?.id === id ? undefined : current),
    cardRef: (id: WorkspaceSectionId, node: HTMLButtonElement | null) => {
      if (node) cards.current.set(id, node);
      else cards.current.delete(id);
    },
    open: (id: WorkspaceSectionId) => { if (!section) queue(id, "forward"); returnTo.current = id; setSelected(id); },
    back: () => { if (section) queue(section.id, "back"); setSelected(undefined); },
  };
}

export function WorkspaceScene({ scene, children }: { scene: ReturnType<typeof useWorkspaceLibrary>; children: ReactNode }) {
  return <div className="aw-workspace-scene" ref={scene.host} data-aw-arrival={scene.handoff?.direction}>
    {scene.handoff && <WorkspacePanelMotion key={scene.handoff.id} handoff={scene.handoff} onComplete={scene.settle} />}
    {children}
  </div>;
}

export function WorkspaceLibrary({ sections, open, cardRef, counts, desktop = false }: {
  sections: readonly WorkspaceSection[];
  open: (id: WorkspaceSectionId) => void;
  cardRef: (id: WorkspaceSectionId, node: HTMLButtonElement | null) => void;
  counts?: Partial<Record<WorkspaceSectionId, number>>;
  desktop?: boolean;
}) {
  const introId = useId();
  return <section className="aw-library" aria-labelledby={introId}>
    {desktop ? <h3 id={introId} className="aw-desktop-library-title">Your library</h3> : <div className="aw-intro">
      <span className="aw-kicker">Your library</span>
      <h3 id={introId}>Everything in its place.</h3>
      <p>Open a workspace to collect, organize, or get something ready for Rift.</p>
    </div>}
    {sections.length ? <ul className="aw-grid" aria-label="Workspace categories">
      {sections.map(section => <li key={section.id}>
        <GlassSurface material="raised" className="aw-card" data-ae-lens-role="control" data-aw-tint={section.tint}>
          <MotionCardButton className="aw-card-button" ref={node => { cardRef(section.id, node); }}
            label={section.label} onClick={() => open(section.id)}>
            <span className="aw-card-top" aria-hidden="true">
              <MotionCardAccent role="symbol" className="aw-symbol"><SpatialIcon name={section.icon} size={25} /></MotionCardAccent>
              <MotionCardAccent role="chevron" className="aw-chevron">›</MotionCardAccent>
            </span>
            <span className="aw-card-title">{section.label}</span>
            <span className="aw-card-description">{section.description}</span>
            {typeof counts?.[section.id] === "number" && <span className="aw-count">{counts[section.id]} {counts[section.id] === 1 ? "item" : "items"}</span>}
          </MotionCardButton>
        </GlassSurface>
      </li>)}
    </ul> : <p>Enable at least one Workspace category in Settings.</p>}
  </section>;
}

export function WorkspaceCategoryHeading({ section, heading, onBack, desktop = false }: {
  section: WorkspaceSection;
  heading: React.RefObject<HTMLHeadingElement | null>;
  onBack: () => void;
  desktop?: boolean;
}) {
  return <header className="aw-category-heading" data-aw-desktop={desktop || undefined} data-aw-tint={section.tint}>
    {desktop ? <IconAction className="aw-back" label="Back to Workspace" icon="back" onClick={onBack} /> :
      <Button variant="quiet" className="aw-back" onClick={onBack}><span aria-hidden="true">‹</span> Back to Workspace</Button>}
    <div className="aw-category-title">
      <div className="aw-heading-symbol" aria-hidden="true"><MotionCardAccent role="symbol" className="aw-symbol">
        <SpatialIcon name={section.icon} size={28} />
      </MotionCardAccent></div>
      <div><h3 ref={heading} tabIndex={-1}>{section.label}</h3><p>{section.description}</p></div>
    </div>
  </header>;
}
