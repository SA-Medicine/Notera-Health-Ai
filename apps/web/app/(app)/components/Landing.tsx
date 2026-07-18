'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from './AuthProvider';

const FEATURES = [
  { ico: '🎙️', h: 'Ambient + transcript', p: 'Record the visit or paste a transcript. Medical ASR handles clinical vocabulary and speaker turns.' },
  { ico: '🧬', h: 'In-house medical NER', p: 'scispaCy · Med7 · medspaCy extract meds, doses, diagnoses and negation — locally, so PHI never leaves.' },
  { ico: '📐', h: 'Schema-structured notes', p: 'Every note is validated against a versioned SOAP schema — a contract, not free text.' },
  { ico: '🛡️', h: 'Medication cross-check', p: 'Guardrails flag any medication the model wrote that the transcript did not support — the highest-harm error class.' },
  { ico: '🔒', h: 'De-identified generation', p: 'PHI is stripped before the Gemini call and re-inserted inside your systems. HIPAA-aligned by design.' },
  { ico: '🔁', h: 'Learns from your edits', p: 'Every clinician sign-off captures the draft→final diff — a compounding training flywheel.' },
];

const STEPS = [
  { n: 1, h: 'Capture', p: 'Record or paste the consult. ASR produces a clean, diarized transcript.' },
  { n: 2, h: 'Ground', p: 'NER pulls the hard facts; PHI is de-identified before generation.' },
  { n: 3, h: 'Draft', p: 'Gemini writes a schema-structured SOAP note grounded on those facts.' },
  { n: 4, h: 'Review & sign', p: 'You edit and approve. No note is finalized without a clinician.' },
];

export default function Landing() {
  const { user } = useAuth();
  const router = useRouter();
  const start = () => router.push(user ? '/app' : '/login');

  return (
    <div className="full">
      {/* Hero */}
      <section className="hero">
        <div className="hero-inner">
          <div>
            <span className="badge"><span className="g" /> Gemini-powered · human-in-the-loop</span>
            <h1>Clinical notes that <span className="grad">write themselves</span>—and that you sign.</h1>
            <p className="lede">
              Notera turns a consultation into a structured, fact-grounded SOAP note in seconds.
              Medical ASR, in-house NER, and a medication cross-check do the heavy lifting; the
              clinician stays in control.
            </p>
            <div className="hero-cta">
              <button className="btn xl" onClick={start}>Get started →</button>
              <a className="btn ghost xl" href="#how">See how it works</a>
            </div>
            <div className="hero-trust">
              <span><b>SOAP</b> schema-validated</span>
              <span><b>PHI</b> de-identified</span>
              <span><b>0</b> notes auto-finalized</span>
            </div>
          </div>

          {/* Preview card */}
          <div className="preview">
            <div className="preview-bar"><i /><i /><i /><span>notera · draft note</span></div>
            <div className="preview-body">
              <div className="pv-row"><span className="status PASS">PASS</span><span className="muted" style={{ fontSize: 12 }}>schema v1.0.0 · general primary care</span></div>
              <div className="pv-h">Subjective</div>
              <div className="pv-line l" /><div className="pv-line m" />
              <div style={{ margin: '8px 0' }}><span className="pv-chip">metformin 500mg</span><span className="pv-chip">penicillin allergy</span></div>
              <div className="pv-h">Objective</div>
              <div className="pv-line m" /><div className="pv-line s" />
              <div className="pv-h">Assessment</div>
              <div className="pv-line l" />
              <div className="pv-h">Plan</div>
              <div className="pv-line m" /><div className="pv-line s" />
            </div>
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="block" id="features">
        <div className="wrap">
          <div className="block-head">
            <div className="eyebrow">Why Notera</div>
            <h2>A pipeline, not just a prompt</h2>
            <p>Clinical-grade accuracy comes from grounding and guardrails around the model — not a bigger model.</p>
          </div>
          <div className="features">
            {FEATURES.map((f) => (
              <div className="feature" key={f.h}>
                <div className="ico">{f.ico}</div>
                <h3>{f.h}</h3>
                <p>{f.p}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* How it works */}
      <section className="block tint" id="how">
        <div className="wrap">
          <div className="block-head">
            <div className="eyebrow">How it works</div>
            <h2>Consult in, signed note out</h2>
            <p>Four steps. Every one instrumented so you can measure and improve SOAP quality.</p>
          </div>
          <div className="steps">
            {STEPS.map((s) => (
              <div className="step" key={s.n}>
                <div className="n">{s.n}</div>
                <h3>{s.h}</h3>
                <p>{s.p}</p>
              </div>
            ))}
          </div>

          <div className="pipeline" style={{ marginTop: 34 }}>
            <div className="pipe">Medical ASR<small>diarized transcript</small></div>
            <span className="pipe-arrow">→</span>
            <div className="pipe">NER<small>meds · dx · negation</small></div>
            <span className="pipe-arrow">→</span>
            <div className="pipe">De-identify<small>PHI out</small></div>
            <span className="pipe-arrow">→</span>
            <div className="pipe">Gemini<small>schema SOAP</small></div>
            <span className="pipe-arrow">→</span>
            <div className="pipe">Guardrails<small>cross-check</small></div>
            <span className="pipe-arrow">→</span>
            <div className="pipe">You sign<small>flywheel</small></div>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="block">
        <div className="wrap">
          <div className="cta-band">
            <div>
              <h2>Draft your first note in under a minute.</h2>
              <p>No setup — try it with a sample consult right now.</p>
            </div>
            <button className="btn white xl" onClick={start}>Open Notera →</button>
          </div>
        </div>
      </section>

      <footer className="landing-footer">
        <div className="wrap">
          <span>© {new Date().getFullYear()} Notera-Health-Ai · SA-Medicine</span>
          <span>Notera drafts; a clinician signs. Not a medical device.</span>
        </div>
      </footer>
    </div>
  );
}
