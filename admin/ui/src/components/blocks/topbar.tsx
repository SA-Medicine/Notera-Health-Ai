import { NAV, type TabId } from '@/lib/nav'
import { StatusPill } from '@/components/ui/badge'
import { useTheme } from './theme-provider'
import { Menu, Search, Sun, Moon } from 'lucide-react'
export function TopBar({ tab, status, onToggleNav, onOpenPalette }: { tab: TabId; status: string; onToggleNav: () => void; onOpenPalette: () => void }) {
  const { theme, toggle } = useTheme()
  const label = NAV.find((n) => n.id === tab)?.label
  return (
    <header className="h-14 shrink-0 border-b border-border bg-surface/80 backdrop-blur flex items-center gap-3 px-4">
      <button onClick={onToggleNav} title="Toggle sidebar" aria-label="Toggle sidebar" className="text-muted-foreground hover:text-foreground w-8 h-8 rounded-lg hover:bg-accent flex items-center justify-center transition"><Menu className="w-4 h-4" /></button>
      <div className="flex items-center gap-2 min-w-0 text-sm">
        <span className="text-muted-foreground">Auto-Tester</span><span className="text-border">/</span><span className="text-foreground font-semibold">{label}</span>
      </div>
      <StatusPill status={status} /><div className="flex-1" />
      <button onClick={onOpenPalette} title="Command palette" className="hidden sm:inline-flex items-center gap-2 text-xs text-muted-foreground bg-accent border border-border rounded-lg pl-2.5 pr-1.5 py-1.5 hover:text-foreground hover:border-muted-foreground/40 transition">
        <Search className="w-3.5 h-3.5" /><span>Search</span><kbd className="text-[10px] text-muted-foreground bg-background border border-border rounded px-1 py-0.5 font-mono">⌘K</kbd>
      </button>
      <button onClick={toggle} title="Toggle theme" aria-label="Toggle theme" className="w-8 h-8 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent flex items-center justify-center transition">{theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}</button>
    </header>
  )
}
