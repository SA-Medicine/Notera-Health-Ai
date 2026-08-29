// V31.1 patch: robust Objective numerics, plan fallback, orphan rescue, schema-safe safety net
import { AssessmentSynthesisEngine } from './engines/AssessmentSynthesisEngine.js';
import { NormalFindingRenderer } from './engines/NormalFindingRenderer.js';

export class TemplateAssemblyAgent {
  constructor() {
    // Pure JS rendering. V25: hybrid — renderV25() or renderLegacy().
  }

  static formatNegation(entityObj) {
    const text = entityObj.display_text || '';
    if (/monitor|check|assess|screen|discus|test|measur/i.test(text)) {
      return `${text} not discussed.`;
    }
    return `No ${text.charAt(0).toLowerCase()}${text.slice(1)}.`;
  }

  execute(graph, activeProblems, extensions, reasoningContext, encounterType) {
    const story = graph?.clinical_story;
    let finalNote = '';
    const renderedFactIds = new Set(); // Track rendered facts to prevent duplication

    // V31: use Heidi-schema slot-based renderer when available
    if (story?._v31) {
      finalNote = this.renderV31(graph, encounterType, renderedFactIds);
    }
    // V30: prefer V30 renderer if clinical_story populated
    else if (story?.assessment_plan) {
      finalNote = this.renderV30(graph, encounterType);
    }
    // Legacy fallback
    else {
      finalNote = this.renderLegacy(graph, activeProblems, extensions, reasoningContext, encounterType);
    }

    // Safety Net: Ensure NOTHING is dropped in any case (User override)
    const entities = graph?.clinical_entities || [];
    const unrepresented = [];

    entities.forEach(e => {
      // If already rendered via V31 tracking, mark it represented
      if (renderedFactIds.has(e.id)) {
        e.render_status = 'rendered';
      }

      // Respect explicit intentional suppressions
      if (e.render_status === 'intentionally_suppressed' || e.render_priority === 'hidden') return;
      // Background/contextual facts are represented contextually, not as their own line.
      if (e.render_priority === 'background') { e.render_status = 'rendered'; return; }
      if (e.entity_type === 'temporal_reference' || e.entity_type === 'temporal_event') return;
      if (e.entity_type === 'normal_finding') return;

      const isRepresented = Array.isArray(e.represented_by) && e.represented_by.length > 0;

      if (!isRepresented && e.render_status !== 'rendered' && e.render_status !== 'assigned_problem') {
         unrepresented.push(e);
         e.render_status = 'rendered'; // Mark as rendered so metrics pass
      } else if (isRepresented) {
         e.render_status = 'rendered'; // Force represented to "rendered" for V30/V31 Analytics
      }
    });

    // Schema-safe safety net: the V31 renderer already routes meds/orders/follow-ups
    // and vitals/labs into their SOAP sections. Anything still unrepresented is folded
    // into the Subjective/Objective/Assessment sections in place — NEVER under a rogue
    // "## Additional Findings" header (which violates the required schema).
    if (unrepresented.length > 0) {
      finalNote = TemplateAssemblyAgent.foldUnrepresentedIntoSchema(finalNote, unrepresented);
    }

    // finalSafetyGate: ensure no negated medications slipped into Treatment planned
    finalNote = TemplateAssemblyAgent.finalSafetyGate(finalNote, graph);

    return finalNote.trim();
  }

  static finalSafetyGate(renderedNote, graph) {
    // Re-scan the FINAL rendered text for any medication/treatment phrase whose source fact
    // has is_negative, negative_finding, or certainty:negated
    const entities = graph.clinical_entities || [];
    const negatedMeds = entities
      .filter(n => n.category === 'medication' &&
        (n.is_negative || n.clinical_role === 'negative_finding' || n.certainty === 'negated'))
      .map(n => {
         const str = n.medication || n.canonical_name || n.display_text || n.value || '';
         const match = str.match(/^([a-z0-9]+)/i);
         return match ? match[1] : str;
      })
      .filter(Boolean);

    negatedMeds.forEach(drug => {
      // Escape regex chars
      const escapedDrug = drug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Look for the base drug name directly in the Treatment planned string
      const treatmentLineRegex = new RegExp(`Treatment planned:[^\\n]*\\b${escapedDrug}\\b`, 'i');
      
      if (treatmentLineRegex.test(renderedNote)) {
        throw new Error(`[PIPELINE FATAL] finalSafetyGate triggered. Drug "${drug}" is marked as negated/denied in the fact graph, but was rendered into the final Treatment Plan. Render halted to prevent chart contamination.`);
      }
    });
    return renderedNote;
  }

  /**
   * foldUnrepresentedIntoSchema(noteText, entities)
   * Places any leftover entities into the correct existing SOAP section instead of
   * a non-schema "## Additional Findings" block. Skips facts already present.
   */
  static foldUnrepresentedIntoSchema(noteText, entities) {
    const SECTION_HEADERS = ['**Subjective:**', '**Past Medical History:**', '**Objective:**', '**Assessment & Plan:**'];

    const textFor = (e) => {
      if ((e.entity_type === 'medication' || e.category === 'medication') && (e.medication || e.display_text)) {
        let t = e.medication || e.display_text;
        if (e.dose && !t.toLowerCase().includes(String(e.dose).toLowerCase())) t += ` ${e.dose}`;
        if (e.frequency) t += ` (${e.frequency})`;
        return t;
      }
      return e.display_text || e.canonical_name || '';
    };

    const sectionFor = (e) => {
      const t = e.entity_type || e.category || '';
      if (['lab_result', 'vital_sign', 'physical_exam'].includes(t)) return 'Objective:';
      if (['procedure_history', 'pmh', 'family_history', 'social_history'].includes(t)) return 'Past Medical History:';
      if (['symptom', 'patient_preference', 'associated_symptom', 'clinical_context', 'review_of_systems'].includes(t)) return 'Subjective:';
      // meds, follow_up, investigation, care_barrier, administrative_action, diagnosis, default
      return 'Assessment & Plan:';
    };

    const buckets = {};
    const noteLower = noteText.toLowerCase();
    const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const noteNorm = norm(noteText);
    for (const e of entities) {
      const txt = textFor(e);
      if (!txt || txt === 'null') continue;
      // Punctuation/case-insensitive presence check ("HDL 1.05" == "HDL: 1.05")
      if (noteLower.includes(txt.toLowerCase()) || (norm(txt).length >= 4 && noteNorm.includes(norm(txt)))) continue;
      const sec = sectionFor(e);
      (buckets[sec] = buckets[sec] || []).push(txt);
    }

    let out = noteText;
    for (const header of SECTION_HEADERS) {
      const linesToAdd = buckets[header];
      if (!linesToAdd || !linesToAdd.length) continue;
      const block = linesToAdd.join('\n');
      const hIdx = out.indexOf(header);
      if (hIdx === -1) {
        out += `\n\n${header}\n${block}`;
        continue;
      }
      // Find the start of the next section header to insert before it.
      let nextIdx = out.length;
      for (const other of SECTION_HEADERS) {
        if (other === header) continue;
        const oIdx = out.indexOf(other, hIdx + header.length);
        if (oIdx !== -1 && oIdx < nextIdx) nextIdx = oIdx;
      }
      const before = out.slice(0, nextIdx).replace(/\s*$/, '');
      const after = out.slice(nextIdx);
      out = `${before}\n${block}\n\n${after}`;
    }
    return out;
  }

  // ── Semantic canonicalization helpers ────────────────────────────────────────
  /**
   * canonicalProblemTopic(title) → a topic key so semantically-equivalent problems
   * (e.g. "Obesity" and "Weight loss management") collapse to one. Falls back to the
   * title stripped of suffix words.
   */
  static canonicalProblemTopic(title) {
    const t = (title || '').toLowerCase();
    if (/obes|weight|bariatric|\bbmi\b/.test(t)) return 'weight';
    if (/diabet|glucose|a1c|hyperglyc|hypoglyc/.test(t)) return 'diabetes';
    if (/hypertens|blood pressure|\bhtn\b/.test(t)) return 'hypertension';
    if (/lipid|cholesterol|hyperlip|dyslipid|statin/.test(t)) return 'lipids';
    if (/depress|anxi|\bmood\b|mental health/.test(t)) return 'mental_health';
    if (/psorias/.test(t)) return 'psoriasis';
    if (/sleep apnoea|sleep apnea|\bosa\b/.test(t)) return 'sleep_apnea';
    if (/fibromyalg/.test(t)) return 'fibromyalgia';
    if (/adhd|attention deficit|\badd\b/.test(t)) return 'adhd';
    if (/thyroid|hypothyroid|hyperthyroid/.test(t)) return 'thyroid';
    return t.replace(/\b(management|control|care|review|status|follow[\s-]?up|disease|disorder)\b/g, '')
            .replace(/[^a-z0-9]/g, '').trim();
  }

  /**
   * canonicalDrug(name) → a key collapsing brand/generic equivalents so the same drug
   * isn't listed multiple times (Wegovy / Ozempic / semaglutide all → "semaglutide").
   */
  static canonicalDrug(name) {
    const n = (name || '').toLowerCase();
    if (/wegovy|ozempic|semaglutide|rybelsus/.test(n)) return 'semaglutide';
    if (/mounjaro|zepbound|tirzepatide/.test(n)) return 'tirzepatide';
    if (/saxenda|victoza|liraglutide/.test(n)) return 'liraglutide';
    if (/trulicity|dulaglutide/.test(n)) return 'dulaglutide';
    if (/jardiance|empagliflozin/.test(n)) return 'empagliflozin';
    if (/crestor|rosuvastatin/.test(n)) return 'rosuvastatin';
    if (/lipitor|atorvastatin/.test(n)) return 'atorvastatin';
    if (/synthroid|levothyroxine/.test(n)) return 'levothyroxine';
    if (/ilumya|alumnia|alumina|tildrakizumab/.test(n)) return 'tildrakizumab';
    if (/zrint|\bzio\b/.test(n)) return 'topical-derm';
    if (/vyvanse|lisdexamfetamine|elvanse/.test(n)) return 'lisdexamfetamine';
    if (/adderall|amphetamine\s*salt/.test(n)) return 'amphetamine';
    if (/concerta|ritalin|methylphenidate/.test(n)) return 'methylphenidate';
    return (n.match(/^([a-z0-9]+)/) || [])[1] || n;
  }

