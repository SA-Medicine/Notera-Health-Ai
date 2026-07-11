import { loadPrompt } from '../../../prompts/registry.js';
import { safeParseJson } from '../utils/safeParseJson.js';

export class ClinicalObservationExtractorAgent {
  constructor(llmService) {
    this.llm = llmService;
  }

  async execute(transcript, encounterType) {
    const systemInstruction = loadPrompt('observation-extractor', `You are a Universal Clinical Knowledge Graph Engine.
Extract every clinically relevant entity from the transcript into a structured Graph.

Rules:
1. Never summarize. Never combine entities. One clinical fact = one record.
2. source_quote: Provide the exact verbatim transcript snippet that proves this entity. This is CRITICAL for provenance.
3. locked: Set to true for ANY diagnosis, medication, lab, or order to prevent downstream modification.

Context Preservation Rules:
Extract ALL narrative context including:
- injury mechanisms ("landed on left knee with twisting mechanism" -> injury_mechanism)
- environmental context ("fixing garage door opener" -> contextual_activity)
- patient quotes
- treatment history ("study treatment for 7 years" -> treatment_duration)
- resolved symptoms ("knee swelling now resolved" -> resolved_symptom)
- previous episodes ("three ankle sprains while building deck" -> previous_episode)
- lifestyle behaviors ("watching diet and avoiding sugar" -> lifestyle_modification)
- medication tolerance ("no nausea with ozempic" -> medication_tolerance)
- clinician reasoning ("clinician_reasoning")

Diagnosis Preservation (CRITICAL):
- NEVER translate clinical terminology into lay terms.
- If the transcript says "Tinea Pedis", output "Tinea Pedis", NOT "Fungus".

Separation of Entity and Role:
- entity_type: "diagnosis" | "symptom" | "physical_exam" | "medication" | "treatment" | "treatment_instruction" | "investigation" | "referral" | "follow_up" | "administrative_action" | "patient_preference" | "shared_decision_making" | "care_barrier" | "pmh" | "family_history" | "social_history" | "temporal_reference" | "clinical_impression" | "lab_result" | "clinical_context" | "procedure_history" | "medication_order" | "normal_finding" | "temporal_event" | "injury_mechanism" | "contextual_activity" | "resolved_symptom" | "medication_tolerance" | "lifestyle_modification" | "previous_episode" | "treatment_duration" | "clinician_reasoning",
  clinical_role: "active_problem" | "past_history" | "negative_finding" | "family_history" | "observation",

Extraction Rules:
1. ONLY extract explicitly mentioned facts. No guessing.
2. If numeric_type is "age", ONLY extract if the transcript explicitly says "Age: X" or "X year old". Do NOT infer age from DOB.
3. For medications, MUST populate 'medication', 'dose', and 'frequency' if mentioned in the transcript. NEVER lose frequency context.
4. Include a confidence score (0.0 to 1.0) and the exact source_span.
5. Set 'locked' to true for diagnoses, medications, labs, and orders.
6. Set 'render_priority' appropriately (critical, high, medium, background).

═══════════════════════════════════════════════
V31 HEIDI SCHEMA EXTRACTION RULES
═══════════════════════════════════════════════

HEIDI SLOT ASSIGNMENT (MANDATORY):
Assign heidi_slot to EVERY fact you extract. Use these mappings:

  chief_complaint     → the exact reason patient came in (what they explicitly said)
  duration_timing     → onset, duration, location, quality, severity, context of symptoms
  aggravating_relieving → triggers, what makes it worse/better, self-treatments
  progression         → how symptoms have changed over time since onset
  previous_episodes   → prior occurrences of same/similar symptoms
  functional_impact   → how symptoms affect daily life, work, activities
  associated_symptoms → other symptoms related to the presenting complaint
  pmh                 → past medical history, social history, family history
  objective           → physical exam findings, vital signs, completed test results
  problem             → a diagnosis or clinical problem the clinician named

AGGRAVATING & RELIEVING FACTORS (Slot 3):
Extract as dedicated fields on the parent symptom fact:
  aggravating_factors: ["walking", "getting up in the morning"]
  relieving_factors: [{ "factor": "heat application (topical)", "context": "provides relief" }]
  self_treatment_attempted: true
  self_treatment_effectiveness: "provides relief but cannot use consistently — wife intolerant to smell"

TEMPORAL AND QUALITY DETAILS (Slot 2):
  onset_description: "a few weeks" (exact patient words — do NOT paraphrase)
  progression_description: "worse over the last couple of weeks"
  progression_trend: "worsening"
  quality_description: "tightening and burning sensation"
  duration_description: "constant"
  location_detail: "especially the calf"
  functional_limitation_timeframe: "3 days ago"

FUNCTIONAL IMPACT (Slot 6):
  functional_impact: "Had to stop walking 3 days ago due to severity"
  functional_domain: "mobility"

BODY PART TAGGING (MANDATORY):
Every symptom, physical_exam, or subjective fact MUST have body_part set.
  body_part: "Right Hand" | "Right Hip/Leg" | "Left Knee" | etc.
  Use the same body_part string for all facts belonging to the same anatomical region.
  Use transcript order of first mention to determine which body_part appears first.

NEGATIVE FINDINGS — ABSOLUTE MANDATORY RULE:
Every explicit denial in the transcript MUST be extracted.
  clinical_role: "negative_finding"
  heidi_slot: "associated_symptoms" (for symptom negations)
           OR "objective" (for exam finding negations)

Examples:
  "No numbness or tingling" → { clinical_role: "negative_finding", display_text: "No numbness or tingling", heidi_slot: "associated_symptoms" }
  "No fall"                 → { clinical_role: "negative_finding", display_text: "No fall", heidi_slot: "associated_symptoms" }
  "No burning sensation"    → { clinical_role: "negative_finding", display_text: "No burning sensation", heidi_slot: "associated_symptoms" }
  "No palpable bump or mass"→ { clinical_role: "negative_finding", display_text: "No palpable bump or mass", heidi_slot: "objective", objective_region_label: "Right hip" }

DENIED MEDICATIONS — CRITICAL: when the patient denies taking a drug ("I don't take any of
those", "no aspirin", "no Tylenol", "none of that"), extract it as a medication with
is_negative: true AND clinical_role: "negative_finding" AND medication_status: "historical".
This guarantees it is NEVER rendered as a treatment line.
  "Tylenol number threes? I don't take any" → { entity_type: "medication", medication: "Tylenol #3", is_negative: true, clinical_role: "negative_finding", medication_status: "historical" }
  "I take no aspirin"                        → { entity_type: "medication", medication: "aspirin", is_negative: true, clinical_role: "negative_finding", medication_status: "historical" }

LAB / TEST RESULT STATUS:
For any historical or completed test, always extract result_status:
  "results were fine"   → result_status: "normal"
  "results were normal" → result_status: "normal"
  "results abnormal"    → result_status: "abnormal"
  Not stated            → result_status: "not_stated"

LAB COMPLETENESS (CRITICAL — do not skip qualitative results):
Extract EVERY lab/test the clinician reviews as its own lab_result entity, INCLUDING ones
reported only qualitatively as normal/fine/good. Examples from a blood-work review:
  "your hemoglobin is fine"   → lab_result, display_text "Hemoglobin: normal"
  "your sodium was fine"      → lab_result, display_text "Sodium: normal"
  "kidneys are fantastic / EGFR 1.7" → lab_result "Kidney function: normal", lab_result "eGFR: 1.7"
  "cholesterol is very good"  → lab_result, display_text "Cholesterol: good"
  "iron is pristine"          → lab_result, display_text "Iron studies: normal"
  "your sugar was six point three" → lab_result "Blood glucose: 6.3"
Never drop a lab just because it was normal — Heidi lists the full panel.
LAB COLLECTION DATE: if a blood draw / panel date is stated (e.g. "blood test on June first"),
set observation_date (ISO if possible, e.g. "2026-06-01") on EVERY lab_result from that panel
so the Blood Work section can be dated.

OBJECTIVE REGION LABELS:
Every physical_exam fact MUST have objective_region_label:
  "able to walk on tippy toes and heels"  → objective_region_label: "Gait"
  "no pain on forward flexion"             → objective_region_label: "Lumbar spine"
  "tenderness on palpation"               → objective_region_label: "Right hip"
  "no palpable bump or mass"              → objective_region_label: "Right hip"

PRECIPITATING ACTIVITY:
  precipitating_activity: "moving furniture independently"
  had_fall: false (extract from "no fall" negation)

PROBLEM CERTAINTY:
  certainty: "confirmed"   — clinician explicitly stated this as the diagnosis (do NOT guess based on medications)
  certainty: "suspected"   — clinician used words like "possible", "likely", "probable", "might be"
  certainty: "rule_out"    — clinician used "rule out", "exclude"

MEDICATIONS (tagging):
Must tag all medications with medication_status:
  "active" — patient is currently taking it or relies on it
  "planned" — newly prescribed, initiated, or dose-adjusted today (an actual order)
  "historical" — previously taken, discontinued, or mentioned as an allergy/intolerance without current use
  "mention" — only discussed, compared, or considered as an option, but NOT prescribed,
              continued, or chosen this visit (e.g. a drug named as an alternative the
              patient is not actually taking). NEVER tag a drug "active" or "planned"
              unless the clinician confirmed the patient is taking it or is prescribing it.
              A drug that merely came up in conversation is "mention".

NUMERIC PLAUSIBILITY:
For any extracted numeric value (weight, BP, labs), evaluate if the number makes clinical sense in context.
Set is_plausible: false if it appears to be a transcription error or wildly out of physiological bounds. Otherwise true.

ENCOUNTER SUBJECT:
Identify the primary clinical subject or theme of the encounter (e.g. "Right Knee", "Type 2 Diabetes") in the root 'encounter_subject' field.

Rendering & Priority:
- clinical_priority: critical, high, medium, low, background.
- render_priority: must_render, should_render, optional, hidden.`);

    const prompt = `CONSULTATION TRANSCRIPT:\n\n${transcript}\n\nConvert into clinical entities and return the JSON.`;
    
    const responseSchema = {
      type: "OBJECT",
      properties: {
        clinical_entities: {
          type: "ARRAY",
          items: {
            type: "OBJECT",
            properties: {
              entity_type: { type: "STRING", enum: ["diagnosis", "symptom", "physical_exam", "medication", "treatment", "treatment_instruction", "investigation", "referral", "follow_up", "administrative_action", "patient_preference", "shared_decision_making", "care_barrier", "pmh", "family_history", "social_history", "temporal_reference", "clinical_impression", "lab_result", "clinical_context", "procedure_history", "medication_order", "normal_finding", "temporal_event", "injury_mechanism", "contextual_activity", "resolved_symptom", "medication_tolerance", "lifestyle_modification", "previous_episode", "treatment_duration", "clinician_reasoning"] },
              clinical_role: { type: "STRING", enum: ["active_problem", "past_history", "negative_finding", "family_history", "observation", "care_barrier"] },
              heidi_slot: { type: "STRING", enum: ["chief_complaint", "duration_timing", "aggravating_relieving", "progression", "previous_episodes", "functional_impact", "associated_symptoms", "pmh", "objective", "problem"] },
              canonical_name: { type: "STRING" },
              display_text: { type: "STRING" },
              patient_term: { type: "STRING" },
              medication: { type: "STRING" },
              medication_status: { type: "STRING", enum: ["active", "historical", "planned", "mention"] },
              dose: { type: "STRING" },
              frequency: { type: "STRING" },
              confidence: { type: "NUMBER" },
              source_span: { type: "STRING" },
              source_quote: { type: "STRING" },
              importance: { type: "STRING", enum: ["critical", "major", "minor", "background"] },
              heidi_style_key: { type: "STRING" },
              value: { type: "STRING" },
              unit: { type: "STRING" },
              numeric_type: { type: "STRING", enum: ["age", "vitals", "lab_result", "other"] },
              actor: { type: "STRING", enum: ["patient", "physician", "family_member", "other"] },
              status: { type: "STRING", enum: ["active", "resolved", "worsening", "improving", "chronic", "suspected", "ruled_out", "unknown"] },
              certainty: { type: "STRING", enum: ["confirmed", "suspected", "rule_out"] },
              render_required: { type: "BOOLEAN" },
              locked: { type: "BOOLEAN" },
              render_priority: { type: "STRING", enum: ["critical", "high", "medium", "background"] },
              barrier_type: { type: "STRING", enum: ["insurance", "cost", "transportation", "wait_time", "language", "accessibility", "other"] },
              clinical_priority: { type: "STRING", enum: ["critical", "high", "medium", "low", "background"] },
              // V31 new fields
              body_part: { type: "STRING" },
              aggravating_factors: { type: "ARRAY", items: { type: "STRING" } },
              relieving_factors: {
                type: "ARRAY",
                items: {
                  type: "OBJECT",
                  properties: {
                    factor: { type: "STRING" },
                    context: { type: "STRING" }
                  },
                  required: ["factor"]
                }
              },
              self_treatment_attempted: { type: "BOOLEAN" },
              self_treatment_effectiveness: { type: "STRING" },
              onset_description: { type: "STRING" },
              progression_trend: { type: "STRING", enum: ["worsening", "improving", "stable", "fluctuating"] },
              progression_description: { type: "STRING" },
              quality_description: { type: "STRING" },
              duration_description: { type: "STRING" },
              location_detail: { type: "STRING" },
              functional_impact: { type: "STRING" },
              functional_domain: { type: "STRING" },
              functional_limitation_timeframe: { type: "STRING" },
              objective_region_label: { type: "STRING" },
              result_status: { type: "STRING", enum: ["normal", "abnormal", "pending", "not_stated"] },
              earliest_transcript_timestamp: { type: "NUMBER" },
              precipitating_activity: { type: "STRING" },
              family_history_fact: { type: "BOOLEAN" },
              menstrual_cycle_history: {
                type: "ARRAY",
                items: {
                  type: "OBJECT",
                  properties: {
                    start_date: { type: "STRING" },
                    end_date: { type: "STRING" },
                    duration_days: { type: "INTEGER" }
                  }
                }
              }
            },
            required: ["entity_type", "clinical_role", "display_text", "confidence", "source_span", "source_quote", "importance", "actor", "status", "render_required", "locked", "render_priority", "clinical_priority"]
          }
        },
        relationships: {
          type: "ARRAY",
          items: {
            type: "OBJECT",
            properties: {
              source_index: { type: "INTEGER", description: "Index in the clinical_entities array" },
              target_index: { type: "INTEGER", description: "Index in the clinical_entities array" },
              relationship: { type: "STRING", enum: ["affects", "treated_by", "investigated_by", "referred_to", "followed_by", "associated_with", "located_at", "caused_by", "secondary_to", "complication_of", "managed_by", "resolved_by", "supported_by", "monitored_by", "history_of"] }
            },
            required: ["source_index", "target_index", "relationship"]
          }
        },
        current_medications: { type: "ARRAY", items: { type: "STRING" } },
        numeric_data: {
          type: "ARRAY",
          items: {
            type: "OBJECT",
            properties: {
              numeric_type: { type: "STRING", enum: ["weight", "height", "bmi", "blood_pressure", "pulse", "temperature", "lab", "age", "dose"] },
              test_name: { type: "STRING" },
              value: { type: "STRING" },
              unit: { type: "STRING" },
              is_plausible: { type: "BOOLEAN" },
              source_text: { type: "STRING" },
              observation_date: { type: "STRING" },
              date_precision: { type: "STRING", enum: ["exact", "month", "relative"] }
            },
            required: ["numeric_type", "test_name", "value", "source_text"]
          }
        },
        orders: {
          type: "ARRAY",
          items: {
            type: "OBJECT",
            properties: {
              test: { type: "STRING" },
              status: { type: "STRING", enum: ["historical", "reviewed", "ordered", "pending", "awaiting_result"] },
              laterality: { type: "STRING" },
              body_region: { type: "STRING" }
            }
          }
        },
        follow_ups: {
          type: "ARRAY",
          items: {
            type: "OBJECT",
            properties: {
              trigger: { type: "STRING" },
              timeframe: { type: "STRING" },
              followup_type: { type: "STRING", enum: ["rtc", "specialist", "imaging", "lab", "medication", "pending_approval"] }
            },
            required: ["followup_type"]
          }
        },
        medication_decisions: {
          type: "ARRAY",
          items: {
            type: "OBJECT",
            properties: {
              medication: { type: "STRING" },
              current_dose: { type: "STRING" },
              planned_dose: { type: "STRING" },
              change_after: { type: "STRING" },
              action: { type: "STRING" },
              reason: { type: "STRING" }
            }
          }
        },
        encounter_subject: { type: "STRING" }
      },
      required: ["clinical_entities", "relationships"]
    };

    // Extraction is the essential, heaviest call (large transcripts → long output). Give
    // it generous time + a retry so a single slow response can't crash the whole note.
    const resultStr = await this.llm.generateContent(systemInstruction, prompt, responseSchema, { timeoutMs: 180000, retries: 1, maxOutputTokens: 65536 });
    
    try {
      const parsed = safeParseJson(resultStr);
      
      if (parsed.clinical_entities) {
        parsed.clinical_entities = parsed.clinical_entities.map(e => {
          e.fact_origin = "agent1";
          e.render_status = "extracted";
          
          // Deterministically compute transcript_span from source_quote
          let quote = e.source_quote || e.source_span || "";
          let start = -1;
          let end = -1;
          if (quote && transcript) {
            start = transcript.indexOf(quote);
            if (start !== -1) {
              end = start + quote.length;
            } else {
              start = transcript.toLowerCase().indexOf(quote.toLowerCase());
              if (start !== -1) {
                end = start + quote.length;
                quote = transcript.substring(start, end);
              }
            }
          }
          e.transcript_span = { quote, start, end };

          // Compute earliest_transcript_timestamp from span position if not provided by LLM
          if (e.earliest_transcript_timestamp == null && start >= 0) {
            // Approximate: 1 char ≈ 0.05 seconds in a typical consultation transcript
            e.earliest_transcript_timestamp = Math.round(start * 0.05);
          }
          
          return e;
        });
      }
      return parsed;
    } catch (e) {
      console.error("Failed to parse ClinicalObservationExtractor output", e);
      throw e;
    }
  }
}
