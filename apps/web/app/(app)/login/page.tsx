import LoginForm from '../components/LoginForm';
import Link from 'next/link';

export default function LoginPage() {
  return (
    <div className="auth">
      <div className="auth-brand">
        <div className="bmark"><i>N</i> Notera-Health-Ai</div>
        <Link href="/admin" style={{ position: 'absolute', top: 18, right: 20, fontSize: 13, fontWeight: 600, color: '#0b1220', background: '#ffffff', border: '1px solid rgba(255,255,255,.6)', borderRadius: 8, padding: '7px 12px', textDecoration: 'none', boxShadow: '0 2px 8px rgba(0,0,0,.18)' }}>Testing lab / Admin →</Link>
        <div>
          <h2>Documentation that keeps you in the room, not on the keyboard.</h2>
          <p>Notera drafts a schema-structured SOAP note grounded on the facts of the consult. You review, edit, and sign — always.</p>
          <div className="points">
            <div><span className="tick">✓</span> Medical ASR + in-house NER — PHI stays on your side</div>
            <div><span className="tick">✓</span> Every medication cross-checked against the transcript</div>
            <div><span className="tick">✓</span> Your edits train the model — it gets better every week</div>
          </div>
        </div>
        <div style={{ opacity: .7, fontSize: 13 }}>Notera drafts; a clinician signs. Not a medical device.</div>
      </div>
      <div className="auth-pane">
        <LoginForm />
      </div>
    </div>
  );
}
