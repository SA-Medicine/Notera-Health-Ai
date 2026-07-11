import { loadPrompt } from '../../../prompts/registry.js';
export class TimelineBuilderAgent {
  constructor(llmService) {
    this.llm = llmService;
  }

  async execute(transcript) {
    const systemInstruction = loadPrompt('timeline-builder', `You are the DAS Timeline Builder.
Your job is to extract clinically relevant chronological events from the transcript.
This timeline is used ONLY as internal reasoning context. It is NEVER rendered into the patient note.

RULES:
1. Only extract events with a temporal marker (e.g., "last Friday", "3 weeks ago", "since yesterday").
2. Assign each event a clinical_relevance of "high" or "low":
   - HIGH: symptom onset, medication started/changed, clinical visit, diagnosis made, investigation ordered, surgical history
   - LOW: vague markers ("years ago felt better"), social events (birthday, holiday), mentions of non-clinical persons (Leo incident, family story)
3. Preserve the exact wording of the date/time marker.
4. Only events with clinical_relevance "high" will be used downstream. Low-relevance events are captured for completeness only.

Output Schema:
{
  "clinical_timeline": [
    {
      "date": "last Friday",
      "event": "ADD confirmed by clinician",
      "clinical_relevance": "high"
    },
    {
      "date": "last Easter",
      "event": "Family gathering mentioned",
      "clinical_relevance": "low"
    }
  ]
}`);

    const prompt = `TRANSCRIPT:\n\n${transcript}\n\nBuild the timeline object and return the JSON.`;
    
    const responseSchema = {
      type: "OBJECT",
      properties: {
        clinical_timeline: {
          type: "ARRAY",
          items: {
            type: "OBJECT",
            properties: {
              date: { type: "STRING" },
              event: { type: "STRING" },
              clinical_relevance: { type: "STRING", enum: ["high", "low"] }
            },
            required: ["date", "event", "clinical_relevance"]
          }
        }
      },
      required: ["clinical_timeline"]
    };

    const resultStr = await this.llm.generateContent(systemInstruction, prompt, responseSchema);
    
    try {
      const cleanJson = resultStr.replace(/```json\n?|```/g, '').trim();
      const parsed = JSON.parse(cleanJson).clinical_timeline;
      // Only keep high-relevance events for downstream reasoning
      return parsed.filter(e => e.clinical_relevance === "high");
    } catch (e) {
      console.error("Failed to parse TimelineBuilder output", resultStr);
      return [];
    }
  }
}
