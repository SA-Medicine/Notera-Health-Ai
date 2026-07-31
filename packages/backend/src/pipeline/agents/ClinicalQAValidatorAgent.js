import { loadPrompt, loadPromptConfig } from '../../../prompts/registry.js';
import { safeParseJson } from '../utils/safeParseJson.js';
import { looksLikeBenchmarkingPrompt } from '../../validation/upgrades.js';

const QA_GATE_FALLBACK = `You are the Clinical QA Validator for DAS V31.

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
  → action: "pipeline_fail"`;

/**
 * ClinicalQAValidatorAgent — DAS V31
 */
export class ClinicalQAValidatorAgent {
  constructor(llmService) {
    this.llm = llmService;
  }

  async execute(jsValidation, transcript = '', generatedNote = '', referenceNote = '') {
    console.log('🏷️ [PromptAgent] qa-validator');
    const _cfg = loadPromptConfig('qa-validator');
    let systemInstruction = loadPrompt('qa-validator', QA_GATE_FALLBACK);

    // Upgrade E — contract-drift guard: this agent is the pipeline QUALITY GATE (it must
    // return {status, action, retry_reason}). If a blind benchmarking rubric (Heidi-vs-Notera,
    // n=2000) was mistakenly published to 'qa-validator', its output contract conflicts with
    // the gate, so we ignore it and use the gate prompt. (Benchmarking belongs to its own id.)
    if (looksLikeBenchmarkingPrompt(systemInstruction)) {
      console.warn('[upgrade:qa-contract] published qa-validator prompt looks like a benchmarking rubric — using the gate prompt instead to avoid output-contract drift. Move the benchmarking rubric to a separate agent id (e.g. comparative-judge).');
      systemInstruction = QA_GATE_FALLBACK;
    }

    // Inject live inputs so a custom evaluator prompt can cross-verify:
    //   [TRANSCRIPT] → source; [NOTERA_NOTE]/[GENERATED_NOTE]/[NOTE] → generated note;
    //   [HEIDI_NOTE]/[REFERENCE_NOTE] → gold/reference note (if available).
    const _ref = referenceNote || '';
    const _subs = {
      '[TRANSCRIPT]': transcript || '(transcript not provided)',
      '[NOTERA_NOTE]': generatedNote || '(note not provided)',
      '[GENERATED_NOTE]': generatedNote || '(note not provided)',
      '[NOTE]': generatedNote || '(note not provided)',
      '[HEIDI_NOTE]': _ref || '(no reference/Heidi note available)',
      '[REFERENCE_NOTE]': _ref || '(no gold reference available)',
    };
    const _hasPlaceholders = /\[(TRANSCRIPT|NOTERA_NOTE|GENERATED_NOTE|NOTE|HEIDI_NOTE|REFERENCE_NOTE)\]/.test(systemInstruction);
    for (const [k, v] of Object.entries(_subs)) systemInstruction = systemInstruction.split(k).join(v);

    const _refBlock = _ref ? `=== REFERENCE / HEIDI NOTE (gold) ===\n\n${_ref}\n\n` : '';
    let prompt = _hasPlaceholders
      ? `JS VALIDATOR FLAGGED FACTS (hints):\n\n${JSON.stringify(jsValidation.errors || jsValidation.missing_facts || [])}\n\nReturn ONLY the JSON exactly per the schema below.`
      : `SOURCE TRANSCRIPT:\n\n${transcript || '(not provided)'}\n\n=== GENERATED NOTE (Notera) ===\n\n${generatedNote || '(not provided)'}\n\n${_refBlock}=== FACTS FLAGGED BY JS VALIDATOR ===\n\n${JSON.stringify(jsValidation.errors || jsValidation.missing_facts || [])}\n\nCross-verify the generated note against the transcript${_ref ? ' (and the reference note)' : ''} and return the validation JSON.`;

    // Append the editable output schema (the metrics contract) to the BOTTOM of every call.
    if (_cfg.schema && _cfg.schema.trim()) {
      prompt += `\n\n=== REQUIRED OUTPUT SCHEMA — return valid JSON matching this exactly ===\n${_cfg.schema.trim()}`;
    } else {
      prompt += `\n\nOutput Schema:\n{\n  "status": "PASS" | "LOW" | "FAIL",\n  "missing_facts": ["string"],\n  "addendum": [],\n  "action": "none" | "retry_slot_filler" | "pipeline_fail",\n  "retry_reason": "string or null"\n}`;
    }

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

    const _opts = {};
    if (_cfg.maxOutputTokens) _opts.maxOutputTokens = _cfg.maxOutputTokens;
    const resultStr = await this.llm.generateContent(systemInstruction, prompt, _cfg.freeform ? null : responseSchema, _opts);
    try{ const _o = (typeof resultStr==='string'?resultStr:JSON.stringify(resultStr)); console.log('📤 [PromptAgentOutput] qa-validator: '+(_o.length>20000?_o.slice(0,20000)+' …[truncated]':_o)); }catch(_){}

    try {
      const result = safeParseJson(resultStr);
      if (Array.isArray(result.addendum) || result.addendum === undefined) result.addendum = [];
      // Loop the output and collect every numeric leaf as a metric (base + any you add),
      // with dotted names for nested fields — these feed the Metrics-tab trend chart.
      const metrics = {};
      (function walk(o, prefix) {
        if (!o || typeof o !== 'object' || Array.isArray(o)) return;
        for (const [k, v] of Object.entries(o)) {
          if (k === 'addendum' || k === 'missing_facts') continue;
          const key = prefix ? prefix + '.' + k : k;
          if (typeof v === 'number' && isFinite(v)) metrics[key] = v;
          else if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(metrics).length < 40) walk(v, key);
        }
      })(result, '');
      result._metrics = metrics;
      if (Object.keys(metrics).length) console.log('📈 [PromptAgentMetrics] qa-validator: ' + JSON.stringify(metrics));
      return result;
    } catch (e) {
      console.error("Failed to parse QA output", e);
      return { status: "FAIL", missing_facts: ["QA parsing failed"], addendum: [], action: "pipeline_fail", _metrics: {} };
    }
  }
}
