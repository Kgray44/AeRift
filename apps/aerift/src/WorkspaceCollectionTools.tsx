import { Button, GlassSurface } from "@aerift/ui";
import { useId, useRef, useState } from "react";
import {
  changeCollectionMembership, collectionCandidates, collectionQueryLimit,
  type WorkspaceCollectionChange, type WorkspaceCollectionObject,
} from "./workspace-collection-tools";

const visibleResultLimit = 40;

export function WorkspaceCollectionTools({ name, memberIds, objects, onChange, disabled = false }: {
  name: string;
  memberIds: readonly string[];
  objects: readonly WorkspaceCollectionObject[];
  onChange: (nextIds: readonly string[], previousIds: readonly string[]) => boolean | Promise<boolean>;
  disabled?: boolean;
}) {
  const headingId = useId();
  const candidatesId = useId();
  const searchInput = useRef<HTMLInputElement>(null);
  const changing = useRef(false);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const membersById = new Map<string, WorkspaceCollectionObject>();
  for (const object of objects) {
    if (!membersById.has(object.id)) membersById.set(object.id, object);
  }
  const candidates = collectionCandidates(objects, memberIds, query);
  const locked = disabled || busy;

  async function edit(change: WorkspaceCollectionChange, focus?: HTMLElement | null) {
    if (disabled || changing.current) return;
    const previous = [...memberIds];
    const next = changeCollectionMembership(previous, change, objects);
    if (!next) return;
    const label = membersById.get(change.id)?.name || "Unavailable item";
    changing.current = true;
    setBusy(true);
    setStatus("");
    setError("");
    try {
      if (!await onChange(next, previous)) throw new Error();
      if (change.type === "move") {
        setStatus(`${label} moved to position ${next.indexOf(change.id) + 1} of ${next.length}.`);
      } else {
        setStatus(change.type === "add" ? `Added ${label} to the collection.` : `Removed ${label} from the collection only.`);
      }
    } catch {
      setError("Could not update the collection. Try again.");
    } finally {
      changing.current = false;
      setBusy(false);
      // Mutation can remove the activating button or put it at a list boundary.
      // Preserve a keyboard destination without stealing focus from outside.
      const active = document.activeElement;
      if ((!active || active === document.body) && focus?.isConnected) focus.focus();
    }
  }

  return <GlassSurface material="content" className="aw-collection-tools">
    <section aria-labelledby={headingId} aria-busy={busy}>
      <h4 id={headingId}>{name} contents</h4>
      {memberIds.length ? <ol className="aw-collection-members">
        {memberIds.map((id, index) => {
          const label = membersById.get(id)?.name || "Unavailable item";
          return <li key={memberIds.indexOf(id) === index ? id : `${id}:duplicate:${index}`} tabIndex={-1}>
            <strong>{label}</strong>
            <div className="ae-actions">
              <Button type="button" variant="quiet" disabled={locked || index === 0}
                aria-label={`Move ${label} up`} onClick={event => void edit({ type: "move", id, by: -1 }, event.currentTarget.closest("li"))}>↑</Button>
              <Button type="button" variant="quiet" disabled={locked || index === memberIds.length - 1}
                aria-label={`Move ${label} down`} onClick={event => void edit({ type: "move", id, by: 1 }, event.currentTarget.closest("li"))}>↓</Button>
              <Button type="button" variant="quiet" disabled={locked}
                aria-label={`Remove ${label} from collection`}
                onClick={() => void edit({ type: "remove", id }, searchInput.current)}>Remove</Button>
            </div>
          </li>;
        })}
      </ol> : <p>This collection is empty.</p>}

      <section aria-labelledby={candidatesId}>
        <h5 id={candidatesId}>Add items</h5>
        <label>Find an item to add
          <input ref={searchInput} type="search" data-ae-lens-role="control" autoComplete="off" maxLength={collectionQueryLimit}
            value={query} onChange={event => setQuery(event.currentTarget.value)} />
        </label>
        {!candidates.length ? <p>{query.trim() ? "No available items match your search." : "No more items to add."}</p> :
          <>
            {candidates.length > visibleResultLimit && <p>Showing {visibleResultLimit} of {candidates.length} matches. Search to narrow the list.</p>}
            <ul className="aw-collection-candidates">
              {candidates.slice(0, visibleResultLimit).map(item => <li key={item.id}>
                <span>{item.name}</span>
                <Button type="button" variant="quiet" disabled={locked}
                  aria-label={`Add ${item.name} to collection`} onClick={() => void edit({ type: "add", id: item.id }, searchInput.current)}>Add</Button>
              </li>)}
            </ul>
          </>}
      </section>
      {status && <p role="status">{status}</p>}
      {error && <p role="alert">{error}</p>}
    </section>
  </GlassSurface>;
}
