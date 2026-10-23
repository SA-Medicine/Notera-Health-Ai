import type { Metadata } from 'next'
import Shell from '../Shell'
import { SITE_URL, LEGAL_EMAIL, TERMS_UPDATED } from '../../lib/legal'

export const metadata: Metadata = {
  title: 'Terms of Service — Notera',
  description: 'The terms for using Notera, the AI medical scribe: who may use it, the clinician’s responsibility to review and sign every note, patient consent, and your content.',
  alternates: { canonical: '/terms' },
  openGraph: { title: 'Notera Terms of Service', description: 'Terms for using Notera, an AI documentation aid for clinicians.', url: `${SITE_URL}/terms`, images: ['/og.png'] },
}

export default function TermsPage() {
  return (
    <Shell>
      <span className="mkt-eyebrow">Legal</span>
      <h1>Terms of Service</h1>
      <p className="lede">Last updated {TERMS_UPDATED}. By creating an account or using Notera you agree to these terms and to the <a href="/privacy" style={{ color: 'var(--brand2)' }}>Privacy Policy</a>. If you use Notera for an organisation, you confirm you may accept them for it.</p>

      <h2>1. Who may use Notera</h2>
      <p>Notera is for licensed healthcare professionals, and for people working under their supervision, who are 18 or older. You must give true account details, keep your sign-in private, and tell us if you think someone else has used your account.</p>

      <h2>2. What Notera is, and what it is not</h2>
      <ul>
        <li>Notera is a <strong>documentation aid</strong>. It drafts a clinical note from a consultation. It is <strong>not a medical device</strong> and gives no medical advice, diagnosis or treatment.</li>
        <li>A draft can be wrong or incomplete: a misheard word or drug name, a missing instruction, a fact put under the wrong problem. <strong>A qualified clinician must read, correct and sign every note</strong> before it is used for care or put in a record. You are responsible for the final note.</li>
        <li>Do not use Notera in an emergency or to make a clinical decision on its own.</li>
      </ul>

      <h2>3. Patient consent and lawful recording</h2>
      <p>You are responsible for telling patients that the visit is recorded and processed by an AI service, and for getting their consent wherever the law, your regulator or your organisation requires it. Do not record anyone without that basis. Notera reminds you but cannot check this for you.</p>

      <h2>4. Your content</h2>
      <ul>
        <li>You keep ownership of your recordings, transcripts and notes (&ldquo;your content&rdquo;).</li>
        <li>You give Notera a limited licence to process your content only to run the service for you: transcribe, draft, store, show it back to you, keep it secure and give support.</li>
        <li>If, and only if, you turn on <em>Help improve Notera</em>, you also allow the further use described in section 5 of the Privacy Policy. You can turn it off at any time.</li>
        <li>You confirm you have the right to upload your content and that you have the consents described in section 3.</li>
      </ul>

      <h2>5. Acceptable use</h2>
      <p>Do not use Notera to break the law, to record people unlawfully, to upload content you have no right to, to share your account, to attack, overload or reverse-engineer the service, or to copy its output into a competing product. We may limit or suspend use that risks patients, other users or the service.</p>

      <h2>6. Plans and payment</h2>
      <p>The free plan includes a limited number of notes (currently 5). Paid plans and enterprise terms are described on the pricing page or agreed with you. We may change plans and prices with notice; a change does not apply to a period you have already paid for.</p>

      <h2>7. Availability and your records</h2>
      <p>We work to keep Notera available but it may be interrupted. Copy each note you sign into your own record system; Notera is not your official medical record. You can delete your consultations at any time, and export them before you close your account.</p>

      <h2>8. Disclaimers and limits</h2>
      <p>To the extent the law allows, Notera is provided &ldquo;as is&rdquo; without warranties of accuracy, fitness for a particular purpose or uninterrupted service, and Notera is not liable for clinical decisions or for notes that were not reviewed. To the extent the law allows, our total liability to you for any claim is limited to the greater of the fees you paid in the 12 months before the claim and US$100, and we are not liable for indirect or consequential loss. Nothing in these terms limits a liability that cannot be limited by law, or your rights under consumer or privacy law.</p>

      <h2>9. Ending your use</h2>
      <p>You can stop using Notera and ask us to close your account at any time. We may suspend or close an account that breaks these terms. Sections that by their nature should continue (ownership, disclaimers, limits) continue after that.</p>

      <h2>10. Changes</h2>
      <p>If we change these terms in a way that matters, we will update the date above and ask you to accept them again in the app before you continue.</p>

      <h2>11. Contact</h2>
      <p>Notera Health, <a href={`mailto:${LEGAL_EMAIL}`} style={{ color: 'var(--brand2)' }}>{LEGAL_EMAIL}</a>.</p>
    </Shell>
  )
}
