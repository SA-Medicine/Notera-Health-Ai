export class RelationshipEngine {
  static execute(graph) {
    const entities = graph.clinical_entities || [];
    const relationships = graph.resolved_relationships || [];

    // Attach bidirectional relationships for easy traversal
    entities.forEach(e => {
      e.related_to = [];
      e.related_from = [];
    });

    relationships.forEach(rel => {
      const source = entities.find(e => e.id === rel.source);
      const target = entities.find(e => e.id === rel.target);
      if (source && target) {
        source.related_to.push({ id: target.id, relationship: rel.relationship, entity_type: target.entity_type });
        target.related_from.push({ id: source.id, relationship: rel.relationship, entity_type: source.entity_type });
      }
    });

    // EDGE RELATIONSHIP FALLBACK
    // To prevent Orphan Diagnoses, we must ensure all active problems have their supporting labs/meds attached.
    const primaryDiagnosis = entities.find(e => e.entity_type === "diagnosis" && e.status === "active");
    if (primaryDiagnosis) {
       entities.forEach(e => {
         if (e.id === primaryDiagnosis.id) return;
         if (e.related_to.length === 0 && e.related_from.length === 0) {
            // It's an orphan. Let's attach it to the primary diagnosis
            if (e.entity_type === "medication") {
               relationships.push({ source: e.id, target: primaryDiagnosis.id, relationship: "treated_by" });
               e.related_to.push({ id: primaryDiagnosis.id, relationship: "treated_by", entity_type: "diagnosis" });
               primaryDiagnosis.related_from.push({ id: e.id, relationship: "treated_by", entity_type: "medication" });
            } else if (e.entity_type === "lab_result" || e.entity_type === "symptom") {
               relationships.push({ source: e.id, target: primaryDiagnosis.id, relationship: "supported_by" });
               e.related_to.push({ id: primaryDiagnosis.id, relationship: "supported_by", entity_type: "diagnosis" });
               primaryDiagnosis.related_from.push({ id: e.id, relationship: "supported_by", entity_type: e.entity_type });
            } else if (e.entity_type === "referral" || e.entity_type === "follow_up") {
               relationships.push({ source: e.id, target: primaryDiagnosis.id, relationship: "managed_by" });
               e.related_to.push({ id: primaryDiagnosis.id, relationship: "managed_by", entity_type: "diagnosis" });
               primaryDiagnosis.related_from.push({ id: e.id, relationship: "managed_by", entity_type: e.entity_type });
            }
         }
       });
    }

    return graph;
  }
}
