// Run: node apps/web/tests/layout.test.mts   (Node 22+ strips the types; no test runner is needed)
import assert from 'node:assert/strict';
import { defaultLayout, reduce, sanitize, dropIndex, dockOf, LIMITS } from '../app/(app)/app/shell/layoutState.ts';
import { groupSessions } from '../app/(app)/app/shell/sessions.ts';

const L = defaultLayout();
assert.deepEqual(L.cards.sidebar, ['modules', 'sessions', 'tools']); assert.deepEqual(L.cards.details, ['session', 'note', 'checks']);
let l = reduce(L, { t: 'move', id: 'checks', to: 'details', index: 0 }); assert.deepEqual(l.cards.details, ['checks', 'session', 'note']);
l = reduce(l, { t: 'nudge', id: 'checks', dir: 1 }); assert.deepEqual(l.cards.details, ['session', 'checks', 'note']);
assert.equal(reduce(l, { t: 'nudge', id: 'session', dir: -1 }), l, 'nudging past the top changes nothing');
l = reduce(L, { t: 'move', id: 'note', to: 'sidebar', index: 1 }); assert.deepEqual(l.cards.sidebar, ['modules', 'note', 'sessions', 'tools']); assert.equal(dockOf(l, 'note'), 'sidebar');
l = reduce(l, { t: 'cross', id: 'note' }); assert.equal(l.cards.details.at(-1), 'note');
const all = (x: typeof L) => [...x.cards.sidebar, ...x.cards.details].sort().join(); assert.equal(all(reduce(L, { t: 'move', id: 'checks', to: 'sidebar', index: 0 })), all(L), 'every panel stays in exactly one dock');
assert.equal(reduce(L, { t: 'swapSide', dock: 'details' }).side.details, 'left'); assert.equal(reduce(L, { t: 'toggleDock', dock: 'sidebar' }).open.sidebar, false);
assert.equal(reduce(reduce(L, { t: 'collapse', id: 'tools' }), { t: 'collapse', id: 'tools' }).collapsed.tools, false);
assert.equal(reduce(L, { t: 'width', dock: 'details', px: 9999 }).width.details, LIMITS.details[1]); assert.equal(reduce(L, { t: 'width', dock: 'details', px: 10 }).width.details, LIMITS.details[0]);
assert.deepEqual(reduce(reduce(L, { t: 'swapSide', dock: 'details' }), { t: 'reset' }), L);
assert.deepEqual(sanitize(null), L); assert.deepEqual(sanitize('junk'), L); assert.deepEqual(sanitize({}), L);
const bad = sanitize({ v: 1, side: { sidebar: 'up', details: 'left' }, open: { sidebar: false }, width: { sidebar: 'wide', details: 100000 }, cards: { sidebar: ['tools', 'tools', 'ghost'], details: ['note'] }, collapsed: { note: true, ghost: true } });
assert.equal(bad.side.sidebar, 'left'); assert.equal(bad.side.details, 'left'); assert.equal(bad.open.sidebar, false); assert.equal(bad.width.sidebar, 252); assert.equal(bad.width.details, LIMITS.details[1]);
assert.equal(all(bad), all(L), 'a repaired layout still holds every panel once'); assert.deepEqual(bad.collapsed, { note: true });
assert.equal(dropIndex([100, 220, 340], 50), 0); assert.equal(dropIndex([100, 220, 340], 230), 2); assert.equal(dropIndex([100, 220, 340], 999), 3); assert.equal(dropIndex([], 10), 0);

const now = new Date(2026, 9, 23, 15, 0); const d = (days: number, h = 10) => new Date(2026, 9, 23 - days, h).toISOString();
const g = groupSessions([{ consult_id: 'a', title: null, specialty: null, created_at: d(0, 9) }, { consult_id: 'b', title: null, specialty: null, created_at: d(0, 13) }, { consult_id: 'c', title: null, specialty: null, created_at: d(1) }, { consult_id: 'd', title: null, specialty: null, created_at: d(4) }, { consult_id: 'e', title: null, specialty: null, created_at: d(30) }], now);
assert.deepEqual(g.map((x) => x.label), ['Today', 'Yesterday', 'Previous 7 days', 'Earlier']); assert.deepEqual(g[0].items.map((x) => x.consult_id), ['b', 'a'], 'newest first');
assert.deepEqual(groupSessions([], now), []);
console.log('layout + sessions ok');
