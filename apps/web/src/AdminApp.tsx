'use client'
import * as React from 'react'
import { api } from '@/lib/api'
import { type TabId } from '@/lib/nav'
import { Sidebar } from '@/components/blocks/sidebar'
import { TopBar } from '@/components/blocks/topbar'
import { CommandPalette } from '@/components/blocks/command-palette'
import { Login } from '@notera/ui/components/blocks/login'
import { Overview } from '@/screens/overview'
import { Run } from '@/screens/run'
import { Patients } from '@/screens/patients'
import { Results } from '@/screens/results'
import { Metrics } from '@/screens/metrics'
import { Prompts } from '@/screens/prompts'
import { Judge } from '@/screens/judge'

function Shell() {
  const [authed, setAuthed] = React.useState<boolean | null>(null)
  const [tab, setTab] = React.useState<TabId>(() => localStorage.getItem('notera_tab') || 'overview')
  const [status, setStatus] = React.useState('idle')
  const [navOpen, setNavOpen] = React.useState(true)
  const [paletteOpen, setPaletteOpen] = React.useState(false)
  const [resultsTarget, setResultsTarget] = React.useState<{ dir: string; file: string } | null>(null)
  React.useEffect(() => { api.session().then((d) => setAuthed(d.authed)).catch(() => setAuthed(false)) }, [])
  React.useEffect(() => { localStorage.setItem('notera_tab', tab) }, [tab])
  const openInResults = (dir: string, file?: string) => { setResultsTarget({ dir, file: file || '' }); setTab('results') }
  if (authed === null) return <div className="h-screen flex items-center justify-center bg-background"><div className="w-6 h-6 rounded-full border-2 border-border border-t-primary animate-spin" /></div>
  if (!authed) return <Login title="Notera" subtitle="Testing lab" footer="Internal regression harness · authorized access only" onSubmit={async (pw) => { const r = await api.login(pw); if (r.ok) { setAuthed(true); return true } return false }} />
  const logout = async () => { await api.logout(); setAuthed(false) }
  return (
    <div className="flex h-screen bg-background">
      <Sidebar tab={tab} setTab={setTab} onLogout={logout} collapsed={!navOpen} />
      <div className="flex-1 flex flex-col min-w-0">
        <TopBar tab={tab} status={status} onToggleNav={() => setNavOpen((o) => !o)} onOpenPalette={() => setPaletteOpen(true)} />
        <main className="flex-1 overflow-auto">
          {tab === 'overview' && <Overview setTab={setTab} />}
          {tab === 'run' && <Run onStatus={setStatus} />}
          {tab === 'patients' && <Patients />}
          {tab === 'results' && <Results setTab={setTab} target={resultsTarget} clearTarget={() => setResultsTarget(null)} />}
          {tab === 'metrics' && <Metrics openInResults={openInResults} />}
          {tab === 'prompts' && <Prompts setTab={setTab} />}
          {tab === 'judge' && <Judge />}
        </main>
      </div>
      <CommandPalette open={paletteOpen} setOpen={setPaletteOpen} setTab={setTab} onToggleNav={() => setNavOpen((o) => !o)} onLogout={logout} />
    </div>
  )
}
// Providers (Theme, Tooltip, Toaster) live in the Next root layout — the shell is bare.
export default function AdminApp() { return <Shell /> }
