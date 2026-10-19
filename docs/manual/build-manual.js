// Builds docs/manual/Notera-Admin-Panel-Manual.docx (screenshots are synthetic mock data — no patient or user information).
const fs = require('fs'); const path = require('path');
const { Document, Packer, Paragraph, TextRun, ImageRun, HeadingLevel, AlignmentType, LevelFormat, Table, TableRow, TableCell, WidthType, ShadingType, BorderStyle, PageBreak, TableOfContents, Footer, PageNumber } = require('docx');
const IMG = path.join(__dirname, 'img');
const BLUE = '0B5FFF', GREY = '5B6470';

const run = (t, o = {}) => new TextRun({ text: t, font: 'Calibri', ...o });
// inline **bold** markup
const rich = (s, base = {}) => s.split(/(\*\*[^*]+\*\*)/).filter(Boolean).map((x) => (x.startsWith('**') ? run(x.slice(2, -2), { ...base, bold: true }) : run(x, base)));
const P = (s, o = {}) => new Paragraph({ children: rich(s), spacing: { after: 120, line: 300 }, ...o });
const H1 = (t) => new Paragraph({ heading: HeadingLevel.HEADING_1, children: [run(t)], pageBreakBefore: true });
const H1n = (t) => new Paragraph({ heading: HeadingLevel.HEADING_1, children: [run(t)] });
const H2 = (t) => new Paragraph({ heading: HeadingLevel.HEADING_2, children: [run(t)], spacing: { before: 240, after: 120 } });
const B = (s, lvl = 0) => new Paragraph({ numbering: { reference: 'bul', level: lvl }, children: rich(s), spacing: { after: 60, line: 290 } });
let stepRef = 0;
const steps = (items) => { const ref = 'num' + (++stepRef); STEPREFS.push(ref); return items.map((s) => new Paragraph({ numbering: { reference: ref, level: 0 }, children: rich(s), spacing: { after: 90, line: 300 } })); };
const STEPREFS = [];
const box = (title, lines, fill = 'EAF2FF', edge = BLUE) => new Table({ width: { size: 9360, type: WidthType.DXA }, columnWidths: [9360], rows: [new TableRow({ children: [new TableCell({ width: { size: 9360, type: WidthType.DXA }, shading: { type: ShadingType.CLEAR, fill }, margins: { top: 100, bottom: 100, left: 160, right: 160 }, borders: { top: { style: BorderStyle.SINGLE, size: 4, color: fill }, bottom: { style: BorderStyle.SINGLE, size: 4, color: fill }, right: { style: BorderStyle.SINGLE, size: 4, color: fill }, left: { style: BorderStyle.SINGLE, size: 24, color: edge } }, children: [new Paragraph({ children: [run(title, { bold: true, color: edge })], spacing: { after: 60 } }), ...lines.map((l) => new Paragraph({ children: rich(l), spacing: { after: 50, line: 280 } }))] })] })] });
const TIP = (...l) => box('Tip', l); const WARN = (...l) => box('Careful', l, 'FFF1F0', 'D92D20'); const SAFE = (...l) => box('Safe to try', l, 'ECFDF3', '12805C');
const gap = () => new Paragraph({ children: [], spacing: { after: 100 } });
function shot(name, caption) {
  const f = path.join(IMG, name + '.png'); if (!fs.existsSync(f)) throw new Error('missing screenshot ' + name);
  return [new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 120, after: 40 }, keepNext: true, children: [new ImageRun({ type: 'png', data: fs.readFileSync(f), transformation: { width: 604, height: 378 }, altText: { title: caption, description: caption, name } })] }),
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 200 }, children: [run(caption, { italics: true, color: GREY, size: 19 })] })];
}
const cell = (t, w, o = {}) => new TableCell({ width: { size: w, type: WidthType.DXA }, margins: { top: 70, bottom: 70, left: 110, right: 110 }, shading: o.head ? { type: ShadingType.CLEAR, fill: 'E8EEF9' } : undefined, children: [new Paragraph({ children: rich(t, o.head ? { bold: true } : {}), spacing: { after: 20 } })] });
const table = (cols, rows) => { const total = cols.reduce((a, b) => a + b, 0); return new Table({ width: { size: total, type: WidthType.DXA }, columnWidths: cols, rows: [new TableRow({ tableHeader: true, children: cols.map((w, i) => cell(rows[0][i], w, { head: true })) }), ...rows.slice(1).map((r) => new TableRow({ children: r.map((c, i) => cell(c, cols[i])) }))] }); };

