'use client'
import { ThemeProvider } from '@notera/ui/components/blocks/theme-provider'
import { TooltipProvider } from '@notera/ui/components/ui/tooltip'
import { Toaster } from 'sonner'

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider>
      <TooltipProvider delayDuration={300}>
        {children}
        <Toaster theme="dark" position="bottom-right" richColors closeButton />
      </TooltipProvider>
    </ThemeProvider>
  )
}
