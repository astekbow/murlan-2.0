// Responsible-gaming reality-check helpers. Pure (testable); the modal owns the
// timing/state. A "reality check" periodically reminds the player how long they've
// played and their net session result — a standard responsible-gaming tool.

/** Human session duration in Albanian, e.g. "30 min" / "1 orë 5 min". */
export function formatDuration(ms: number): string {
  const totalMin = Math.max(0, Math.floor(ms / 60_000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0) return m > 0 ? `${h} orë ${m} min` : `${h} orë`;
  return `${m} min`;
}
