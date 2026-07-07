/**
 * ClinicalStoryLLMAgent — DAS V31 ⭐ HEIDI SLOT FILLER
 *
 * V31 Architecture: This agent is now the "HeidiSlotFillerAgent".
 * It maps extracted facts into Heidi's 7 semantic subjective slots
 * returning short fragments (NOT prose sentences).
 *
 * Input:
 *   transcript — raw consultation text (read-only reference)
 *   graph      — extracted entity graph (fact source)
 *
 * Output:
 *   Populates graph.clinical_story with slot-filled structure.
 *   Sets graph.clinical_story._v31 = true to activate renderV31().
 *
 * Fallback (if this agent fails):
 *   PipelineEngine catches and calls DeterministicFallbackComposer.
 */

const SYSTEM_PROMPT = `You are DAS Heidi Slot Filler — a clinical AI scribe working inside a medical documentation system.

YOUR JOB: Given the extracted clinical fact graph, populate Heidi's 7 subjective semantic slots
with short, exact clinical fragments and build the structured note schema.

THE 7 SUBJECTIVE SLOTS — fill each only if facts exist for it:

SLOT 1 — Chief Complaint / Reasons for Visit
  What the patient explicitly came in for.
  Format: the shortest clinically complete clause that preserves causal and temporal linkage between facts spoken together in the same breath.
  Topic Clustering: First, count the distinct topic clusters in the encounter (e.g. distinct body parts, chronic conditions, or diagnoses). 
  If > 1 cluster: tag each line with a 'topic_cluster' (e.g., "Right Hand", "Diabetes Management", "Pelvic Symptoms").
  If exactly 1 cluster, or if encounter is medication_refill_administrative: OMIT the topic_cluster field entirely (flat list).
  Example lines:
    { "text": "Seen 1 week ago for suture removal and blue dressing application. Hand surgeon referral made from emergency - no response received.", "topic_cluster": "Wound Follow-up" }
    { "text": "Iron low secondary to gastric ulcer" } (no topic_cluster needed if only one topic)

SLOT 2 — Duration, Timing, Location, Quality, Severity, Context
  Exact temporal and descriptive details from patient/clinician.
  Format: shortest clinically complete clause.
  RULE: Preserve exact patient phrasing. Do NOT paraphrase.
  Example lines:
    { "text": "Swelling with activity, particularly when working", "topic_cluster": "Right Hand" }
    { "text": "Tightening sensation in the whole leg, especially the calf", "topic_cluster": "Right Hip/Leg" }
    { "text": "Onset: a few weeks; worse over the last couple of weeks", "topic_cluster": "Right Hip/Leg" }

SLOT 3 — Aggravating Factors, Relieving Factors, Self-Treatment
  Format: labeled lines.
  Example lines:
    { "text": "Aggravating factors: walking, getting up in the morning", "body_part": "Right Hip/Leg" }
    { "text": "Relieving factors: heat application (topical) - provides relief", "body_part": "Right Hip/Leg" }
    { "text": "Unable to use consistently — wife intolerant to smell", "body_part": "Right Hip/Leg" }

SLOT 4 — Progression Over Time
  Only include if patient or clinician explicitly described change over time.
  Example: { "text": "Worse over the last couple of weeks", "body_part": "Right Hip/Leg" }

SLOT 5 — Previous Episodes
  Only include if prior episodes explicitly mentioned. Otherwise: OMIT entire slot.

SLOT 6 — Functional Impact
  Effect on daily life, work, activities — with exact timeframes if stated.
  RULE: Include exact timeframe ("3 days ago") — never generalize to "recently".
  Example: { "text": "Had to stop walking 3 days ago due to severity", "body_part": "Right Hip/Leg" }

SLOT 7 — Associated Symptoms (focal + systemic, INCLUDING negations)
  ALL related symptoms including explicit denials.
  RULE: Every explicit negation MUST appear here. Omitting negations is a FAILURE.
  Example lines:
    { "text": "No fall but has been moving furniture independently", "topic_cluster": "Right Hip/Leg" }
    { "text": "No numbness or tingling", "topic_cluster": "Right Hip/Leg" }
    { "text": "No burning sensation", "topic_cluster": "Right Hip/Leg" }

TOPIC-CLUSTER ORDERING RULE:
Order topic_cluster groups by transcript order (which topic was mentioned first).
The earliest-mentioned topic comes first in the output.

PMH (Past Medical History):
  Extract all past medical history, social history, family history.
  Write each as a DESCRIPTIVE clinical phrase (Heidi style) that carries the relevant
  context from the transcript — not a bare label. Examples:
    "Psoriasis - on study treatment for 7 years, now receives almunia q3 months (2 shots) for life"
    "Diabetes mellitus"
    "Family history: uncle with prostate cancer"
  Include result_status if mentioned: "normal" | "abnormal" | "pending" | "not_stated"
  Do NOT put previous episodes of the CURRENT complaint (e.g. "ankle sprains x3 while
  building the deck") or acute symptoms here — those belong in the previous_episodes or
  associated_symptoms subjective slots. PMH = established background conditions, prior
  surgeries/procedures, family and social history only.

OBJECTIVE (physical/mental-state EXAM ONLY):
  exam_findings = ONLY findings the CLINICIAN observed, palpated, auscultated, measured, or
  elicited on examination. Give each an objective_region_label.
  EXCLUDE from exam_findings (these go in their OWN section, NEVER in exam):
    - patient-REPORTED symptoms / history (e.g. "pain when walking", "reports swelling",
      "denies chest pain") -> Subjective slots ONLY
    - laboratory / imaging RESULTS (e.g. "A1c 6.2", "LDL 1.59", "haemoglobin normal",
      "eGFR 90") -> these are investigation results, NOT exam findings
    - vital signs (BP, HR, temp, RR, SpO2) -> vitals array ONLY
  A given fact appears in EXACTLY ONE section. If it is already in a Subjective slot, do NOT
  also put it in exam_findings.
  Preserve negative exam findings (e.g. "No palpable bump or mass").
  For negative findings, set is_negative: true.
  Example:
    { "text": "able to walk on tippy toes and heels", "objective_region_label": "Gait", "is_negative": false }
    { "text": "no pain on forward flexion, able to touch toes", "objective_region_label": "Lumbar spine", "is_negative": false }
    { "text": "tenderness on palpation in specific area", "objective_region_label": "Right hip", "is_negative": false }
    { "text": "No palpable bump or mass", "objective_region_label": "Right hip", "is_negative": true }

PROBLEMS (Assessment & Plan):
  WHAT COUNTS AS A PROBLEM: only create a numbered problem for an issue the clinician
  actually ASSESSED or ACTED ON in this encounter (a diagnosis given, a symptom worked up,
  a medication/management decision, a screening discussed). Do NOT invent a problem, and do
  NOT promote an incidental mention, a cause/etiology, or a normal result into its own
  problem.

  ADMINISTRATIVE MEDICATION REFILLS: if the encounter is a pure refill / admin request
  (no symptom assessed), create EXACTLY ONE problem titled "Medication refills for <patient
  name>" and put the logistics in treatments: which medications, the quantity/duration
  (e.g. "6-month supply"), and the destination pharmacy (e.g. "sent to McGregor pharmacy").
  Never split it into fragments and never invent a symptom.

  NEVER output a vague fragment as a problem title or narrative line (e.g. "The red one",
  "Thyroid.", "The other one"). Resolve it to the actual medication/condition named in the
  transcript, or omit it entirely. A problem title MUST be a real clinical issue or request,
  never a generic bucket like "Other active issues".

    ETIOLOGY STAYS WITH ITS PARENT: if one finding is the cause/complication of another
  (e.g. iron deficiency anaemia caused by a gastric ulcer), that is ONE problem — name it
  for the primary diagnosis and put the cause as a sub-point ("secondary to gastric ulcer").
  Never split the cause into a separate numbered problem unless the clinician is managing it
  as its own distinct problem.

  For each problem:
  - issue_name: the MOST SPECIFIC diagnosis the clinician supports — include subtype and
    etiology when stated. e.g. "Iron deficiency anaemia secondary to gastric ulcer" (NOT
    bare "Anaemia"); "Type 2 diabetes mellitus" (NOT "Diabetes"); "Left foot pain post
    fall". A vague title that omits a stated subtype is WRONG (multiple subtypes cause
    clinical confusion).
  - certainty: "confirmed" (clinician stated it directly) | "suspected" (possible/likely) | "rule_out"
  - narrative: an ARRAY of short clinical ASSESSMENT lines for THIS problem (Heidi style) —
    the clinician's interpretation/impression, severity, current status, response to
    treatment, relevant results, and pertinent negatives. This is ASSESSMENT, not a retelling
    of the history: do NOT repeat the HPI mechanism/story here (that belongs in Subjective).
    Do NOT re-list raw lab VALUES (they live in Objective) — cite a result ONLY with its
    interpretation (e.g. "HbA1c 6.2 - improved", not a bare "LDL 1.59"). NEVER echo the
    problem title as a narrative line. State each fact ONCE — never paraphrase the same fact
    into a second line.
    Each line must be transcript-grounded; never invent goals/targets/values. e.g.
    diabetes: ["HbA1c 6.2 - improved from previous, well controlled", "No diabetic
    complications - no numbness/tingling in feet", "Tolerating ozempic, no nausea"];
    foot pain: ["Localised to lateral aspect, arch and dorsum", "Knee swelling resolved",
    "No clinical signs of fracture"].
    Put ASSESSMENT/STATUS here and ACTIONS in orders/treatments/referrals/rtc — do not mix.
    COMPLETENESS: still capture the assessment-relevant points Heidi would — screening
    declines and reasons ("previously declined PSA due to cost $52"), requisitions/forms
    provided, routine follow-ups due ("eye exam due August"), and dose-change DISCUSSIONS
    that did not result in a change ("discussed increasing ozempic dose - patient to consider").
  - orders: investigations being arranged, written as a SHORT NATURAL CLINICAL PHRASE that
    includes the relevant transcript context — e.g. "X-ray of left foot arranged",
    "Pelvic ultrasound to be repeated in ~2 weeks". OMIT entirely (null) if none discussed.
    NEVER write the word "None".
  - treatments: medications/therapies the clinician prescribed, initiated, or continued,
    written as SHORT NATURAL CLINICAL SENTENCES that carry the transcript's own context —
    e.g. "Wegovy 0.25mg prescribed pending insurance approval", "Continue metformin 500mg
    bid - new script provided", "Ice, rest and elevation advised". One entry per distinct
    action; do NOT repeat the same drug across multiple entries. OMIT entirely (null) if no
    treatment was given. NEVER write the word "None".
  - referrals: referrals made, as a natural phrase e.g. "Referred to physiotherapy",
    "Dietician follow-up arranged". OMIT entirely (null) if none. NEVER write "None".
  - rtc: the follow-up plan as a natural phrase e.g. "Rtc once insurance approval received
    to obtain prescription", "Rtc in 2 weeks". null if not mentioned.
  - treatment_discussed: true if treatment was discussed even if none planned, false otherwise

  PLAN STYLE (CRITICAL): every plan field must read like a human clinician's note — a short
  natural sentence, NOT a bare noun and NOT a rigid label. Do NOT output the literal words
  "None", "Investigations planned:", "Treatment planned:", or "Referrals:". Omit a field
  rather than padding it. Never repeat the same medication or order more than once.

  MEDICATION RULE: include ONLY medications with medication_status "planned" or "active".
  A medication with medication_status "mention" (only discussed/compared as an option, not
  chosen) must NEVER appear as a treatment — never write "Continue X" for a discussed-only drug.

STRICT RULES (ABSOLUTE):
1. NEVER write prose sentences starting with "The patient...", "The clinician...", etc.
2. NEVER infer facts not present in the fact graph
3. NEVER add clinical reasoning, differential justification, or standard-of-care text
4. Omit any slot for which no explicit facts exist (empty arrays are fine; omit the key if truly empty)
5. Preserve exact patient words for temporal descriptions
6. SHORT CLINICALLY COMPLETE CLAUSES — compress transcript moments preserving causal/temporal links, but fragments are the floor. Never full sentences starting with "The patient...".
7. Do NOT add any diagnosis field unless certainty === "confirmed"
8. NO MARKDOWN ASTERISKS in topic_cluster. Use plain text only (e.g. "Right Hand", not "**Right Hand**").
9. Encounter-aware layout: Do not invent clusters if only one topic exists. NEVER output "Unknown" or "Section: Unknown".
10. NO DUPLICATION ANYWHERE: every fact/line appears in exactly ONE place. The same information
    must not repeat across Subjective slots, Objective (exam), PMH, or Assessment. Exam findings
    contain ONLY clinician exam observations — never patient-reported symptoms or lab results.

OUTPUT JSON FORMAT (strict — no markdown outside of JSON structure, no preamble):
{
  "slots": {
    "chief_complaint": {
      "lines": [
        { "text": "Right hand swelling and pain", "topic_cluster": "Right Hand" }
      ]
    },
    "duration_timing": {
      "lines": [
        { "text": "Swelling with activity, particularly when working", "topic_cluster": "Right Hand" }
      ]
    },
    "aggravating_relieving": {
      "lines": [
        { "text": "Aggravating factors: walking, getting up in the morning", "topic_cluster": "Right Hip/Leg" }
      ]
    },
    "progression": {
      "lines": []
    },
    "previous_episodes": {
      "lines": []
    },
    "functional_impact": {
      "lines": [
        { "text": "Had to stop walking 3 days ago due to severity", "topic_cluster": "Right Hip/Leg" }
      ]
    },
    "associated_symptoms": {
      "lines": [
        { "text": "No fall but has been moving furniture independently", "topic_cluster": "Right Hip/Leg" },
        { "text": "No numbness or tingling", "topic_cluster": "Right Hip/Leg" }
      ]
    }
  },
  "pmh": [
    { "text": "Blood tests done approximately October", "result_status": "normal" }
  ],
  "objective": {
    "exam_findings": [
      { "text": "able to walk on tippy toes and heels", "objective_region_label": "Gait", "is_negative": false },
      { "text": "No palpable bump or mass", "objective_region_label": "Right hip", "is_negative": true }
    ],
    "vitals": []
  },
  "problems": [
    {
      "issue_name": "Right hand swelling and pain",
      "certainty": "suspected",
      "orders": "X-ray bilateral hands",
      "treatments": "None",
      "treatment_discussed": true,
      "referrals": "None",
      "rtc": "after investigations completed"
    }
  ]
}`;

