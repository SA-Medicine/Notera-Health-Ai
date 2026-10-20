import './globals.css'
import { AuthProvider } from './components/AuthProvider'
import TopBar from './components/TopBar'
import InterviewInvite from './components/InterviewInvite'

// The clinician product — restored to its original white theme, gated by AuthProvider.
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <TopBar />
      <InterviewInvite />
      <main>{children}</main>
    </AuthProvider>
  )
}
