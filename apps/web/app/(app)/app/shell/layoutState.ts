// The modular layout of the app screen, as plain data + a reducer (no React), so it can be tested and saved.
//   two docks: "sidebar" (aubergine) and "details"; each can sit on the left or the right of the workspace
//   panels (cards) live in a dock, in an order the clinician sets; any panel can be dragged into the other dock
//   a dock can be opened/closed (the sidebar then shows as a slim icon rail), resized, and every panel collapsed
// The layout is saved in the browser (localStorage) and repaired on load: unknown panels are dropped, missing ones come back.

export type DockId = 'sidebar' | 'details';
export type Side = 'left' | 'right';
export type CardId = 'modules' | 'sessions' | 'session' | 'note' | 'checks' | 'tools';
export const ALL_CARDS: CardId[] = ['modules', 'sessions', 'session', 'note', 'checks', 'tools'];
export const DOCKS: DockId[] = ['sidebar', 'details'];
export const LIMITS: Record<DockId, [number, number]> = { sidebar: [208, 340], details: [260, 460] };
export const RAIL_WIDTH = 68;

export type Layout = {
  v: 1;
  side: Record<DockId, Side>;
  open: Record<DockId, boolean>;
  width: Record<DockId, number>;
  cards: Record<DockId, CardId[]>;
  collapsed: Partial<Record<CardId, boolean>>;
};

export type Action =
  | { t: 'move'; id: CardId; to: DockId; index: number }   // index = position among the destination's panels (the dragged panel excluded)
  | { t: 'nudge'; id: CardId; dir: -1 | 1 }                // one step up or down inside its dock
  | { t: 'cross'; id: CardId }                             // to the end of the other dock
  | { t: 'collapse'; id: CardId }
  | { t: 'width'; dock: DockId; px: number }
  | { t: 'toggleDock'; dock: DockId }
  | { t: 'swapSide'; dock: DockId }
  | { t: 'reset' };

export const defaultLayout = (): Layout => ({
  v: 1,
  side: { sidebar: 'left', details: 'right' },
  open: { sidebar: true, details: true },
  width: { sidebar: 252, details: 316 },
  cards: { sidebar: ['modules', 'sessions', 'tools'], details: ['session', 'note', 'checks'] },
  collapsed: {},
});

const clamp = (n: number, [lo, hi]: [number, number]) => Math.min(hi, Math.max(lo, Math.round(n)));
const otherDock = (d: DockId): DockId => (d === 'sidebar' ? 'details' : 'sidebar');
export const dockOf = (l: Layout, id: CardId): DockId => (l.cards.sidebar.includes(id) ? 'sidebar' : 'details');

export function reduce(l: Layout, a: Action): Layout {
  switch (a.t) {
    case 'move': {
      const from = dockOf(l, a.id);
      const cards = { sidebar: l.cards.sidebar.filter((c) => c !== a.id), details: l.cards.details.filter((c) => c !== a.id) };
      const dest = [...cards[a.to]]; dest.splice(Math.min(Math.max(a.index, 0), dest.length), 0, a.id); cards[a.to] = dest;
      const same = from === a.to && cards[a.to].join() === l.cards[a.to].join();
      return same ? l : { ...l, cards };
    }
    case 'nudge': {
      const d = dockOf(l, a.id); const list = [...l.cards[d]]; const i = list.indexOf(a.id); const j = i + a.dir;
      if (j < 0 || j >= list.length) return l;
      [list[i], list[j]] = [list[j], list[i]]; return { ...l, cards: { ...l.cards, [d]: list } };
    }
    case 'cross': { const d = dockOf(l, a.id); return reduce(l, { t: 'move', id: a.id, to: otherDock(d), index: l.cards[otherDock(d)].length }); }
    case 'collapse': return { ...l, collapsed: { ...l.collapsed, [a.id]: !l.collapsed[a.id] } };
    case 'width': return { ...l, width: { ...l.width, [a.dock]: clamp(a.px, LIMITS[a.dock]) } };
    case 'toggleDock': return { ...l, open: { ...l.open, [a.dock]: !l.open[a.dock] } };
    case 'swapSide': return { ...l, side: { ...l.side, [a.dock]: l.side[a.dock] === 'left' ? 'right' : 'left' } };
    case 'reset': return defaultLayout();
  }
}

/** Anything read from storage is untrusted: rebuild a valid layout from whatever is usable. */
export function sanitize(raw: unknown): Layout {
  const d = defaultLayout();
  if (!raw || typeof raw !== 'object') return d;
  const r = raw as Partial<Layout>;
  const side = (v: unknown, dflt: Side): Side => (v === 'left' || v === 'right' ? v : dflt);
  const num = (v: unknown, dock: DockId) => (typeof v === 'number' && Number.isFinite(v) ? clamp(v, LIMITS[dock]) : d.width[dock]);
  const seen = new Set<CardId>(); const take = (list: unknown): CardId[] => (Array.isArray(list) ? list : []).filter((c): c is CardId => ALL_CARDS.includes(c as CardId) && !seen.has(c as CardId) && (seen.add(c as CardId), true));
  const cards = { sidebar: take(r.cards?.sidebar), details: take(r.cards?.details) };
  for (const c of ALL_CARDS) if (!seen.has(c)) cards[dockOf(d, c)].push(c);   // a panel added in a later version goes to its default dock
  const collapsed: Layout['collapsed'] = {}; for (const c of ALL_CARDS) if (r.collapsed?.[c] === true) collapsed[c] = true;
  return {
    v: 1,
    side: { sidebar: side(r.side?.sidebar, d.side.sidebar), details: side(r.side?.details, d.side.details) },
    open: { sidebar: r.open?.sidebar !== false, details: r.open?.details !== false },
    width: { sidebar: num(r.width?.sidebar, 'sidebar'), details: num(r.width?.details, 'details') },
    cards, collapsed,
  };
}

/** Where a dragged panel lands: the index among the panels (the dragged one excluded) whose middle is below the pointer. */
export function dropIndex(mids: number[], pointerY: number): number {
  const i = mids.findIndex((m) => pointerY < m);
  return i === -1 ? mids.length : i;
}

export const STORAGE_KEY = 'notera.layout.v1';