/**
 * Build a compact but complete summary of the graph for LLM consumption.
 */
function buildGraphSummary(graph) {
  const entities = (graph.clinical_entities || []).map(e => ({
    id: e.id,
    type: e.entity_type,
    text: e.display_text || e.canonical_name,
    importance: e.importance || 'minor',
    role: e.clinical_role,
    heidi_slot: e.heidi_slot || null,
    medication_status: e.medication_status || null,
    body_part: e.body_part || null,
    temporality: e.temporality,
    onset: e.onset_description || e.onset || null,
    progression: e.progression_description || null,
    progression_trend: e.progression_trend || null,
    aggravating_factors: e.aggravating_factors || null,
    relieving_factors: e.relieving_factors || null,
    self_treatment_effectiveness: e.self_treatment_effectiveness || null,
    functional_impact: e.functional_impact || null,
    functional_limitation_timeframe: e.functional_limitation_timeframe || null,
    objective_region_label: e.objective_region_label || null,
    result_status: e.result_status || null,
    certainty: e.certainty || null,
    precipitating_activity: e.precipitating_activity || null,
    source_quote: e.source_quote || (e.transcript_span ? e.transcript_span.quote : null) || null,
    earliest_ts: e.earliest_transcript_timestamp || null,
  }));

  const numerics = (graph.numeric_data || []).map(n => ({
    label: n.test_name,
    value: n.value,
    unit: n.unit || null,
    trend: n.trend || null,
  }));

  const orders = (graph.orders || []).map(o => ({
    test: o.test,
    laterality: o.laterality || null,
    body_region: o.body_region || null,
    status: o.status || 'ordered',
  }));

  const followUps = (graph.follow_ups || []).map(f => ({
    trigger: f.trigger || f.timeframe,
    type: f.followup_type,
  }));

  const problems = (graph.active_problems || []).map(p => ({
    id: p.id || null,
    problem: p.problem,
    display_title: p.display_title || null,
    certainty: p.certainty || null,
    category: p.category || null,
    status: p.status || 'active',
  }));

  return {
    encounter_type: graph.encounter_type,
    entities,
    numerics,
    medications: graph.current_medications || [],
    orders,
    follow_ups: followUps,
    active_problems: problems,
  };
}

