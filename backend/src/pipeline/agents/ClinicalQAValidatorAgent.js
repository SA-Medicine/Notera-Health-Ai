import { loadPrompt } from '../../../prompts/registry.js';
import { safeParseJson } from '../utils/safeParseJson.js';

/**
 * ClinicalQAValidatorAgent — DAS V31
 *
 * V31 CRITICAL CHANGES:
 *   - Addendum generation REMOVED entirely
 *   - On LOW coverage: return retry_slot_filler signal
 *   - On FAIL coverage: return critical failure signal
 *   - The pipeline uses these signals to retry Layer B, never to append addendum
 *   - Notes must be complete in the main body — addendum was an escape hatch, now removed
 */
export class ClinicalQAValidatorAgent {
  constructor(llmService) {
    this.llm = llmService;
  }

  async execute(jsValidation) {
    const systemInstruction = loadPrompt('qa-validator', `You are the Clinical QA Validator for DAS V31.

Your job: review missing clinical facts that were dropped by the documentation pipeline.

V31 RULES — CRITICAL:
1. DO NOT generate any addendum text. Addendum is eliminated in V31.
2. On LOW severity: return action: "retry_slot_filler" — pipeline will retry Layer B.
3. On FAIL severity: return action: "pipeline_fail" — clinician must re-run.
4. The "addendum" field is now ALWAYS an empty array. Never populate it.

SEVERITY DETERMINATION:
- PASS: No meaningful facts missing.
- LOW: Minor facts missing (routine medications, normal findings, follow-up times, context).
  → action: "retry_slot_filler"
- FAIL: Critical facts missing (active diagnoses, current medications, critical abnormalities).
  → action: "pipeline_fail"

Output Schema:
{
  "status": "PASS" | "LOW" | "FAIL",
  "missing_facts": ["string"],
  "addendum": [],
  "action": "none" | "retry_slot_filler" | "pipeline_fail",
  "retry_reason": "string or null"
}`);

    const prompt = `MISSING FACTS IDENTIFIED BY JS VALIDATOR:\n\n${JSON.stringify(jsValidation.errors || jsValidation.missing_facts || [])}\n\nEvaluate and return validation JSON. Remember: addendum is always []. Return action instead.`;
    
    const responseSchema = {
      type: "OBJECT",
      properties: {
        status: { type: "STRING", enum: ["PASS", "LOW", "FAIL"] },
        missing_facts: { type: "ARRAY", items: { type: "STRING" } },
        addendum: { type: "ARRAY", items: { type: "STRING" } },
        action: { type: "STRING", enum: ["none", "retry_slot_filler", "pipeline_fail"] },
        retry_reason: { type: "STRING" }
      },
      required: ["status", "missing_facts", "addendum", "action"]
    };

    const resultStr = await this.llm.generateContent(systemInstruction, prompt, responseSchema);
    
    try {
      const result = safeParseJson(resultStr);
      // V31: Force addendum to empty — never allow it to be populated
      result.addendum = [];
      return result;
    } catch (e) {
      console.error("Failed to parse QA output", e);
      return { status: "FAIL", missing_facts: ["QA parsing failed"], addendum: [], action: "pipeline_fail" };
    }
  }
}
