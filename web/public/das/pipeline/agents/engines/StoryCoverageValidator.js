/**
 * StoryCoverageValidator — DAS V25
 *
 * Replaces fragile substring QA. Uses entity.represented_by[] to validate
 * that every critical entity in the graph is assigned to at least one
 * narrative section before rendering.
 *
 * PASS: entity.represented_by.length > 0
 * FAIL: entity.critical === true AND entity.represented_by.length === 0
 *
 * Returns a validation result that feeds into JSValidatorLayer.
 * Only triggers LLM QA on real structural misses (unrepresented critical facts).
 */

export class StoryCoverageValidator {
  static validate(graph) {
    const entities = graph.clinical_entities || [];
    const numerics = graph.numeric_data || [];

    const unrepresentedCritical = [];
    const unrepresentedNonCritical = [];
    let totalCritical = 0;
    let representedCritical = 0;

    // Check clinical entities
    entities.forEach(e => {
      const isCritical = e.critical === true ||
        e.clinical_priority === 'critical' ||
        e.clinical_significance === 'critical' ||
        e.clinical_significance === 'major';

      const isRepresented = Array.isArray(e.represented_by) && e.represented_by.length > 0;

      // Skip intentionally suppressed entities
      if (e.render_status === 'intentionally_suppressed' || e.render_priority === 'hidden') return;
      // Skip pure temporal references
      if (e.entity_type === 'temporal_reference' || e.entity_type === 'temporal_event') return;

      if (isCritical) {
        totalCritical++;
        if (isRepresented) {
          representedCritical++;
        } else {
          unrepresentedCritical.push({
            id: e.id,
            type: e.entity_type,
            text: e.display_text || e.canonical_name || '',
            priority: e.clinical_priority || e.clinical_significance || 'unknown',
          });
        }
      } else if (!isRepresented && e.importance !== 'ignore') {
        unrepresentedNonCritical.push({
          id: e.id,
          type: e.entity_type,
          text: e.display_text || e.canonical_name || '',
        });
      }
    });

    // Check numeric_data
    numerics.forEach(n => {
      if (n.render_status === 'aggregated') return; // already handled
      const isRepresented = Array.isArray(n.represented_by) && n.represented_by.length > 0;
      if (!isRepresented) {
        unrepresentedCritical.push({
          id: n.id || n.test_name,
          type: 'numeric',
          text: `${n.test_name}: ${n.value}${n.unit ? ` ${n.unit}` : ''}`,
          priority: 'critical',
        });
        totalCritical++;
      } else {
        representedCritical++;
        totalCritical++;
      }
    });

    const coveragePercent = totalCritical > 0
      ? Math.round((representedCritical / totalCritical) * 100)
      : 100;

    const status = unrepresentedCritical.length === 0 ? 'PASS' : 'FAIL';

    const result = {
      status,
      coverage_percent: coveragePercent,
      total_critical: totalCritical,
      represented_critical: representedCritical,
      unrepresented_critical: unrepresentedCritical,
      unrepresented_non_critical: unrepresentedNonCritical,
      warnings: unrepresentedNonCritical.length > 0
        ? [`${unrepresentedNonCritical.length} non-critical entity(ies) unrepresented`]
        : [],
    };

    // Store result on graph for pipeline logging
    graph._storyCoverageValidation = result;

    return result;
  }
}
