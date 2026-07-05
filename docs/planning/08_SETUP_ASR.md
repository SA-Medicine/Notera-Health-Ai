# 08 — Setup: Medical ASR (Speech-to-Text)

Enable and use Google's medical/enhanced speech recognition to turn consult audio into a clean, diarized transcript — the input to the whole pipeline.

> We use Google's Speech-to-Text (Chirp / medical models) to stay in one ecosystem with Gemini + Firestore. Keep the transcript interface abstract (`01 §4`) so a different vendor (Amazon Transcribe Medical, AssemblyAI, Corti) can be swapped later.

---

## 1. Enable the API

```bash
gcloud services enable speech.googleapis.com

# The Cloud Run backend's service account needs permission to call it.
gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
  --member="serviceAccount:BACKEND_SA_EMAIL" \
  --role="roles/speech.client"
```

No API key needed — Cloud Run uses its service account automatically (Application Default Credentials).

---

## 2. Two modes

- **Batch (recommended to start):** upload the finished recording, get a transcript back. Simplest, best accuracy, fine for "record visit → generate note."
- **Streaming (later):** live transcription as the clinician speaks (ambient scribe feel). More moving parts; add once batch works.

Store audio in **GCS** (BAA-eligible) and point the API at the `gs://` URI for anything longer than ~1 minute.

---

## 3. Key settings for clinical audio

| Setting | Why |
|---------|-----|
| **Model:** medical/enhanced (e.g. `medical_conversation` / Chirp) | Domain vocabulary — general models mis-hear drug names. |
| **Speaker diarization: ON** | Separate clinician vs patient turns → better notes. |
| **Automatic punctuation: ON** | Readable transcript. |
| **Word time offsets: ON** | Lets you link note text back to audio (audit/trust). |
| **Language + region** | Match your locale; keep data in-region. |

`[DECIDE]` Confirm which medical model your region/account exposes, and whether you need MedASR (open model) vs the managed Speech-to-Text medical model.

---

## 4. Call it from the Node backend (batch example)

```js
import speech from "@google-cloud/speech";
const client = new speech.SpeechClient();

export async function transcribe(gcsUri) {
  const [operation] = await client.longRunningRecognize({
    audio: { uri: gcsUri }, // gs://bucket/consult123.wav
    config: {
      encoding: "LINEAR16",
      sampleRateHertz: 16000,
      languageCode: "en-US",
      model: "medical_conversation",     // domain model
      useEnhanced: true,
      enableAutomaticPunctuation: true,
      enableWordTimeOffsets: true,
      diarizationConfig: {
        enableSpeakerDiarization: true,
        minSpeakerCount: 2, maxSpeakerCount: 2,
      },
    },
  });
  const [response] = await operation.promise();

  // Build speaker-tagged turns for the transcript object (01 §4)
  const turns = response.results.map(r => ({
    speaker: r.alternatives[0]?.words?.[0]?.speakerTag ?? null,
    text: r.alternatives[0]?.transcript ?? "",
  }));
  return { turns, raw: response.results };
}
```

Output feeds straight into the transcript object, then NER, then Gemini.

---

## 5. Quality guardrails

- General ASR can hit ~40% word-error-rate on medical dictation — **always use a medical/enhanced model**, never a baseline.
- Add a **custom vocabulary / phrase hints** for your specialty's drugs, procedures, and abbreviations to cut errors further.
- Surface a **low-confidence flag** per segment so the clinician reviews shaky transcription.
- Since ASR errors poison everything downstream, spot-check ASR accuracy on a sample as part of your eval (`03 §6`).

---

## 6. Compliance

- Audio and transcripts are **PHI** — store in BAA-covered GCS/Firestore, encrypted, access-controlled.
- Speech-to-Text is BAA-eligible on Google Cloud — confirm it's covered by your BAA.
- Sign the BAA **before** any real patient audio flows.

---

## 7. Checklist

- [ ] Speech API enabled, backend SA has `speech.client`.
- [ ] Audio bucket in GCS (BAA-covered, encrypted).
- [ ] Medical/enhanced model selected; diarization + punctuation on.
- [ ] Custom phrase hints for your specialty added.
- [ ] Transcript maps into the transcript object (`01 §4`).
- [ ] ASR accuracy sampled in eval.

> Next: `09_SETUP_FIRESTORE.md` — where transcripts, notes, and feedback live.
