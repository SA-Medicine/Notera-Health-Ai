'use client'

import { useEffect, useRef } from 'react'
import './landing.css'

/* Icons kept inline so the component is dependency-free and matches the mockup exactly. */
const Check = () => (
  <svg viewBox="0 0 24 24" fill="none"><path d="M5 13l4 4L19 7" stroke="currentColor" strokeWidth="2.2" /></svg>
)

export default function Landing({ appUrl }: { appUrl: string }) {
  const root = useRef<HTMLDivElement>(null)
  const loginUrl = appUrl.replace(/\/+$/, '') + '/login'

  useEffect(() => {
    const el = root.current
    if (!el) return
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const cleanups: Array<() => void> = []
    /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
    let lenis: any = null

    const nav = el.querySelector('nav')
    const setNav = (y: number) => nav && nav.classList.toggle('scrolled', y > 24)
    const frame = el.querySelector<HTMLElement>('#heroFrame')
    if (frame) frame.style.transform = 'rotateX(8deg)'
    const tilt = (y: number) => { if (frame && !reduce) { const p = Math.min(1, y / 700); frame.style.transform = `rotateX(${8 - p * 8}deg) translateY(${p * -10}px)` } }

    // Lenis smooth scroll (dynamic import → no SSR window access)
    let rafId = 0
    if (!reduce) {
      import('lenis').then(({ default: Lenis }) => {
        lenis = new Lenis({ duration: 1.1, easing: (t: number) => Math.min(1, 1.001 - Math.pow(2, -10 * t)), smoothWheel: true })
        const raf = (t: number) => { lenis.raf(t); rafId = requestAnimationFrame(raf) }
        rafId = requestAnimationFrame(raf)
        lenis.on('scroll', ({ scroll }: { scroll: number }) => { setNav(scroll); tilt(scroll) })
        el.querySelectorAll<HTMLAnchorElement>('a[href^="#"]').forEach((a) => {
          const h = (e: Event) => { const t = el.querySelector(a.getAttribute('href')!); if (t) { e.preventDefault(); lenis.scrollTo(t, { offset: -70 }) } }
          a.addEventListener('click', h); cleanups.push(() => a.removeEventListener('click', h))
        })
      }).catch(() => {
        // Lenis unavailable → native smooth scroll fallback
        document.documentElement.style.scrollBehavior = 'smooth'
        const onS = () => { setNav(window.scrollY); tilt(window.scrollY) }
        window.addEventListener('scroll', onS); cleanups.push(() => window.removeEventListener('scroll', onS))
      })
    } else {
      const onS = () => setNav(window.scrollY)
      window.addEventListener('scroll', onS); cleanups.push(() => window.removeEventListener('scroll', onS))
    }
    setNav(0)

    // Reveal on scroll
    const io = new IntersectionObserver((es) => es.forEach((en) => { if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target) } }), { threshold: 0.15, rootMargin: '0px 0px -8% 0px' })
    el.querySelectorAll('[data-reveal]').forEach((n) => io.observe(n))

    // Count-up stats
    const co = new IntersectionObserver((es) => es.forEach((en) => {
      if (!en.isIntersecting) return
      const n = en.target as HTMLElement; co.unobserve(n)
      const to = +(n.dataset.final || n.dataset.count || '0'); const suf = n.dataset.suffix || ''
      if (to === 0) { n.textContent = '0' + suf; return }
      let v = 0; const st = Math.max(1, to / 38)
      const t = setInterval(() => { v += st; if (v >= to) { v = to; clearInterval(t) } n.textContent = Math.round(v) + suf }, 22)
    }), { threshold: 0.6 })
    el.querySelectorAll('[data-count]').forEach((n) => co.observe(n))

    // FAQ accordion
    el.querySelectorAll<HTMLElement>('.qa').forEach((qa) => {
      const q = qa.querySelector('.q'); const a = qa.querySelector<HTMLElement>('.a')
      if (!q || !a) return
      const h = () => {
        const open = qa.classList.contains('open')
        el.querySelectorAll<HTMLElement>('.qa.open').forEach((o) => { o.classList.remove('open'); const oa = o.querySelector<HTMLElement>('.a'); if (oa) oa.style.maxHeight = '0' })
        if (!open) { qa.classList.add('open'); a.style.maxHeight = a.scrollHeight + 'px' }
      }
      q.addEventListener('click', h); cleanups.push(() => q.removeEventListener('click', h))
    })

    // Pricing toggle
    const sw = el.querySelector<HTMLElement>('#billSw')
    if (sw) {
      const h = () => { const on = sw.classList.toggle('on'); el.querySelectorAll<HTMLElement>('.amt').forEach((a) => { a.textContent = '$' + (on ? a.dataset.a : a.dataset.m) }) }
      sw.addEventListener('click', h); cleanups.push(() => sw.removeEventListener('click', h))
    }

    return () => { cleanups.forEach((c) => c()); io.disconnect(); co.disconnect(); if (rafId) cancelAnimationFrame(rafId); if (lenis) lenis.destroy() }
  }, [])

  return (
    <div className="notera-landing" ref={root}>
      <div className="bg"><div className="gridlines" /><div className="orb a" /><div className="orb b" /><div className="orb c" /></div>

      <div className="lp-content">
        {/* NAV */}
        <nav>
          <div className="wrap">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <div className="brand"><img className="m-img" src="/icon.png" alt="Notera" width={32} height={32} />Notera</div>
            <div className="nlinks"><a href="#how">How it works</a><a href="#features">Features</a><a href="#security">Security</a><a href="#pricing">Pricing</a><a href="#faq">FAQ</a></div>
            <div className="nauth"><a className="btn btn-ghost" href={loginUrl}>Sign in</a><a className="btn btn-primary" href={loginUrl}>Start free</a></div>
          </div>
        </nav>

        {/* HERO */}
        <header className="hero">
          <div className="wrap">
            <h1 data-reveal>Your notes, done before<br /><span className="g">the patient&apos;s coat is back on.</span></h1>
            <p className="lead d2" data-reveal>Notera listens to the visit and writes a clean, structured note you&apos;ll actually recognise as your own. No macros, no templates, no catching up at 9pm.</p>
            <div className="hcta d3" data-reveal>
              <a className="btn btn-primary btn-lg" href={loginUrl}>Start free — no card ↗</a>
              <a className="btn btn-ghost btn-lg" href="#how">See how it works</a>
            </div>
            <p className="hnote d3" data-reveal>Free for your first 50 notes · Set up in about 3 minutes</p>
          </div>

          <div className="frame-wrap" data-reveal>
            <div className="frame" id="heroFrame">
              <div className="fbar"><i /><i /><i /><span className="u">app.notera.health/scribe</span></div>
              <div className="app">
                <div className="aside">
                  <div className="it on"><svg viewBox="0 0 24 24" fill="none"><path d="M12 14a3 3 0 003-3V6a3 3 0 00-6 0v5a3 3 0 003 3z" stroke="currentColor" strokeWidth="1.6" /><path d="M5 11a7 7 0 0014 0M12 18v3" stroke="currentColor" strokeWidth="1.6" /></svg>Scribe</div>
                  <div className="it"><svg viewBox="0 0 24 24" fill="none"><path d="M4 6h16M4 12h16M4 18h10" stroke="currentColor" strokeWidth="1.6" /></svg>Context</div>
                  <div className="it"><svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="1.6" /><path d="M12 8v4l3 2" stroke="currentColor" strokeWidth="1.6" /></svg>History</div>
                </div>
                <div className="amain">
                  <div className="atabs"><span>Transcript</span><span className="on">Note</span><span>History</span><span className="live">● Writing…</span></div>
                  <div className="nh">Subjective</div><div className="nl w92" /><div className="nl w80" />
                  <div className="nh">Objective</div><div className="nl w86" /><div className="nl w66" />
                  <div className="nh">Assessment &amp; Plan</div><div className="nl w92" /><div className="nl w74" />
                </div>
              </div>
            </div>
          </div>
        </header>

        {/* LOGOS */}
        <div className="logos"><div className="wrap" data-reveal>
          <p>Used by clinicians across</p>
          <div className="logorow"><span>Family Medicine</span><span>Cardiology</span><span>Psychiatry</span><span>Paediatrics</span><span>Urgent Care</span></div>
        </div></div>

        {/* PROBLEM */}
        <section className="blk"><div className="wrap prob">
          <div data-reveal>
            <span className="eyebrow">The 9pm problem</span>
            <div className="big" style={{ marginTop: 12 }}>You went into medicine to look after people — not to type until the house is asleep.</div>
            <p>Documentation quietly became a second job. It eats into evenings, it&apos;s the number-one thing clinicians cite when they talk about burnout, and it pulls your eyes off the patient and onto a screen.</p>
            <p>Notera takes the note off your plate. You talk to your patient like a person; it does the writing.</p>
          </div>
          <div className="statcard d1" data-reveal>
            <div className="s"><div className="n" data-count="2">0</div><div className="l">hrs/day on notes, industry avg</div></div>
            <div className="s"><div className="n" data-count="12">0</div><div className="l">minutes saved per visit</div></div>
            <div className="s"><div className="n" data-count="7">0</div><div className="l">seconds to a first draft</div></div>
            <div className="s"><div className="n" data-count="0" data-suffix="k+" data-final="40">0</div><div className="l">notes written so far</div></div>
          </div>
        </div></section>

        {/* HOW */}
        <section className="blk" id="how"><div className="wrap">
          <div className="shead" data-reveal>
            <span className="eyebrow">How it works</span>
            <h2>Three steps. That&apos;s genuinely it.</h2>
            <p className="lead">No new hardware, no template-building weekend. Open Notera, talk, done.</p>
          </div>
          <div className="steps">
            <div className="step" data-reveal><div className="k">1</div><h3>Hit record and talk</h3><p>Have the visit exactly like you always do. Notera runs quietly in the background — it&apos;s fine with accents, interruptions, and the patient&apos;s own words.</p></div>
            <div className="step d1" data-reveal><div className="k">2</div><h3>Read the draft</h3><p>Seconds after you stop, a structured SOAP note is waiting — subjective, objective, assessment and plan, in the order you&apos;d write it yourself.</p></div>
            <div className="step d2" data-reveal><div className="k">3</div><h3>Tweak &amp; sign off</h3><p>Skim it, fix a word if you want, and copy it straight into your EMR. Most notes need barely a touch.</p></div>
          </div>
        </div></section>

        {/* FEATURES */}
        <section className="blk" id="features"><div className="wrap">
          <div className="shead" data-reveal>
            <span className="eyebrow">What makes it different</span>
            <h2>Built to be trusted with a real chart</h2>
            <p className="lead">Speed is easy. Getting it right, every time, is the hard part — and it&apos;s the part we obsess over.</p>
          </div>

          <div className="frow">
            <div className="ftext" data-reveal>
              <span className="eyebrow">Grounded, not guessed</span>
              <h3>It won&apos;t invent a lab it never heard</h3>
              <p>Every sentence Notera writes is traceable back to something that was actually said in the room. If a value wasn&apos;t mentioned, it doesn&apos;t appear — no hallucinated potassium, no phantom medications.</p>
              <ul>
                <li><Check />Line-by-line grounding to the transcript</li>
                <li><Check />Drug names checked against a real drug database</li>
                <li><Check />Flags anything it isn&apos;t sure it heard right</li>
              </ul>
            </div>
            <div className="fvis d1" data-reveal><img alt="Clinician reviewing notes on a tablet" src="https://images.unsplash.com/photo-1584982751601-97dcc096659c?w=900&q=75" /><div className="tint" /></div>
          </div>

          <div className="frow">
            <div className="ftext" data-reveal>
              <span className="eyebrow">Sounds like you</span>
              <h3>Notes in your voice, in your specialty</h3>
              <p>Notera figures out the type of visit on its own and shapes the note the way your field actually documents — a cardiology plan reads like cardiology, a psych note reads like psych. No settings to fiddle with.</p>
              <ul>
                <li><Check />Auto-detects the encounter type</li>
                <li><Check />Keeps your phrasing and structure</li>
                <li><Check />Edit once — it remembers your style</li>
              </ul>
            </div>
            <div className="fvis d1" data-reveal><img alt="Doctor and patient in conversation" src="https://images.unsplash.com/photo-1576091160399-112ba8d25d1d?w=900&q=75" /><div className="tint" /></div>
          </div>

          <div className="frow">
            <div className="ftext" data-reveal>
              <span className="eyebrow">Fits your day</span>
              <h3>One click into the chart you already use</h3>
              <p>Copy the finished note straight into your EMR, or grab a clean formatted version for anything else. No copy-paste gymnastics, no reformatting.</p>
              <ul>
                <li><Check />One-click &quot;Copy to EMR&quot;</li>
                <li><Check />Full history of every visit, searchable</li>
                <li><Check />Works on the laptop you already have</li>
              </ul>
            </div>
            <div className="fvis d1" data-reveal><img alt="Healthcare team at work" src="https://images.unsplash.com/photo-1519494026892-80bbd2d6fd0d?w=900&q=75" /><div className="tint" /></div>
          </div>
        </div></section>

        {/* SECURITY */}
        <section className="blk sec-band" id="security"><div className="wrap">
          <div className="shead" data-reveal>
            <span className="eyebrow">Security &amp; privacy</span>
            <h2>Your patients&apos; data stays your patients&apos; data</h2>
            <p className="lead">We treat privacy as the product, not a footnote.</p>
          </div>
          <div className="secgrid">
            <div className="secitem" data-reveal><svg viewBox="0 0 24 24" fill="none"><path d="M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7l8-4z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /></svg><h4>HIPAA-ready</h4><p>Built to meet HIPAA requirements from the ground up.</p></div>
            <div className="secitem d1" data-reveal><svg viewBox="0 0 24 24" fill="none"><rect x="5" y="11" width="14" height="9" rx="2" stroke="currentColor" strokeWidth="1.6" /><path d="M8 11V8a4 4 0 018 0v3" stroke="currentColor" strokeWidth="1.6" /></svg><h4>Encrypted end to end</h4><p>At rest and in transit — always.</p></div>
            <div className="secitem d2" data-reveal><svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.6" /><path d="M8 12l3 3 5-6" stroke="currentColor" strokeWidth="1.6" /></svg><h4>Never trained on your data</h4><p>Your visits are never used to train models.</p></div>
            <div className="secitem d3" data-reveal><svg viewBox="0 0 24 24" fill="none"><path d="M4 6h16M4 12h16M4 18h10" stroke="currentColor" strokeWidth="1.6" /></svg><h4>Full audit trail</h4><p>Every access is logged and reviewable.</p></div>
          </div>
        </div></section>

        {/* TESTIMONIALS */}
        <section className="blk"><div className="wrap">
          <div className="shead" data-reveal>
            <span className="eyebrow">From the people using it</span>
            <h2>Evenings back. Notes that sound right.</h2>
          </div>
          <div className="tgrid">
            <div className="tcard" data-reveal>
              <div className="stars">★★★★★</div>
              <p>&quot;I used to finish charting at home after dinner. Now it&apos;s done before my next patient&apos;s even sat down. The notes actually sound like me — that&apos;s the part I didn&apos;t expect.&quot;</p>
              <div className="who"><img src="https://i.pravatar.cc/88?img=15" alt="" /><div><b>Dr. Anita Rao</b><span>Family Medicine</span></div></div>
            </div>
            <div className="tcard d1" data-reveal>
              <div className="stars">★★★★★</div>
              <p>&quot;I was sceptical about the &lsquo;AI won&apos;t make things up&rsquo; claim. Three months in, it hasn&apos;t invented a single value. That trust is everything in a chart.&quot;</p>
              <div className="who"><img src="https://i.pravatar.cc/88?img=33" alt="" /><div><b>Dr. Marcus Bell</b><span>Cardiology</span></div></div>
            </div>
            <div className="tcard d2" data-reveal>
              <div className="stars">★★★★★</div>
              <p>&quot;My patients notice I&apos;m looking at them again instead of the keyboard. That alone made me a believer. Setup took me one coffee.&quot;</p>
              <div className="who"><img src="https://i.pravatar.cc/88?img=45" alt="" /><div><b>Dr. Priya Nair</b><span>Psychiatry</span></div></div>
            </div>
          </div>
        </div></section>

        {/* PRICING */}
        <section className="blk" id="pricing"><div className="wrap">
          <div className="shead" data-reveal>
            <span className="eyebrow">Pricing</span>
            <h2>Start free. Upgrade when it&apos;s saving you hours.</h2>
            <p className="lead">No card to begin. Cancel any time — we&apos;d rather earn the month.</p>
          </div>
          <div className="toggle" data-reveal>
            <span>Monthly</span>
            <div className="sw" id="billSw"><i /></div>
            <span>Annual</span><span className="save">Save 20%</span>
          </div>
          <div className="pgrid">
            <div className="pcard" data-reveal>
              <h3>Solo</h3>
              <div className="price">$0<small>/first 50 notes</small></div>
              <p className="desc">Everything you need to try it on real visits.</p>
              <ul>
                <li><Check />Up to 50 notes free</li>
                <li><Check />SOAP notes + transcript</li>
                <li><Check />Copy to any EMR</li>
              </ul>
              <a className="btn btn-ghost" href={loginUrl}>Start free</a>
            </div>
            <div className="pcard pop d1" data-reveal>
              <span className="tagpop">Most popular</span>
              <h3>Practice</h3>
              <div className="price"><span className="amt" data-m="49" data-a="39">$49</span><small>/clinician / mo</small></div>
              <p className="desc">For clinicians who see patients all day, every day.</p>
              <ul>
                <li><Check />Unlimited notes</li>
                <li><Check />Specialty auto-tuning</li>
                <li><Check />Full searchable history</li>
                <li><Check />Priority support</li>
              </ul>
              <a className="btn btn-primary" href={loginUrl}>Start free trial</a>
            </div>
            <div className="pcard d2" data-reveal>
              <h3>Enterprise</h3>
              <div className="price">Let&apos;s talk</div>
              <p className="desc">For groups and health systems with their own rules.</p>
              <ul>
                <li><Check />SSO &amp; admin controls</li>
                <li><Check />EMR integrations</li>
                <li><Check />BAA &amp; custom security review</li>
              </ul>
              <a className="btn btn-ghost" href="#">Talk to us</a>
            </div>
          </div>
        </div></section>

        {/* FAQ */}
        <section className="blk" id="faq"><div className="wrap">
          <div className="shead" data-reveal>
            <span className="eyebrow">Questions clinicians actually ask</span>
            <h2>The honest FAQ</h2>
          </div>
          <div className="faq">
            <div className="qa" data-reveal><button className="q">Will it cope with my patients&apos; accents and the way people actually talk?<span className="pm">+</span></button><div className="a"><p>Yes — that&apos;s exactly what it&apos;s tuned for. Real visits are messy: people interrupt, trail off, and use their own words. Notera is built around real consultation audio, not clean studio dictation.</p></div></div>
            <div className="qa" data-reveal><button className="q">Is my patient data used to train the AI?<span className="pm">+</span></button><div className="a"><p>No. Your visits are never used to train models. Data is encrypted at rest and in transit, and every access is logged.</p></div></div>
            <div className="qa" data-reveal><button className="q">What if it writes something the patient didn&apos;t say?<span className="pm">+</span></button><div className="a"><p>It&apos;s designed specifically not to. Every line is grounded to the transcript, drug names are checked against a real drug database, and anything uncertain is flagged for you rather than quietly written in.</p></div></div>
            <div className="qa" data-reveal><button className="q">Does it work with my EMR?<span className="pm">+</span></button><div className="a"><p>The finished note copies cleanly into any EMR today. Deeper write-back integrations are available on Enterprise — tell us which system you use and we&apos;ll walk you through it.</p></div></div>
            <div className="qa" data-reveal><button className="q">How long does setup take?<span className="pm">+</span></button><div className="a"><p>About three minutes. Create an account, allow your microphone, and record your first visit. No IT ticket required.</p></div></div>
          </div>
        </div></section>

        {/* FINAL CTA */}
        <div className="final" data-reveal><div className="finalbox">
          <h2>Get your evenings back.</h2>
          <p>Try Notera free on your next 50 visits — no card, no commitment.</p>
          <a className="btn btn-lg" href={loginUrl}>Start free — no card ↗</a>
        </div></div>

        {/* FOOTER */}
        <footer><div className="wrap">
          <div className="fgrid">
            <div className="col about">
              <div className="brand"><span className="m"><svg viewBox="0 0 24 24" fill="none"><path d="M12 2v20M5 8l7-4 7 4M5 8v8l7 4 7-4V8" stroke="#fff" strokeWidth="1.8" strokeLinejoin="round" /></svg></span>Notera</div>
              <p>The AI scribe that writes the note before you finish talking — grounded, private, and in your voice.</p>
            </div>
            <div className="col"><h5>Product</h5><a href="#how">How it works</a><a href="#features">Features</a><a href="#pricing">Pricing</a><a href="#security">Security</a></div>
            <div className="col"><h5>Company</h5><a href="#">About</a><a href="#">Careers</a><a href="#">Blog</a><a href="#">Contact</a></div>
            <div className="col"><h5>Legal</h5><a href="#">Privacy</a><a href="#">Terms</a><a href="#">HIPAA</a><a href="#">Security</a></div>
          </div>
          <div className="fbot"><span>© 2026 Notera Health. All rights reserved.</span><span>Grounded, private, physician-built.</span></div>
        </div></footer>
      </div>
    </div>
  )
}
