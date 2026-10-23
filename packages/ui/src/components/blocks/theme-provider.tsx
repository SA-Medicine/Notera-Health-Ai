'use client'
import * as React from 'react'
type Theme = 'dark' | 'light'
const Ctx = React.createContext<{ theme: Theme; toggle: () => void }>({ theme: 'light', toggle: () => {} })
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // SSR-safe: localStorage only exists in the browser.
  const [theme, setTheme] = React.useState<Theme>('light')   // light by default; dark only when the person picks it (the operating system's setting is ignored)
  React.useEffect(() => { setTheme(localStorage.getItem('notera.theme') === 'dark' ? 'dark' : 'light') }, [])
  React.useEffect(() => {
    if (typeof document === 'undefined') return
    const root = document.documentElement
    root.classList.toggle('dark', theme === 'dark')
  }, [theme])
  const toggle = () => setTheme((t) => { const n: Theme = t === 'dark' ? 'light' : 'dark'; try { localStorage.setItem('notera.theme', n) } catch { /* private window */ } return n })
  return <Ctx.Provider value={{ theme, toggle }}>{children}</Ctx.Provider>
}
export const useTheme = () => React.useContext(Ctx)