const kids = [];
// ───────── cover ─────────
kids.push(new Paragraph({ spacing: { before: 2400, after: 200 }, children: [run('Notera Admin Panel', { size: 64, bold: true, color: BLUE })] }));
kids.push(new Paragraph({ spacing: { after: 400 }, children: [run('Manual for beginners: test the note writer, read the results, and improve the prompt', { size: 30, color: GREY })] }));
kids.push(P('Product version v2.1.0 · open **https://admin.aitoolsfordoctor.com** and sign in with your administrator account.'));
kids.push(P('Every screenshot uses **sample data only**. Red numbered circles show where to click or what to look at; the number matches the numbered step.'));
kids.push(gap());
kids.push(box('The idea in one minute', [
  '1. The panel has two halves. **Harness** is a safe test bench: it runs the note writer on sample consultations and scores the notes. Nothing you do there changes real clinicians\' notes.',
  '2. **Admin** shows and controls the live product (prompts, models, users). Changes there go live within a minute, so read the "Careful" boxes.',
  '3. The loop is: **Run → Review notes → Diagnose → Improve → Promote → Watch**. This manual walks through each step.']));
kids.push(new Paragraph({ children: [new PageBreak()] }));
kids.push(new Paragraph({ children: [run('Contents', { size: 36, bold: true })], spacing: { after: 160 } }));
kids.push(new TableOfContents('Contents', { hyperlink: true, headingStyleRange: '1-2' }));

// ───────── 1 ─────────
kids.push(H1('1. Before you start'));
kids.push(H2('Sign in and find your way around'));
kids.push(...steps(['Open **https://admin.aitoolsfordoctor.com** and sign in with your administrator email and password. Non-administrator accounts are refused.', 'The left menu is always visible and scrolls if your screen is small. Click **Start here** (1) any time you are unsure what to do next: it highlights the next step for you (2).']));
kids.push(...shot('01-start-here', 'Start here shows the next recommended step in blue.'));
kids.push(table([2400, 6960], [['Menu group', 'What it is for'], ['**Admin · Monitor**', 'Overview, Users, Notes, Audio, Activity: what real users are doing.'], ['**Admin · Control production**', 'System (live health), Prompts, Settings. **Changes go live.**'], ['**Harness · Test and improve**', 'The numbered test bench: 1 Run & inputs, 2 Review notes, 3 Compare runs / Blind judge, 4 Diagnose, 5 Improve, Trends. **Safe.**'], ['**Tools**', 'Pipeline log and Test bench (upload an audio file through the real speech-to-text pipeline).']]));
kids.push(gap());
kids.push(SAFE('Everything under **Harness** runs in a separate test service. You can run, repeat and delete experiments as often as you like without touching production.'));

// ───────── 2 predefined audio ─────────
kids.push(H1('2. First test: a predefined audio recording'));
kids.push(P('The panel includes real simulated doctor–patient consultations (mp3) so you can try the whole system without recording anything. You can **listen**, **download**, and **use the transcript** as the test input.'));
kids.push(...steps(['In the menu click **1 · Run & inputs**.', 'At the top click the **Predefined audio** tab (1 in the first picture below).']));
kids.push(...shot('02-run-inputs', 'Run & inputs: choose what to test (1), the writer model (2) and start (3).'));
kids.push(...steps(['In the list, press the **play** button (1) to listen in your browser. Each recording is about 9–13 minutes.', 'To keep a copy, press **Download mp3** (2). The file saves to your Downloads folder.', 'To test the note writer on what was said, press **Use transcript** (3).']));
kids.push(...shot('03-predefined-audio', 'Predefined audio: listen (1), download (2), use the transcript (3).'));
kids.push(TIP('The recordings are for testing the **note writer** (the transcript goes straight in). To test **speech-to-text too**, download an mp3, open **Tools → Test bench** in the menu, and upload that file there.'));
kids.push(H2('Run it once'));
kids.push(...steps(['After **Use transcript** the screen switches to **Paste a transcript** with the text already filled in (1).', 'Leave the **Writer model** as it is (2). It is already set to what production uses.', 'Press **Run on this transcript** (3). It takes about 10 seconds.']));
kids.push(...shot('04-use-transcript', 'The transcript is loaded. Press Run on this transcript.'));
kids.push(...steps(['The generated note appears below the button (1). The grey strip shows how long it took and which prompt was used. Open **Pipeline log** to see what each stage did.']));
kids.push(...shot('05-own-result', 'The note written from the transcript.'));
kids.push(box('What you just did', ['One recording → transcript → SOAP note. That is the "run once" test. Because these recordings have no clinician note to compare with, the score columns stay empty; the next section shows how to get scores by testing against the **predefined gold notes**.']));

