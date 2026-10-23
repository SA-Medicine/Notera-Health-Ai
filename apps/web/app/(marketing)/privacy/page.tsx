import type { Metadata } from 'next'
import Shell from '../Shell'
import { SITE_URL, LEGAL_EMAIL, TERMS_UPDATED } from '../../lib/legal'

export const metadata: Metadata = {
  title: 'Privacy Policy — Notera',
  description: 'What Notera collects, why, who can see it, how long it is kept, and the choices clinicians have, including the optional, off-by-default choice to help improve Notera.',
  alternates: { canonical: '/privacy' },
  openGraph: { title: 'Notera Privacy Policy', description: 'Plain-language privacy policy for clinicians and their patients.', url: `${SITE_URL}/privacy`, images: ['/og.png'] },
}

export default function PrivacyPage() {
  return (
    <Shell>
      <span className="mkt-eyebrow">Legal</span>
      <h1>Privacy Policy</h1>
      <p className="lede">Last updated {TERMS_UPDATED}. This explains what Notera Health (&ldquo;Notera&rdquo;, &ldquo;we&rdquo;) collects, why, who can see it, how long we keep it, and the choices you have. Recordings of consultations contain health information, so we have written it in plain language.</p>

      <h2>1. What we collect</h2>
      <ul>
        <li><strong>Your account:</strong> name, email, specialty, a salted hash of your password (never the password itself), your plan and how many notes you have used.</li>
        <li><strong>Your recordings, transcripts and notes:</strong> the audio of consultations you choose to record, the transcript, the note drafted from it, and the edits and corrections you make. Whatever is said in the room may be in them, including patients&apos; health information.</li>
        <li><strong>Technical data:</strong> error and performance logs that contain no patient content, sign-in times, browser type, and an audit record of sensitive actions, for example when a member of our staff opens a recording.</li>
      </ul>
      <p>We do not use advertising trackers and we do not sell or rent personal information.</p>

      <h2>2. How we use it</h2>
      <ul>
        <li>To provide Notera: turn the audio into a transcript, draft the note, and keep your history.</li>
        <li>To keep it secure and working: prevent abuse, find and fix faults, answer support requests.</li>
        <li>To improve Notera itself: <strong>only if you choose to allow it</strong> (section 5). It is off unless you turn it on.</li>
      </ul>

      <h2>3. Who processes it for us</h2>
      <ul>
        <li><strong>Google Cloud</strong> (United States regions) provides speech-to-text, the AI models that draft the note (Vertex AI), and the servers, storage and database. Google acts as our service provider under its Cloud terms, which do not allow it to use this content to train its own models.</li>
        <li><strong>Cloudflare</strong> delivers the website and app and carries traffic securely. It does not store recordings.</li>
        <li><strong>An email provider</strong> sends account emails such as password resets. These contain no patient information.</li>
      </ul>
      <p>Before a draft is written, Notera tries to remove direct identifiers such as names from the text it sends to the writing model. This is a safeguard, not a guarantee. We do not share your information with anyone else unless you tell us to or the law requires it.</p>

      <h2>4. Where it is stored and how it is protected</h2>
      <ul>
        <li>Recordings are kept in a private Google Cloud storage bucket with public access switched off. Transcripts and notes are kept in a database. Both are encrypted in transit (HTTPS) and at rest (Google Cloud encryption).</li>
        <li>Each account sees only its own recordings and notes. A small number of named Notera staff can open recordings for support, safety and quality work, and every time one is opened, played or downloaded it is written to an audit log.</li>
        <li>No system is perfectly secure. If you think something is wrong, email us. If a breach affects your information we will tell you as the law requires.</li>
      </ul>

      <h2>5. Helping improve Notera (optional, off by default)</h2>
      <p>If you turn this on, Notera staff and the clinician who trains Notera may listen to and read your recordings, transcripts, notes and corrections to measure accuracy, find mistakes, and build test sets and improve Notera&apos;s own speech and note-writing quality.</p>
      <ul>
        <li>It is used inside Notera. It is not sold, and not given to other companies to train their general AI models. We do not publish identifiable content.</li>
        <li>Turn it on only if your patients&apos; consent and your local rules allow this additional use of their recordings. Using Notera does not require it.</li>
        <li>You can change your choice at any time from the account menu in the app (Privacy &amp; data). Turning it off stops any new use straight away. We remove your material from the evaluation and training sets we hold; a measurement already made from it cannot be unmade.</li>
      </ul>

      <h2>6. How long we keep it</h2>
      <ul>
        <li>Recordings, transcripts and notes are kept until you delete them from History or close your account. When you delete a consultation its audio is removed from storage (it can remain recoverable by us for up to 7 days before it is permanently gone) and its note and transcript are removed from the database.</li>
        <li>Logs that contain no patient content are kept for as long as needed for security and troubleshooting.</li>
        <li>To close your account and have your data removed, email us.</li>
      </ul>

      <h2>7. Your rights</h2>
      <p>You can ask us to give you a copy of your information, correct it, delete it, or stop using it for a purpose you agreed to. You can also withdraw any consent you gave. Email <a href={`mailto:${LEGAL_EMAIL}`} style={{ color: 'var(--brand2)' }}>{LEGAL_EMAIL}</a>; we will answer within 30 days. You may also complain to your privacy regulator, for example your national or provincial privacy commissioner, or the Office for Civil Rights of the US Department of Health and Human Services.</p>

      <h2>8. Patients</h2>
      <p>Notera is a tool used by clinicians. For the patient information in a recording, the clinician or their organisation decides why and how it is used and is responsible for telling patients and getting their consent where required. Notera acts as the clinician&apos;s service provider. A patient who has a question about their record should contact their clinician.</p>

      <h2>9. HIPAA and other health privacy laws</h2>
      <p>Notera is built with safeguards in line with HIPAA and with Canadian privacy law (PIPEDA and provincial health privacy laws): access control, encryption, audit logging and limited staff access. Whether a clinician or organisation is covered by these laws depends on where and how they practise. A Business Associate Agreement is available on our Enterprise plan; contact us to arrange one.</p>

      <h2>10. Children</h2>
      <p>Notera is for healthcare professionals. It is not for people under 18 to use as an account holder.</p>

      <h2>11. Changes</h2>
      <p>If we change this policy in a way that matters, we will update the date above and ask you to read and accept it again in the app before you continue.</p>

      <h2>12. Contact</h2>
      <p>Notera Health, <a href={`mailto:${LEGAL_EMAIL}`} style={{ color: 'var(--brand2)' }}>{LEGAL_EMAIL}</a>.</p>
    </Shell>
  )
}
