export class EncounterIntegrityAgent {
  constructor(llmService) {
    // This agent is pure JS assertion. It doesn't need the LLM for most checks, 
    // but we accept it for constructor uniformity.
    this.llm = llmService;
  }

  async execute(extractedData, currentEncounterId) {
    const leakageErrors = [];
    const structuralErrors = [];
    const pmhContaminations = [];
    const subjectiveObjectiveContaminations = [];

    const facts = extractedData.clinical_facts || [];
    
    for (const fact of facts) {
      // 1. Cross Encounter Leakage
      if (fact.encounter_id && fact.encounter_id !== currentEncounterId) {
        leakageErrors.push(`Fact "${fact.text}" belongs to encounter ${fact.encounter_id}, but current is ${currentEncounterId}.`);
      }

      // 2. Impossible Rendering (Patient report in Objective)
      if (fact.actor === "patient" && fact.category === "physical_exam") {
        subjectiveObjectiveContaminations.push(`Patient report "${fact.text}" categorized as physical_exam.`);
        // Auto-fix
        fact.category = "symptom";
      }

      // 3. PMH Contamination
      if (fact.category === "pmh" && ["investigation_ordered", "medication_change"].includes(fact.clinical_role)) {
        pmhContaminations.push(`Active order/med change "${fact.text}" placed in PMH.`);
      }
    }

    // 4. Medication Contradictions (Optional future implementation via LLM if needed)
    
    const errors = [...leakageErrors, ...structuralErrors, ...pmhContaminations, ...subjectiveObjectiveContaminations];
    
    if (errors.length > 0) {
      console.warn("⚠️ EncounterIntegrityAgent fixed/flagged structural issues:", errors);
    }
    
    if (leakageErrors.length > 0) {
      throw new Error("🚨 CRITICAL: Cross Encounter Leakage Detected. Aborting rendering.\n" + leakageErrors.join("\n"));
    }

    return extractedData;
  }
}
