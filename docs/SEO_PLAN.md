# SEO Plan — aitoolsfordoctor.com

A growth plan for a **multi‑tool brand** ("AI Tools for Doctors") where **Notera** (AI medical scribe) is the flagship, with more tools to follow. Goal: rank for high‑intent physician queries and turn organic traffic into free‑trial sign‑ups.

## 1. Positioning & information architecture

Treat the site as a **hub‑and‑spoke**: the brand hub ranks for broad terms; each tool gets its own page ranking for its specific terms.

```
aitoolsfordoctor.com/                → hub: "AI tools for doctors" (brand + overview)   [built]
             /notera                  → tool: "AI medical scribe / SOAP note generator"
             /coding-assist           → tool: "ICD-10 / CPT coding AI"  (future)
             /referral-writer         → tool: "referral letter generator" (future)
             /pricing                 → commercial intent
             /about  /contact         → trust / E-E-A-T
             /blog/*                  → topical authority (see §4)
app.aitoolsfordoctor.com/            → the product (noindex, gated)
```

Each tool page targets ONE primary keyword + a cluster of long‑tails, links up to the hub and across to related tools, and ends with a sign‑up CTA.

## 2. Keyword strategy (seed → target)

| Page | Primary keyword | Supporting long‑tails |
|---|---|---|
| Home (hub) | AI tools for doctors | AI software for physicians, medical AI assistant, doctor productivity tools |
| Notera | AI medical scribe | SOAP note generator, AI clinical documentation, ambient scribe, automated charting, dictation alternative |
| Coding Assist | AI medical coding | ICD‑10 code lookup AI, CPT coding assistant |
| Pricing | AI scribe pricing | how much does an AI medical scribe cost |
| Blog | informational | "how to write a SOAP note", "reduce physician burnout documentation", "is AI scribe HIPAA compliant" |

Prioritise **commercial + problem‑aware** terms first (scribe, SOAP note generator, HIPAA AI scribe) — they convert. Use **informational** blog terms to build authority and capture top‑of‑funnel.

## 3. Technical SEO — implemented in this repo ✅

| Item | File |
|---|---|
| Per‑page + templated titles, description, keywords, canonical, OpenGraph, Twitter, robots directives, `metadataBase` | `apps/web/app/layout.tsx` |
| `robots.txt` (allow site, disallow app/API/private) + sitemap link | `apps/web/app/robots.ts` |
| XML `sitemap.xml` (add a line per new page) | `apps/web/app/sitemap.ts` |
| PWA/web manifest | `apps/web/app/manifest.ts` |
| JSON‑LD: Organization + WebSite (site‑wide), SoftwareApplication + FAQ (home) | `layout.tsx`, `(marketing)/marketing/page.tsx` |
| Public marketing site (semantic H1/H2, fast, no auth) on the apex domain | `(marketing)/` + `middleware.ts` host split |

**Still to add (assets + config):**
- Drop real images into `apps/web/public/`: `og.png` (1200×630 social card), `icon-192.png`, `icon-512.png`, `favicon.ico`. (They're referenced already; add the files.)
- Set env on the frontend host: `NEXT_PUBLIC_SITE_URL=https://aitoolsfordoctor.com`, `NEXT_PUBLIC_APP_URL=https://app.aitoolsfordoctor.com`.
- After launch: verify the domain in **Google Search Console** + **Bing Webmaster**, submit `sitemap.xml`, and request indexing of the home + Notera pages.
- Core Web Vitals: the marketing pages are static and light — keep images optimized (`next/image`) and avoid heavy client JS on marketing routes.

## 4. Content plan (authority)

Publish 1–2 posts/week targeting the informational cluster, each internally linking to Notera:
- "The complete guide to writing SOAP notes (with examples)" → links to Notera.
- "Is an AI medical scribe HIPAA compliant? What to check." → trust + links to Notera.
- "How much time do physicians spend on documentation?" (data post, link‑bait).
- "Ambient AI scribe vs. dictation vs. templates" (comparison).
- Specialty landing posts: "AI scribe for family medicine / psychiatry / …".

Each post: one clear primary keyword in the H1/title/URL/first 100 words, descriptive H2s, FAQ block (FAQ schema), and a CTA.

## 5. Off‑page & trust (E‑E‑A‑T matters a LOT in health/YMYL)

- **Author bylines** with real clinical credentials on every medical post; an About page with team/advisors.
- **Trust signals** on the site: BAA/HIPAA statement, security page, testimonials, logos.
- Backlinks: medical directories, physician communities, guest posts on healthcare‑IT blogs, product listings (Capterra/G2/Software Advice for "medical scribe software").
- Google Business Profile if you have a registered entity.

## 6. Conversion

- Primary CTA everywhere → **Start free** → `app.aitoolsfordoctor.com`.
- Add a lightweight lead magnet (e.g., free SOAP‑note template) to capture emails from blog traffic.
- Track: GA4 + Search Console; measure organic → sign‑up conversion per landing page.

## 7. 90‑day roadmap

- **Weeks 1–2:** launch marketing site (done), add OG/icons, verify Search Console + Bing, submit sitemap, publish Home + Notera + Pricing + About.
- **Weeks 3–6:** ship the Notera tool page targeting "AI medical scribe" + "SOAP note generator"; publish 4 cornerstone blog posts; start directory listings.
- **Weeks 7–12:** 8–10 more posts (specialty + comparison), first backlink outreach, add the second tool page, iterate titles/meta from Search Console query data.

## 8. Measurement

Watch in Search Console: impressions/clicks/position for the target keywords; in GA4: organic sessions → free‑trial starts. Re‑optimise any page stuck on page 2 (positions 11–20) — usually a title/intro/internal‑link tweak moves it.
