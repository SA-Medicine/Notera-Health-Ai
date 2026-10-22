'use client';

// The "read before you sign" strip above a generated note: a draft banner plus the things the pipeline wants the clinician to check.
// It sits OUTSIDE the editable note body, so nothing here is copied to the EMR or saved into the note text.
// Flag sources (backend, Style Spec v2): grounding agent (lines the recording does not clearly support), side check, lines removed because the
// recording did not support them, plus the older guardrail flags.

export type NoteFlag = { type: string; field?: string; message: string; severity?: string };

type Group = { key: string; title: string; hint: string; tone: 'warn' | 'quiet' | 'info'; items: NoteFlag[] };

const KNOWN: Record<string, { title: string; hint: string; tone: 'warn' | 'quiet' }> = {
  check_against_recording: { title: 'Check against the recording', hint: 'The recording may not support these lines. Confirm or edit them.', tone: 'warn' },
  laterality_check: { title: 'Check the side', hint: 'Left or right differs from what the recording names.', tone: 'warn' },
  condition_not_said: { title: 'Check the problem name', hint: 'The recording does not name this condition.', tone: 'warn' },
  non_patient_context: { title: 'Check who it is about', hint: 'The recording has someone else speaking about themselves. Make sure nothing about them is in the note.', tone: 'warn' },
  dropped_declined_option: { title: 'Declined option not recorded', hint: 'Something was offered and declined or put off. Add it to the plan if it matters.', tone: 'warn' },
  ungrounded_date: { title: 'Date removed', hint: 'A date the recording does not give was taken out. Add the right one if you need it.', tone: 'warn' },
  laterality_inversion: { title: 'Check the side', hint: 'Left or right may be the wrong way round.', tone: 'warn' },
  drug_indication_unclear: { title: 'Check the drug', hint: 'The reason for this drug is not clear from the recording.', tone: 'warn' },
  removed_unsupported: { title: 'Removed from the note', hint: 'Taken out because the recording did not support them. Add back if you did say it.', tone: 'quiet' },
};

function groupFlags(flags: NoteFlag[]): Group[] {
  const map = new Map<string, Group>();
  for (const f of flags) {
    if (!f || !f.message) continue;
    const k = KNOWN[f.type];
    const key = k ? k.title : `${f.type}:${f.severity || 'info'}`;   // two flag types with the same title (the two side checks) share one group
    if (!map.has(key)) {
      const sev = String(f.severity || 'info');
      map.set(key, k
        ? { key, ...k, items: [] }
        : { key, title: f.type.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()), hint: '', tone: sev === 'critical' || sev === 'warning' ? 'warn' : 'info', items: [] });
    }
    map.get(key)!.items.push(f);
  }
  const order = { warn: 0, info: 1, quiet: 2 } as const;
  return [...map.values()].sort((a, b) => order[a.tone] - order[b.tone]);
}

const Icon = {
  shield: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="15" height="15" aria-hidden="true"><path d="M12 3l8 3v6c0 4.5-3.2 8-8 9-4.8-1-8-4.5-8-9V6l8-3z" /><path d="M9 12l2 2 4-4" /></svg>,
  chevron: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12" aria-hidden="true"><polyline points="6 9 12 15 18 9" /></svg>,
};

export default function NoteChecks({ flags }: { flags: NoteFlag[] }) {
  const groups = groupFlags(flags || []);
  const toCheck = groups.filter((g) => g.tone === 'warn').reduce((n, g) => n + g.items.length, 0);
  const roomy = toCheck <= 4;   // few things to check: show them open; many: one tidy row per group, click to open
  return (
    <div className="note-checks" aria-label="Before you sign">
      <div className={`draft-bar${toCheck ? ' has-checks' : ''}`} role="note">
        <span className="draft-bar-ico">{Icon.shield}</span>
        <span className="draft-bar-text"><strong>Draft.</strong> Read every line before you sign. Check drug names, doses, side and results.</span>
        {toCheck > 0 && <span className="draft-bar-count" aria-label={`${toCheck} to check`}>{toCheck} to check</span>}
      </div>
      {groups.length > 0 && (
        <div className="checks-list">
          {groups.map((g) => (
            <details key={g.key} className={`checks-group tone-${g.tone}`} open={roomy && g.tone !== 'quiet'}>
              <summary title={g.hint || undefined}>
                <span className="checks-title">{g.title}</span>
                <span className="checks-n">{g.items.length}</span>
                <span className="checks-chev">{Icon.chevron}</span>
              </summary>
              <ul>
                {g.items.map((f, i) => <li key={i}>{f.message}</li>)}
              </ul>
            </details>
          ))}
        </div>
      )}
    </div>
  );
}
