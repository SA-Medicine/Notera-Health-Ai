export class TemporalIntelligenceEngine {
  static execute(graph) {
    const entities = graph.clinical_entities || [];
    
    // Ensure all temporal_event entities have correct priorities
    entities.forEach(e => {
      if (e.entity_type === "temporal_event" || e.entity_type === "temporal_reference") {
        e.render_priority = "background"; // Usually background for inline rendering
      }
    });

    return graph;
  }
}
