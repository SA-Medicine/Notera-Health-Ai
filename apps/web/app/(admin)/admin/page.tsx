'use client'
import dynamic from 'next/dynamic'

// The testing lab is a pure client SPA (localStorage, SSE, etc.), so we load it
// with SSR disabled — no server render, no `localStorage is not defined`.
const AdminApp = dynamic(() => import('@/AdminApp'), {
  ssr: false,
  loading: () => (
    <div className="h-screen flex items-center justify-center bg-background">
      <div className="w-6 h-6 rounded-full border-2 border-border border-t-primary animate-spin" />
    </div>
  ),
})

export default function AdminPage() {
  return <AdminApp />
}
