import { loadPrompt } from '../../../prompts/registry.js';
export class DiagnosisPreservationAgent {
  constructor(llmService) {
    this.llm = llmService;
  }

  async execute(transcript, extractedData) {
    console.log('🏷️ [PromptAgent] diagnosis-preservation');
    const systemInstruction = loadPrompt('diagnosis-preservation', `You are the DAS Diagnosis Preservation Agent.
Your job is to strictly enforce that DIAGNOSES are extracted verbatim from the transcript.
Clinical terminology abstraction is FORBIDDEN.

Rules:
1. Fibromyalgia ≠ chronic pain
2. Endometriosis ≠ pelvic pain
3. ADHD ≠ concentration issue
4. PCOS ≠ irregular periods

Compare the RAW TRANSCRIPT against the "diagnosis" or "differential" facts in the EXTRACTED DATA.
If a diagnosis was abstracted or rewritten, correct its "text" field to the EXACT phrase used in the transcript.
Return the updated clinical_facts array.`);

    const prompt = `RAW TRANSCRIPT:\n\n${transcript}\n\n=== EXTRACTED FACTS ===\n\n${JSON.stringify(extractedData.clinical_facts, null, 2)}\n\nCorrect any abstracted diagnoses and return the full updated clinical_facts JSON array.`;
    
    const responseSchema = {
      type: "OBJECT",
      properties: {
        clinical_facts: {
          type: "ARRAY",
          items: {
            type: "OBJECT",
            properties: {
              category: { type: "STRING" },
              text: { type: "STRING" },
              actor: { type: "STRING" },
              evidence_source: { type: "STRING" },
              clinical_role: { type: "STRING" },
              certainty: { type: "STRING" },
              temporality: { type: "STRING" },
              clinical_priority: { type: "STRING" },
              body_site: { type: "STRING" },
              symptom_characteristic: { type: "STRING" }
            }
          }
        }
      },
      required: ["clinical_facts"]
    };

    const resultStr = await this.llm.generateContent(systemInstruction, prompt, responseSchema);
    
    try {
      const cleanJson = resultStr.replace(/```json\n?|```/g, '').trim();
      const parsed = JSON.parse(cleanJson);
      
      if (parsed.clinical_facts) {
        extractedData.clinical_facts = parsed.clinical_facts;
      }
      return extractedData;
    } catch (e) {
      console.error("Failed to parse DiagnosisPreservation output", resultStr);
      return extractedData;
    }
  }
}
