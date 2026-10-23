'use client';

// Dock components for the modular layout (state and rules live in layoutState.ts).
//   useLayout   the saved layout + dispatch
//   DockFrame   one dock (aside): width, side, rail mode, the resize handle
//   DockCards   the panels inside a dock: drag to reorder or into the other dock, keyboard moves, collapse
// Accessibility: the drag grip is a real button; arrow keys move the panel (up/down inside the dock, left/right into the other dock) and every
// move is announced in a live region. Dragging is a convenience, never the only way.
import { Fragment, useCallback, useEffect, useRef, useState, type DragEvent, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { type Action, type CardId, type DockId, type Layout, LIMITS, RAIL_WIDTH, STORAGE_KEY, defaultLayout, dropIndex, reduce, sanitize } from './layoutState';

export function useLayout() {
  const [layout, setLayout] = useState<Layout>(defaultLayout);
  const [loaded, setLoaded] = useState(false);
  const dispatch = useCallback((a: Action) => setLayout((l) => reduce(l, a)), []);
  useEffect(() => { try { const raw = localStorage.getItem(STORAGE_KEY); if (raw) setLayout(sanitize(JSON.parse(raw))); } catch { /* private mode or bad JSON: defaults */ } setLoaded(true); }, []);
  useEffect(() => { if (!loaded) return; try { localStorage.setItem(STORAGE_KEY, JSON.stringify(layout)); } catch { /* storage full or blocked: the layout just is not remembered */ } }, [layout, loaded]);
  return { layout, dispatch, loaded };
}

const Ico = {
  grip: <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><circle cx="5.5" cy="3.5" r="1.2" /><circle cx="10.5" cy="3.5" r="1.2" /><circle cx="5.5" cy="8" r="1.2" /><circle cx="10.5" cy="8" r="1.2" /><circle cx="5.5" cy="12.5" r="1.2" /><circle cx="10.5" cy="12.5" r="1.2" /></svg>,
  chev: <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 6l4 4 4-4" /></svg>,
};

export type CardDef = { id: CardId; title: string; icon: ReactNode; body: ReactNode; meta?: ReactNode };
export type Drag = { id: CardId | null; set: (id: CardId | null) => void };

export function DockFrame({ dock, layout, dispatch, children, className = '', label }: { dock: DockId; layout: Layout; dispatch: (a: Action) => void; children: ReactNode; className?: string; label: string }) {
  const open = layout.open[dock]; const side = layout.side[dock]; const width = layout.width[dock];
  const order = side === 'left' ? (dock === 'sidebar' ? -2 : -1) : (dock === 'sidebar' ? 2 : 3);
  const start = useRef<{ x: number; w: number } | null>(null);
  const raf = useRef(0);
  const sign = side === 'left' ? 1 : -1;
  const onDown = (e: PointerEvent<HTMLDivElement>) => { start.current = { x: e.clientX, w: width }; e.currentTarget.setPointerCapture(e.pointerId); document.body.classList.add('dock-resizing'); };
  const onMove = (e: PointerEvent<HTMLDivElement>) => { if (!start.current) return; const px = start.current.w + sign * (e.clientX - start.current.x); cancelAnimationFrame(raf.current); raf.current = requestAnimationFrame(() => dispatch({ t: 'width', dock, px })); };
  const onUp = (e: PointerEvent<HTMLDivElement>) => { start.current = null; document.body.classList.remove('dock-resizing'); try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* already released */ } };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 48 : 16;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); const dx = e.key === 'ArrowRight' ? step : -step; dispatch({ t: 'width', dock, px: width + sign * dx }); }
    if (e.key === 'Home') { e.preventDefault(); dispatch({ t: 'width', dock, px: LIMITS[dock][0] }); }
    if (e.key === 'End') { e.preventDefault(); dispatch({ t: 'width', dock, px: LIMITS[dock][1] }); }
  };
  const w = open ? width : dock === 'sidebar' ? RAIL_WIDTH : 0;
  return (
    <aside className={`dock dock-${dock} side-${side}${open ? '' : ' is-rail'} ${className}`} style={{ width: w, minWidth: w, order }} aria-label={label} data-open={open}>
      {children}
      {open && (
        <div className={`dock-resizer r-${side}`} role="separator" aria-orientation="vertical" aria-label={`Resize the ${label}`} aria-valuemin={LIMITS[dock][0]} aria-valuemax={LIMITS[dock][1]} aria-valuenow={width} tabIndex={0}
          onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onKeyDown={onKey} onDoubleClick={() => dispatch({ t: 'width', dock, px: defaultLayout().width[dock] })} title="Drag to resize · double-click to reset" />
      )}
    </aside>
  );
}

