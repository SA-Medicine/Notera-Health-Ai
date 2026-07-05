import { safeParseJson } from '../utils/safeParseJson.js';

export class EncounterClassifierAgent {
  constructor(llmService) {
    this.llm = llmService;
  }

  async execute(transcript) {
    const systemInstruction = `You are DAS Encounter Classifier.
Analyze the transcript and categorize the primary nature of the clinical encounter.

Valid Encounter Types:
- acute_injury (e.g. fracture, sprain, laceration)
- musculoskeletal (e.g. chronic back pain, osteoarthritis)
- diabetes (e.g. diabetes review, A1c check)
- hypertension (e.g. blood pressure management)
- lipids (e.g. cholesterol check)
- weight_loss (e.g. Wegovy/Zepbound consultation, obesity management)
- medication_refill (e.g. refill request that includes symptom checks, dose titration, or clinical discussion)
- medication_refill_administrative (e.g. third-party proxy requests, or simple multi-med refills with absolute absence of any symptom, exam, or clinical discussion)
- mental_health (e.g. depression, anxiety, ADHD)
- gynecology (e.g. pelvic symptoms, endometriosis, contraception)
- pregnancy (e.g. prenatal visit)
- pediatrics (e.g. well-child check, pediatric illness)
- dermatology (e.g. rash, lesion check)
- anemia (e.g. iron deficiency, CBC review)
- general_followup (e.g. general post-op or routine follow-up)
- general_primary_care (e.g. annual physical, undifferentiated symptoms)

Few-Shot Boundaries for Administrative Refills:
- If a patient calls to say "I need my Zepbound, I have no side effects, I want to go up to 5mg", and the doctor says "Sent to Rexall" -> medication_refill_administrative.
- If a daughter calls to say "My dad needs his blood pressure pills renewed, send to Shoppers" -> medication_refill_administrative.
- If a patient calls for a refill but adds "I've been feeling dizzy on it" or "my blood pressure is 140/90" -> medication_refill (because clinical context exists).

Output JSON only.`;

    const prompt = `CONSULTATION TRANSCRIPT:\n\n${transcript}\n\nDetermine the encounter type and return the JSON.`;
    
    const responseSchema = {
      type: "OBJECT",
      properties: {
        encounter_type: {
          type: "STRING",
          enum: [
            "acute_injury", "musculoskeletal", "diabetes", "hypertension", "lipids", "weight_loss", 
            "medication_refill", "medication_refill_administrative", "mental_health", "gynecology", "pregnancy", "pediatrics", 
            "dermatology", "anemia", "general_followup", "general_primary_care"
          ]
        }
      },
      required: ["encounter_type"]
    };

    const resultStr = await this.llm.generateContent(systemInstruction, prompt, responseSchema);
    
    try {
      return safeParseJson(resultStr).encounter_type;
    } catch (e) {
      console.error("Failed to parse EncounterClassifier output", e);
      throw e;
    }
  }
}
