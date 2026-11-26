export function availableCollectionMembers(objects: readonly { id: string; kind?: string }[]) {
  return new Set(objects.filter(item => item.kind !== "collection").map(item => item.id));
}

export function selectedCollectionMembers(ids: readonly string[], available: ReadonlySet<string>) {
  return [...new Set(ids)].filter(id => available.has(id));
}

export function canUpdateCollectionMembers(current: readonly string[], next: readonly string[], previous: readonly string[],
  available: ReadonlySet<string>) {
  if (current.length !== previous.length || !current.every((id, index) => id === previous[index])) return false;
  const retained = new Set(current);
  return next.length === new Set(next).size && next.every(id => available.has(id) || retained.has(id));
}

export function collectionIncludesClipboard(itemIds: readonly string[], clipboardIds: ReadonlySet<string>) {
  return itemIds.some(id => clipboardIds.has(id));
}
