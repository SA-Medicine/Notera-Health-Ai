import * as React from 'react'
import * as TabsPrimitive from '@radix-ui/react-tabs'
import { cn } from '@/lib/utils'
export const Tabs = TabsPrimitive.Root
export const TabsList = React.forwardRef<React.ElementRef<typeof TabsPrimitive.List>, React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>>(({ className, ...p }, ref) =>
  <TabsPrimitive.List ref={ref} className={cn('inline-flex items-center gap-0.5 rounded-lg bg-muted p-0.5', className)} {...p} />)
TabsList.displayName = 'TabsList'
export const TabsTrigger = React.forwardRef<React.ElementRef<typeof TabsPrimitive.Trigger>, React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>>(({ className, ...p }, ref) =>
  <TabsPrimitive.Trigger ref={ref} className={cn('inline-flex items-center justify-center rounded-md px-3 py-1.5 text-xs font-medium text-muted-foreground transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=active]:bg-raised data-[state=active]:text-foreground data-[state=active]:shadow-sm', className)} {...p} />)
TabsTrigger.displayName = 'TabsTrigger'
export const TabsContent = TabsPrimitive.Content
