export class AssessmentSynthesisEngine {
  static compose(problemObj, graph) {
    const entities = graph.clinical_entities || [];
    const diagnoses = problemObj.diagnosis_ids.map(id => entities.find(e => e.id === id)).filter(Boolean);
    
    if (diagnoses.length === 0) return problemObj.problem;

    const baseDiagnosis = diagnoses[0];
    let assessmentStr = baseDiagnosis.canonical_name || baseDiagnosis.display_text;

    const lowerAssessment = assessmentStr.toLowerCase();
    
    // Obesty -> Obesity - weight loss management
    if (lowerAssessment.includes("obesity") || lowerAssessment.includes("overweight")) {
       assessmentStr += " - weight loss management";
    }

    // Tinea pedis mapping (from "Fungus")
    if (lowerAssessment === "fungus" && entities.find(e => (e.display_text || "").toLowerCase().includes("foot") || (e.body_site || "").toLowerCase().includes("foot"))) {
       assessmentStr = "Tinea pedis";
    }

    const causes = baseDiagnosis.related_to?.filter(r => r.relationship === "secondary_to" || r.relationship === "caused_by") || [];
    
    if (causes.length > 0) {
      const causeEntity = entities.find(e => e.id === causes[0].id);
      if (causeEntity) {
        assessmentStr += ` secondary to ${causeEntity.canonical_name || causeEntity.display_text}`;
      }
    }

    // Capitalize first letter and add period
    assessmentStr = assessmentStr.charAt(0).toUpperCase() + assessmentStr.slice(1);
    if (!assessmentStr.endsWith('.')) {
      assessmentStr += '.';
    }

    return assessmentStr;
  }
}
