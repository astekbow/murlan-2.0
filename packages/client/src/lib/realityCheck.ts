// Responsible-gaming reality-check helpers. The modal owns the timing/state. A
// "reality check" periodically reminds the player how long they've played and
// their net session result — a standard responsible-gaming tool.
import { translate, useLangStore } from './i18n.ts';

/** Localized human session duration, e.g. "30 min" / "1 orë 5 min" (sq) | "1h 5m" (en). */
export function formatDuration(ms: number): string {
  const totalMin = Math.max(0, Math.floor(ms / 60_000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  const lang = useLangStore.getState().lang;
  if (h > 0) return m > 0 ? translate('rc.hoursMins', lang, { h, m }) : translate('rc.hours', lang, { h });
  return translate('rc.mins', lang, { m });
}