// ───────── 3 gold ─────────
kids.push(H1('3. Second test: predefined gold notes, then audit'));
kids.push(P('A **gold note** is a note a clinician wrote for a real (de-identified) consultation. The panel holds about 2,700 of them with their transcripts. When you run the writer on a gold transcript, the system scores your note against the clinician\'s.'));
kids.push(...steps(['Open **1 · Run & inputs** and keep the **Gold notes** tab.', 'Click **Pick & search** (1). Type a word in the search box (2), for example "diabetes".', 'Tick **one** note (3 is the checkbox). The green pill on the right says "1 note selected".', 'Press **Start run · 1 note** (the blue button at the bottom).']));
kids.push(...shot('06-gold-pick', 'Pick & search: type to find a note (1), tick it (2), then start (3).'));
kids.push(P('The run appears in the **Runs** table (1) as a blue "running 6/10" badge. When it turns green **done**, press **Review notes** (2).'));
kids.push(...shot('07-run-status', 'The Runs table: status (1) and the Review notes button (2).'));
kids.push(H2('Read the result: Review notes'));
kids.push(...steps(['The left list (1) shows every note in the run. Red dots need attention, green dots look good. The worst notes are listed first.', 'The middle pane (2) is the note the system wrote. The right pane (3) is the clinician\'s gold note. Read them side by side.']));
kids.push(...shot('08-review-notes', 'Generated note (2) next to the clinician\'s gold note (3).'));
kids.push(H2('Audit one note'));
kids.push(P('An **audit** asks a stronger AI to compare one note with the transcript and the gold note and list the mistakes.'));
kids.push(...steps(['Click the **What it lacks / got wrong** tab (1).', 'If it says nobody has audited this note, press **Audit this note** and wait about 20 seconds.', 'Read the orange box (2): facts the note is missing. Read the red box (3): wrong or unsupported statements. "Critical" items matter most.']));
kids.push(...shot('09-audit', 'The audit lists what the note lacks (2) and what it got wrong (3).'));
kids.push(H2('See how the note was built'));
kids.push(P('Click **Pipeline log** (1). The strip (2) shows the four stages (Writer → Checklist → Merge & cleanup → Verifier), which model and prompt version were used, and what each stage added or removed.'));
kids.push(...shot('10-pipeline-log', 'Pipeline log: what each stage did for this note.'));

// ───────── 4 multi ─────────
kids.push(H1('4. Many notes at once, one overall report'));
kids.push(P('One note tells you little. To find patterns you test many notes and let the system write **one report** that combines all the audits.'));
kids.push(H2('Step A: run 20 notes'));
kids.push(...steps(['In **1 · Run & inputs** keep **Gold notes → Random** and type **20** in "How many random notes" (1).', 'Keep the writer model (2). Give the run a name such as "baseline Monday" (3).', 'Press **Start run · 20 notes** (4). It takes 2–3 minutes. The run shows progress; press **Stop** if you change your mind.']));
kids.push(...shot('11-multi-run', 'A 20-note run: how many (1), model (2), name (3), start (4).'));
kids.push(H2('Step B: audit and diagnose the whole run'));
kids.push(...steps(['Click **4 · Diagnose**. Choose the run (1) and how many notes to audit (about 15 is a good start).', 'Press **Generate overall diagnosis** (2). The system audits the worst notes one by one, adds the pipeline logs, and writes a single report. This takes 2–6 minutes.', 'Read the headline and the **Recurring patterns** table (3): what keeps going wrong, in which stage, in how many notes.', 'Read **Recommended changes** (4). Mark each as **Accepted**, **Done** or **Dismissed** so you can track it. **Export .md** saves the report as a file.']));
kids.push(...shot('12-diagnose', 'The overall report: patterns (3) and recommended changes (4).'));
kids.push(TIP('You can read the individual audits later in **2 · Review notes**. The Diagnose report is the "many audits in one report" view.'));

// ───────── 5 improve ─────────
kids.push(H1('5. Improve the prompt from the report'));
kids.push(P('The report tells you what to fix. **5 · Improve** lets the system draft a better writer prompt from the failures, prove it on notes it has never seen, and only then make it live.'));
kids.push(...steps(['Click **5 · Improve**. Choose the run to learn from (1). Press **Analyse failures & propose a prompt** (2). Wait 1–2 minutes.', 'A new row appears under **Candidates** (3). Click it.']));
kids.push(...shot('13-improve', 'Pick the run (1), press Analyse (2), open the candidate (3).'));
kids.push(...steps(['Read **What it found** and **What it changed**. The green/red lines show the exact text it added or removed.', 'Press **Run validation on 40 unseen notes** (1). It tests the current prompt and the candidate on the same notes, then a blind judge compares them. This takes 8–10 minutes.', 'Look at the **Gate** (2): a checklist computed on the server. Every line should be a green tick.', 'Only when the gate says "All checks passed", press **Promote to production** (3). If it did not pass, leave it.']));
kids.push(...shot('14-candidate', 'Validate (1), check the gate (2), promote only if it passed (3).'));
kids.push(WARN('**Promote to production** changes what every real clinician\'s note uses, within about a minute. You can undo it any time under **Prompts → History → Roll back**.'));

