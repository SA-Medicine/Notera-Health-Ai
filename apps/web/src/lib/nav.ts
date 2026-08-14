import { LayoutGrid, Play, Rows3, LineChart, PencilLine, Scale, Users, Sparkles, Lightbulb, Stethoscope, type LucideIcon } from 'lucide-react'
export interface NavItem { id: string; label: string; icon: LucideIcon }
export const NAV: NavItem[] = [
  { id: 'overview', label: 'Overview', icon: LayoutGrid },
  { id: 'run', label: 'Run', icon: Play },
  { id: 'patients', label: 'Patients', icon: Users },
  { id: 'results', label: 'Results', icon: Rows3 },
  { id: 'critique', label: 'Second Opinion', icon: Stethoscope },
  { id: 'metrics', label: 'Metrics', icon: LineChart },
  { id: 'prompts', label: 'Prompts', icon: PencilLine },
  { id: 'upgrader', label: 'Upgrader', icon: Sparkles },
  { id: 'judge', label: 'Gates & Judge', icon: Scale },
  { id: 'system', label: 'System Ideas', icon: Lightbulb },
]
export type TabId = string
