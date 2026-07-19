import * as React from 'react'
import { api, type Patient, type ImportResult } from '@/lib/api'
import { Card } from '@notera/ui/components/ui/card'
import { Button } from '@notera/ui/components/ui/button'
import { EmptyState, Skeleton } from '@notera/ui/components/ui/skeleton'
import { toast } from 'sonner'
import { Upload, FileJson, CheckCircle2, AlertTriangle, Users, Trash2 } from 'lucide-react'

export function Patients() {
  const [patients, setPatients] = React.useState<Patient[] | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [result, setResult] = React.useState<ImportResult | null>(null)
  const [dbErr, setDbErr] = React.useState<string | null>(null)
  const [busyId, setBusyId] = React.useState<number | null>(null)
  const inputRef = React.useRef<HTMLInputElement>(null)

  const load = React.useCallback(() => {
    api.patients().then((d) => { setPatients(d.patients || []); setDbErr(d.error ? (d.hint || d.error) : null) }).catch(() => setPatients([]))
  }, [])
  React.useEffect(() => { load() }, [load])

  const doImport = async (text: string) => {
    let parsed: any
    try { parsed = JSON.parse(text) } catch { toast.error('That file is not valid JSON'); return }
    setBusy(true); setResult(null)
    try {
      const r = await api.importPatients(parsed)
      setResult(r)
      if (r.ok) { toast.success(`Imported: ${r.counts?.added || 0} new, ${r.counts?.updated || 0} updated`); load() }
      else toast.error(r.error || 'Import failed')
    } catch { toast.error('Import request failed') }
    setBusy(false)
  }

  const del = async (p: Patient) => {
    if (!confirm(`Delete "${p.name}"?\n\nThis permanently removes the patient, its transcript + gold note, and every run record, agent output and metric for it. This cannot be undone.`)) return
    setBusyId(p.id)
    try {
      const r = await api.deletePatient(p.id)
      if (r.ok) { setPatients((list) => (list || []).filter((x) => x.id !== p.id)); toast.success(`Deleted ${p.name}`) }
      else toast.error(r.error || 'Delete failed')
    } catch { toast.error('Delete request failed') }
    setBusyId(null)
  }

  const onFile = (f?: File) => { if (!f) return; const rd = new FileReader(); rd.onload = () => doImport(String(rd.result || '')); rd.readAsText(f) }
  const onDrop = (e: React.DragEvent) => { e.preventDefault(); onFile(e.dataTransfer.files?.[0]) }

  return (
    <div className="p-4 sm:p-6 space-y-6 max-w-5xl">
      <div>
        <h1 className="text-lg font-semibold text-foreground flex items-center gap-2"><Users className="w-5 h-5 text-primary" /> Reference patients</h1>
        <p className="text-sm text-muted-foreground mt-1">Each patient is a reference transcript + its gold SOAP note. Imported patients become runnable fixtures alongside Patient 1/2/3 and appear in run ranges.</p>
      </div>

      {/* import drop-zone */}
      <Card
        className="p-6 border-dashed border-2 flex flex-col items-center justify-center text-center gap-3 cursor-pointer hover:border-primary/50 transition"
        onClick={() => inputRef.current?.click()}
        onDrop={onDrop} onDragOver={(e) => e.preventDefault()}
      >
        <div className="w-11 h-11 rounded-full bg-accent flex items-center justify-center"><Upload className="w-5 h-5 text-primary" /></div>
        <div className="text-sm font-medium text-foreground">Drop a sessions JSON here, or click to choose</div>
        <div className="text-xs text-muted-foreground">A JSON array of sessions (each with <code>transcript</code> + <code>soap_note</code>). Re-importing updates in place.</div>
        <input ref={inputRef} type="file" accept="application/json,.json" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
        {busy && <div className="text-xs text-primary">Importing…</div>}
      </Card>

      {dbErr && <div className="text-sm text-warning flex items-center gap-2"><AlertTriangle className="w-4 h-4" /> {dbErr}</div>}

      {/* import result */}
      {result?.ok && (
        <Card className="p-4 space-y-2">
          <div className="text-sm font-semibold text-foreground flex items-center gap-2"><CheckCircle2 className="w-4 h-4 text-success" /> Import summary</div>
          <div className="flex flex-wrap gap-4 text-sm">
            <span className="text-success">{result.counts?.added || 0} added</span>
            <span className="text-info">{result.counts?.updated || 0} updated</span>
            <span className="text-muted-foreground">{result.counts?.skipped || 0} skipped</span>
          </div>
          {!!result.skipped?.length && <div className="text-xs text-muted-foreground">Skipped: {result.skipped.map((s) => `${s.name} (${s.reason})`).join(', ')}</div>}
          {result.note && <div className="text-xs text-warning">{result.note}</div>}
        </Card>
      )}

      {/* patient list */}
      {patients === null ? <Skeleton className="h-48" />
        : !patients.length ? <EmptyState icon="🧑" title="No patients yet" hint="Import a sessions JSON above to add reference cases." />
        : (
          <Card className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead className="bg-muted text-muted-foreground text-xs uppercase">
                <tr><th className="text-left px-4 py-2.5 font-medium">Patient</th><th className="text-left px-3 font-medium">Fixture (slug)</th><th className="px-3 font-medium">Transcript</th><th className="px-3 font-medium">Gold note</th><th className="px-3 font-medium w-10" /></tr>
              </thead>
              <tbody>
                {patients.map((p) => (
                  <tr key={p.id} className="border-t border-border hover:bg-accent/50">
                    <td className="px-4 py-2.5 text-foreground/90 flex items-center gap-2"><FileJson className="w-3.5 h-3.5 text-muted-foreground" />{p.name}</td>
                    <td className="px-3 font-mono text-xs text-muted-foreground">{p.slug}</td>
                    <td className="px-3 text-center tabular-nums text-foreground/70">{p.transcript_len ? `${p.transcript_len} ch` : '—'}</td>
                    <td className="px-3 text-center tabular-nums text-foreground/70">{p.gold_len ? `${p.gold_len} ch` : '—'}</td>
                    <td className="px-3 text-right">
                      <button onClick={() => del(p)} disabled={busyId === p.id}
                        title={`Delete ${p.name} and all of its run data`}
                        className="text-muted-foreground hover:text-destructive disabled:opacity-40 p-1 transition">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
    </div>
  )
}
