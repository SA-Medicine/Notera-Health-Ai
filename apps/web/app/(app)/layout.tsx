import './globals.css'
import { AuthProvider } from './components/AuthProvider'
import TopBar from './components/TopBar'

// The clinician product — restored to its original white theme, gated by AuthProvider.
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <TopBar />
      <main>{children}</main>
    </AuthProvider>
  )
}
