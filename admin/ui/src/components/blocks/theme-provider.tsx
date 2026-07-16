import * as React from 'react'
type Theme = 'dark' | 'light'
const Ctx = React.createContext<{ theme: Theme; toggle: () => void }>({ theme: 'dark', toggle: () => {} })
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = React.useState<Theme>(() => (localStorage.getItem('notera-theme') as Theme) || 'dark')
  React.useEffect(() => {
    const root = document.documentElement
    root.classList.toggle('dark', theme === 'dark')
    localStorage.setItem('notera-theme', theme)
  }, [theme])
  const toggle = () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))
  return <Ctx.Provider value={{ theme, toggle }}>{children}</Ctx.Provider>
}
export const useTheme = () => React.useContext(Ctx)
