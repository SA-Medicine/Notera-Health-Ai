import * as React from 'react'
import { cn } from '../../lib/utils'
export const Card = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(({ className, ...p }, ref) =>
  <div ref={ref} className={cn('rounded-xl border border-border bg-card text-card-foreground shadow-card', className)} {...p} />)
Card.displayName = 'Card'
export const CardHeader = ({ className, ...p }: React.HTMLAttributes<HTMLDivElement>) => <div className={cn('flex flex-col gap-1 p-4', className)} {...p} />
export const CardTitle = ({ className, ...p }: React.HTMLAttributes<HTMLDivElement>) => <div className={cn('font-semibold text-sm', className)} {...p} />
export const CardContent = ({ className, ...p }: React.HTMLAttributes<HTMLDivElement>) => <div className={cn('p-4 pt-0', className)} {...p} />
