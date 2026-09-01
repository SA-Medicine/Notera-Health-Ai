import { loadPrompt, loadPromptConfig } from '../../../prompts/registry.js';
import { safeParseJson } from '../utils/safeParseJson.js';

export class FactRecoveryAgent {
  constructor(llmService) {
    this.llm = llmService;
  }

  async execute(transcript, missingCategories, entitiesObj) {
    console.log('🏷️ [PromptAgent] fact-recovery');
    const systemInstruction = loadPrompt('fact-recovery', `You are the DAS Targeted Fact Recovery Agent.
Your job is to read the RAW TRANSCRIPT and extract ONLY the clinical facts belonging to the missing categories provided.
Do NOT extract anything else.

MISSING CATEGORIES TO RECOVER:
${JSON.stringify(missingCategories)}

ClinicalEntity Interface:
{
  entity_type: "diagnosis" | "symptom" | "physical_exam" | "medication" | "treatment" | "treatment_instruction" | "investigation" | "referral" | "follow_up" | "administrative_action" | "patient_preference" | "shared_decision_making" | "care_barrier" | "pmh" | "family_history" | "social_history" | "temporal_reference" | "clinical_impression" | "lab_result" | "clinical_context" | "procedure_history" | "medication_order" | "normal_finding" | "temporal_event",
  clinical_role: "active_problem" | "past_history" | "negative_finding" | "family_history" | "observation",
  canonical_name?: string,
  display_text: string,
  patient_term?: string,
  confidence: number,
  source_span: string,
  value?: string,
  unit?: string,
  numeric_type?: "age" | "vitals" | "lab_result" | "other",
  actor: "patient" | "physician" | "family_member" | "other",
  status: "active" | "resolved" | "worsening" | "improving" | "chronic" | "suspected" | "ruled_out" | "unknown",
  render_required: boolean,
  locked: boolean,
  render_priority: "critical" | "high" | "medium" | "background",
  barrier_type?: "insurance" | "cost" | "transportation" | "wait_time" | "language" | "accessibility" | "other",
  body_site?: string,
  laterality?: "right" | "left" | "bilateral",
  anatomical_location?: string,
  symptom_characteristic?: string,
  observation_date?: string,
  date_precision?: "exact" | "month" | "relative"
}

Only output facts that belong to the missing categories. Do not hallucinate.`, { missingCategories: JSON.stringify(missingCategories) });

    const prompt = `RAW TRANSCRIPT:\n\n${transcript}\n\nIdentify any MISSING facts that match the requested categories and return them in the "recovered_entities" array.`;
    
    const responseSchema = {
      type: "OBJECT",
      properties: {
        recovered_entities: {
          type: "ARRAY",
          items: {
            type: "OBJECT",
            properties: {
              entity_type: { type: "STRING", enum: ["diagnosis", "symptom", "physical_exam", "medication", "treatment", "treatment_instruction", "investigation", "referral", "follow_up", "administrative_action", "patient_preference", "shared_decision_making", "care_barrier", "pmh", "family_history", "social_history", "temporal_reference", "clinical_impression", "lab_result", "clinical_context", "procedure_history", "medication_order", "normal_finding", "temporal_event"] },
              clinical_role: { type: "STRING", enum: ["active_problem", "past_history", "negative_finding", "family_history", "observation"] },
              canonical_name: { type: "STRING" },
              display_text: { type: "STRING" },
              patient_term: { type: "STRING" },
              confidence: { type: "NUMBER" },
              source_span: { type: "STRING" },
              value: { type: "STRING" },
              unit: { type: "STRING" },
              numeric_type: { type: "STRING", enum: ["age", "vitals", "lab_result", "other"] },
              actor: { type: "STRING", enum: ["patient", "physician", "family_member", "other"] },
              status: { type: "STRING", enum: ["active", "resolved", "worsening", "improving", "chronic", "suspected", "ruled_out", "unknown"] },
              render_required: { type: "BOOLEAN" },
              locked: { type: "BOOLEAN" },
              render_priority: { type: "STRING", enum: ["critical", "high", "medium", "background"] },
              barrier_type: { type: "STRING", enum: ["insurance", "cost", "transportation", "wait_time", "language", "accessibility", "other"] },
              body_site: { type: "STRING" },
              laterality: { type: "STRING", enum: ["right", "left", "bilateral"] },
              anatomical_location: { type: "STRING" },
              symptom_characteristic: { type: "STRING" },
              observation_date: { type: "STRING" },
              date_precision: { type: "STRING", enum: ["exact", "month", "relative"] }
            },
            required: ["entity_type", "clinical_role", "display_text", "confidence", "source_span", "actor", "status", "render_required", "locked", "render_priority"]
          }
        }
      },
      required: ["recovered_entities"]
    };

    // Fact recovery is OPTIONAL polish — it must never hang or fail the pipeline. Bound it
    // with a short timeout and swallow any error (timeout/network): on failure we simply
    // proceed with the entities we already have (this step was hanging for 3m+).
    let resultStr;
    try {
      resultStr = await (async () => {
        const _cfg = loadPromptConfig('fact-recovery');
        const _opts = { ...({ timeoutMs: 45000 }) };
        if (_cfg.maxOutputTokens) _opts.maxOutputTokens = _cfg.maxOutputTokens;
        return this.llm.generateContent(systemInstruction, prompt, _cfg.freeform ? null : responseSchema, _opts);
      })();
      try{ const _o = (typeof resultStr==='string'?resultStr:JSON.stringify(resultStr)); console.log('📤 [PromptAgentOutput] fact-recovery: '+(_o.length>20000?_o.slice(0,20000)+' …[truncated]':_o)); }catch(_){}
    } catch (e) {
      console.warn("[FactRecovery] skipped — LLM call failed/timed out:", e && e.message);
      return entitiesObj;
    }

    try {
      const parsed = safeParseJson(resultStr);

      if (parsed.recovered_entities && parsed.recovered_entities.length > 0) {
        // DEDUP: recovery can now fire on big coverage gaps even when a few entities exist, so
        // drop any recovered entity that duplicates one already captured (by normalized name or
        // source span) — prevents duplicate ORPHAN NODES.
        const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        const existing = new Set();
        for (const e of (entitiesObj.clinical_entities || [])) {
          for (const k of [e.display_text, e.canonical_name, e.source_span]) { const n = norm(k); if (n) existing.add(n); }
        }
        const injected = parsed.recovered_entities
          .filter((e) => {
            const keys = [norm(e.display_text), norm(e.canonical_name), norm(e.source_span)].filter(Boolean);
            if (keys.some((k) => existing.has(k))) return false;   // already captured → skip
            keys.forEach((k) => existing.add(k));                  // guard against intra-batch dupes
            return true;
          })
          .map((e) => { e.fact_origin = 'agent1_5'; e.render_status = 'extracted'; return e; });
        if (injected.length < parsed.recovered_entities.length) {
          console.log(`[FactRecovery] deduped ${parsed.recovered_entities.length - injected.length} already-captured entity(ies)`);
        }
        entitiesObj.clinical_entities = (entitiesObj.clinical_entities || []).concat(injected);
      }
      return entitiesObj;
    } catch (e) {
      console.error("Failed to parse FactRecovery output", e);
      return entitiesObj;
    }
  }
}
