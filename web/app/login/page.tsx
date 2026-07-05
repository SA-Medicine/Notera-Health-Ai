import LoginForm from '../components/LoginForm';

export default function LoginPage() {
  return (
    <div className="auth">
      <div className="auth-brand">
        <div className="bmark"><i>N</i> Notera-Health-Ai</div>
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
