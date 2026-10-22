// Builds the CANDIDATE writer prompt "v5" from the locked writer-v4 text plus the doctor's interview profile (Studio, confirmed profile v1)
// and the gold-format principles. It writes a file under lab/candidates only; prompts/writer-v4.txt (locked) is read, never changed.
// Usage: node lab/candidates/buildV5Candidate.mjs   -> lab/candidates/writer-v5-candidate.txt
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
let t = fs.readFileSync(path.join(HERE, '..', '..', 'prompts', 'writer-v4.txt'), 'utf8').replace(/\r\n/g, '\n');
const swap = (from, to) => { if (t.split(from).length !== 2) throw new Error('anchor not found exactly once: ' + from.slice(0, 60)); t = t.replace(from, to); };

// 1. problems in the order they were discussed (profile: "ordered as they were discussed in the visit")
swap('ONE entry per problem the clinician addressed, most important first:', 'ONE entry per problem the clinician addressed, in the order they were discussed in the visit:');
// 2. allergies on their own line (profile: "Allergies and their reactions on a separate 'Allergies:' line")
swap('and "Preventive care: …" for screening/vaccines said to be done or up to date.', 'and "Preventive care: …" for screening/vaccines said to be done or up to date, and a separate line "Allergies: allergen - reaction" when allergies are stated.');
// 3. recent events and what was tried (profile: "recent hospital/ER visits, recent tests, medication adherence issues, what the patient has already tried")
swap('also lifestyle the patient reports (diet, exercise, work) as "Diet: …", "Exercise: …".', 'also lifestyle the patient reports (diet, exercise, work) as "Diet: …", "Exercise: …"; recent ER or hospital visits, recent tests, what the patient has already tried and medication adherence problems.');
// 4. imaging wording (profile: "include the full wording from imaging reports")
swap('One line per different test or imaging study', 'For imaging keep the report\'s own wording of the findings and impression. One line per different test or imaging study');
// 5. assessment = status line for every problem (profile: "one short assessment line with the status for every problem")
swap('assessment: the clinician\'s interpretation only if stated; otherwise "".', 'assessment: the clinician\'s interpretation or, when none was given, the problem\'s status exactly as the transcript shows it ("Stable on candesartan", "Improved", "New, 2 weeks"); never your own interpretation and never a diagnosis.');
swap('Leave it empty when the clinician stated no conclusion.', 'When no conclusion was stated give a short status line only if the transcript shows how the problem is going (stable, improved, worse, new); otherwise leave it empty.');
// 6. plan items: drug detail, advice, safety-netting, refusals and follow-up each their own item (profile + gold F4)
swap('treatment_planned: medication decisions (continue/start/stop/change with dose), advice, monitoring, and follow-up timing (e.g., "Rtc: 3 months"). Separate items with "; ".',
  'treatment_planned: medication decisions (continue/start/stop/change with drug, dose, route, frequency, duration, quantity and refills when stated, and what it is for), then each piece of advice or monitoring as its own item starting "Advised …" (return precautions as "Return if …", patient refusals as "Declined …"), then the follow-up as the LAST item ("Rtc: <timeframe>" or "Follow-up: <timeframe> with <tests>"). Each label appears once per problem: join the items with "; ".');
// 7. referral detail (profile: "specialist's name, service and reason")
swap('referrals: referral target and service ("Foot surgeon").', 'referrals: referral target, service and reason, with the specialist\'s name when stated ("Foot surgeon for bunion assessment").');
// 7b. a declined referral is a plan decision, not a referral made (profile: patient refusals in the plan under the problem)
swap('Name referrals and who they are to, including offered or declined ones.', 'Name referrals made or recommended and who they are to; a declined or deferred referral goes in treatment_planned as "Declined <referral> - <reason>", not in referrals.');
// 8. language (profile: Canadian spelling, metric units, numerals)
swap('Clinical third-person wording,', 'Canadian spelling (colour, centre, counselling, anemia), metric units, numerals for all numbers. Clinical third-person wording,');

fs.writeFileSync(path.join(HERE, 'writer-v5-candidate.txt'), t);
console.log('candidate written:', t.length, 'chars (v4 is', fs.readFileSync(path.join(HERE, '..', '..', 'prompts', 'writer-v4.txt'), 'utf8').length, ')');
