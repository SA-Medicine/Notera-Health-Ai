import type { MetadataRoute } from 'next'

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Notera — AI Medical Scribe',
    short_name: 'Notera',
    description: 'Notera turns consultations into grounded, structured SOAP notes in seconds. HIPAA-ready, physician-built.',
    start_url: '/',
    display: 'standalone',
    background_color: '#06070f',
    theme_color: '#6d5efc',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }
}
