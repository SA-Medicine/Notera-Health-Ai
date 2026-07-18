import type { Config } from 'tailwindcss'
import preset from '@notera/ui/tailwind-preset'

// The design system (tokens, colors, radii, animations) comes from the shared preset.
// We only declare where to scan for class names — including the @notera/ui source.
export default {
  presets: [preset as any],
  content: [
    './app/**/*.{ts,tsx}',
    './src/**/*.{ts,tsx}',
    '../../packages/ui/src/**/*.{ts,tsx}',
  ],
} satisfies Config
