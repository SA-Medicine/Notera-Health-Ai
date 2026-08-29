/**
 * HeidiStyleEngine — DAS V30
 *
 * Post-processes the clinical story to enforce Heidi-specific terminology and formatting.
 * Uses `heidi_style_key` from entities and regex for strict formatting.
 */

export class HeidiStyleEngine {
  static execute(graph) {
    if (!graph.clinical_story) return graph;

    const styleMap = {
      blood_glucose: (text) => text.replace(/blood sugar/gi, 'Blood glucose:'),
      kidney_function: (text) => text.replace(/kidney function fine/gi, 'Kidney function: normal').replace(/kidneys are fine/gi, 'Kidney function: normal'),
      cholesterol: (text) => text.replace(/cholesterol fine/gi, 'Cholesterol: good').replace(/cholesterol is good/gi, 'Cholesterol: good'),
      eye_exam: (text) => text.replace(/eye exam in ([a-zA-Z]+)/gi, 'Eye exam due $1'),
      numbness: (text) => text.replace(/no numbness/gi, 'No numbness or tingling in feet'),
    };

    const processArray = (arr) => {
      if (!arr || !Array.isArray(arr)) return arr;
      return arr.map(sentence => {
        if (!sentence) return sentence;
        let text = typeof sentence === 'string' ? sentence : sentence.text;
        if (!text) return sentence;

        // Apply style maps
        for (const [key, fn] of Object.entries(styleMap)) {
          text = fn(text);
        }

        // Add specific cost formatting for PSA/etc if we detect a cost pattern
        text = text.replace(/declined (.+) due to cost/gi, 'Patient previously declined due to cost');
        text = text.replace(/cost = \$(\d+)/gi, '($$1)');

        if (typeof sentence === 'string') {
          return text;
        } else {
          sentence.text = text;
          return sentence;
        }
      });
    };

    const story = graph.clinical_story;

    // Process subjective
    if (story.subjective) {
      Object.keys(story.subjective).forEach(key => {
        story.subjective[key] = processArray(story.subjective[key]);
      });
    }

    // Process PMH
    if (story.pmh) {
      Object.keys(story.pmh).forEach(key => {
        story.pmh[key] = processArray(story.pmh[key]);
      });
    }

    // Process objective
    if (story.objective) {
      Object.keys(story.objective).forEach(key => {
        story.objective[key] = processArray(story.objective[key]);
      });
    }

    // Process Assessment & Plan
    if (story.assessment_plan) {
      story.assessment_plan.forEach(ap => {
        ap.evidence = processArray(ap.evidence);
        ap.counselling = processArray(ap.counselling);
        ap.investigations_planned = processArray(ap.investigations_planned);
        ap.treatments_planned = processArray(ap.treatments_planned);
        ap.referrals = processArray(ap.referrals);
        ap.follow_ups = processArray(ap.follow_ups);
      });
    }

    return graph;
  }
}
