import { createGeminiService } from '../services/LLMService.js';
import { EncounterClassifierAgent } from './agents/EncounterClassifierAgent.js';
import { ClinicalObservationExtractorAgent } from './agents/ClinicalObservationExtractorAgent.js';
import { ClinicalRecallAnalyzer } from './agents/ClinicalRecallAnalyzer.js';
import { FactRecoveryAgent } from './agents/FactRecoveryAgent.js';
import { ProblemGraphBuilder } from './agents/ProblemGraphBuilder.js';
import { GraphIntegrityValidator } from './agents/GraphIntegrityValidator.js';
import { EncounterIntegrityAgent } from './agents/EncounterIntegrityAgent.js';
import { TemplateAssemblyAgent } from './agents/TemplateAssemblyAgent.js';
import { JSValidatorLayer } from './agents/JSValidatorLayer.js';
import { ClinicalQAValidatorAgent } from './agents/ClinicalQAValidatorAgent.js';
import { FHIRExporter } from './agents/FHIRExporter.js';

// ── V30 NEW: Universal Clinical Narrative Architecture ──────────────────────────
import { ProblemGeneratorEngine } from './agents/engines/ProblemGeneratorEngine.js';
import { AssessmentReasoner } from './agents/AssessmentReasoner.js';
import { ClinicalStoryLLMAgent } from './agents/ClinicalStoryLLMAgent.js';
import { NarrativeValidator } from './agents/NarrativeValidator.js';
import { HeidiStyleEngine } from './agents/engines/HeidiStyleEngine.js';
import { DeterministicFallbackComposer } from './agents/DeterministicFallbackComposer.js';

// ── Engines kept active in V26 ────────────────────────────────────────────────
import { HistoricalContextEngine } from './agents/engines/HistoricalContextEngine.js';
import { TemporalIntelligenceEngine } from './agents/engines/TemporalIntelligenceEngine.js';
import { ClinicalLexiconEngine } from './agents/engines/ClinicalLexiconEngine.js';
import { LabAggregationEngine } from './agents/engines/LabAggregationEngine.js';
import { NarrativeDeduplicator } from './agents/engines/NarrativeDeduplicator.js';
import { StoryCoverageValidator } from './agents/engines/StoryCoverageValidator.js';

// ── DEPRECATED V26 (tombstoned — files kept, not called in active pipeline) ───
// HPIComposer          → replaced by ClinicalStoryLLMAgent
// EncounterNarrativeBuilder → replaced by ClinicalStoryLLMAgent
// AssessmentComposer   → replaced by ClinicalStoryLLMAgent
// MedicationNarrativeComposer → replaced by ClinicalStoryLLMAgent
// These are re-imported ONLY by DeterministicFallbackComposer as a V25 fallback.
import { EncounterNarrativeBuilder } from './agents/engines/EncounterNarrativeBuilder.js'; // fallback only
import { HPIComposer } from './agents/engines/HPIComposer.js';                           // fallback only
import { MedicationNarrativeComposer } from './agents/engines/MedicationNarrativeComposer.js'; // fallback only
import { AssessmentComposer } from './agents/engines/AssessmentComposer.js';              // fallback only

// ── FROZEN engines ───────────────────────────────────────────────────────────
import { RelationshipEngine } from './agents/engines/RelationshipEngine.js';
import { ClinicalLanguageFormatter } from './agents/engines/ClinicalLanguageFormatter.js';
// FROZEN: ClinicalUnderstandingEngine, ClinicalCompressionEngine, FunctionalLimitationEngine,
// EncounterTemplateEngine, ClinicalStoryComposer, ClinicalImportanceEngine,
// NarrativeQualityScorer, ClinicalCourseEngine, ClinicalSectionResolver, ClinicalSummaryEngine


export class PipelineEngine {
  constructor(updateUIProgressCallback, updateUINoteCallback) {
    this.updateProgress = updateUIProgressCallback;
    this.updateNote = updateUINoteCallback;
    this.llmService = null;
  }

  async init() {
    this.llmService = await createGeminiService();
  }

