import { PipelineEngine } from './PipelineEngine.js';

async function run() {
  const transcript = `
    Doctor: Hi John, how are you feeling?
    Patient: My stomach has been hurting a lot lately, and I've been feeling really tired.
    Doctor: I see. Are you still taking your stomach pills?
    Patient: Yes, the pantoprazole. But it's not helping much.
    Doctor: We got your lab results back. Your hemoglobin is 8.7, which means you have iron deficiency anemia, likely secondary to a bleeding gastric ulcer.
    Patient: Oh wow.
    Doctor: I'm going to start you on iron pills. Also, I'm referring you to Dr. Taraban for an endoscopy. Follow up with me in 4 weeks.
  `;

  console.log("Starting v17 pipeline test...");
  const pipeline = new PipelineEngine(() => {}, () => {});
  await pipeline.init();

  const { finalNote, logs, textLogs } = await pipeline.runPipeline(transcript);

  console.log("\n\n========================");
  console.log("FINAL NOTE GENERATED");
  console.log("========================");
  console.log(finalNote);

  console.log("\n\n========================");
  console.log("TRACEABILITY LOGS");
  console.log("========================");
  // filter text logs to just show traceability/analytics
  const analyticsLogs = textLogs.filter(l => l.includes("ANALYTICS") || l.includes("TRACEABILITY"));
  analyticsLogs.forEach(l => console.log(l));
}

run().catch(console.error);
