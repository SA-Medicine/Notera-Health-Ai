'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from './AuthProvider';

const FEATURES = [
  { ico: '🎙️', h: 'Record or paste', p: 'Record the visit or paste a transcript. Speech-to-text handles clinical vocabulary, and a recording that comes out too short is caught and can be re-transcribed.' },
  { ico: '🧾', h: 'Your clinic\'s note format', p: 'Topic-headed Subjective, one problem per issue, and a plan with its own Advice and Follow-up lines. Every label appears once.' },
  { ico: '🔎', h: 'Every line checked', p: 'A second pass compares each line with what was said. Lines the recording does not support are removed; doubtful ones are flagged above the note.' },
  { ico: '🧭', h: 'Plan items under the right problem', p: 'Investigations, treatments and referrals sit under the problem they are for, and an issue you dealt with gets its own problem.' },
  { ico: '🛡️', h: 'Drug, side and date checks', p: 'Drug names are checked against the transcript, a left or right the recording does not name is flagged, and invented dates are removed.' },
  { ico: '🔁', h: 'Learns from your edits', p: 'Your edits are kept as suggestions for the clinic\'s note style. Nothing changes without the owner\'s approval.' },
];

const STEPS = [
  { n: 1, h: 'Capture', p: 'Record or paste the consult. Speech-to-text produces the transcript.' },
  { n: 2, h: 'Draft', p: 'Gemini writes the SOAP note in your clinic\'s format, with the plan sorted by problem.' },
  { n: 3, h: 'Check', p: 'Each line is compared with the recording. Unsupported lines are removed; doubtful ones are flagged for you.' },
  { n: 4, h: 'Review & sign', p: 'You read the flags, edit and approve. No note is finalized without a clinician.' },
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
              Notera turns a consultation into a draft SOAP note in your clinic's format in about half a minute,
              checks each line against the recording, and flags what needs your eye. You read it and sign it.
            </p>
            <div className="hero-cta">
              <button className="btn xl" onClick={start}>Get started →</button>
              <a className="btn ghost xl" href="#how">See how it works</a>
            </div>
            <div className="hero-trust">
              <span><b>Every line</b> checked</span>
              <span><b>Flags</b> above the note</span>
              <span><b>0</b> notes auto-finalized</span>
            </div>
          </div>

          {/* Preview card */}
          <div className="preview">
            <div className="preview-bar"><i /><i /><i /><span>notera · draft note</span></div>
            <div className="preview-body">
              <div className="pv-row"><span className="status PASS">DRAFT</span><span className="muted" style={{ fontSize: 12 }}>2 to check · read before you sign</span></div>
              <div className="pv-h">Subjective</div>
              <div className="pv-line l" /><div className="pv-line m" />
              <div style={{ margin: '8px 0' }}><span className="pv-chip">Advice</span><span className="pv-chip">Follow-up</span></div>
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
            <p>The accuracy work is in the checks around the model: grounding, guardrails and a read-before-you-sign strip. No scribe is perfect, so the note stays a draft until you sign.</p>
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
            <p>Four steps, and you are the last one.</p>
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
            <div className="pipe">Speech to text<small>transcript</small></div>
            <span className="pipe-arrow">→</span>
            <div className="pipe">Draft<small>your format</small></div>
            <span className="pipe-arrow">→</span>
            <div className="pipe">Check<small>line by line</small></div>
            <span className="pipe-arrow">→</span>
            <div className="pipe">Flags<small>above the note</small></div>
            <span className="pipe-arrow">→</span>
            <div className="pipe">You sign<small>always</small></div>
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
