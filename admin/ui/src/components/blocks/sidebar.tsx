import { NAV, type TabId } from '@/lib/nav'
import { cn } from '@/lib/utils'
import { LogOut } from 'lucide-react'
export function Sidebar({ tab, setTab, onLogout, collapsed }: { tab: TabId; setTab: (t: TabId) => void; onLogout: () => void; collapsed: boolean }) {
  return (
    <aside className={cn('shrink-0 bg-surface border-r border-border flex flex-col transition-all duration-200', collapsed ? 'w-16' : 'w-56')}>
      <div className="h-14 flex items-center gap-2.5 px-4 border-b border-border overflow-hidden whitespace-nowrap">
        <div className="w-8 h-8 rounded-lg bg-primary/15 border border-primary/25 flex items-center justify-center text-primary font-bold shrink-0">N</div>
        {!collapsed && <div className="leading-tight"><div className="text-foreground font-semibold text-sm">Notera</div><div className="text-muted-foreground text-[11px]">Auto-Tester</div></div>}
      </div>
      <nav className="flex-1 p-2.5 space-y-0.5" aria-label="Primary">
        {NAV.map(({ id, label, icon: Icon }) => {
          const active = tab === id
          return (
            <button key={id} onClick={() => setTab(id)} title={label} aria-current={active ? 'page' : undefined}
              className={cn('group relative w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition',
                active ? 'bg-raised text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground')}>
              {active && <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-full bg-primary" />}
              <Icon className={cn('w-4 h-4 shrink-0', active ? 'opacity-100' : 'opacity-70 group-hover:opacity-100')} />
              {!collapsed && label}
            </button>
          )
        })}
      </nav>
      <button onClick={onLogout} className="m-2.5 px-3 py-2 rounded-lg text-xs text-muted-foreground hover:text-foreground hover:bg-accent text-left flex items-center gap-2 transition">
        <LogOut className="w-4 h-4" />{!collapsed && <span>Sign out</span>}
      </button>
    </aside>
  )
}
