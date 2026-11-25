export interface WorkspaceCollectionObject {
  id: string;
  name: string;
  kind?: string;
}

export type WorkspaceCollectionChange =
  | { type: "add" | "remove"; id: string }
  | { type: "move"; id: string; by: -1 | 1 };

export const collectionQueryLimit = 180;

export function collectionCandidates(
  objects: readonly WorkspaceCollectionObject[], memberIds: readonly string[], query: string,
) {
  const seen = new Set(memberIds);
  const words = query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  return objects.filter(object => {
    if (!object.id || seen.has(object.id) || object.kind === "collection") return false;
    seen.add(object.id);
    const text = `${object.name}\n${object.kind ?? ""}`.toLocaleLowerCase();
    return words.every(word => text.includes(word));
  });
}

// Applies a single edit to this collection's reference list only. A failed
// operation returns null, never a partially reordered or filtered list.
export function changeCollectionMembership(
  memberIds: readonly string[],
  edit: WorkspaceCollectionChange,
  objects: readonly WorkspaceCollectionObject[],
): string[] | null {
  const index = memberIds.indexOf(edit.id);
  if (edit.type === "add") {
    if (index !== -1 || !edit.id || objects.find(item => item.id === edit.id)?.kind === "collection" ||
        !objects.some(item => item.id === edit.id)) return null;
    return [...memberIds, edit.id];
  }
  if (index === -1) return null;
  if (edit.type === "remove") return memberIds.filter((_, position) => position !== index);
  if (edit.type !== "move" || (edit.by !== -1 && edit.by !== 1)) return null;
  const destination = index + edit.by;
  if (destination < 0 || destination >= memberIds.length) return null;
  const next = [...memberIds];
  [next[index], next[destination]] = [next[destination], next[index]];
  return next;
}
