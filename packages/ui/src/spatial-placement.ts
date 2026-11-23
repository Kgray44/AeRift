export function reconcilePeerSlots(current: ReadonlyMap<string, number>, ids: readonly string[]) {
  const present = new Set(ids);
  if (current.size === present.size && ids.every(id => current.has(id))) return current;

  const next = new Map([...current].filter(([id]) => present.has(id)));
  const occupied = new Set(next.values());
  let slot = 0;
  for (const id of ids) {
    if (next.has(id)) continue;
    while (occupied.has(slot)) slot++;
    next.set(id, slot);
    occupied.add(slot);
  }
  return next;
}
