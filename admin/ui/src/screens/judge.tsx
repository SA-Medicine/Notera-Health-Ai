import * as React from 'react'
import { Card } from '@/components/ui/card'
import { cn } from '@/lib/utils'
const DEF_TH: Record<string, [number, number]> = { section_coverage: [0.8, 0.6], similarity_to_gold: [0.4, 0.28], story_flow: [0.85, 0.65], omission_rate: [0.45, 0.6] }
const GATES: [string, string, string][] = [
  ['schema_valid', 'Schema validity', 'note validates against Heidi schema v2'],
  ['section_coverage', 'Section coverage', 'how many core SOAP sections are populated'],
  ['similarity_to_gold', 'Similarity to gold', 'token overlap with the reference note'],
  ['story_flow', 'Story / Flow', 'prose reads as connected clinical narrative'],
  ['omission_rate', 'Omission', 'share of gold key-terms missing (lower is better)'],
  ['meds_unsupported', 'Fabrication scan', 'medications not grounded by NER — highest severity'],
]
export function Judge() {
  const [th, setTh] = React.useState<Record<string, [number, number]>>(() => { try { return { ...DEF_TH, ...JSON.parse(localStorage.getItem('notera_th') || '{}') } } catch { return DEF_TH } })
  const save = (k: string, i: number, v: string) => { const n = { ...th, [k]: th[k].map((x, j) => (j === i ? Number(v) : x)) as [number, number] }; setTh(n); localStorage.setItem('notera_th', JSON.stringify(n)) }
  return (
    <div className="p-6 max-w-3xl space-y-5">
      <Card className="p-5">
        <div className="text-foreground font-semibold mb-1">Grading gates</div>
        <p className="text-muted-foreground text-sm mb-4">This harness scores deterministically (metrics in <code className="text-primary font-mono">eval/metrics.mjs</code>). Fabrication scan is the highest-severity class.</p>
        <div className="space-y-2">{GATES.map(([k, t, d]) => <div key={k} className="flex items-center gap-3 bg-surface border border-border rounded-lg px-3 py-2">
          <span className={cn('w-2 h-2 rounded-full', k === 'meds_unsupported' ? 'bg-destructive' : 'bg-primary')} />
          <div className="flex-1"><div className="text-sm text-foreground">{t}</div><div className="text-xs text-muted-foreground">{d}</div></div>
          {k === 'meds_unsupported' && <span className="text-[11px] bg-destructive/15 text-destructive px-2 py-0.5 rounded font-bold">SEV-1</span>}</div>)}</div>
      </Card>
      <Card className="p-5">
        <div className="text-foreground font-semibold mb-3">Colour thresholds (green ≥ / amber ≥)</div>
        <div className="grid grid-cols-2 gap-3">{Object.entries(th).map(([k, v]) => <div key={k} className="bg-surface border border-border rounded-lg p-3">
          <div className="text-xs text-muted-foreground mb-2">{k}{k === 'omission_rate' && ' (lower better)'}</div>
          <div className="flex gap-2"><input type="number" step="0.01" value={v[0]} onChange={(e) => save(k, 0, e.target.value)} className="w-20 bg-background border border-border rounded px-2 py-1 text-sm" /><input type="number" step="0.01" value={v[1]} onChange={(e) => save(k, 1, e.target.value)} className="w-20 bg-background border border-border rounded px-2 py-1 text-sm" /></div></div>)}</div>
      </Card>
    </div>
  )
}
