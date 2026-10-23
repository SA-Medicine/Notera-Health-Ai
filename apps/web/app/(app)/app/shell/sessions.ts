// Recent sessions grouped by day for the Sessions panel (pure, so it can be tested without React).
export type SessionItem = { consult_id: string; title: string | null; specialty: string | null; created_at: string; checks?: number };
export type Group = { label: string; items: SessionItem[] };

/** Today / Yesterday / Previous 7 days / Earlier, newest first; empty groups are left out. */
export function groupSessions(list: SessionItem[], now = new Date()): Group[] {
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const t0 = startOf(now); const DAY = 86_400_000;
  const buckets: Group[] = [{ label: 'Today', items: [] }, { label: 'Yesterday', items: [] }, { label: 'Previous 7 days', items: [] }, { label: 'Earlier', items: [] }];
  for (const s of [...list].sort((a, b) => +new Date(b.created_at) - +new Date(a.created_at))) {
    const t = startOf(new Date(s.created_at));
    (t >= t0 ? buckets[0] : t >= t0 - DAY ? buckets[1] : t >= t0 - 7 * DAY ? buckets[2] : buckets[3]).items.push(s);
  }
  return buckets.filter((b) => b.items.length);
}
