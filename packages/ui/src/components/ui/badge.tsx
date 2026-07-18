import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../../lib/utils'
const badgeVariants = cva('inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-semibold tracking-wide ring-1', {
  variants: { variant: {
    neutral: 'bg-muted text-muted-foreground ring-border',
    success: 'bg-success/10 text-success ring-success/20',
    danger: 'bg-destructive/10 text-destructive ring-destructive/20',
    warning: 'bg-warning/10 text-warning ring-warning/20',
    info: 'bg-info/10 text-info ring-info/20',
  } }, defaultVariants: { variant: 'neutral' } })
export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}
export const Badge = ({ className, variant, ...p }: BadgeProps) => <span className={cn(badgeVariants({ variant }), className)} {...p} />
export function StatusPill({ status }: { status: string }) {
  const map: Record<string, [string, string, string]> = {
    idle: ['Idle', 'bg-muted text-muted-foreground', 'bg-muted-foreground'],
    running: ['Running', 'bg-info/15 text-info', 'bg-info animate-pulse'],
    passed: ['Passed', 'bg-success/15 text-success', 'bg-success'],
    failed: ['Failed', 'bg-destructive/15 text-destructive', 'bg-destructive'],
    killed: ['Killed', 'bg-warning/15 text-warning', 'bg-warning'],
    error: ['Error', 'bg-destructive/15 text-destructive', 'bg-destructive'],
    interrupted: ['Interrupted', 'bg-warning/15 text-warning', 'bg-warning'],
  }
  const [t, c, dot] = map[status] || map.idle
  return <span className={cn('inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium', c)}><span className={cn('w-1.5 h-1.5 rounded-full', dot)} />{t}</span>
}
export function PassBadge({ passed }: { passed: boolean | null }) {
  if (passed === null) return <span className="text-muted-foreground text-xs">—</span>
  return <Badge variant={passed ? 'success' : 'danger'}>{passed ? 'PASS' : 'FAIL'}</Badge>
}
