export class NegationNormalizerAgent {
  constructor(llmService) {
    this.llm = llmService;
  }

  async execute(transcript, clinicalObservations) {
    const systemInstruction = `You are the DAS Negation Normalizer.
Your ONLY job is to cross-reference the extracted clinical observations against the transcript to fix any false negatives or flipped negations.
Do NOT add new facts. ONLY correct existing facts or remove completely hallucinated negated facts.

NEGATION OBJECT FORMAT:
negative_conditions must be an array of objects: { "id": "...", "fact": "...", "negated": true }
Never return plain strings in negative_conditions.

CRITICAL RULE — HISTORICAL FACTS ARE NOT NEGATIONS:
A historical fact is NOT a negative condition. Examples:
- "History of one cycle lasting 70 days" → Historical fact, NOT a negation. Remove from negative_conditions.
- Markers: "history of", "prior", "previously", "had", "was diagnosed with".

ERRORS TO FIX:
1. "Not discussed" turning into "Performed" → Remove the erroneous entry.
2. Contextual negation lost (e.g., "Tenderness lying down, not when standing" placed as present in positive findings) → Move to negative_conditions with negated:true, fact: "Tenderness when standing".
3. Historical facts in negative_conditions → Remove from negative_conditions entirely.
4. A symptom listed as negated that IS ACTUALLY PRESENT in the transcript → Remove from negative_conditions.

RULES:
1. Read the transcript carefully for each fact.
2. Return the exact same JSON structure with corrections applied.
3. Preserve all id fields on negation objects.
3. Historical facts appearing in negative_conditions must be removed from that array — do not keep them there.
4. Return the exact same JSON structure, just with corrected strings and arrays.

Output Schema: Same as input JSON structure.`;

    const prompt = `TRANSCRIPT:\n\n${transcript}\n\nEXTRACTED OBSERVATIONS:\n\n${JSON.stringify(clinicalObservations, null, 2)}\n\nCorrect any negation errors. Pay special attention to historical facts that were incorrectly placed in negative_conditions. Return corrected JSON.`;
    
    const resultStr = await this.llm.generateContent(systemInstruction, prompt);
    
    try {
      const cleanJson = resultStr.replace(/```json\n?|```/g, '').trim();
      return JSON.parse(cleanJson);
    } catch (e) {
      console.error("Failed to parse NegationNormalizer output", resultStr);
      return clinicalObservations;
    }
  }
}