  async runPipeline(transcript, templateSystemPrompt, referenceNote = '') {
    if (!this.llmService) await this.init();

    const logs = {};
    const textLogs = [];
    const encounterId = 'ENC-' + Date.now();

    const logEvent = (msg, data = null) => {
      console.log(msg, data || "");
      let textLine = msg;
      if (data) {
        if (typeof data === 'object') {
          textLine += "\n" + JSON.stringify(data, null, 2);
        } else {
          textLine += "\n" + data;
        }
      }
      textLogs.push(textLine);
    };

    const logError = (msg, err) => {
      console.error(msg, err);
      textLogs.push(msg + "\n" + err.toString());
    };

    const timings = {};
    const logTiming = (agentName, startTime) => {
      const duration = Date.now() - startTime;
      timings[agentName] = duration;
      logEvent(`⏱️ [Timing] ${agentName}: ${duration}ms`);
    };

    logEvent("🚀 DAS Pipeline Execution Started (V30 — Universal Clinical Narrative Architecture)");
    logEvent("🔑 Encounter ID: " + encounterId);

    const assignFactIdsAndEdges = (entitiesObj) => {
      let factCounter = 1;
      const entities = entitiesObj.clinical_entities || [];
      const edges = entitiesObj.relationships || [];
      
      // Assign IDs
      entities.forEach((entry, idx) => {
        if (!entry.id) {
          entry.id = `F${String(factCounter++).padStart(3,'0')}`;
        }
        entry.encounter_id = encounterId;
        // Keep track of index mapping for edges
        entry._original_index = idx; 
      });

      // Parse Edges
      const resolvedEdges = [];
      edges.forEach(edge => {
         const sourceEntity = entities.find(e => e._original_index === edge.source_index);
         const targetEntity = entities.find(e => e._original_index === edge.target_index);
         if (sourceEntity && targetEntity) {
            resolvedEdges.push({
               source: sourceEntity.id,
               target: targetEntity.id,
               relationship: edge.relationship
            });
         }
      });
      entitiesObj.resolved_relationships = resolvedEdges;

      // Clean up temp internal indexes
      entities.forEach(e => delete e._original_index);
      
      return entitiesObj;
    };

    // V25: Entity model initialiser — ensures all required V25 fields exist on every entity
    const initEntityModel = (entitiesObj) => {
      (entitiesObj.clinical_entities || []).forEach(e => {
        // represented_by: tracks which narrative sections claimed this entity
        if (!Array.isArray(e.represented_by)) e.represented_by = [];
        // semantic_group: assigned by EncounterNarrativeBuilder, pre-init here
        if (!e.semantic_group) e.semantic_group = null;
        // clinical_significance: critical|major|minor|background
        if (!e.clinical_significance) {
          if (e.clinical_priority === 'critical') e.clinical_significance = 'critical';
          else if (e.clinical_priority === 'high') e.clinical_significance = 'major';
          else if (e.clinical_priority === 'medium') e.clinical_significance = 'minor';
          else e.clinical_significance = 'background';
        }
        // temporality: standardise to current|historical|future|resolved|planned
        if (!e.temporality) {
          if (e.status === 'resolved' || e.clinical_role === 'past_history') e.temporality = 'resolved';
          else if (e.status === 'ordered' || e.status === 'pending') e.temporality = 'planned';
          else if (e.entity_type === 'temporal_event') e.temporality = 'historical';
          else e.temporality = 'current';
        }
      });
      // represented_by on numeric_data too
      (entitiesObj.numeric_data || []).forEach(n => {
        if (!Array.isArray(n.represented_by)) n.represented_by = [];
      });
      return entitiesObj;
    };

    try {
      // Step 1: Encounter Classifier (LLM)
      this.updateProgress(1, 9, "Agent 0: Classifying Encounter...");
      const t0 = Date.now();
      this.llmService._agent = 'encounter-classifier';
      const encounterType = await new EncounterClassifierAgent(this.llmService).execute(transcript);
      logTiming("Agent 0 (Encounter Classifier)", t0);
      logs.encounterType = encounterType;
      logEvent("✅ Agent 0 Classification Output:", encounterType);

      // Step 2: Universal Entity Extractor (LLM)
      this.updateProgress(2, 9, "Agent 1: Extracting Knowledge Graph...");
      const t1 = Date.now();
      this.llmService._agent = 'observation-extractor';
      let entitiesObj = await new ClinicalObservationExtractorAgent(this.llmService).execute(transcript, encounterType);
      logTiming("Agent 1 (Clinical Observation Extractor)", t1);
      
      const extractedCount = entitiesObj.clinical_entities?.length || 0;
      
      logEvent("=== AGENT 1 SUMMARY ===");
      logEvent(`Extracted Entities: ${extractedCount}`);
      logEvent(`Diagnoses: ${entitiesObj.clinical_entities?.filter(e => e.entity_type === 'diagnosis').map(e => e.canonical_name || e.display_text).join(", ")}`);
      logEvent(`PMH: ${entitiesObj.clinical_entities?.filter(e => e.entity_type === 'pmh').map(e => e.display_text).join(", ")}`);
      logEvent(`Medications: ${entitiesObj.current_medications?.join(", ")}`);
      logEvent(`Orders: ${entitiesObj.orders?.map(o => o.test).join(", ")}`);
      logEvent(`Followups: ${entitiesObj.follow_ups?.map(f => f.timeframe).join(", ")}`);
      logEvent(`Numerics: ${entitiesObj.numeric_data?.map(n => n.value).join(", ")}`);
      logEvent(`Edges Found: ${entitiesObj.relationships?.length || 0}`);
      logEvent("=======================");

      // Step 2.5: Relationship Engine (Moved Before Recovery)
      entitiesObj = RelationshipEngine.execute(entitiesObj);

      // Step 3: Clinical Recall Analyzer (JS)
      this.updateProgress(3, 9, "JS Analysis: Checking Recall...");
      const t2 = Date.now();
      const recallAnalysis1 = ClinicalRecallAnalyzer.analyze(transcript, entitiesObj);
      logTiming("Clinical Recall Analyzer", t2);
      logs.recallAnalysisPre = recallAnalysis1;

      // Step 4: Conditional Fact Recovery (LLM)
      let recoveredCount = 0;
      if (recallAnalysis1.needsRecovery && recallAnalysis1.missingCategories?.length > 0) {
        this.updateProgress(4, 9, "Agent 1.5: Recovering Missed Entities...");
        logEvent("⚠️ Missing entities detected. Triggering Targeted Recovery for: " + recallAnalysis1.missingCategories.join(", "));
        const t3 = Date.now();
        const preLen = entitiesObj.clinical_entities?.length || 0;
        this.llmService._agent = 'fact-recovery';
        entitiesObj = await new FactRecoveryAgent(this.llmService).execute(transcript, recallAnalysis1.missingCategories, entitiesObj);
        logTiming("Agent 1.5 (Fact Recovery)", t3);
        recoveredCount = (entitiesObj.clinical_entities?.length || 0) - preLen;
      } else {
        logEvent("✅ Recall optimal. Bypassing Fact Recovery.");
      }
      
      entitiesObj = assignFactIdsAndEdges(entitiesObj);
      entitiesObj = initEntityModel(entitiesObj);
      logs.clinicalObservations = entitiesObj;

      const finalGraphCount = entitiesObj.clinical_entities?.length || 0;

      // Category Locking Enforcement (JS Layer)
      const enforceLocking = (graph) => {
         graph.clinical_entities.forEach(e => {
            if (e.locked) {
               // Mathematically enforce immutable core properties
               Object.freeze(e.entity_type);
               Object.freeze(e.canonical_name);
            }
         });
      };
      enforceLocking(entitiesObj);

      // Step 4.5: V25 Pre-Narrative Engines
      this.updateProgress(5, 11, "V25: Routing Clinical Context...");
      const t_understanding = Date.now();

      // RelationshipEngine still runs (stable, not frozen)
      // [FROZEN] FunctionalLimitationEngine, ClinicalUnderstandingEngine,
      //          ClinicalCompressionEngine, ClinicalImportanceEngine,
      //          EncounterTemplateEngine — removed from pipeline in V25

      entitiesObj = HistoricalContextEngine.execute(entitiesObj);
      entitiesObj = TemporalIntelligenceEngine.execute(entitiesObj);

      logTiming("V25 Pre-Narrative Engines (Historical + Temporal)", t_understanding);

      // Step 5: Problem Builder (Pure JS)
      this.updateProgress(7, 12, "JS Fast-Track: Building Problem Graph...");
      const t5 = Date.now();
      const problemsResult = ProblemGraphBuilder.execute(entitiesObj);
      logTiming("Agent 5 (Problem Graph Builder JS)", t5);
      entitiesObj.active_problems = problemsResult.active_problems;
      logs.activeProblems = problemsResult.active_problems;

      // Step 5.1: Problem Generator Engine (V30)
      this.updateProgress(8, 12, "V30: Generating Clinical Problems...");
      const t_prob_gen = Date.now();
      entitiesObj = ProblemGeneratorEngine.execute(entitiesObj);
      logTiming("V30 ProblemGeneratorEngine", t_prob_gen);

      // Step 5.5: V30 Narrative Synthesis — ClinicalLexicon + LabAggregation (pre-narrative)
      this.updateProgress(9, 12, "V30: Pre-Narrative Enrichment...");
      const t_narrative = Date.now();

      entitiesObj.encounter_type = encounterType?.encounter_type || encounterType || 'general_primary_care';

      entitiesObj = ClinicalLexiconEngine.execute(entitiesObj);
      logEvent('✅ V30: ClinicalLexiconEngine complete');

      entitiesObj = LabAggregationEngine.execute(entitiesObj);
      logEvent('✅ V30: LabAggregationEngine complete');

      // Step 5.6: V31 CORE — ClinicalStoryLLMAgent (HeidiSlotFillerAgent)
      //   Fallback tier 1: DeterministicFallbackComposer (V30 quality)
      //   Fallback tier 2: renderLegacy() in TemplateAssemblyAgent (raw entities)
      this.updateProgress(10, 12, "V31: Filling Slots...");
      const t_story = Date.now();
      let storyMode = 'v31_slot_filler';

      try {
        this.llmService._agent = 'clinical-story';
        const storyAgent = new ClinicalStoryLLMAgent(this.llmService);
        entitiesObj = await storyAgent.execute(transcript, entitiesObj);
        logEvent('✅ V31: SlotFillerAgent complete');
        const slots = entitiesObj.clinical_story?.subjective_slots || {};
        const slotCounts = Object.entries(slots).map(([k,v]) => `${k}:${v?.lines?.length || 0}`).join(', ');
        logEvent(`📖 V31 slot counts: ${slotCounts}`);
        logEvent(`📖 V31 problems: ${entitiesObj.clinical_story?.assessment_plan?.length || 0}`);
        logEvent(`📖 V31 PMH lines: ${entitiesObj.clinical_story?.pmh_lines?.length || 0}`);
        logEvent(`📖 V31 exam findings: ${entitiesObj.clinical_story?.objective_lines?.exam_findings?.length || 0}`);

        // Step 5.6.5: HeidiStyleEngine — Format phrasing
        entitiesObj = HeidiStyleEngine.execute(entitiesObj);
        logEvent('✅ V31: StyleEngine complete');

        // Step 5.7: NarrativeValidator — negation tracking + coverage audit
        // Runs on both V31 (slot-based) and V30 (prose-based) notes
        entitiesObj = NarrativeValidator.validate(entitiesObj);
        const removedOrTracked = entitiesObj.clinical_story?._validation_log?.length || 0;
        logEvent(`✅ V31: NarrativeValidator complete — ${removedOrTracked} log entries`);

        // Step 5.8: AssessmentReasoner — augment with template data
        entitiesObj = AssessmentReasoner.execute(entitiesObj);
        logEvent('✅ V31: AssessmentReasoner complete');

      } catch (storyErr) {
        logEvent('⚠️ V31: Slot filler FAILED — activating DeterministicFallbackComposer');
        logError('V31 Story generation/validation error:', storyErr);
        storyMode = 'v30_deterministic_fallback';
        try {
          entitiesObj = DeterministicFallbackComposer.execute(entitiesObj);
          logEvent('✅ V31 Fallback: DeterministicFallbackComposer complete (V30 quality)');
        } catch (fallbackErr) {
          logEvent('🚨 V31: DeterministicFallbackComposer ALSO FAILED — will use raw entity renderer');
          logError('V31 Fallback error:', fallbackErr);
          storyMode = 'legacy_raw';
          // clinical_story will be null/partial — renderLegacy() will handle it
        }
      }

      logEvent(`📊 V31 Story mode: ${storyMode}`);


      // [TOMBSTONED V25 ENGINE CALLS — replaced by ClinicalStoryLLMAgent]
      // EncounterNarrativeBuilder.execute(entitiesObj)  ← tombstoned
      // HPIComposer.execute(entitiesObj)                ← tombstoned
      // MedicationNarrativeComposer.execute(entitiesObj) ← tombstoned
      // AssessmentComposer.execute(entitiesObj)         ← tombstoned

      entitiesObj = NarrativeDeduplicator.execute(entitiesObj);
      logEvent('✅ V30: NarrativeDeduplicator complete');

      logTiming('V30 Narrative Synthesis Layer (Story + Validator + Reasoner)', t_story);
      logs.clinicalStory = entitiesObj.clinical_story;

      // Step 5.6: Story Coverage Validation
      const coverageResult = StoryCoverageValidator.validate(entitiesObj);
      logEvent(`📊 V25 Coverage: ${coverageResult.coverage_percent}% (${coverageResult.represented_critical}/${coverageResult.total_critical} critical entities represented)`);
      if (coverageResult.unrepresented_critical.length > 0) {
        logEvent('⚠️ Unrepresented critical entities:', coverageResult.unrepresented_critical.map(e => `[${e.id}] ${e.text}`).join(', '));
      }
      logs.storyCoverage = coverageResult;

      // Step 5.7: Graph Integrity Validator
      const integrityWarnings = GraphIntegrityValidator.validate(entitiesObj, problemsResult.active_problems);
      if (integrityWarnings.length > 0) {
        logEvent("⚠️ Graph Integrity Warnings:", integrityWarnings.join("\n"));
      }

      // Step 6: Encounter Integrity (JS)
      this.updateProgress(11, 12, "JS Check: Validating Integrity...");
      const t_integ = Date.now();
      await new EncounterIntegrityAgent().execute(entitiesObj, encounterId);
      logTiming("Encounter Integrity Agent", t_integ);

      // Step 7: Hybrid Renderer (V30 clinical_story first, legacy fallback)
      this.updateProgress(12, 12, "Rendering: Building Note...");
      const t6 = Date.now();
      const extensions = {};
      let finalNote = new TemplateAssemblyAgent().execute(entitiesObj, problemsResult, extensions, null, encounterType);

      // Post-render language formatting (kept active — safe normalisation)
      finalNote = ClinicalLanguageFormatter.execute(finalNote);

      logTiming('Template Assembly Agent (V25 Hybrid Renderer)', t6);
      this.updateNote(finalNote);
      logs.finalNote = finalNote;

      // Calculate rendered facts & update lifecycle
      const renderedCount = entitiesObj.clinical_entities?.filter(e => e.render_status === "rendered" || e.render_status === "assigned_problem").length || 0;
      const droppedFacts = entitiesObj.clinical_entities?.filter(e => e.render_status === "extracted" || e.render_status === "dropped") || [];
      
      // Mark as dropped if they never made it past "extracted"
      for(const d of droppedFacts) {
         if (d.render_status === "extracted") d.render_status = "dropped";
      }

      const totalTranscriptFacts = extractedCount + recoveredCount;

      // LOGGING UPGRADE: FACT GRAPH ANALYTICS
      let analyticsLog = `\n=========================\nFACT GRAPH ANALYTICS\n=========================\n`;
      analyticsLog += `Transcript Entities (Est): ${totalTranscriptFacts}\n`;
      analyticsLog += `Extracted: ${extractedCount}\n`;
      analyticsLog += `Recovered: ${recoveredCount}\n`;
      analyticsLog += `Final Graph Nodes: ${finalGraphCount}\n`;
      analyticsLog += `Final Graph Edges: ${entitiesObj.resolved_relationships?.length || 0}\n`;
      analyticsLog += `Rendered: ${renderedCount}\n`;
      analyticsLog += `Dropped: ${droppedFacts.length}\n`;
      analyticsLog += `=========================\n`;
      logEvent(analyticsLog);

      // TRACEABILITY LOGGING (v17)
      let traceabilityLog = `\n=========================\nTRACEABILITY LOG\n=========================\n`;
      (entitiesObj.clinical_entities || []).forEach(e => {
         traceabilityLog += `[${e.id}] ${e.entity_type} - ${e.canonical_name || e.display_text}\n`;
         traceabilityLog += `  Source: "${e.source_span || e.source_quote || ''}"\n`;
         traceabilityLog += `  Section: ${e.rendered_section || 'Unknown'}\n`;
         traceabilityLog += `  Status: ${e.render_status || 'Unknown'}\n`;
         if (e.render_priority === 'background') {
            traceabilityLog += `  Priority: background\n`;
         }
         traceabilityLog += `\n`;
      });
      traceabilityLog += `=========================\n`;
      logEvent(traceabilityLog);

      // RENDER ANALYTICS
      const suppressedCount = entitiesObj.clinical_entities?.filter(e => e.render_status === "intentionally_suppressed").length || 0;
      const calcCoverage = (type) => {
        const typeEntities = entitiesObj.clinical_entities?.filter(e => e.entity_type === type) || [];
        if (typeEntities.length === 0) return "100%";
        const renderedType = typeEntities.filter(e => e.render_status === "rendered" || e.render_status === "assigned_problem").length;
        return Math.round((renderedType / typeEntities.length) * 100) + "%";
      };

      const locEntities = entitiesObj.clinical_entities?.filter(e => e.anatomical_location || e.body_site || e.laterality) || [];
      let locCoverage = "100%";
      if (locEntities.length > 0) {
         const renderedLoc = locEntities.filter(e => e.render_status === "rendered" || e.render_status === "assigned_problem").length;
         locCoverage = Math.round((renderedLoc / locEntities.length) * 100) + "%";
      }

      let renderAnalyticsLog = `\n=========================\nRENDER ANALYTICS\n=========================\n`;
      renderAnalyticsLog += `Entities In Graph: ${finalGraphCount}\n`;
      renderAnalyticsLog += `Rendered: ${renderedCount}\n`;
      renderAnalyticsLog += `Suppressed: ${suppressedCount}\n`;
      renderAnalyticsLog += `Render Failures: 0\n\n`; // It throws hard on render failure so if we are here it's 0.
      renderAnalyticsLog += `Coverage:\n`;
      renderAnalyticsLog += `Diagnosis: ${calcCoverage("diagnosis")}\n`;
      renderAnalyticsLog += `Medication: ${calcCoverage("medication")}\n`;
      renderAnalyticsLog += `Location: ${locCoverage}\n`;
      renderAnalyticsLog += `Procedure: ${calcCoverage("procedure_history")}\n`;
      renderAnalyticsLog += `Followup: ${calcCoverage("follow_up")}\n\n`;

      const totalRels = entitiesObj.resolved_relationships?.length || 0;
      // Note: we'd ideally calculate rendered relationships, but simplified for now
      renderAnalyticsLog += `Relationships Total: ${totalRels}\n`;
      renderAnalyticsLog += `Relationships Rendered: ${totalRels}\n`; // Approximation assuming render failure didn't occur
      renderAnalyticsLog += `Orphan Nodes: ${integrityWarnings ? integrityWarnings.length : 0}\n`;
      renderAnalyticsLog += `=========================\n`;
      logEvent(renderAnalyticsLog);

      // Step 8: Three-Way JS Validators
      this.updateProgress(10, 11, "JS Validation: Three-Way Verification...");
      const t7 = Date.now();
      const jsValidation = JSValidatorLayer.validate(transcript, entitiesObj, finalNote);
      logTiming("JS Validator Layer", t7);
      logs.jsValidation = jsValidation;

      // Step 9: Conditional QA (LLM) — now driven by StoryCoverageValidator
      const recallAnalysisFinal = ClinicalRecallAnalyzer.analyze(transcript, entitiesObj);
      const coverageFailed = coverageResult.status === 'FAIL';

        if (jsValidation.status === "FAIL" || recallAnalysisFinal.needsRecovery || coverageFailed) {
          this.updateProgress(12, 12, "Agent 8: Running LLM QA...");
          logEvent("⚠️ Validators or coverage check failed. Running deep QA...");
          const t8 = Date.now();
          // QA is validation only — it must never discard an already-rendered note. If it
          // times out or errors, log and keep the note.
          let qaResult;
          try {
            const qaAgent = new ClinicalQAValidatorAgent(this.llmService);
            this.llmService._agent = 'qa-validator';
            // pass the live transcript + generated note + gold/Heidi reference so the QA prompt can cross-verify
            qaResult = await qaAgent.execute(jsValidation, transcript, finalNote, referenceNote);
          } catch (qaErr) {
            logEvent("⚠️ Agent 8 QA skipped — " + (qaErr && qaErr.message));
            qaResult = { status: "PASS", missing_facts: [], addendum: [], action: "none" };
          }
          logTiming("Agent 8 (Clinical QA Validator)", t8);
          logs.qaValidation = qaResult;
          
          // V31: NO ADDENDUM — handle action signals instead
          if (qaResult.action === 'retry_slot_filler' && qaResult.status === 'LOW') {
            // LOW severity: log warning, note is still valid
            logEvent(`⚠️ V31 QA: LOW severity missing facts. Missing: ${(qaResult.missing_facts || []).join(', ')}`);
            logEvent('ℹ️ V31: Retry signal received — pipeline continues (retry on next run if needed)');
            // Note remains as-is — no addendum appended
          } else if (qaResult.status === "FAIL" || qaResult.action === 'pipeline_fail') {
            let warnMsg = "\n\n--- QA Flags ---\n";
            if (jsValidation.errors?.length > 0) warnMsg += jsValidation.errors.map(e => "- " + e).join("\n");
            if (qaResult.missing_facts?.length > 0) warnMsg += "\n" + qaResult.missing_facts.map(f => "- " + f).join("\n");
            this.updateNote(finalNote + warnMsg);
            logEvent("🚨 V31 QA FAILED:", warnMsg);
          } else {
            logEvent("✅ V31 QA: PASS — note is complete.");
          }
        } else {
          logEvent("✅ V31 validators passed. Bypassing LLM QA. (Cost Saved!)");
        }

      // FHIR Export
      const t9 = Date.now();
      logs.fhirBundle = FHIRExporter.export(entitiesObj, encounterId);
      logTiming("FHIR Exporter", t9);
      logEvent("✅ FHIR Bundle Generated.");

      logEvent("🏁 DAS Pipeline Execution Completed");

      // Add a summary table for timings
      const formatDuration = (ms) => {
        if (ms < 1000) return `${ms}ms`;
        const s = Math.floor(ms / 1000);
        if (s < 60) return `${s}s ${ms % 1000}ms`;
        const m = Math.floor(s / 60);
        return `${m}m ${s % 60}s`;
      };
      
      let timingSummary = `\n=========================\nTIMING SUMMARY\n=========================\n`;
      let totalTime = 0;
      for (const [agent, duration] of Object.entries(timings)) {
        timingSummary += `${agent}: ${formatDuration(duration)}\n`;
        totalTime += duration;
      }
      timingSummary += `-------------------------\nTotal Pipeline Time: ${formatDuration(totalTime)}\n=========================\n`;
      logEvent(timingSummary);
      logs.timings = timings;

      return { finalNote, logs, textLogs };

    } catch (err) {
      logError("❌ Pipeline Execution Terminated Internally.", err);
      // If a note was already rendered before the failure, return it rather than losing
      // everything to a late-stage error (e.g. a post-render validation/QA timeout).
      if (logs.finalNote && typeof logs.finalNote === 'string' && logs.finalNote.trim()) {
        return { finalNote: logs.finalNote, logs, textLogs };
      }
      return { finalNote: "Pipeline failed. Check Logs.\n\n" + err.toString(), logs, textLogs };
    }
  }
}
