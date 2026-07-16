import { cn } from '@/lib/utils'
export function Skeleton({ className }: { className?: string }) { return <div className={cn('skeleton', className)} /> }
export function EmptyState({ icon, title, hint, action }: { icon?: React.ReactNode; title: string; hint?: string; action?: React.ReactNode }) {
  return <div className="flex flex-col items-center justify-center text-center py-16 px-6">
    <div className="w-12 h-12 rounded-2xl bg-accent border border-border flex items-center justify-center text-muted-foreground text-xl mb-3.5">{icon || '○'}</div>
    <div className="text-foreground font-medium text-sm">{title}</div>
    {hint && <div className="text-muted-foreground text-xs mt-1.5 max-w-sm leading-relaxed">{hint}</div>}
    {action && <div className="mt-4">{action}</div>}
  </div>
}
