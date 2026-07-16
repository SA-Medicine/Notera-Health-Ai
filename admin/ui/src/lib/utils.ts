import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) { return twMerge(clsx(inputs)) }

export const fmtPct = (v: number | null | undefined) => (v == null ? '—' : (v * 100).toFixed(1) + '%')
export const fmtNum = (v: number | null | undefined, d = 3) => (v == null ? '—' : Number(v).toFixed(d))
export const shortId = (id: string) => id.replace(/^run_/, '').replace('_', ' ')
export const BLOCKERS = ['patient2', 'patient5']
export const isBlocker = (f: string) => BLOCKERS.includes(String(f || '').toLowerCase())