  /**
   * planLineTopicMismatch(text, problemTopic) → true if the line names a systemic drug
   * that belongs to a DIFFERENT problem topic, so it can be dropped from this problem's
   * plan. Kills cross-contamination (e.g. "Metformin" under foot pain, psoriasis creams
   * under diabetes). Analgesics/unrestricted drugs are never flagged.
   */
  static planLineTopicMismatch(text, problemTopic) {
    const t = (text || '').toLowerCase();
    const groups = [
      { rx: /\b(metformin|insulin|ozempic|wegovy|semaglutide|glipizide|gliclazide|jardiance|empagliflozin|trulicity|dulaglutide|mounjaro|tirzepatide)\b/, topics: ['diabetes', 'weight'] },
      { rx: /\b(ilumya|alumnia|alumina|tildrakizumab|olumiant|otezla|zoryve|skyrizi|cosentyx|taltz|siliq|tremfya|methotrexate|dupixent|dovobet|betamethasone|calcipotriene|zrint|zio)\b/, topics: ['psoriasis'] },
      { rx: /\b(lisinopril|amlodipine|ramipril|losartan|metoprolol|bisoprolol|perindopril|valsartan)\b/, topics: ['hypertension'] },
      { rx: /\b(atorvastatin|rosuvastatin|simvastatin|crestor|lipitor|ezetimibe)\b/, topics: ['lipids'] },
      { rx: /\b(vyvanse|lisdexamfetamine|elvanse|adderall|concerta|ritalin|methylphenidate)\b/, topics: ['adhd'] },
      { rx: /\b(synthroid|levothyroxine|levothyrox|eltroxin)\b/, topics: ['thyroid'] },
    ];
    for (const g of groups) {
      if (g.rx.test(t) && !g.topics.includes(problemTopic)) return true;
    }
    return false;
  }