export function DockCards({ dock, layout, dispatch, defs, drag, announce }: { dock: DockId; layout: Layout; dispatch: (a: Action) => void; defs: Partial<Record<CardId, CardDef>>; drag: Drag; announce: (m: string) => void }) {
  const ids = layout.cards[dock].filter((id) => defs[id]);
  const listRef = useRef<HTMLDivElement>(null);
  const [over, setOver] = useState<number | null>(null);
  const railed = dock === 'sidebar' && !layout.open.sidebar;

  const mids = () => Array.from(listRef.current?.querySelectorAll<HTMLElement>(':scope > .dcard:not(.is-dragging)') ?? []).map((el) => { const r = el.getBoundingClientRect(); return r.top + r.height / 2; });
  const onOver = (e: DragEvent) => { if (!drag.id) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setOver(dropIndex(mids(), e.clientY)); };
  const onDrop = (e: DragEvent) => { e.preventDefault(); if (drag.id && over !== null) { dispatch({ t: 'move', id: drag.id, to: dock, index: over }); announce(`${defs[drag.id]?.title ?? 'Panel'} moved`); } setOver(null); drag.set(null); };
  const onLeave = (e: DragEvent) => { if (!listRef.current?.contains(e.relatedTarget as Node)) setOver(null); };

  const gripKey = (id: CardId) => (e: KeyboardEvent<HTMLButtonElement>) => {
    const t = defs[id]?.title ?? 'Panel';
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); dispatch({ t: 'nudge', id, dir: e.key === 'ArrowUp' ? -1 : 1 }); announce(`${t} moved ${e.key === 'ArrowUp' ? 'up' : 'down'}`); requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-grip="${id}"]`)?.focus()); }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); dispatch({ t: 'cross', id }); announce(`${t} moved to the other side panel`); requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-grip="${id}"]`)?.focus()); }
  };

  const line = <div className="drop-line" aria-hidden="true" />;
  return (
    <div ref={listRef} className={`dock-cards${drag.id ? ' is-dragging-any' : ''}${ids.length === 0 ? ' is-empty' : ''}`} onDragOver={onOver} onDrop={onDrop} onDragLeave={onLeave}>
      {ids.map((id, i) => {
        const d = defs[id]!; const collapsed = !!layout.collapsed[id] && !railed;
        return (
          <Fragment key={id}>
            {over === i && drag.id && line}
            <section className={`dcard card-${id}${collapsed ? ' is-collapsed' : ''}${drag.id === id ? ' is-dragging' : ''}`} data-card={id}>
              <header className="dcard-h">
                {!railed && (
                  <button type="button" className="dcard-grip" data-grip={id} draggable aria-label={`Move the ${d.title} panel. Arrow keys move it; left and right switch side.`} title="Drag to move this panel"
                    onKeyDown={gripKey(id)}
                    onDragStart={(e) => { drag.set(id); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', id); const card = (e.currentTarget as HTMLElement).closest('.dcard'); if (card) e.dataTransfer.setDragImage(card, 20, 18); }}
                    onDragEnd={() => { drag.set(null); setOver(null); }}>{Ico.grip}</button>
                )}
                <span className="dcard-title">{d.icon}{!railed && <span>{d.title}</span>}</span>
                {!railed && d.meta}
                {!railed && <button type="button" className="dcard-toggle" aria-expanded={!collapsed} aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${d.title}`} onClick={() => dispatch({ t: 'collapse', id })}>{Ico.chev}</button>}
              </header>
              <div className="dcard-body" hidden={collapsed}>{d.body}</div>
            </section>
          </Fragment>
        );
      })}
      {over === ids.length && drag.id && line}
      {ids.length === 0 && <div className="dock-empty">{drag.id ? 'Drop a panel here' : 'No panels here. Drag one in, or use Reset layout.'}</div>}
    </div>
  );
}

/** A polite live region for panel moves (screen readers). */
export function useAnnouncer(): [string, (m: string) => void] {
  const [msg, setMsg] = useState('');
  const t = useRef<ReturnType<typeof setTimeout> | null>(null);
  const announce = useCallback((m: string) => { setMsg(m); if (t.current) clearTimeout(t.current); t.current = setTimeout(() => setMsg(''), 2500); }, []);
  useEffect(() => () => { if (t.current) clearTimeout(t.current); }, []);
  return [msg, announce];
}
