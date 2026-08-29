export class GraphIntegrityValidator {
  static validate(graph, activeProblems) {
    const entities = graph.clinical_entities || [];
    const relationships = graph.resolved_relationships || [];
    const warnings = [];

    const isLinked = (entityId, relatedTypes = []) => {
      for (const rel of relationships) {
        if (rel.source === entityId || rel.target === entityId) {
          if (relatedTypes.length === 0) return true; // Just care if it's linked at all
          const otherId = rel.source === entityId ? rel.target : rel.source;
          const otherEntity = entities.find(e => e.id === otherId);
          if (otherEntity && relatedTypes.includes(otherEntity.entity_type)) {
            return true;
          }
        }
      }
      return false;
    };

    for (const entity of entities) {
      if (entity.entity_type === "diagnosis") {
        const hasTreatment = isLinked(entity.id, ["medication", "treatment", "treatment_instruction", "procedure_history", "medication_order"]);
        const hasSymptoms = isLinked(entity.id, ["symptom"]);
        
        if (!hasTreatment) {
          warnings.push(`Orphan Diagnosis (No Treatment): [${entity.id}] ${entity.display_text}`);
        }
        if (!hasSymptoms) {
          warnings.push(`Orphan Diagnosis (No Symptoms): [${entity.id}] ${entity.display_text}`);
        }
      } else if (entity.entity_type === "medication" || entity.entity_type === "medication_order") {
        if (!isLinked(entity.id)) {
          warnings.push(`Orphan Medication: [${entity.id}] ${entity.display_text}`);
        }
      } else if (entity.entity_type === "referral") {
        if (!isLinked(entity.id)) {
          warnings.push(`Orphan Referral: [${entity.id}] ${entity.display_text}`);
        }
      } else if (entity.entity_type === "follow_up") {
        if (!isLinked(entity.id)) {
          warnings.push(`Orphan Follow-up: [${entity.id}] ${entity.display_text}`);
        }
      }
    }

    return warnings;
  }
}
