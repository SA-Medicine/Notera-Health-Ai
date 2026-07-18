export class ClinicalRecallAnalyzer {
  static SYNONYM_DICT = {
    htn: "hypertension",
    sob: "shortness of breath",
    ida: "iron deficiency anemia",
    bp: "blood pressure",
    hr: "heart rate",
    dx: "diagnosis",
    hx: "history"
  };

  static normalize(text) {
    let norm = text.toLowerCase();
    for (const [key, val] of Object.entries(this.SYNONYM_DICT)) {
      const regex = new RegExp(`\\b${key}\\b`, 'g');
      norm = norm.replace(regex, val);
    }
    return norm;
  }

  static analyze(transcript, extractedData) {
    const transcriptLower = this.normalize(transcript);
    const entities = extractedData.clinical_entities || [];
    const factTextLower = entities.map(e => e.display_text.toLowerCase()).join(" ");
    
    // Flatten numeric data and meds for easy checking
    const extractedNumerics = (extractedData.numeric_data || []).map(n => n.value).join(" ").toLowerCase();
    const extractedMeds = [
      ...(extractedData.current_medications || []),
      ...(extractedData.medication_decisions || []).map(m => m.medication)
    ].join(" ").toLowerCase();

    // 1. Numeric Coverage
    const transcriptNumbers = transcript.match(/\\b\\d{1,4}(\\.\\d{1,2})?\\b/g) || [];
    let numFound = 0;
    for (const num of transcriptNumbers) {
      if (factTextLower.includes(num) || extractedNumerics.includes(num)) {
        numFound++;
      }
    }
    const numericCoverage = transcriptNumbers.length ? Math.round((numFound / transcriptNumbers.length) * 100) : 100;

    // 2. Medication Coverage
    const medKeywords = ["mg", "mcg", "dose", "tablet", "capsule", "prescribe", "started", "stop"];
    let medTokens = 0;
    let medsFound = 0;
    for (const kw of medKeywords) {
      if (transcriptLower.includes(kw)) {
        medTokens++;
        if (extractedMeds.includes(kw) || factTextLower.includes(kw)) {
          medsFound++;
        }
      }
    }
    const medicationCoverage = medTokens ? Math.round((medsFound / medTokens) * 100) : 100;

    // 3. Diagnosis Coverage
    const diagKeywords = ["diagnosed", "diagnosis", "fibromyalgia", "diabetes", "hypertension", "obesity", "apnea"];
    let diagTokens = 0;
    let diagsFound = 0;
    const extractedDiags = entities.filter(e => e.entity_type === 'diagnosis').map(e => (e.canonical_name || e.display_text)).join(" ").toLowerCase();
    for (const kw of diagKeywords) {
      if (transcriptLower.includes(kw)) {
        diagTokens++;
        if (extractedDiags.includes(kw) || factTextLower.includes(kw)) {
          diagsFound++;
        }
      }
    }
    const diagnosisCoverage = diagTokens ? Math.round((diagsFound / diagTokens) * 100) : 100;

    // 4. Followup Coverage
    const fuKeywords = ["follow up", "follow-up", "rtc", "return to clinic", "see you in", "weeks", "months"];
    let fuTokens = 0;
    let fusFound = 0;
    const extractedFus = (extractedData.follow_ups || []).map(f => (f.timeframe || '') + ' ' + (f.trigger || '')).join(" ").toLowerCase();
    for (const kw of fuKeywords) {
      if (transcriptLower.includes(kw)) {
        fuTokens++;
        if (extractedFus.includes(kw) || factTextLower.includes(kw)) {
          fusFound++;
        }
      }
    }
    const followupCoverage = fuTokens ? Math.round((fusFound / fuTokens) * 100) : 100;

    // 5. Life Safety Coverage
    const lifeSafetyKeywords = ["chest pain", "suicide", "suicidal", "bleeding", "shortness of breath", "stroke"];
    let lsTokens = 0;
    let lsFound = 0;
    for (const kw of lifeSafetyKeywords) {
      if (transcriptLower.includes(kw)) {
        lsTokens++;
        if (factTextLower.includes(kw)) {
          lsFound++;
        }
      }
    }
    const lifeSafetyCoverage = lsTokens ? Math.round((lsFound / lsTokens) * 100) : 100;

    // Calculate Overall standard coverage
    const overall = Math.round((numericCoverage + medicationCoverage + diagnosisCoverage + followupCoverage + lifeSafetyCoverage) / 5);

    const scores = {
      life_safety: lifeSafetyCoverage,
      diagnosis: diagnosisCoverage,
      medication: medicationCoverage,
      followup: followupCoverage,
      numeric: numericCoverage,
      overall_standard: overall
    };

    console.log("🚀 JS Clinical Recall Analyzer Scores:", scores);

    const missingCategories = [];
    if (lifeSafetyCoverage < 100) missingCategories.push("life_safety");
    if (diagnosisCoverage < 100) missingCategories.push("diagnosis");
    if (medicationCoverage < 100) missingCategories.push("medication");
    if (followupCoverage < 100) missingCategories.push("follow_up");
    if (numericCoverage < 100) missingCategories.push("lab_result"); // using lab_result or vitals

    const needsRecovery = missingCategories.length > 0 || overall < 95;

    return { scores, needsRecovery, missingCategories };
  }
}
