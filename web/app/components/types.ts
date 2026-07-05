export type Flag = { type: string; field?: string; message: string; severity: 'info' | 'low' | 'warning' | 'critical' };

export interface APIssue {
  issue: string;
  diagnosis: string;
  differential_diagnoses: string[];
  investigations_planned: string;
  treatment_planned: string;
  referrals: string;
}

export interface Note {
  schema_version: string;
  note_type: string;
  specialty: string;
  subjective: {
    reason_for_visit: string;
    hpi_details: string;
    aggravating_relieving_factors: string;
    symptom_progression: string;
    previous_episodes: string;
    functional_impact: string;
    associated_symptoms: string;
  };
  past_medical_history: {
    medical_surgical: string;
    social: string;
    family: string;
    exposure: string;
    immunisation: string;
    other: string;
  };
  objective: {
    vital_signs: string;
    examination: string;
    completed_investigations: string;
  };
  assessment_and_plan: APIssue[];
  metadata: {
    generated_by: string;
    encounter_id: string | null;
    confidence?: Record<string, number>;
    medications_mentioned?: string[];
    flags?: Flag[];
  };
}

export interface PipelineLogs {
  textLogs: string[];
  timings: Record<string, number>;
  stages: {
    encounterType: string | null;
    entityCount: number;
    activeProblems: number;
    storyCoverage: number | null;
    jsValidation: string | null;
    qaValidation: string | null;
    fhirGenerated: boolean;
  };
}

export interface DraftResult {
  consultId: string;
  draftId: string;
  note: Note;
  renderedNote: string;
  status: 'PASS' | 'FLAGGED' | 'INVALID';
  flags: Flag[];
  schemaErrors: { path: string; message: string }[];
  entities: { text: string; label: string; negated?: boolean }[];
  logs?: PipelineLogs;
}
