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

    // 6. Investigation / test coverage (labs, imaging, orders) — was never scored, so gaps
    //    in investigations/referrals never triggered recovery (only 'medication' fired).
    const invKeywords = ["blood work", "bloodwork", "x-ray", "xray", "ct scan", "mri", "ultrasound", "biopsy", "culture", "requisition", "referral", "imaging", "ecg", "ekg", "urinalysis", "swab", "scan", "screening"];
    const extractedInv = ([...(extractedData.investigations || []), ...(extractedData.orders || [])]).map((i) => JSON.stringify(i)).join(" ").toLowerCase();
    let invTokens = 0, invFound = 0;
    for (const kw of invKeywords) { if (transcriptLower.includes(kw)) { invTokens++; if (extractedInv.includes(kw) || factTextLower.includes(kw)) invFound++; } }
    const investigationCoverage = invTokens ? Math.round((invFound / invTokens) * 100) : 100;

    // 7. Procedure / administration coverage (injections, vaccines, TB tests, lot #, expiry).
    const procKeywords = ["injection", "aspiration", "vaccine", "vaccination", "ppd", "tb test", "tuberculin", "lot number", "expiration", "expiry", "administered", "cortisone", "steroid shot"];
    let procTokens = 0, procFound = 0;
    for (const kw of procKeywords) { if (transcriptLower.includes(kw)) { procTokens++; if (factTextLower.includes(kw)) procFound++; } }
    const procedureCoverage = procTokens ? Math.round((procFound / procTokens) * 100) : 100;

    // Calculate Overall standard coverage (now across 7 categories)
    const overall = Math.round((numericCoverage + medicationCoverage + diagnosisCoverage + followupCoverage + lifeSafetyCoverage + investigationCoverage + procedureCoverage) / 7);

    const scores = {
      life_safety: lifeSafetyCoverage,
      diagnosis: diagnosisCoverage,
      medication: medicationCoverage,
      followup: followupCoverage,
      numeric: numericCoverage,
      investigation: investigationCoverage,
      procedure: procedureCoverage,
      overall_standard: overall
    };

    console.log("🚀 JS Clinical Recall Analyzer Scores:", scores);

    // A category is only worth RECOVERY if it is GENUINELY EMPTY (nothing of that type was
    // extracted). The keyword-coverage above is noisy (it reported medication:0 even when 5
    // drugs were extracted), which made recovery re-extract already-captured entities into
    // duplicate ORPHAN NODES. So for categories we can count, gate on count===0; for the two
    // we can't count directly (life_safety, procedure) fall back to coverage.
    const nEntity = (pred) => entities.filter(pred).length;
    const extractedCount = {
      diagnosis: nEntity((e) => /diagnosis/i.test(e.entity_type || '')),
      medication: nEntity((e) => /medication/i.test(e.entity_type || '')) + (extractedData.current_medications || []).length + (extractedData.medication_decisions || []).length,
      follow_up: (extractedData.follow_ups || []).length + nEntity((e) => /follow_up|referral/i.test(e.entity_type || '')),
      lab_result: (extractedData.numeric_data || []).length + nEntity((e) => /lab_result/i.test(e.entity_type || '')),
      investigation: (extractedData.investigations || []).length + (extractedData.orders || []).length + nEntity((e) => /investigation/i.test(e.entity_type || '')),
    };
    const missingCategories = [];
    // Recover a category when NOTHING of its type was captured (count===0), OR when coverage is
    // SEVERELY low even though a few entities exist (count>0). The low-coverage path catches
    // cases like fatigue-thyroid — where the extractor grabbed one investigation but missed the
    // whole reviewed lab panel — without re-recovering near-complete categories (the < LOW gate
    // is tight, and recovered entities are deduped downstream to avoid duplicate orphan nodes).
    const LOW = Number(process.env.RECOVERY_LOW_COVERAGE || 40);
    const consider = (cat, cov, count) => {
      if (cov >= 100) return;
      if (count === undefined || count === 0 || cov < LOW) missingCategories.push(cat);
    };
    consider("life_safety", lifeSafetyCoverage);                         // no direct count → coverage
    consider("diagnosis", diagnosisCoverage, extractedCount.diagnosis);
    consider("medication", medicationCoverage, extractedCount.medication);
    consider("follow_up", followupCoverage, extractedCount.follow_up);
    consider("lab_result", numericCoverage, extractedCount.lab_result);
    consider("investigation", investigationCoverage, extractedCount.investigation);
    consider("procedure", procedureCoverage);                           // no direct count → coverage

    // LAB VALUES: numericCoverage is fooled by med doses/vitals (e.g. "Seroquel 5 mg" made it
    // 100%), so it never flags a missing lab panel. When the transcript clearly REVIEWS labs
    // but NO lab_result entity carrying a value was captured, force lab_result recovery so the
    // recovery agent pulls the actual analyte values (CRP, LFTs, platelets, TSH, …).
    const LAB_REVIEW_RX = /\b(crp|c-?reactive|\balt\b|\bast\b|\balp\b|ggt|bilirubin|platelet|h[ae]?moglobin|\bhgb\b|h[ae]?matocrit|\bwbc\b|\btsh\b|egfr|creatinine|\bldl\b|\bhdl\b|cholesterol|triglycerid|ferritin|\bb12\b|glucose|\ba1c\b|hba1c|\besr\b|albumin|liver enzyme|blood (?:test|work)|lab (?:results?|values?|work)|inflammatory marker)\b/i;
    const labResultEntities = entities.filter((e) => /lab_result/i.test(e.entity_type || '') && (e.value != null && String(e.value).trim())).length;
    if (LAB_REVIEW_RX.test(transcript) && labResultEntities === 0 && !missingCategories.includes('lab_result')) {
      missingCategories.push('lab_result');
    }

    const needsRecovery = missingCategories.length > 0;

    return { scores: { ...scores, extractedCount }, needsRecovery, missingCategories };
  }
}