// ───────── 6 compare ─────────
kids.push(H1('6. Compare two versions'));
kids.push(P('To check whether a change really helped, run the **same notes** twice (use **Re-run** on a finished run, then change the model or prompt) and compare.'));
kids.push(...steps(['Click **3 · Compare runs**. Pick run A, the baseline (1), and run B, the challenger (2).', 'Read the statistics table (3): the average change, how many notes got better or worse, and a verdict (better / worse / no clear change).', 'For a second opinion click **3 · Blind judge** and press **Run blind judge**. It reads both notes without knowing which version wrote them and counts what each lacks or invents.']));
kids.push(...shot('18-compare', 'Compare two runs on the same notes.'));
kids.push(TIP('Small differences (under about 3 points) are noise. A change is only real if it holds on 100 notes or more.'));

// ───────── 7 prompts & settings ─────────
kids.push(H1('7. Prompts and Settings (these go live)'));
kids.push(H2('Prompts'));
kids.push(...steps(['Click **Prompts**. Choose a prompt on the left (1): the note writer, fact checklist, verifier or editor.', 'Edit the text in the big box (2). Press **Review changes** to see exactly what differs from the live version.', 'Type a short note saying what and why, then press **Save as new version & go live** (3). The server refuses edits that remove parts the pipeline depends on.', 'To undo, open the **History** tab (4) and press **Roll back to this** on an older version.']));
kids.push(...shot('15-prompts', 'Edit (2), save as a new version (3), roll back from History (4).'));
kids.push(H2('Settings'));
kids.push(...steps(['Click **Settings**. Each row shows the current value, the default and who changed it last.', 'Change the value (1) and press **Save** (2). A pop-up asks why; your answer is kept in the change history.', 'Press **Reset** (3) to return a setting to its default. Changes take effect within about 30 seconds.']));
kids.push(...shot('16-settings', 'Settings: change (1), Save (2), Reset (3).'));
kids.push(WARN('Settings such as **Writer model** change the cost and speed of every real note. Change one thing at a time and check **System** the next day.'));

// ───────── 8 system & trends ─────────
kids.push(H1('8. System health and Trends'));
kids.push(H2('System'));
kids.push(P('**System** shows how the live product is doing: notes generated, failure rate, speed, cost (1), every stage of the pipeline with the model and prompt it uses (2), and links to edit them (3). Check it after any change.'));
kids.push(...shot('17-system', 'System: live health (1), pipeline stages (2), edit links (3).'));
kids.push(H2('Trends and what the numbers mean'));
kids.push(P('**Trends** charts every run over time. **Hover any metric name** to see its range, whether higher or lower is better, and its exact formula (the popup in the picture).'));
kids.push(...shot('19-trends', 'Trends: formulas explained (1) and hover help (2).'));
kids.push(table([2100, 2200, 5060], [['Metric', 'Scale', 'What it is'], ['**Parity score**', '0–100, higher', 'An AI rates how close the note is to the clinician\'s note. This is the "90+" score from the original Testing Lab.'], ['**Notes at 90+**', '% of notes', 'Share of notes with parity 90 or more: shows consistency.'], ['**Audit score**', '0–100, higher', 'Strict AI audit against the transcript only. Clinicians\' own notes score about 73.'], ['**Critical wrong claims per note**', 'lower, target < 0.10', 'Invented or contradicted drug, dose, negation or diagnosis.'], ['**Similarity to gold**', '0–1, higher', 'Word overlap with the clinician\'s note: Jaccard |note ∩ gold| ÷ |note ∪ gold|. 0.35 is normal.'], ['**Omission rate**', '0–1, lower', 'Share of the gold note\'s distinct words missing from the note.'], ['**Story / flow**', '0–1, higher', '0.7 × good-line share + 0.3 × min(1, words per line ÷ 6). A formatting check only.'], ['**Latency p50 / p95**', 'seconds, lower', 'Median time per note / time 95% of notes beat.']]));
kids.push(gap());
kids.push(P('Rule of thumb: trust **Parity** and **Audit** for quality. Similarity, omission and flow are quick word counts that help you spot changes but are not accuracy.'));

