export class HeidiCompressionAgent {
  constructor(llmService) {
    this.llm = llmService;
  }

  async execute(draftNote) {
    const systemInstruction = `You are DAS Compression Engine.
Goal: Remove unnecessary filler words. Preserve every clinical fact exactly.

## PERMITTED COMPRESSIONS
- Remove "The patient reports", "The patient states", "The patient notes", "Patient mentions"
- Remove "It was noted that", "It is reported that"
- Remove trailing periods where redundant (keep one per bullet)
- Shorten verbose phrases: "is currently experiencing" → drop entirely

## COMPRESSION RULES (READ CAREFULLY)

RULE 1 — DO NOT SPLIT FACTS.
If one bullet contains a compound fact (e.g., "Bloating or heaviness"), keep it as ONE bullet.
NEVER turn "Bloating or heaviness" into two bullets "Bloating" and "Heaviness".
Use "/" to join: "Bloating/heaviness."

RULE 2 — DO NOT MERGE FACTS.
Two separate bullets must remain separate bullets. Never combine into one sentence.

RULE 3 — DO NOT ADD TEMPORAL MARKERS.
If the original says "Bloating", do not write "Daily bloating" unless "daily" was in the original.
Never add: daily, chronic, persistent, ongoing, recurrent, worsening, improving — unless explicitly stated.

RULE 4 — DO NOT SUMMARIZE.
Never replace a list of bullet facts with a prose sentence summary.

RULE 5 — DO NOT REMOVE NEGATION TOKENS.
"No tenderness when standing" must remain "No tenderness when standing."
"Blood pressure monitoring not discussed" must remain unchanged.
Never strip the "No" or "not" from negation bullets.

RULE 6 — PRESERVE ALL HEADERS.
You MUST preserve all section headers (e.g. **Subjective:**, **Pelvic Symptoms:**, **Assessment & Plan:**) exactly as they appear. Do NOT delete or rename them.

RULE 7 — PRESERVE ALL BULLETS.
Every bullet in the draft note must appear in the compressed note. Count the input bullets and verify the output has the same count.

RULE 8 — DO NOT COMPRESS SPECIFICS.
Never compress locations (e.g., lateral, arch), numbers, dosages, or dates. Only compress filler words.

Output ONLY the compressed note text. No pleasantries. No explanations.`;

    const prompt = `DRAFT NOTE:\n\n${draftNote}\n\nApply compression. Same number of bullets. Same headers. No new temporal markers. No fact splitting.`;
    
    return this.llm.generateContentStream(systemInstruction, prompt);
  }
}
