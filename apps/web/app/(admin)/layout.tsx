import '@notera/ui/globals.css'
import { Providers } from '../providers'

// The testing lab: shadcn dark design system, scoped to the (admin) group so it
// never touches the clinician product's white theme.
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="dark min-h-screen bg-background text-foreground antialiased">
      <Providers>{children}</Providers>
    </div>
  )
}