// ───────── 9 admin ─────────
kids.push(H1('9. The Admin monitor screens'));
kids.push(H2('Overview'));
kids.push(P('Live numbers from the real product: users, sign-ups, notes, recordings stored, note runs and cost, and free users who reached their limit (1).'));
kids.push(...shot('20-overview', 'Overview.'));
kids.push(H2('Users'));
kids.push(P('Everyone who signed up, their plan (free or full), how many free notes they used, and when they last logged in. Click a person to see their notes and change their plan.'));
kids.push(...shot('21-users', 'Users.'));
kids.push(H2('Notes and Audio'));
kids.push(P('**Notes** lists every generated note across all users. Click one to open it: the note, the transcript, the pipeline trace ("Produced with": which model and prompt version wrote it), and the raw data. **Audio** lists the recordings that were stored; open a note and press **Load recording** to listen. Opening a note or playing audio is written to an audit log.'));
kids.push(...shot('22-notes', 'Notes (Audio looks the same, filtered to recordings).'));
kids.push(WARN('Notes and recordings can contain patient information. Do not share screenshots of them, and only open what you need.'));

// ───────── 10 faq ─────────
kids.push(H1('10. Cheat sheet and troubleshooting'));
kids.push(H2('The routine'));
kids.push(...steps(['**Run & inputs**: run 20+ notes with the current settings.', '**Review notes**: open the red ones, audit a few.', '**Diagnose**: one report for the whole run; accept the recommendations you agree with.', '**Improve**: draft a candidate prompt, validate on 40 unseen notes, check the gate.', '**Promote** only if the gate passed; otherwise change one setting or prompt line yourself in **Prompts** / **Settings**.', '**Re-run** the same notes and **Compare**. Watch **System** and **Trends** the next day.']));
kids.push(H2('Common questions'));
kids.push(table([3200, 6160], [['Problem', 'What to do'], ['"The lab is not reachable"', 'Refresh. If it persists, the test service is restarting; wait a minute. Your session must be an administrator.'], ['A run stays at "running"', 'Press **Stop**, then start again with fewer notes. Runs interrupted by a restart show "interrupted".'], ['The audio will not play', 'Press play once and wait a few seconds (files are large). Use **Download mp3** and play it locally.'], ['Audit says "not audited yet"', 'Press **Audit this note** (about 20 s). Diagnose audits many notes for you.'], ['Gate shows a red cross', 'Do not promote. Read which check failed; run validation again or improve further.'], ['I changed something and want it back', 'Prompts → History → **Roll back**; Settings → **Reset**. Both are instant and logged.'], ['Scores jump around between runs', 'Normal: single notes vary 15–25 points. Compare on 100 notes before drawing conclusions.']]));
kids.push(gap());
kids.push(P('Technical detail (formulas, experiments and history) lives in the repository under **docs/**: ADMIN_CONSOLE.md, ADMIN_UI_STRUCTURE.md and the reports folder. Release: https://github.com/SA-Medicine/Notera-Health-Ai/releases/tag/v2.1.0'));

const nums = STEPREFS.map((ref) => ({ reference: ref, levels: [{ level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 540, hanging: 360 } }, run: { bold: true, color: BLUE } } }] }));
const doc = new Document({
  creator: 'Notera', title: 'Notera Admin Panel Manual',
  styles: { default: { document: { run: { font: 'Calibri', size: 22 } } }, paragraphStyles: [
    { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: 36, bold: true, font: 'Calibri', color: BLUE }, paragraph: { spacing: { before: 240, after: 200 }, outlineLevel: 0 } },
    { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: 27, bold: true, font: 'Calibri', color: '1F2937' }, paragraph: { spacing: { before: 240, after: 120 }, outlineLevel: 1 } }] },
  numbering: { config: [{ reference: 'bul', levels: [{ level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 540, hanging: 270 } } } }, { level: 1, format: LevelFormat.BULLET, text: '–', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 1000, hanging: 270 } } } }] }, ...nums] },
  sections: [{ properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 1200, right: 1440, bottom: 1200, left: 1440 } } }, footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [run('Notera Admin Panel Manual · page ', { color: GREY, size: 18 }), new TextRun({ children: [PageNumber.CURRENT], color: GREY, size: 18, font: 'Calibri' })] })] }) }, children: kids }],
});
Packer.toBuffer(doc).then((b) => { const out = path.join(__dirname, 'Notera-Admin-Panel-Manual.docx'); fs.writeFileSync(out, b); console.log('written', out, (b.length / 1e6).toFixed(1) + ' MB'); });
