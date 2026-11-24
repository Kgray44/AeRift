import { Button, GlassSurface, SpatialIcon } from "@aerift/ui";
import { useId, useLayoutEffect, useRef, useState } from "react";
import type { ModuleId } from "@aerift/app-contract/experience";
import { workspaceSections, type WorkspaceSection, type WorkspaceSectionId } from "./workspace-categories";
import "./workspace-library.css";

export function useWorkspaceLibrary(enabled: (module: ModuleId) => boolean) {
  const [selected, setSelected] = useState<WorkspaceSectionId>();
  const cards = useRef(new Map<WorkspaceSectionId, HTMLButtonElement>());
  const returnTo = useRef<WorkspaceSectionId>(undefined);
  const heading = useRef<HTMLHeadingElement>(null);
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
  return {
    sections, section, heading,
    cardRef: (id: WorkspaceSectionId, node: HTMLButtonElement | null) => {
      if (node) cards.current.set(id, node);
      else cards.current.delete(id);
    },
    open: (id: WorkspaceSectionId) => { returnTo.current = id; setSelected(id); },
    back: () => setSelected(undefined),
  };
}

export function WorkspaceLibrary({ sections, open, cardRef, counts }: {
  sections: readonly WorkspaceSection[];
  open: (id: WorkspaceSectionId) => void;
  cardRef: (id: WorkspaceSectionId, node: HTMLButtonElement | null) => void;
  counts?: Partial<Record<WorkspaceSectionId, number>>;
}) {
  const introId = useId();
  return <section className="aw-library" aria-labelledby={introId}>
    <div className="aw-intro">
      <span className="aw-kicker">Your library</span>
      <h3 id={introId}>Everything in its place.</h3>
      <p>Open a workspace to collect, organize, or get something ready for Rift.</p>
    </div>
    {sections.length ? <ul className="aw-grid" aria-label="Workspace categories">
      {sections.map(section => <li key={section.id}>
        <GlassSurface material="raised" className="aw-card" data-ae-lens-role="control" data-aw-tint={section.tint}>
          <button type="button" className="aw-card-button" ref={node => { cardRef(section.id, node); }}
            aria-label={section.label} onClick={() => open(section.id)}>
            <span className="aw-card-top" aria-hidden="true">
              <span className="aw-symbol"><SpatialIcon name={section.icon} size={25} /></span>
              <span className="aw-chevron">›</span>
            </span>
            <span className="aw-card-title">{section.label}</span>
            <span className="aw-card-description">{section.description}</span>
            {typeof counts?.[section.id] === "number" && <span className="aw-count">{counts[section.id]} {counts[section.id] === 1 ? "item" : "items"}</span>}
          </button>
        </GlassSurface>
      </li>)}
    </ul> : <p>Enable at least one Workspace category in Settings.</p>}
  </section>;
}

export function WorkspaceCategoryHeading({ section, heading, onBack }: {
  section: WorkspaceSection;
  heading: React.RefObject<HTMLHeadingElement | null>;
  onBack: () => void;
}) {
  return <header className="aw-category-heading" data-aw-tint={section.tint}>
    <Button variant="quiet" className="aw-back" onClick={onBack}><span aria-hidden="true">‹</span> Back to Workspace</Button>
    <div className="aw-category-title">
      <span className="aw-symbol" aria-hidden="true"><SpatialIcon name={section.icon} size={28} /></span>
      <div><h3 ref={heading} tabIndex={-1}>{section.label}</h3><p>{section.description}</p></div>
    </div>
  </header>;
}