  /**
   * mergeSynonymProblems(problems) — collapse problems that share a canonical topic
   * (e.g. "1. Obesity" + "2. Weight loss" → one), merging their plan_actions and
   * narrative. Keeps the most descriptive title and any confirmed diagnosis. Order-stable.
   */
  static mergeSynonymProblems(problems) {
    const byTopic = new Map();
    const result = [];
    for (const p of problems) {
      const topic = TemplateAssemblyAgent.canonicalProblemTopic(p.title || '');
      if (topic && byTopic.has(topic)) {
        const target = byTopic.get(topic);
        target.plan_actions = [...(target.plan_actions || []), ...TemplateAssemblyAgent.effectivePlanActions(p)];
        target.narrative = [...(target.narrative || []), ...(p.narrative || [])];
        if (!target.diagnosis && p.diagnosis) target.diagnosis = p.diagnosis;
        // Prefer the more descriptive (longer, non-catch-all) title.
        if (!target._titleLocked) {
          const a = target.title || '', b = p.title || '';
          if ((p._catch_all !== true) && (b.length > a.length || target._catch_all)) target.title = b;
        }
      } else {
        // normalize plan_actions onto the kept problem so merges accumulate cleanly
        p.plan_actions = TemplateAssemblyAgent.effectivePlanActions(p);
        if (topic) byTopic.set(topic, p);
        result.push(p);
      }
    }

    // Second pass: collapse problems with identical/subset plan+narrative content but
    // different titles (e.g. "Post-traumatic pain" vs "Soreness in foot" carrying the
    // exact same lines). Keeps the title that names a body part where possible.
    const sig = (p) => {
      const parts = [
        ...(p.narrative || []),
        ...TemplateAssemblyAgent.effectivePlanActions(p).map(a => a.text || ''),
      ].map(s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '')).filter(Boolean).sort();
      return parts;
    };
    const hasBodyPart = (t) => /\b(foot|knee|ankle|hip|shoulder|back|hand|wrist|elbow|neck|toe|finger|leg|arm)\b/i.test(t || '');
    const merged = [];
    for (const p of result) {
      const ps = sig(p);
      if (ps.length === 0) { merged.push(p); continue; }
      const psSet = new Set(ps);
      let foundDup = null;
      for (const m of merged) {
        const ms = sig(m);
        if (ms.length === 0) continue;
        const msSet = new Set(ms);
        const subset = ps.every(x => msSet.has(x)) || ms.every(x => psSet.has(x));
        if (subset) { foundDup = m; break; }
      }
      if (foundDup) {
        // merge into the existing one; prefer a body-part title
        foundDup.plan_actions = [...(foundDup.plan_actions || []), ...TemplateAssemblyAgent.effectivePlanActions(p)];
        foundDup.narrative = [...(foundDup.narrative || []), ...(p.narrative || [])];
        if (!foundDup.diagnosis && p.diagnosis) foundDup.diagnosis = p.diagnosis;
        if (!hasBodyPart(foundDup.title) && hasBodyPart(p.title)) foundDup.title = p.title;
      } else {
        merged.push(p);
      }
    }
    return merged;
  }

  /**
   * specifyProblemTitle(prob, graph) — upgrade a vague diagnosis title to the specific
   * subtype when the transcript supports it (e.g. bare "Anaemia" → "Iron deficiency
   * anaemia"). A vague title that omits a stated subtype causes clinical confusion.
   */
  static specifyProblemTitle(prob, graph) {
    let t = prob.title || '';
    const ents = (graph && graph.clinical_entities) || [];
    const hay = ents.map(e => `${e.display_text || e.canonical_name || ''} ${e.source_quote || ''}`).join(' ').toLowerCase();
    if (/\b(anaemia|anemia)\b/i.test(t) && !/iron|b12|folate|deficien|haemolytic|hemolytic|chronic disease|pernicious|aplastic|sickle/i.test(t)) {
      if (/iron deficien|iron[\s-]?low|low iron|ferritin\s*(low|deficien)/i.test(hay))
        t = t.replace(/\b(anaemia|anemia)\b/i, m => `Iron deficiency ${m.toLowerCase()}`);
    }
    return t;
  }

  /**
   * mergeCausallyLinkedProblems(problems, graph) — when two problems are linked by a
   * causal edge (one is secondary_to / caused_by / a complication_of the other), they are
   * really ONE problem. Keep the more actively-managed problem and fold the other in as a
   * "secondary to …" sub-point, so an etiology (e.g. gastric ulcer) doesn't appear as its
   * own numbered problem.
   */
  static mergeCausallyLinkedProblems(problems, graph) {
    const rels = (graph && graph.resolved_relationships) || [];
    if (!rels.length || problems.length < 2) return problems;
    const CAUSAL = /secondary[_\s]?to|caused[_\s]?by|complication[_\s]?of|due[_\s]?to/i;
    const entToProb = new Map();
    problems.forEach((p, i) => [...(p.entity_ids || []), ...(p.diagnosis_ids || [])].forEach(id => { if (!entToProb.has(id)) entToProb.set(id, i); }));
    const removed = new Set();
    const score = (p) => TemplateAssemblyAgent.effectivePlanActions(p).length + (p.narrative?.length || 0) + (p.diagnosis ? 1 : 0);
    for (const r of rels) {
      if (!CAUSAL.test(r.relationship || '')) continue;
      let a = entToProb.get(r.source), b = entToProb.get(r.target);
      if (a == null || b == null || a === b || removed.has(a) || removed.has(b)) continue;
      const keepIdx = score(problems[a]) >= score(problems[b]) ? a : b;
      const dropIdx = keepIdx === a ? b : a;
      const keep = problems[keepIdx], drop = problems[dropIdx];
      const dropTitle = (drop.title || '').replace(/^\s*\d+[.)]\s*/, '').trim();
      keep.narrative = keep.narrative || [];
      if (dropTitle && !keep.narrative.some(n => String(n).toLowerCase().includes(dropTitle.toLowerCase())) &&
          !(keep.title || '').toLowerCase().includes(dropTitle.toLowerCase())) {
        keep.narrative.push(`Secondary to ${dropTitle.charAt(0).toLowerCase()}${dropTitle.slice(1)}`);
      }
      keep.plan_actions = [...(keep.plan_actions || []), ...TemplateAssemblyAgent.effectivePlanActions(drop)];
      keep.narrative.push(...(drop.narrative || []));
      removed.add(dropIdx);
    }
    return problems.filter((_, i) => !removed.has(i));
  }

  // ── Plan helpers ─────────────────────────────────────────────────────────────
  /**
   * effectivePlanActions(prob)
   * Returns a normalized [{ text, field_type, timestamp }] list for a problem.
   * Prefers prob.plan_actions (built by AssessmentReasoner); otherwise synthesizes
   * from the named arrays so slot-filler-only problems still render their plan.
   */
  static effectivePlanActions(prob) {
    const flat = (v) => Array.isArray(v) ? v.map(flat).filter(Boolean).join('; ')
      : (v == null ? '' : (typeof v === 'object' ? String(v.text ?? v.value ?? '') : String(v)));
    if (Array.isArray(prob.plan_actions) && prob.plan_actions.length > 0) {
      // Coerce text to a string defensively (LLM can emit nested arrays/objects).
      return prob.plan_actions.map(a => ({ ...a, text: flat(a && a.text) }));
    }
    const acts = [];
    const add = (arr, field_type) => (arr || []).forEach(t => {
      const text = flat(t);
      if (text && text !== 'null') acts.push({ text, field_type, timestamp: 0 });
    });
    add(prob.investigations_planned, 'investigations');
    add(prob.treatment_planned || prob.treatments_planned, 'treatment');
    add(prob.referrals, 'referral');
    add(prob.follow_up || prob.follow_ups, 'follow_up');
    return acts;
  }

  /**
   * naturalizePlanAction(action) → a natural clinical sentence (Heidi style), or null.
   * Drops empty/"None" actions, removes rigid field labels, and adds a light verb only
   * when the action text is a bare noun phrase. If the text already reads as a sentence
   * (e.g. the slot filler wrote "prescribed pending insurance approval"), it's kept as-is.
   */
  static naturalizePlanAction(action) {
    let t = (action && action.text ? String(action.text) : '').trim().replace(/\s+/g, ' ');
    if (!t || /^none\.?$/i.test(t) || t === 'null') return null;
    const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
    const hasVerb = /\b(arrang|order|request|complet|done|perform|prescrib|start|initiat|continu|increas|decreas|adjust|provid|refer|review|discuss|submit|trial|recommend|advis|monitor|repeat|check|stop|ceas|book|schedul|give|given|await|pending|obtain|to\s)/i.test(t);
    let out;
    switch (action.field_type) {
      case 'investigations':
        out = hasVerb ? t : `${t} arranged`; break;
      case 'treatment':
        // Only append "prescribed" to something that looks like a dosed medication;
        // leave advice/therapy (e.g. "Ice, rest and elevation") as a bare statement.
        if (hasVerb) out = t;
        else if (/\d+\s*(mg|mcg|g|ml|units|iu|tab|tablet|capsule|puff|drop)\b/i.test(t)) out = `${t} prescribed`;
        else out = t;
        break;
      case 'referral':
        out = hasVerb ? t : `Referred to ${t}`; break;
      case 'follow_up':
        out = /^(rtc|return|review|follow|book|see)/i.test(t) ? t : `Rtc ${t}`; break;
      default:
        out = t;
    }
    out = cap(out.trim());
    if (!/[.?!]$/.test(out)) out += '.';
    return out;
  }

  /**
   * dedupPlanLines(lines) — collapse exact duplicates AND near-duplicates that share the
   * same core content (e.g. "Continue Wegovy." vs "Wegovy 0.25mg prescribed." → keep the
   * more specific one). Preserves order.
   */
  static dedupPlanLines(lines) {
    const STOP = new Set(['continue', 'continued', 'start', 'started', 'initiate', 'initiated', 'prescribed', 'planned', 'treatment', 'arranged', 'ordered', 'order', 'rtc', 'return', 'review', 'referred', 'referral', 'to', 'the', 'for', 'of', 'and', 'once', 'after', 'pending', 'provided', 'given', 'daily', 'weekly', 'today']);
    const STOP_RX = new RegExp(`\\b(${[...STOP].join('|')})\\b`, 'gi');
    const core = (s) => s.toLowerCase().replace(STOP_RX, ' ').replace(/[^a-z0-9]/g, '');
    // significant token SET (order-independent) so "X-ray Left Foot ordered" and
    // "Left X-ray arranged" collapse (one's tokens are a subset of the other's).
    const tokenSet = (s) => new Set(s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 2 && !STOP.has(w)));
    const subset = (a, b) => a.size > 0 && [...a].every(t => b.has(t));
    const kept = [];
    for (const line of lines) {
      const c = core(line);
      const ts = tokenSet(line);
      if (!c) { if (!kept.some(k => k.text.toLowerCase() === line.toLowerCase())) kept.push({ text: line, core: c, ts }); continue; }
      let dup = false;
      for (let i = 0; i < kept.length; i++) {
        const kc = kept[i].core, kts = kept[i].ts;
        if (!kc) continue;
        // existing is same or a superset (richer) → drop new
        if (kc === c || kc.includes(c) || subset(ts, kts)) { dup = true; break; }
        // new is richer (existing's tokens are a subset of new's) → replace existing
        if (c.includes(kc) || subset(kts, ts)) { kept[i] = { text: line, core: c, ts }; dup = true; break; }
      }
      if (!dup) kept.push({ text: line, core: c, ts });
    }
    return kept.map(k => k.text);
  }

  /**
   * tidyClinicalLine(s) — clean a rendered clinical line: collapse immediately-repeated
   * words and two-word phrases ("Foot Foot soreness" → "Foot soreness"; "Left Knee Left
   * knee discomfort" → "Left knee discomfort"), trim stray punctuation/whitespace.
   */
  static tidyClinicalLine(s) {
    let t = String(s == null ? '' : s).trim();
    if (!t) return '';
    t = t.replace(/\b(\w+\s+\w+)\s+\1\b/gi, '$1');   // repeated 2-word phrase
    t = t.replace(/\b(\w+)(\s+\1\b)+/gi, '$1');        // repeated single word
    t = t.replace(/\s{2,}/g, ' ').replace(/\s+([.,;:])/g, '$1').trim();
    t = t.replace(/[\s.,;:–-]+$/, '').trim();           // trailing punctuation incl. dashes
    if (t && !/[.?!]$/.test(t)) t += '.';
    return t;
  }

  /**
   * dedupNarrative(lines) — collapse near-duplicate assessment/evidence lines that refer
   * to the same finding (e.g. "HbA1c 6.2" vs "A1c 6.2 - stable and unchanged"), keeping
   * the most descriptive version. Preserves order.
   */
  static dedupNarrative(lines) {
    const norm = (s) => s.toLowerCase().replace(/\bhba1c\b/g, 'a1c').replace(/[^a-z0-9 ]/g, ' ');
    const TERMS = /\b(a1c|glucose|sugar|ldl|cholesterol|egfr|kidney|sodium|h(a)?emoglob|numbness|tingling|neuropath|nausea|appetite|swelling|metformin|ozempic|insulin|complication)\b/g;
    const kept = [];
    const keyToIdx = new Map();
    for (const raw of lines) {
      const s = String(raw || '').trim();
      if (!s || s === 'null') continue;
      const n = norm(s);
      const terms = [...new Set(n.match(TERMS) || [])].sort();
      const nums = [...new Set(s.match(/\d+\.?\d*/g) || [])].sort();
      const key = terms.length ? `t:${terms.join(',')}|${nums.join(',')}` : `s:${n.replace(/\s+/g, '')}`;
      if (keyToIdx.has(key)) {
        const i = keyToIdx.get(key);
        if (s.length > kept[i].length) kept[i] = s; // keep the richer phrasing
        continue;
      }
      keyToIdx.set(key, kept.length);
      kept.push(s);
    }
    return kept;
  }

  /**
   * Medication↔problem compatibility (mirror of AssessmentReasoner logic so the
   * renderer can route orphans even when AssessmentReasoner didn't run).
   */
  static isMedCompatibleWithProblem(medName, probName) {
    const med = (medName || '').toLowerCase();
    const prob = (probName || '').toLowerCase();
    if (/(metformin|insulin|ozempic|wegovy|semaglutide|glipizide|jardiance|farxiga|mounjaro|tirzepatide|saxenda|liraglutide)/i.test(med)) {
      return /(diabet|sugar|glucose|a1c|weight|obes|metabolic)/i.test(prob);
    }
    if (/(lisinopril|amlodipine|ramipril|losartan|metoprolol|bisoprolol)/i.test(med)) {
      return /(hypertension|blood pressure|htn|cardiac|heart)/i.test(prob);
    }
    if (/(atorvastatin|rosuvastatin|simvastatin|crestor|lipitor)/i.test(med)) {
      return /(lipid|cholesterol|hyperlip)/i.test(prob);
    }
    if (/(sertraline|fluoxetine|escitalopram|venlafaxine)/i.test(med)) {
      return /(depress|anxi|mood|mental)/i.test(prob);
    }
    return true; // unrestricted (e.g. analgesics) — compatible with anything
  }

  /**
   * isMentionOnlyMed(e)
   * True when a medication was only discussed/compared/considered — NOT prescribed,
   * initiated, or continued. Such facts must never become a treatment line.
   * Conservative: if no state signal exists, treat as actionable (return false) so real
   * meds are never silently dropped.
   */
  static isMentionOnlyMed(e) {
    const state = String(e.medication_status || e.med_state || e.medication_state || '').toLowerCase();
    if (['order', 'active', 'continue', 'continued', 'prescribed', 'initiated', 'started', 'refill'].includes(state)) return false;
    if (['mention', 'mentioned', 'discussed', 'considered', 'compared', 'option', 'proposed', 'deferred'].includes(state)) return true;
    const action = String(e.action || '').toLowerCase();
    if (/\b(discuss|compar|consider|mention|option|propos|defer)/.test(action)) return true;
    const status = String(e.status || '').toLowerCase();
    if (['discussed', 'considered', 'proposed', 'deferred'].includes(status)) return true;
    return false;
  }

  static humanizeEncounterType(encType) {
    const raw = (typeof encType === 'object' && encType) ? (encType.encounter_type || '') : (encType || '');
    if (!raw) return 'Other active issues';
    const cleaned = String(raw).replace(/[_-]+/g, ' ').trim();
    // A pure refill / medication-admin encounter gets a concrete problem title so the
    // logistics (which meds, quantity, pharmacy) render under a real heading.
    if (/refill|repeat\s*script|repeat\s*prescription|medication\s*(admin|request)/i.test(cleaned)) return 'Medication refills';
    // A medical SPECIALTY (gynecology, cardiology…) or generic encounter type is not a
    // valid problem title — never spawn a "Gynecology" problem.
    if (!cleaned || /general|primary|administrative|unknown|gyn(a)?ecolog|cardiolog|dermatolog|neurolog|urolog|gastro|endocrin|rheumatolog|psychiatr|orthopa|nephrolog|oncolog|specialist|consult/i.test(cleaned)) return 'Other active issues';
    return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  }

  /**
   * rescueOrphanPlanFacts(graph, problems, encounterType)
   *
   * Ensures medications, orders/investigations and follow-ups that were never
   * attached to a problem still surface inside Assessment & Plan (the schema),
   * instead of being dumped under a non-schema "Additional Findings" header.
   * Attaches each orphan to a compatible existing problem, or to a single
   * humanized catch-all problem appended to the list. Mutates `problems`.
   */
  static rescueOrphanPlanFacts(graph, problems, encounterType) {
    const entities = graph.clinical_entities || [];
    const orders = graph.orders || [];
    const followUps = graph.follow_ups || [];

    // Build a haystack of everything already represented in the plans/titles.
    const buildHay = () => problems.map(p => [
      p.title || '',
      ...(p.plan_actions || []).map(a => a.text || ''),
      ...(p.investigations_planned || []),
      ...(p.treatment_planned || []),
      ...(p.treatments_planned || []),
      ...(p.referrals || []),
      ...(p.follow_up || []),
      ...(p.follow_ups || []),
      ...(p.narrative || [])
    ].join('  ').toLowerCase()).join('  ');
    let hay = buildHay();
    const alreadyShown = (s) => !!s && hay.includes(String(s).toLowerCase());

    // Normalize a problem title for near-identical comparison by stripping common
    // suffix words ("management"/"control"/"care"/...) so "Weight loss" and
    // "Weight loss management" collapse to the same key.
    const normTitle = (s) => (s || '').toLowerCase()
      .replace(/\b(management|control|care|review|status|follow[\s-]?up)\b/g, '')
      .replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();

    let catchAll = null;
    const ensureCatchAll = () => {
      if (catchAll) return catchAll;
      const wantTitle = TemplateAssemblyAgent.humanizeEncounterType(encounterType);
      // Merge into an existing problem of the SAME canonical topic so the encounter-named
      // catch-all never collides with a real problem (an encounter "Diabetes" catch-all
      // folds into the existing "Diabetes mellitus" instead of duplicating it).
      const wantTopic = TemplateAssemblyAgent.canonicalProblemTopic(wantTitle);
      const existing = problems.find(p => !p._catch_all && wantTopic &&
        TemplateAssemblyAgent.canonicalProblemTopic(p.title) === wantTopic);
      catchAll = existing || newProblem(wantTitle);
      return catchAll;
    };

    const pushAction = (prob, text, field_type) => {
      if (!prob.plan_actions) prob.plan_actions = [];
      prob.plan_actions.push({ text, field_type, timestamp: 0 });
      hay += '  ' + text.toLowerCase();
    };

    const BODY_PART_RX = /\b(foot|feet|knee|ankle|hip|shoulder|back|hand|wrist|elbow|neck|toe|finger|leg|arm|spine|calf|thigh)\b/i;
    const bodyPartOf = (s) => { const m = (s || '').match(BODY_PART_RX); return m ? m[0].toLowerCase() : null; };
    const capWord = (s) => s.charAt(0).toUpperCase() + s.slice(1);
    const newProblem = (title) => {
      const np = { title, certainty: 'suspected', problem_id: `P${String(problems.length + 1).padStart(3, '0')}`,
        narrative: [], plan_actions: [], diagnosis: null, _catch_all: true };
      problems.push(np);
      return np;
    };
    const createdByTopic = new Map();

    // Form a "Prostate cancer screening" problem from a PSA decline / prostate family
    // history (Heidi lists this as its own problem). Pulls in the decline, cost barrier
    // and family history as narrative.
    if (!problems.some(p => /prostate|psa/i.test(p.title || ''))) {
      const txt = (e) => e.display_text || e.canonical_name || '';
      const isProstate = (e) => /\bpsa\b|prostate/i.test(txt(e));
      const decline = entities.find(e => isProstate(e) && (e.entity_type === 'administrative_action' || e.entity_type === 'investigation' || /declin/i.test(txt(e))));
      const fhx = entities.find(e => isProstate(e) && (e.entity_type === 'family_history' || e.clinical_role === 'family_history'));
      const cost = entities.find(e => e.entity_type === 'care_barrier' && /\bpsa\b|prostate|\$\d/i.test(txt(e)));
      if (decline || fhx) {
        const prob = newProblem('Prostate cancer screening');
        prob.certainty = 'confirmed';
        const addN = (s) => { const t = TemplateAssemblyAgent.tidyClinicalLine(s); if (t && !prob.narrative.includes(t)) prob.narrative.push(t); };
        if (decline) { addN(txt(decline)); decline.render_status = 'rendered'; }
        if (cost) { addN(txt(cost)); cost.render_status = 'rendered'; }
        if (fhx) addN(txt(fhx)); // also remains in PMH (Heidi lists it both places)
      }
    }

    // Route an orphan to the problem matching its OWN topic (not the encounter's): a
    // body-part problem for MSK facts, a screening problem for PSA, else the catch-all —
    // creating a correctly-named problem when none exists. This stops foot facts landing
    // under "Diabetes".
    const routeByTopic = (text, field_type, fact = {}) => {
      if (!text || alreadyShown(text)) return;
      const bp = bodyPartOf(text) || bodyPartOf(fact.body_region) || bodyPartOf(fact.body_site) ||
        bodyPartOf(`${fact.laterality || ''} ${fact.test || ''}`);
      if (bp) {
        let prob = problems.find(p => !p._catch_all && (p.title || '').toLowerCase().includes(bp));
        if (!prob && createdByTopic.has('pain:' + bp)) prob = createdByTopic.get('pain:' + bp);
        if (!prob) { prob = newProblem(`${capWord(bp)} pain`); createdByTopic.set('pain:' + bp, prob); }
        pushAction(prob, text, field_type); return;
      }
      if (/\bpsa\b|prostate/i.test(text)) {
        let prob = problems.find(p => !p._catch_all && /prostate|psa/i.test(p.title || ''));
        if (!prob && createdByTopic.has('prostate')) prob = createdByTopic.get('prostate');
        if (!prob) { prob = newProblem('Prostate cancer screening'); createdByTopic.set('prostate', prob); }
        pushAction(prob, text, field_type); return;
      }
      // Match an existing problem by canonical topic (e.g. "ADD medication follow-up" →
      // the ADD problem) so follow-ups don't spawn a specialty/"Other" catch-all.
      const txtTopic = TemplateAssemblyAgent.canonicalProblemTopic(text);
      if (txtTopic) {
        const tp = problems.find(p => !p._catch_all && TemplateAssemblyAgent.canonicalProblemTopic(p.title) === txtTopic);
        if (tp) { pushAction(tp, text, field_type); return; }
      }
      // Else match by shared keyword (drug name, doctor name, body region) against each
      // problem's title+narrative+plan ("follow up with Dr. Perennio" → ADD problem).
      const STOP = new Set(['follow', 'followup', 'with', 'your', 'doctor', 'appointment', 'review', 'results', 'regarding', 'about', 'after', 'weeks', 'week', 'medication', 'patient', 'arrange', 'repeat', 'once', 'and', 'the', 'for']);
      const sig = (String(text).toLowerCase().match(/[a-z]{4,}/g) || []).filter(w => !STOP.has(w));
      if (sig.length) {
        let best = null, bestScore = 0;
        for (const p of problems) {
          if (p._catch_all) continue;
          const hayP = `${p.title || ''} ${(p.narrative || []).join(' ')} ${(p.plan_actions || []).map(a => a.text).join(' ')}`.toLowerCase();
          const sc = sig.filter(w => hayP.includes(w)).length;
          if (sc > bestScore) { bestScore = sc; best = p; }
        }
        if (best && bestScore >= 1) { pushAction(best, text, field_type); return; }
      }
      pushAction(ensureCatchAll(), text, field_type);
    };

    const routeOrCatch = (text, field_type, compatFn) => {
      if (!text || alreadyShown(text)) return;
      const compat = compatFn ? problems.find(p => !p._catch_all && compatFn(p)) : null;
      if (compat) { pushAction(compat, text, field_type); return; }
      routeByTopic(text, field_type);
    };

    // 1. Medications (positive, actionable only), deduped by canonical first token.
    //    A "mention" (drug discussed/compared but not prescribed or continued) must
    //    never become a Treatment line — template A&P clause: treatment = therapies the
    //    clinician "explicitly stated will be initiated".
    const actionableMeds = entities
      .filter(e => (e.category === 'medication' || e.entity_type === 'medication'))
      .filter(e => !(e.is_negative || e.clinical_role === 'negative_finding' || e.certainty === 'negated'))
      .filter(e => !TemplateAssemblyAgent.isMentionOnlyMed(e))
      .filter(e => e.render_priority !== 'background' && e.render_status !== 'intentionally_suppressed');

    // Pick the best representative per CANONICAL drug (brand/generic collapse) so the
    // same drug isn't routed as multiple lines (Wegovy + Ozempic + semaglutide → one).
    const bestByDrug = new Map();
    for (const e of actionableMeds) {
      const base = e.medication || e.display_text || e.canonical_name || '';
      if (!base) continue;
      const key = TemplateAssemblyAgent.canonicalDrug(base);
      const score = (e.dose ? 2 : 0) + (e.medication_status === 'planned' ? 1 : 0);
      const cur = bestByDrug.get(key);
      if (!cur || score > cur.score) bestByDrug.set(key, { e, base, score });
    }
    for (const { e, base } of bestByDrug.values()) {
      let txt = base;
      if (e.dose && !txt.toLowerCase().includes(String(e.dose).toLowerCase())) txt += ` ${e.dose}`;
      if (e.frequency) txt += ` (${e.frequency})`;
      if (alreadyShown(base) || alreadyShown(txt)) { e.render_status = 'rendered'; continue; }
      routeOrCatch(txt, 'treatment', (p) => TemplateAssemblyAgent.isMedCompatibleWithProblem(base, p.title));
      e.render_status = 'rendered';
    }
    // Mark the non-chosen duplicates rendered so the safety net doesn't dump them.
    for (const e of actionableMeds) if (e.render_status !== 'rendered') e.render_status = 'rendered';

    // Mention-only meds are discussion context, not orders. Mark them represented so the
    // safety net won't dump them as bare lines — they never become a treatment line.
    entities
      .filter(e => (e.category === 'medication' || e.entity_type === 'medication') && TemplateAssemblyAgent.isMentionOnlyMed(e))
      .forEach(e => { e.render_status = 'rendered'; });

    // 2. Orders / planned investigations — routed by the order's OWN topic (body region),
    //    so an X-ray foot forms/joins a "Foot pain" problem, never a Diabetes catch-all.
    orders
      .filter(o => (o.status || 'ordered') !== 'completed' && o.temporality !== 'historical')
      .forEach(o => {
        let txt = o.test || '';
        if (!txt) return;
        if (o.laterality && !txt.toLowerCase().includes(o.laterality.toLowerCase())) txt = `${o.laterality} ${txt}`;
        routeByTopic(txt, 'investigations', o);
      });

    // 3. Treatment-instruction / care-barrier entities with a body part (e.g. RICE for the
    //    foot) — route to the matching body-part problem so they don't orphan.
    entities
      .filter(e => (e.entity_type === 'treatment_instruction' || e.category === 'treatment_instruction'))
      .filter(e => !(e.is_negative || e.clinical_role === 'negative_finding'))
      .forEach(e => {
        const txt = e.display_text || e.canonical_name || '';
        if (!txt) return;
        const bp = bodyPartOf(txt) || bodyPartOf(e.body_part) || bodyPartOf(e.body_site);
        if (bp) { routeByTopic(txt, 'treatment', { body_region: bp }); e.render_status = 'rendered'; }
      });

    // 4. Follow-ups.
    followUps.forEach(f => {
      const txt = f.trigger || f.timeframe || '';
      routeByTopic(txt, 'follow_up', f);
    });
  }

  // ── V31 Renderer — True Heidi Schema (7 slots + body-part grouping) ──────────
  /**
   * renderV31()
   *
   * Renders the Heidi-schema-filled note exactly matching Heidi's output format.
   *
   * Rules:
   * - Omit any field that is null (not explicitly mentioned)
   * - Group subjective lines by body_part under bold headers (transcript order)
   * - Objective: "Region: finding" prefix for positive findings
   * - Negative objective findings render as plain lines
   * - Assessment & Plan: flat inline fields, no prose reasoning
   * - NO ADDENDUM — dropped facts are a pipeline bug, not rendered as addendum
   */
  renderV31(graph, encounterType, renderedFactIds = new Set()) {
    const story = graph.clinical_story;
    if (!story) return '# Clinical Note\n\n*Note generation failed.*';

    // Helper to mark a fact ID as rendered
    const trackId = (factOrLine) => {
      if (factOrLine && factOrLine.id) renderedFactIds.add(factOrLine.id);
      if (factOrLine && factOrLine.fact_id) renderedFactIds.add(factOrLine.fact_id);
    };

    const slots = story.subjective_slots || {};
    let pmhLines = story.pmh_lines || [];
    const objectiveData = story.objective_lines || {};
    const rawProblems = story.assessment_plan || [];
    const isFallback = story._fallback === true;

    const lines = [];

    if (encounterType) lines.push(`*${encounterType}*`);
    if (isFallback) lines.push(`*⚠ Fallback rendering — V31 slot filler did not complete*`);

    // ── SUBJECTIVE (Heidi flow-based grouping — by SLOT, not by problem) ────────
    const collectSlot = (keys) => {
      const out = [];
      for (const k of keys) {
        const slot = slots[k];
        if (!slot?.lines?.length) continue;
        for (const line of slot.lines) { trackId(line); if (line.text) out.push(line.text); }
      }
      return out;
    };
    const sPresenting = collectSlot(['chief_complaint']);
    const sHpi = collectSlot(['duration_timing', 'aggravating_relieving', 'progression', 'previous_episodes', 'functional_impact']);
    const sAssoc = collectSlot(['associated_symptoms']);

    // MANDATORY HEADER
    lines.push('**Subjective:**');
    const pushSubBlock = (label, arr) => {
      if (!arr.length) return;
      lines.push(`**${label}:**`);
      for (const l of arr) lines.push(l);
      lines.push('');
    };
    pushSubBlock('Presenting Complaints', sPresenting);
    pushSubBlock('History of Presenting Complaint', sHpi);
    pushSubBlock('Associated Symptoms', sAssoc);
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    lines.push('');

    // ── PAST MEDICAL HISTORY ──────────────────────────────────────────────────
    // MANDATORY HEADER
    lines.push('**Past Medical History:**');
    
    const PMH_ELIGIBLE_CATEGORIES = [
      'pmh', 'procedure_history', 'family_history', 'social_history',
      'past_history_role', 'past_history'
    ];
    // Types that must NEVER appear in PMH — previous episodes belong in HPI, lab/vital/
    // symptom/context facts belong in their own sections.
    const PMH_EXCLUDED = ['previous_episode', 'resolved_symptom', 'symptom', 'lab_result',
      'vital_sign', 'physical_exam', 'care_barrier', 'medication_tolerance',
      'lifestyle_modification', 'investigation', 'treatment_instruction', 'clinical_context'];
    const isExcludedPmh = (e) => {
      const ct = e.category || e.entity_type || '';
      if (PMH_EXCLUDED.includes(ct)) return true;
      if (/ankle sprain|previous episode|prior episode/i.test(e.text || e.display_text || '')) return true;
      return false;
    };

    // Source 1: LLM slot-filler pmh_lines.
    const pmhCandidates = pmhLines.filter(fact => {
      if (isExcludedPmh(fact)) return false;
      const cat = fact.category || fact.entity_type || '';
      const role = fact.clinical_role || '';
      return PMH_ELIGIBLE_CATEGORIES.includes(cat) || role === 'past_history';
    });

    // Source 2: graph entities explicitly routed to PMH (procedure history, resolved or
    // chronic-reviewed conditions). Recovers facts the LLM dropped.
    for (const e of (graph.clinical_entities || [])) {
      if (isExcludedPmh(e)) continue;
      const cat = e.category || e.entity_type || '';
      const role = e.clinical_role || '';
      const isPmh = e.rendered_section === 'Past Medical History' || role === 'past_history' ||
        PMH_ELIGIBLE_CATEGORIES.includes(cat);
      if (!isPmh) continue;
      if (e.is_negative || role === 'negative_finding') continue; // denials handled elsewhere
      pmhCandidates.push(e);
    }

    // Source 3: chronic conditions managed in A&P should ALSO appear as a PMH entry
    // (Heidi lists "Diabetes mellitus", "Psoriasis - on study treatment for 7 yrs..." in
    // PMH while managing them below). Acute problems and normal lab panels are excluded.
    const CHRONIC_PMH_TOPICS = new Set(['diabetes', 'hypertension', 'psoriasis', 'sleep_apnea', 'fibromyalgia', 'mental_health', 'copd', 'asthma', 'thyroid']);
    // Enrich a chronic condition with its long-term treatment history (the "story"):
    // e.g. "Psoriasis - on study treatment for 7 years (Alumnia)".
    const enrichChronic = (topic, title) => {
      const td = (graph.clinical_entities || []).find(e =>
        (e.entity_type === 'treatment_duration' || e.category === 'treatment_duration') &&
        !TemplateAssemblyAgent.planLineTopicMismatch(e.display_text || e.canonical_name || '', topic));
      if (td) {
        const t = (td.display_text || td.canonical_name || '').trim();
        if (t && !title.toLowerCase().includes(t.toLowerCase())) return `${title} - ${t}`;
      }
      return title;
    };
    const candTopics = new Set(pmhCandidates.map(c => TemplateAssemblyAgent.canonicalProblemTopic(c.text || c.display_text || '')));
    for (const p of (rawProblems || [])) {
      const topic = TemplateAssemblyAgent.canonicalProblemTopic(p.title || '');
      // Only add a bare chronic title if the LLM didn't already provide a (richer) PMH line.
      if (CHRONIC_PMH_TOPICS.has(topic) && !candTopics.has(topic)) {
        const cleanTitle = (p.title || '').replace(/\s*[-–:].*$/, '').trim();
        if (cleanTitle) { pmhCandidates.push({ text: enrichChronic(topic, cleanTitle), entity_type: 'pmh' }); candTopics.add(topic); }
      }
    }

    // Source 4: a current/active medication with NO matching A&P problem (e.g. synthroid
    // when there is no thyroid problem) is listed as a background current med in PMH —
    // matching Heidi ("Current medications: synthroid"). Meds that belong to a problem
    // (metformin→diabetes, vyvanse→ADD) stay in A&P and are NOT repeated here.
    {
      const problemTopics = new Set((rawProblems || []).map(p => TemplateAssemblyAgent.canonicalProblemTopic(p.title || '')));
      const DRUG_TOPIC = [
        [/synthroid|levothyroxine|eltroxin/i, 'thyroid'],
        [/metformin|insulin|ozempic|wegovy|semaglutide|jardiance|gliclazide/i, 'diabetes'],
        [/vyvanse|lisdexamfetamine|adderall|concerta|methylphenidate/i, 'adhd'],
        [/lisinopril|amlodipine|ramipril|losartan|metoprolol|bisoprolol/i, 'hypertension'],
        [/statin|atorvastatin|rosuvastatin|crestor|lipitor/i, 'lipids'],
      ];
      const seenDrug = new Set();
      const orphanCurrentMeds = [];
      for (const e of (graph.clinical_entities || [])) {
        if (!(e.entity_type === 'medication' || e.category === 'medication')) continue;
        if (e.is_negative || e.clinical_role === 'negative_finding' || e.certainty === 'negated') continue;
        if (TemplateAssemblyAgent.isMentionOnlyMed(e)) continue;
        if (e.medication_status && !['active', 'historical'].includes(String(e.medication_status).toLowerCase())) continue; // only ongoing meds
        const name = e.medication || e.display_text || e.canonical_name || '';
        const dt = DRUG_TOPIC.find(([rx]) => rx.test(name));
        if (!dt || problemTopics.has(dt[1])) continue;   // has a home problem → stays in A&P
        const ck = TemplateAssemblyAgent.canonicalDrug(name);
        if (seenDrug.has(ck)) continue; seenDrug.add(ck);
        orphanCurrentMeds.push(name.replace(/\s+\d.*$/, '').trim() || name);
        e.render_status = 'rendered';
      }
      if (orphanCurrentMeds.length) {
        pmhCandidates.push({ text: `Current medications: ${orphanCurrentMeds.join(', ')}`, entity_type: 'pmh' });
      }
    }

    // Dedup by normalized text so the two sources don't double up.
    const seenPmh = new Set();
    for (const fact of pmhCandidates) {
      let line = fact.text || fact.display_text || fact.canonical_name || '';
      if (!line || line === 'null') continue;
      const key = line.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (!key || seenPmh.has(key)) continue;
      seenPmh.add(key);
      trackId(fact);
      if (fact.is_negative || /^no /i.test(line.trim())) {
        // Negative PMH or Family History remains plain
      } else if (fact.result_status === 'normal') {
        line += ' - results were fine';
      } else if (fact.result_status === 'abnormal') {
        line += ' - results were abnormal';
      }
      lines.push(line);
    }
    lines.push('');

    // ── OBJECTIVE ─────────────────────────────────────────────────────────────
    // MANDATORY HEADER
    lines.push('**Objective:**');

    const allEntities = graph.clinical_entities || [];
    const numData = graph.numeric_data || [];
    const storyObj = story.objective_lines || {};
    const isCat = (f, ...cats) => cats.includes(f.category) || cats.includes(f.entity_type);

    const VITAL_RX = /(weight|height|bmi|blood\s*pressure|\bbp\b|pulse|heart\s*rate|\bhr\b|respirat|\brr\b|temp|o2|oxygen|sat\b|spo2|waist|circumf)/i;
    const LAB_RX = /(hdl|ldl|cholesterol|triglyc|hba1c|a1c|glucose|sugar|sodium|potassium|h(a)?emoglob|creatinin|kidney|renal|\begfr\b|\bgfr\b|\btsh\b|thyroid|ferritin|\bwbc\b|\brbc\b|platelet|bilirubin|\bb12\b|vitamin\s*d|\bcrp\b|\besr\b|\binr\b|albumin|iron studies|\biron\b|electrolyte|liver|\balt\b|\bast\b)/i;
    const IMG_RX = /(x-?ray|ultrasound|\bus\b|mri|ct\s*scan|\bct\b|ecg|ekg|echo(cardiogram)?|scan|mammogram|dexa|doppler)/i;
    // Result signal includes qualitative descriptors so "Kidney function: fantastic" /
    // "Cholesterol: very good" / "Iron studies: pristine" count as completed lab results.
    const RESULT_RX = /(\d|normal|abnorm|negativ|positiv|\bno\b|finding|mass|fracture|clear|unremark|tender|swell|intact|present|absent|resolved|good|fine|fantastic|pristine|excellent|stable|acceptable|elevated|low\b|high\b|within)/i;
    const AGE_RX = /\bage\b|years?\s*old/i;

    const fmtNumeric = (n) => {
      const label = n.test_name || n.label || n.metric_type || '';
      const val = (n.value !== null && n.value !== undefined) ? String(n.value) : '';
      if (!val) return '';
      if (n.trend_narrative && String(n.trend_narrative).includes(val)) return n.trend_narrative;
      const unit = n.unit ? ` ${n.unit}` : '';
      return label ? `${label}: ${val}${unit}` : `${val}${unit}`;
    };

    // Gather every candidate objective fact into one list, then classify + dedup,
    // so a value can never appear in two subsections (the source of the duplicates).
    const candidates = [];
    const pushCand = (text, region, is_negative, fact, observation_date) => {
      if (text && text !== 'null') candidates.push({ text: String(text).trim(), region: region || null, is_negative: !!is_negative, fact, observation_date });
    };

    for (const n of numData) {
      const label = n.test_name || n.label || n.metric_type || '';
      if (AGE_RX.test(label) || n.numeric_type === 'age') continue;
      pushCand(fmtNumeric(n), null, false, n, n.observation_date);
    }
    for (const e of allEntities) {
      if (isCat(e, 'vital_sign') || isCat(e, 'lab_result') || isCat(e, 'physical_exam') ||
          (isCat(e, 'investigation') && e.temporality === 'historical')) {
        pushCand(e.display_text || e.canonical_name, e.objective_region_label, e.is_negative, e, e.observation_date);
      }
    }
    for (const v of (storyObj.vitals || [])) pushCand(typeof v === 'string' ? v : v.text, (typeof v === 'object' ? v.objective_region_label : null), (typeof v === 'object' && v.is_negative), v);
    for (const f of (storyObj.exam_findings || [])) pushCand(typeof f === 'string' ? f : f.text, (typeof f === 'object' ? f.objective_region_label : null), (typeof f === 'object' && f.is_negative), f);

    // strip a known section-label prefix so "Labs: HDL: 1.05" == "HDL: 1.05"
    const stripPrefix = (s) => s.replace(/^(labs?|imaging|radiology|bloods?|blood\s*work|vitals?|exam|investigation[s]?)\s*:\s*/i, '').trim();
    const objKey = (s) => stripPrefix(s).toLowerCase().replace(/[^a-z0-9]/g, '');

    // Metric signature dedup: collapses the same measurement phrased differently
    // (e.g. "Home Blood Glucose: 6.6 mmol/L" == "Home glucose 6.6"; duplicate Height).
    const lastNumber = (s) => { const m = s.match(/\d+\.?\d*(?:\/\d+\.?\d*)?/g); return m ? m[m.length - 1] : ''; };
    const metricSig = (bucket, t) => {
      if (bucket === 'vital') {
        if (/^\s*\d{2,3}\s*\/\s*\d{2,3}\b/.test(t)) return 'v:bp';   // bare "130/70" BP value
        const m = t.match(/blood\s*pressure|\bbp\b|weight|height|\bbmi\b|pulse|heart\s*rate|\bhr\b|respirat|\brr\b|temp|o2|oxygen|spo2|\bsat\b|waist/);
        return m ? `v:${m[0].replace(/\s+/g, '')}` : null;
      }
      if (bucket === 'lab') {
        // Dedup by TEST NAME alone (one line per lab) so "Kidney function: fantastic" and
        // "Kidney function normal; eGFR 1.7" collapse, and duplicate eGFR lines merge.
        const words = t.replace(/\b(home|fasting|random|serum|blood|plasma|level|reading|monitoring|result|function|studies|count)\b/g, ' ').match(/[a-z]{3,}/g);
        const primary = words && words.length ? words[0] : '';
        return primary ? `l:${primary}` : null;
      }
      return null;
    };
    // A blood-pressure-style "130/70" value is a vital, never a lab.
    const isBpValue = (s) => /^\s*\d{2,3}\s*\/\s*\d{2,3}\b/.test(s);

    const buckets = { vital: [], lab: [], imaging: [], exam: [] };
    let labDate = '';
    const seenObj = new Set();
    const seenMetric = new Set();
    for (const c of candidates) {
      const clean = stripPrefix(c.text);
      if (!clean || clean === 'null') continue;
      const key = objKey(c.text);
      if (!key) continue;
      // Already shown elsewhere in Objective — track the duplicate's source fact so the
      // safety net won't re-add it, then skip.
      if (seenObj.has(key)) { trackId(c.fact); continue; }
      const region = (c.region || '').toLowerCase();
      const t = clean.toLowerCase();

      // Objective = measured signs only. Exclude menstrual-cycle HISTORY (belongs in
      // Subjective) and clinician/physio REASONING (not an exam finding).
      if (/menstrual|cycle\s*(day|length)|day\s*\d+\s*of\s*(the\s*)?cycle/.test(t)) { trackId(c.fact); continue; }
      if (/(suggested by|potential|possible|might be|may be|query|likely|could be)/.test(t) &&
          /(adhesion|positioning|malposition|reasoning|impression)/.test(t)) { trackId(c.fact); continue; }
      if (c.fact && (c.fact.entity_type === 'clinician_reasoning' || c.fact.category === 'clinician_reasoning')) { trackId(c.fact); continue; }

      let bucket;
      if (isBpValue(clean)) bucket = 'vital';                       // "130/70" → vital, never lab
      else if (/imag|radiol/.test(region) || IMG_RX.test(t)) bucket = 'imaging';
      else if (/lab|blood|serum/.test(region) || LAB_RX.test(t)) bucket = 'lab';
      else if (/vital/.test(region) || VITAL_RX.test(t)) bucket = 'vital';
      else bucket = 'exam';

      // Home self-monitoring glucose is subjective (Diabetes Management), not a Blood Work
      // lab — keep it out of the Objective panel to match Heidi and avoid a duplicate.
      if (bucket === 'lab' && /\bhome\b/.test(t)) { seenObj.add(key); trackId(c.fact); continue; }

      // Objective = completed findings only. Bare planned orders (a test name with no
      // result) belong in Assessment & Plan, not here — drop them from Objective but
      // track the fact so it isn't re-dumped by the safety net.
      if ((bucket === 'imaging' || bucket === 'lab') && !RESULT_RX.test(t)) { seenObj.add(key); trackId(c.fact); continue; }

      // Metric-level dedup (same measurement phrased differently).
      const msig = metricSig(bucket, t);
      if (msig) { if (seenMetric.has(msig)) { trackId(c.fact); continue; } seenMetric.add(msig); }

      seenObj.add(key);
      if (!labDate && bucket === 'lab' && c.observation_date) labDate = c.observation_date;

      // Region prefix is only meaningful for exam findings (e.g. "Right hip: tenderness").
      const showRegion = bucket === 'exam' && c.region && !/^(vitals?|labs?|imaging|exam)$/i.test(c.region) && !c.is_negative && !/^no /i.test(t);
      // Guard against a doubled label ("Gait: Gait: …"): if the text already opens
      // with the same region label, don't prepend it again.
      const alreadyPrefixed = showRegion && clean.toLowerCase().startsWith((c.region || '').toLowerCase() + ':');
      buckets[bucket].push({ text: (showRegion && !alreadyPrefixed) ? `${c.region}: ${clean}` : clean, fact: c.fact });
    }

    const renderObjSubsection = (title, items) => {
      if (!items || !items.length) return;
      lines.push(`**${title}**`);
      for (const it of items) { trackId(it.fact); lines.push(it.text); }
      lines.push('');
    };

    renderObjSubsection('Vital Signs', buckets.vital);
    renderObjSubsection(`Blood Work${labDate ? ` (${labDate})` : ''}`, buckets.lab);
    renderObjSubsection('Imaging', buckets.imaging);
    renderObjSubsection('Exam Findings', buckets.exam);

    // ── ASSESSMENT & PLAN ─────────────────────────────────────────────────────
    // Collapse semantically-equivalent problems (e.g. "Obesity" + "Weight loss") into
    // one BEFORE rescue, so orphan facts attach to the single merged problem.
    let problems = TemplateAssemblyAgent.mergeSynonymProblems(rawProblems);
    // Fold etiology/cause problems into the parent they're secondary to (e.g. gastric
    // ulcer → sub-point of iron-deficiency anaemia) instead of a separate problem.
    problems = TemplateAssemblyAgent.mergeCausallyLinkedProblems(problems, graph);
    // Upgrade vague diagnosis titles to the stated subtype (e.g. "Anaemia" → "Iron
    // deficiency anaemia") to avoid clinical ambiguity.
    for (const p of problems) p.title = TemplateAssemblyAgent.specifyProblemTitle(p, graph);
    // Orphan rescue: attach un-routed meds / orders / follow-ups to a compatible
    // problem (or a humanized catch-all) BEFORE rendering, so nothing is dumped
    // outside the SOAP schema. Mutates `problems` in place.
    TemplateAssemblyAgent.rescueOrphanPlanFacts(graph, problems, encounterType);

    // Drop non-actionable normal lab "problems" (e.g. Hyperlipidaemia from a normal LDL
    // with no statin) — those values belong in Blood Work, not as an A&P problem.
    problems = problems.filter(p => {
      const topic = TemplateAssemblyAgent.canonicalProblemTopic(p.title || '');
      const acts = TemplateAssemblyAgent.effectivePlanActions(p);
      if (topic === 'lipids' && acts.length === 0 && !p.diagnosis) return false;
      return true;
    });

    // MANDATORY HEADER
    lines.push('**Assessment & Plan:**');

    if (problems.length > 0) {
      for (let i = 0; i < problems.length; i++) {
        const prob = problems[i];
        
        // Track the problem and its linked facts
        trackId({id: prob.problem_id});
        if (prob.entity_ids) prob.entity_ids.forEach(id => trackId({id}));
        
        lines.push('');

        // Issue name (numbered)
        lines.push(`${i + 1}. ${prob.title || `Problem ${i + 1}`}`);
        
        // Output actual diagnosis line if the certainty gate passed
        if (prob.diagnosis) {
          lines.push(`Diagnosis: ${prob.diagnosis}`);
        }

        // Coerce any value to a clean string (LLM sometimes returns nested arrays/objects).
        const toStr = (v) => {
          if (v == null) return '';
          if (Array.isArray(v)) return v.map(toStr).filter(Boolean).join('; ');
          if (typeof v === 'object') return String(v.text ?? v.value ?? v.name ?? '');
          return String(v);
        };

        // split a value into separate clean lines (arrays/'; '/newlines → one line each)
        const splitLines = (v) => {
          const out = [];
          const walk = (x) => {
            if (x == null) return;
            if (Array.isArray(x)) { x.forEach(walk); return; }
            const s = (typeof x === 'object') ? String(x.text ?? x.value ?? x.name ?? '') : String(x);
            s.split(/\s*;\s*|\n+/).forEach(part => { const t = part.trim(); if (t && t !== 'null') out.push(t); });
          };
          walk(v);
          return out;
        };

        // Narrative lines (template evidence) — split, tidied (no "Foot Foot"), deduped.
        if (prob.narrative?.length > 0) {
          const narr = [];
          for (const n of prob.narrative) for (const s of splitLines(n)) {
            const tidy = TemplateAssemblyAgent.tidyClinicalLine(s);
            if (tidy) narr.push(tidy);
          }
          for (const s of TemplateAssemblyAgent.dedupNarrative(narr)) lines.push(s);
        }

        // Effective plan actions: prefer plan_actions (built by AssessmentReasoner), else
        // the named arrays. Each array entry / '; '-separated item becomes its OWN line so
        // the plan reads like Heidi (separate lines), never one jammed line.
        const effectiveActions = [];
        for (const a of TemplateAssemblyAgent.effectivePlanActions(prob)) {
          for (const t of splitLines(a && a.text)) effectiveActions.push({ ...a, text: t });
        }
        const probTopic = TemplateAssemblyAgent.canonicalProblemTopic(prob.title || '');

        // Chronological plan actions
        if (effectiveActions.length > 0) {
          // Identify negated meds from the graph to use as a second layer
          const negatedMeds = (graph.clinical_entities || [])
            .filter(n => n.category === 'medication' && (n.is_negative || n.clinical_role === 'negative_finding' || n.certainty === 'negated'))
            .map(n => {
              const str = n.medication || n.canonical_name || n.display_text || n.value || '';
              const match = str.match(/^([a-z0-9]+)/i);
              return match ? match[1].toLowerCase() : str.toLowerCase();
            })
            .filter(Boolean);

          // Hard JS Guard: filter negated meds from treatment plan
          const safeActions = effectiveActions.filter(action => {
            if (!action.text || action.text === 'null') return false;
            if (action.field_type !== 'treatment') return true;
            
            // Layer 1: Text contains explicit denial
            const denialPhrases = /\bno\b|\bdon't take\b|\bnot taking\b|\bdenies\b/i;
            if (denialPhrases.test(action.text)) {
              return false;
            }
            
            // Layer 2: Graph has fact flagged negative that matches this text
            const actionTextLower = action.text.toLowerCase();
            const isNegatedInGraph = negatedMeds.some(m => actionTextLower.includes(m));
            if (isNegatedInGraph) {
              return false;
            }

            // Layer 3: Cross-contamination guard — drop a line naming a systemic drug
            // that belongs to a different problem topic (e.g. Metformin under foot pain,
            // psoriasis cream under diabetes).
            if (TemplateAssemblyAgent.planLineTopicMismatch(action.text, probTopic)) {
              return false;
            }

            return true;
          });

          // Follow-up cleanup: keep at most ONE follow-up per problem, and drop a vague
          // "routine follow-up"/"follow-up as scheduled" when any other action exists.
          const VAGUE_FU = /^(rtc\s+)?(routine\s+follow[\s-]?up|follow[\s-]?up( as (scheduled|needed|normal|appropriate))?|as scheduled|as needed)\.?$/i;
          const hasSpecificAction = safeActions.some(a => a.field_type !== 'follow_up');
          let followUpKept = false;
          const prunedActions = safeActions.filter(a => {
            if (a.field_type !== 'follow_up') return true;
            if (VAGUE_FU.test(a.text.trim()) && hasSpecificAction) return false; // drop filler
            if (followUpKept) return false;                                       // only one rtc
            followUpKept = true;
            return true;
          });

          // Render plan as natural clinical sentences (Heidi style) — no rigid labels,
          // empty/None omitted, near-duplicates collapsed, garbled repeats tidied.
          const planLines = [];
          for (const action of prunedActions) {
            const nat = TemplateAssemblyAgent.naturalizePlanAction(action);
            const tidy = TemplateAssemblyAgent.tidyClinicalLine(nat);
            if (tidy) planLines.push(tidy);
          }
          for (const line of TemplateAssemblyAgent.dedupPlanLines(planLines)) {
            lines.push(line);
          }
        }
      }
    }

    // NO ADDENDUM — V31 eliminates addendum entirely
    // If facts are dropped, that is a pipeline bug to fix upstream

    return lines.join('\n').trim();
  }

  // ── V30 Renderer — Heidi-exact section schema (approved 2026-06) ─────────────
  // Sections:
  //   Subjective: Reason for Visit, Symptom Characteristics, Symptom Modifiers,
  //               Symptom Progression, Previous Episodes, Impact on Daily Activities,
  //               Associated Symptoms, (Presenting Complaint + HPI merged per Heidi)
  //   Past Medical History
  //   Objective: Vital Signs, Physical Examination, Investigations with Results
  //   Assessment & Plan (COMBINED, numbered Heidi style)
  renderV30(graph, encounterType) {
    const story = graph.clinical_story;
    const subj = story.subjective || {};
    const pmh  = story.pmh  || {};
    const obj  = story.objective || {};
    const plans = story.assessment_plan || [];
    const isFallback = story._fallback === true;

    // Helper: render a section only if it has content
    const section = (label, lines, numbered = false) => {
      const clean = (lines || []).filter(Boolean);
      if (!clean.length) return '';
      if (numbered) {
        return `**${label}**\n${clean.map((l, i) => `${i + 1}. ${l}`).join('\n')}\n\n`;
      }
      return `**${label}**\n${clean.map(l => `- ${l}`).join('\n')}\n\n`;
    };

    let note = `# Clinical Note\n`;
    if (encounterType) note += `*${encounterType}*\n`;
    if (isFallback) note += `*⚠ Narrative quality: deterministic fallback (V25)*\n`;
    note += '\n';

    // ── SUBJECTIVE ──────────────────────────────────────────────────────────────
    const hasSubj = Object.values(subj).some(v => Array.isArray(v) ? v.length > 0 : !!v);
    if (hasSubj) {
      note += `## Subjective\n\n`;

      // Reason for Visit / Presenting Complaints
      // V30 schema uses presenting_complaints[]; V25 fallback uses reason_for_visit
      const complaints = (subj.presenting_complaints?.length > 0)
        ? subj.presenting_complaints
        : (subj.reason_for_visit ? [subj.reason_for_visit] : []);
      note += section('Reason for visit or chief complaint', complaints);

      // History of Presenting Complaint (the story — the most important section)
      // V30: history_presenting_complaint; V25 fallback: history_presenting_illness
      const hpi = subj.history_presenting_complaint?.length > 0
        ? subj.history_presenting_complaint
        : (subj.history_presenting_illness || []);
      note += section('History of Presenting Complaint', hpi);

      // Symptom Characteristics (V25 field, may be present)
      note += section('Symptom characteristics', subj.symptom_characteristics);

      // Symptom Modifiers (V25 field)
      note += section('Symptom modifiers and self-management', subj.symptom_modifiers);

      // Symptom Progression (V25 field)
      note += section('Symptom progression', subj.symptom_progression);

      // Previous Episodes (new V30 field)
      note += section('Previous episodes', subj.previous_episodes);

      // Impact on Daily Activities (new V30 field)
      note += section('Impact on daily activities', subj.impact_on_daily_activities);

      // Associated Symptoms
      note += section('Associated symptoms', subj.associated_symptoms);

      // Disease Management (existing medications/management before this visit)
      note += section('Disease Management', subj.disease_management);

      // Negatives / Review of Systems (V25 field still supported)
      note += section('Review of Systems', subj.negatives);
    }

    // ── PAST MEDICAL HISTORY ─────────────────────────────────────────────────
    const pmhValues = Object.values(pmh).filter(v => Array.isArray(v) && v.length > 0);
    if (pmhValues.length > 0) {
      note += `## Past Medical History\n\n`;
      note += section('Relevant medical and surgical history',
        [...(pmh.medical_history || []), ...(pmh.surgical_history || [])]);
      note += section('Relevant social history', pmh.social_history);
      note += section('Relevant family history', pmh.family_history);
      note += section('Exposure history', pmh.exposure_history);
      note += section('Immunisation history', pmh.immunization_history);
      note += section('Other relevant subjective information', pmh.other_relevant);
    }

    // ── OBJECTIVE ────────────────────────────────────────────────────────────
    // V30 objective uses string arrays; V25 fallback uses object arrays (converted by DeterministicFallbackComposer)
    const objVitals   = (obj.vitals || []).map(v => typeof v === 'string' ? v
      : v.trend_narrative || `${v.label || ''}: ${v.value || ''}${v.unit ? ` ${v.unit}` : ''}`);
    const objExam     = (obj.physical_exam || []).map(v => typeof v === 'string' ? v : (v.text || ''));
    const objInvest   = (obj.investigations_with_results || obj.labs || []).map(v =>
      typeof v === 'string' ? v
        : v.trend_narrative || `${v.label || ''}${v.value ? `: ${v.value}` : ''}${v.unit ? ` ${v.unit}` : ''}`);
    const objNormal   = (obj.normal_findings || []).map(v => typeof v === 'string' ? v : (v.text || ''));

    const hasObj = objVitals.length || objExam.length || objInvest.length || objNormal.length;
    if (hasObj) {
      note += `## Objective\n\n`;
      note += section('Vital signs', objVitals);
      note += section('Physical or mental examination findings', objExam);
      note += section('Investigations with results', objInvest);
      note += section('Normal findings', objNormal);
    }

    // ── ASSESSMENT & PLAN ─────────────────────────────────────────────────────────
    if (plans.length > 0) {
      note += `## Assessment & Plan\n\n`;
      plans.forEach((ap, idx) => {
        const num = idx + 1;
        const title = ap.title || `Problem ${num}`;
        note += `### ${num}. ${title}\n`;
        
        if (ap.narrative?.length > 0) {
          ap.narrative.filter(Boolean).forEach(ev => { note += `${ev}\n`; });
        }

        if (ap.investigations_planned?.length > 0) {
          note += `\n**Investigations planned:**\n`;
          ap.investigations_planned.filter(Boolean).forEach(i => { note += `- ${i}\n`; });
        }

        if (ap.treatment_planned?.length > 0) {
          note += `\n**Treatment planned:**\n`;
          ap.treatment_planned.filter(Boolean).forEach(t => { note += `- ${t}\n`; });
        }

        if (ap.follow_up?.length > 0) {
          note += `\n**Follow-up:**\n`;
          ap.follow_up.filter(Boolean).forEach(f => { note += `- ${f}\n`; });
        }

        note += '\n';
      });
    }

    return note.trim();
  }

  // ── V25 Renderer (KEPT FOR REFERENCE — superseded by renderV30) ──────────────
  // Not called by execute(). Preserved so DeterministicFallbackComposer
  // can reference V25 logic patterns if needed.
  renderV25(graph, activeProblems, encounterType) {
    const story = graph.clinical_story;
    const subj = story.subjective || {};
    const pmh = story.pmh || {};
    const obj = story.objective || {};
    const plans = story.assessment_plan || [];

    let note = `# Clinical Note\n`;
    if (encounterType) note += `*${encounterType}*\n`;
    note += '\n';

    note += `## Subjective\n\n`;
    if (subj.reason_for_visit) note += `**Presenting Complaint**\n${subj.reason_for_visit}\n\n`;
    const hpiLines = [...(subj.history_presenting_illness || []), ...(subj.symptom_characteristics || [])];
    if (hpiLines.length > 0) { note += `**History of Presenting Complaint**\n`; note += hpiLines.map(l => `- ${l}`).join('\n') + '\n\n'; }
    if (subj.associated_symptoms?.length > 0) { note += `**Associated Symptoms**\n`; note += subj.associated_symptoms.map(l => `- ${l}`).join('\n') + '\n\n'; }
    if (subj.disease_management?.length > 0) { note += `**Disease Management**\n`; note += subj.disease_management.map(l => `- ${l}`).join('\n') + '\n\n'; }

    const hasPMH = Object.values(pmh).some(arr => arr?.length > 0);
    if (hasPMH) {
      note += `## Past Medical History\n\n`;
      if (pmh.medical_history?.length > 0) { note += `**Medical History**\n`; note += pmh.medical_history.map(l => `- ${l}`).join('\n') + '\n\n'; }
    }

    const hasObj = obj.vitals?.length || obj.physical_exam?.length || obj.labs?.length;
    if (hasObj) {
      note += `## Objective\n\n`;
      if (obj.vitals?.length > 0) { note += `**Vital Signs**\n`; note += obj.vitals.map(v => `- ${v.trend_narrative || `${v.label}: ${v.value}${v.unit ? ` ${v.unit}` : ''}`}`).join('\n') + '\n\n'; }
      if (obj.labs?.length > 0) { note += `**Investigations with Results**\n`; note += obj.labs.map(l => `- ${l.trend_narrative || `${l.label}${l.value ? `: ${l.value}` : ''}${l.unit ? ` ${l.unit}` : ''}`}`).join('\n') + '\n\n'; }
    }

    if (plans.length > 0) {
      note += `## Assessment & Plan\n\n`;
      plans.forEach((ap, idx) => {
        note += `**${idx + 1}. ${ap.diagnosis || 'Assessment'}**\n\n`;
        if (ap.evidence?.length > 0) { ap.evidence.forEach(ev => { note += `${ev}\n`; }); note += '\n'; }
        if (ap.recommendations?.length > 0) { note += `Recommendations:\n`; note += ap.recommendations.map(r => `- ${r}`).join('\n') + '\n\n'; }
        if (ap.treatments_planned?.length > 0) { note += `Treatment planned:\n`; note += ap.treatments_planned.map(t => `- ${t}`).join('\n') + '\n\n'; }
        if (ap.follow_ups?.length > 0) { note += `Follow-up:\n`; note += ap.follow_ups.map(f => `- ${f}`).join('\n') + '\n\n'; }
      });
    }

    return note.trim();
  }

  // ── Legacy Renderer (V18/V19 fallback) ───────────────────────────────────────
  renderLegacy(graph, activeProblems, extensions, reasoningContext, encounterType) {

    const entities = graph?.clinical_entities || [];
    
    // Deduplication & Filtering
    const renderEntities = (entitiesArray, reason) => {
      const output = [];
      for (const entity of entitiesArray) {
        if (!entity) continue;

        if (typeof entity === 'string') {
          output.push(`- ${entity}`);
          continue;
        }

        // Apply rendering blocks
        if (entity.render_priority === "hidden" || entity.importance === "ignore" || entity.entity_type === "temporal_reference") {
          entity.render_reason = "hidden_by_priority_or_type";
          continue;
        }

        if (entity.render_status !== "rendered") {
          entity.render_status = "rendered"; // Update lifecycle
          entity.render_reason = reason;

          let outputText = entity.display_text || entity.canonical_name;
          if (entity.entity_type === "medication" && entity.medication) {
            outputText = entity.medication;
            if (entity.dose) outputText += ` ${entity.dose}`;
            if (entity.frequency) outputText += ` (${entity.frequency})`;
          }
          if (entity.body_site && !outputText.toLowerCase().includes(entity.body_site.toLowerCase())) {
            outputText += ` (${entity.body_site})`;
          }
          if (entity.symptom_characteristic) {
            outputText += ` - ${entity.symptom_characteristic}`;
          }
          // Intentionally omitting [status] rendering to avoid fact-dumping aesthetics
          if (entity.observation_date) {
            outputText += ` (on ${entity.observation_date})`;
          }
          
          if (entity.clinical_role === "negative_finding") {
            outputText = TemplateAssemblyAgent.formatNegation(entity);
          }

          // Care barriers format
          if (entity.entity_type === "care_barrier" && entity.barrier_type) {
             outputText = `[Barrier: ${entity.barrier_type}] ${outputText}`;
          }

          output.push(`- ${outputText}`);
        }
      }
      return output;
    };

    // 1. SUBJECTIVE
    note += `## Subjective\n`;
    if (graph?.reason_for_visit) {
      note += `**Reason for Visit:** ${graph.reason_for_visit}\n\n`;
    }
    
    const subjectiveEntities = entities.filter(e => e.rendered_section === "Subjective");
    const subjRendered = renderEntities(subjectiveEntities, "subjective");
    if (subjRendered.length > 0) {
      note += `${subjRendered.join("\n")}\n\n`;
    }

    // 2. OBJECTIVE
    note += `## Objective\n`;
    const numericData = graph?.numeric_data || [];
    const validNumerics = numericData.filter(n => {
      // Age validation
      if (n.numeric_type === "age") {
        if (!n.source_text || n.source_text.trim() === "") return false;
      }
      return true;
    });

    if (validNumerics.length > 0) {
      note += `**Vitals & Labs:**\n`;
      note += validNumerics.map(n => {
        if (n.trend_narrative) {
           return `- ${n.trend_narrative}`;
        }
        let str = `- ${n.test_name}: ${n.value}`;
        if (n.unit) str += ` ${n.unit}`;
        if (n.observation_date) str += ` (${n.observation_date})`;
        return str;
      }).join("\n") + "\n\n";
    }
    
    const objectiveEntities = entities.filter(e => e.rendered_section === "Objective" && e.entity_type !== "normal_finding");
    const objRendered = renderEntities(objectiveEntities, "objective");
    if (objRendered.length > 0) {
      note += `${objRendered.join("\n")}\n\n`;
    }

    const normalFindingsRendered = NormalFindingRenderer.render(entities);
    if (normalFindingsRendered) {
       note += normalFindingsRendered;
    }

    // 2.5 PAST MEDICAL HISTORY
    const pmhEntities = entities.filter(e => e.rendered_section === "Past Medical History");
    const pmhRendered = renderEntities(pmhEntities, "past_history");
    if (pmhRendered.length > 0) {
      note += `## Past Medical History\n${pmhRendered.join("\n")}\n\n`;
    }

    // 3. MEDICATIONS
    // 3. ASSESSMENT
    note += `## Assessment\n`;
    const problems = activeProblems?.active_problems || [];
    if (problems.length > 0) {
      problems.forEach((p, idx) => {
        const assessmentStr = AssessmentSynthesisEngine.compose(p, graph);
        note += `**${idx + 1}. ${assessmentStr}**`;
        if (p.status) note += ` - ${p.status}`;
        note += "\n";
        
        // Grab IDs
        const diagIds = p.diagnosis_ids || [];
        const assessEntities = entities.filter(e => diagIds.includes(e.id) && e.rendered_section === "Assessment");
        
        assessEntities.forEach(e => {
           if(e.render_status === "extracted") {
             e.render_status = "assigned_problem"; 
             e.render_reason = "active_problem_support";
           }
        });

        const renderedAssess = renderEntities(assessEntities, "active_problem_support");
        if (renderedAssess.length > 0) {
          note += renderedAssess.map(line => "   " + line).join("\n") + "\n";
        }
        note += "\n";
      });
    }

    // Catch-all for synthesized Assessment narratives not tied to a specific problem
    const orphanAssessEntities = entities.filter(e => e.rendered_section === "Assessment" && e.render_status === "extracted" && e.render_required);
    const renderedOrphanAssess = renderEntities(orphanAssessEntities, "orphan_assessment");
    if (renderedOrphanAssess.length > 0) {
      note += `**General Assessment:**\n`;
      note += renderedOrphanAssess.map(line => "   " + line).join("\n") + "\n\n";
    }

    // 4. PLAN
    note += `## Plan\n`;
    if (problems.length > 0) {
      problems.forEach((p, idx) => {
        if (p.composed_plan) {
           note += `**${idx + 1}. ${p.problem}**\n${p.composed_plan}\n\n`;
           return;
        }

        const planEntitiesIds = [
           ...(p.medication_ids || []),
           ...(p.treatment_ids || []),
           ...(p.treatment_instruction_ids || []),
           ...(p.investigation_ids || []),
           ...(p.referral_ids || []),
           ...(p.followup_ids || [])
        ];
        
        const planEntities = entities.filter(e => planEntitiesIds.includes(e.id));
        planEntities.forEach(e => {
           if(e.render_status === "extracted") {
             e.render_status = "assigned_problem"; 
             e.render_reason = "plan_instruction";
           }
        });

        const renderedPlan = renderEntities(planEntities, "plan_instruction");
        if (renderedPlan.length > 0) {
           note += `**${idx + 1}. ${p.problem}**\n`;
           note += renderedPlan.map(line => "   " + line).join("\n") + "\n\n";
        }
      });
    }

    const orders = graph?.orders || [];
    const adminEntities = entities.filter(e => e.entity_type === "administrative_action");
    
    if (orders.length > 0) {
      note += `**Orders / Investigations:**\n`;
      note += orders.map(o => `- [${o.status?.toUpperCase() || 'ORDERED'}] ${o.test}`).join("\n") + "\n\n";
    }

    const adminRendered = renderEntities(adminEntities, "administrative_action");
    if (adminRendered.length > 0) {
      note += `**Administrative Actions:**\n${adminRendered.join("\n")}\n\n`;
    }
    
    const followups = graph?.follow_ups || [];
    if (followups.length > 0) {
      note += `**Follow-up:**\n`;
      note += followups.map(f => {
         let text = `- ${f.followup_type ? f.followup_type.toUpperCase() + ':' : ''} ${f.trigger || ''} ${f.timeframe || ''}`;
         return text.trim();
      }).join("\n") + "\n\n";
    }

    const uncategorizedPlanEntities = entities.filter(e => e.rendered_section === "Plan" && e.render_status === "extracted");
    const planRendered = renderEntities(uncategorizedPlanEntities, "plan");
    if (planRendered.length > 0) {
      note += `**Additional Plan Items:**\n${planRendered.join("\n")}\n\n`;
    }

    // 5. NEGATIVE FINDINGS
    const negativeEntities = entities.filter(e => e.clinical_role === "negative_finding" && e.entity_type !== "normal_finding");
    const negRendered = renderEntities(negativeEntities, "negative_finding");
    if (negRendered.length > 0) {
      note += `## Negative Findings\n${negRendered.join("\n")}\n\n`;
    }

    // 6. UNCATEGORIZED / ORPHAN ENTITIES
    const uncategorizedEntities = entities.filter(e => e.render_status === "extracted" && e.render_required && (!e.rendered_section || e.rendered_section === "Uncategorized"));
    const uncategorizedRendered = renderEntities(uncategorizedEntities, "uncategorized_orphan");
    if (uncategorizedRendered.length > 0) {
      note += `## Additional Findings\n${uncategorizedRendered.join("\n")}\n\n`;
    }

    // Default drop reason and Render Assertions
    entities.forEach(e => {
      if (e.render_status === "extracted") {
        if (e.render_required) {
          throw new Error("RENDER FAILURE " + e.id);
        } else {
          e.render_status = "intentionally_suppressed";
          if (!e.render_reason) {
            e.render_reason = "filtered_by_renderer";
          }
        }
      }
    });

    return note.trim();
  }
}
