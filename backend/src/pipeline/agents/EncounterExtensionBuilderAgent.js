export class EncounterExtensionBuilderAgent {
  constructor(llmService) {
    this.llm = llmService;
  }

  async execute(transcript, clinicalObservations, encounterType) {
    const extension = {};

    const clinicalFacts = clinicalObservations?.clinical_facts || [];

    for (const fact of clinicalFacts) {
      if (!fact.text || !fact.category) continue;
      
      // Initialize rendered state
      fact.rendered = false;

      if (!extension[fact.category]) extension[fact.category] = [];
      extension[fact.category].push(fact);
    }

    console.log("✅ Agent 4 EncounterExtensionBuilder Output:", extension);
    return extension;
  }
}