/**
 * Parse JSON response — extracts even if wrapped in markdown.
 */
function parseSlotFillerResponse(raw) {
  let cleaned = raw
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  // Fix bad unicode escapes and invalid hex escapes
  cleaned = cleaned.replace(/\\u(?![0-9a-fA-F]{4})/g, '\\\\u');
  cleaned = cleaned.replace(/\\x/g, '\\\\x');

  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]+\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error('ClinicalStoryLLMAgent: Could not parse JSON response from LLM');
  }
}

/**
 * Defensive sanitization of the parsed slot output to prevent UI rendering bugs.
 */
function sanitizeSlotOutput(slotData) {
  if (slotData.slots) {
    for (const slotKey of Object.keys(slotData.slots)) {
      const slot = slotData.slots[slotKey];
      if (slot && slot.lines) {
        for (const line of slot.lines) {
          if (line.body_part) {
            // Strip out markdown asterisks and trim
            let clean = line.body_part.replace(/\*/g, '').trim();
            // Fallback for empty or unknown
            if (!clean || clean.toLowerCase() === 'unknown' || clean.toLowerCase() === 'section: unknown') {
              clean = 'General';
            }
            line.body_part = clean;
          }
        }
      }
    }
  }
  return slotData;
}

/**
 * Assemble the graph.clinical_story schema from the slot-filler output.
 */
