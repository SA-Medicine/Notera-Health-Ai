import type { MetadataRoute } from 'next'

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://aitoolsfordoctor.com'

// Public, indexable marketing routes. Add a line here whenever you ship a new tool page or blog post.
export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date()
  const pages: Array<{ path: string; priority: number; freq: MetadataRoute.Sitemap[number]['changeFrequency'] }> = [
    { path: '/', priority: 1.0, freq: 'weekly' },
    { path: '/notera', priority: 0.9, freq: 'monthly' },        // flagship tool page (add when built)
    { path: '/pricing', priority: 0.7, freq: 'monthly' },
    { path: '/about', priority: 0.5, freq: 'yearly' },
    { path: '/contact', priority: 0.5, freq: 'yearly' },
  ]
  return pages.map((p) => ({
    url: `${SITE_URL}${p.path === '/' ? '' : p.path}`,
    lastModified: now,
    changeFrequency: p.freq,
    priority: p.priority,
  }))
}
