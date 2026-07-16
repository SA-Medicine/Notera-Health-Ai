import * as React from 'react'
import { Command } from 'cmdk'
import { NAV, type TabId } from '@/lib/nav'
import { Search } from 'lucide-react'

export function CommandPalette({ open, setOpen, setTab, onToggleNav, onLogout }:
  { open: boolean; setOpen: (v: boolean | ((o: boolean) => boolean)) => void; setTab: (t: TabId) => void; onToggleNav: () => void; onLogout: () => void }) {
  React.useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setOpen((o) => !o) }
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [setOpen])
  const run = (fn: () => void) => { setOpen(false); setTimeout(fn, 0) }
  if (!open) return null
  const item = 'flex items-center gap-3 px-4 py-2 text-sm text-muted-foreground rounded-md cursor-pointer data-[selected=true]:bg-raised data-[selected=true]:text-foreground'
  return (
    <div className="fixed inset-0 z-[90] flex items-start justify-center pt-[14vh] px-4">
      <div className="absolute inset-0 bg-black/55 backdrop-blur-sm" onClick={() => setOpen(false)} />
      <Command loop className="relative w-full max-w-xl rounded-xl border border-border bg-popover text-popover-foreground shadow-pop overflow-hidden">
        <div className="flex items-center gap-2.5 px-4 border-b border-border">
          <Search className="w-4 h-4 text-muted-foreground" />
          <Command.Input autoFocus placeholder="Type a command or search…" className="flex-1 bg-transparent py-3.5 text-sm outline-none text-foreground placeholder:text-muted-foreground/60" />
          <kbd className="text-[10px] text-muted-foreground border border-border rounded px-1.5 py-0.5">ESC</kbd>
        </div>
        <Command.List className="max-h-[22rem] overflow-auto p-2">
          <Command.Empty className="px-4 py-10 text-center text-muted-foreground text-sm">No results.</Command.Empty>
          <Command.Group heading="Navigate" className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-muted-foreground">
            {NAV.map(({ id, label, icon: Icon }) => (
              <Command.Item key={id} value={'go ' + label} onSelect={() => run(() => setTab(id))} className={item}><Icon className="w-4 h-4" />{'Go to ' + label}</Command.Item>
            ))}
          </Command.Group>
          <Command.Group heading="Actions" className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-muted-foreground">
            <Command.Item value="run tester" onSelect={() => run(() => setTab('run'))} className={item}>▶ Run the tester</Command.Item>
            <Command.Item value="toggle sidebar" onSelect={() => run(onToggleNav)} className={item}>☰ Toggle sidebar</Command.Item>
            <Command.Item value="sign out logout" onSelect={() => run(onLogout)} className={item}>⎋ Sign out</Command.Item>
          </Command.Group>
        </Command.List>
      </Command>
    </div>
  )
}
