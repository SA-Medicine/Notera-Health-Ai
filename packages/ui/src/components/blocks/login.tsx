import * as React from 'react'
import { Button } from '../ui/button'
import { Input } from '../ui/input'

// Presentational sign-in card. The consuming app supplies onSubmit(password) and the
// branding, so the same component serves the clinician product and the admin lab.
export function Login({
  onSubmit,
  title = 'Notera',
  subtitle = 'Sign in to continue',
  footer = 'Authorized access only',
  logo = 'N',
}: {
  onSubmit: (password: string) => Promise<boolean | void> | boolean | void
  title?: string
  subtitle?: string
  footer?: string
  logo?: React.ReactNode
}) {
  const [pw, setPw] = React.useState(''); const [err, setErr] = React.useState(''); const [busy, setBusy] = React.useState(false)
  const go = async () => {
    if (!pw || busy) return; setBusy(true); setErr('')
    try { const ok = await onSubmit(pw); if (ok === false) setErr('Incorrect password') }
    catch { setErr('Could not reach the server') }
    setBusy(false)
  }
  return (
    <div className="h-screen flex items-center justify-center bg-background relative overflow-hidden">
      <div className="absolute -top-1/3 left-1/2 -translate-x-1/2 w-[560px] h-[560px] rounded-full blur-3xl pointer-events-none" style={{ background: 'radial-gradient(circle, hsl(var(--primary) / .10), transparent 60%)' }} />
      <div className="w-[360px] rounded-xl border border-border bg-card p-8 relative shadow-card">
        <div className="flex items-center gap-2.5 mb-6">
          <div className="w-9 h-9 rounded-xl bg-primary/15 border border-primary/25 flex items-center justify-center text-primary font-bold text-lg">{logo}</div>
          <div><div className="text-foreground font-semibold leading-tight">{title}</div><div className="text-muted-foreground text-xs">{subtitle}</div></div>
        </div>
        <label className="block text-xs font-medium text-muted-foreground mb-1.5">Password</label>
        <Input type="password" value={pw} autoFocus onChange={(e) => setPw(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && go()} placeholder="Enter password" />
        {err && <div className="text-destructive text-xs mt-2">✕ {err}</div>}
        <Button className="w-full mt-4" onClick={go} disabled={!pw || busy}>{busy ? 'Signing in…' : 'Sign in'}</Button>
        <p className="text-muted-foreground text-[11px] text-center mt-5">{footer}</p>
      </div>
    </div>
  )
}
