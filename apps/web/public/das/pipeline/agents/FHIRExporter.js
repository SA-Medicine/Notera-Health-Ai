export class FHIRExporter {
  static export(extractedData, encounterId) {
    const patientId = "urn:uuid:patient-123"; // Placeholder
    const fhirEncounterId = "urn:uuid:" + encounterId;
    
    const bundle = {
      resourceType: "Bundle",
      type: "transaction",
      entry: []
    };

    // 1. Encounter
    bundle.entry.push({
      fullUrl: fhirEncounterId,
      resource: {
        resourceType: "Encounter",
        id: encounterId,
        status: "finished",
        class: {
          system: "http://terminology.hl7.org/CodeSystem/v3-ActCode",
          code: "AMB",
          display: "ambulatory"
        },
        subject: { reference: patientId }
      },
      request: { method: "POST", url: "Encounter" }
    });

    const facts = extractedData.clinical_facts || [];

    // 2. Condition (Diagnoses & Active Problems)
    const diagnoses = facts.filter(f => f.category === "diagnosis");
    for (const diag of diagnoses) {
      bundle.entry.push({
        fullUrl: "urn:uuid:" + diag.id,
        resource: {
          resourceType: "Condition",
          id: diag.id,
          clinicalStatus: {
            coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-clinical", code: "active" }]
          },
          code: {
            text: diag.canonical_name || diag.text
          },
          subject: { reference: patientId },
          encounter: { reference: fhirEncounterId }
        },
        request: { method: "POST", url: "Condition" }
      });
    }

    // 3. Observation (Physical Exam, Numerics, Labs)
    const observations = facts.filter(f => f.category === "physical_exam" || f.category === "symptom");
    for (const obs of observations) {
      bundle.entry.push({
        fullUrl: "urn:uuid:" + obs.id,
        resource: {
          resourceType: "Observation",
          id: obs.id,
          status: "final",
          code: {
            text: obs.text
          },
          subject: { reference: patientId },
          encounter: { reference: fhirEncounterId },
          valueString: obs.symptom_characteristic || undefined,
          bodySite: obs.body_site ? { text: obs.body_site } : undefined
        },
        request: { method: "POST", url: "Observation" }
      });
    }

    // Include Numerics as Observations
    const numerics = extractedData.numeric_data || [];
    for (let i = 0; i < numerics.length; i++) {
      const numId = "NUM-" + i;
      bundle.entry.push({
        fullUrl: "urn:uuid:" + numId,
        resource: {
          resourceType: "Observation",
          id: numId,
          status: "final",
          code: { text: "Numeric Vital/Lab" },
          subject: { reference: patientId },
          encounter: { reference: fhirEncounterId },
          valueString: numerics[i]
        },
        request: { method: "POST", url: "Observation" }
      });
    }

    // 4. MedicationRequest
    const medDecisions = extractedData.medication_decisions || [];
    for (let i = 0; i < medDecisions.length; i++) {
      const med = medDecisions[i];
      const medId = "MED-" + i;
      bundle.entry.push({
        fullUrl: "urn:uuid:" + medId,
        resource: {
          resourceType: "MedicationRequest",
          id: medId,
          status: "active",
          intent: "order",
          medicationCodeableConcept: {
            text: med.medication
          },
          subject: { reference: patientId },
          encounter: { reference: fhirEncounterId },
          dosageInstruction: [{
            text: med.planned_dose || med.current_dose
          }]
        },
        request: { method: "POST", url: "MedicationRequest" }
      });
    }

    return bundle;
  }
}
