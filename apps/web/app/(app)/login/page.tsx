import LoginForm from '../components/LoginForm';

export default function LoginPage() {
  return (
    <div className="auth">
      <div className="auth-brand">
        <div className="bmark"><i>N</i> Notera</div>
        <div>
          <h2>Documentation that keeps you in the room, not on the keyboard.</h2>
          <p>Notera drafts a clean, structured SOAP note grounded on the facts of the consult. You review, edit, and sign — always.</p>
          <div className="points">
            <div><span className="tick">✓</span> Grounded to the transcript — no invented labs or medications</div>
            <div><span className="tick">✓</span> HIPAA-ready · your visits are never used to train models</div>
            <div><span className="tick">✓</span> Notes in your voice, ready in seconds</div>
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