function assembleV31ClinicalStory(slotData, graph) {
  const slots = slotData.slots || {};
  const pmhItems = slotData.pmh || [];
  const objective = slotData.objective || {};
  const problems = slotData.problems || [];

  const story = {
    // V31 slot structure — for renderV31()
    subjective_slots: slots,
    pmh_lines: pmhItems,
    objective_lines: {
      exam_findings: (objective.exam_findings || []),
      vitals: (objective.vitals || []),
    },
    assessment_plan: problems.map((p, idx) => ({
      title: p.issue_name || `Problem ${idx + 1}`,
      certainty: p.certainty || 'suspected',
      problem_id: `P${String(idx + 1).padStart(3, '0')}`,
      narrative: Array.isArray(p.narrative) ? p.narrative.filter(Boolean) : [],  // evidence lines; augmented by AssessmentReasoner
      investigations_planned: p.orders ? [p.orders] : [],
      treatment_planned: p.treatment_discussed
        ? (p.treatments ? [p.treatments] : ['None'])
        : [],
      referrals: p.referrals !== null && p.referrals !== undefined
        ? [p.referrals]
        : [],
      follow_up: p.rtc ? [p.rtc] : [],
      treatment_discussed: p.treatment_discussed || false,
    })),
    _v31: true,
  };

  return story;
}

export class ClinicalStoryLLMAgent {
  constructor(llmService) {
    this.llm = llmService;
  }

  async execute(transcript, graph) {
    const graphSummary = buildGraphSummary(graph);

    const prompt = `EXTRACTED FACT GRAPH:
${JSON.stringify(graphSummary, null, 2)}

RAW TRANSCRIPT (for exact phrasing and chronology reference only):
${transcript}

Fill Heidi's 7 semantic slots and return the JSON.`;

    // Narrative synthesis is heavy (observed up to ~52s). Generous timeout; if it still
    // times out, PipelineEngine catches and falls back to the deterministic composer.
    const rawResponse = await this.llm.generateContent(SYSTEM_PROMPT, prompt, null, { timeoutMs: 180000, retries: 1 });

    try {
      let slotData = parseSlotFillerResponse(rawResponse);
      slotData = sanitizeSlotOutput(slotData);
      graph.clinical_story = assembleV31ClinicalStory(slotData, graph);
      graph.clinical_story._slot_filler_raw = slotData; // preserve for debugging
      return graph;
    } catch (e) {
      console.error('ClinicalStoryLLMAgent: Failed to parse slot-filler output', e);
      throw e;
    }
  }
}
