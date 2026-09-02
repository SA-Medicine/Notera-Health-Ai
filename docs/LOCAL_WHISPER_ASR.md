# Local Whisper ASR

Notera can run speech-to-text locally with `faster-whisper` and Whisper
`large-v3-turbo` while preserving the existing `/api/asr` contract.

## Provider Switch

```bash
ASR_PROVIDER=whisper_local
ASR_WHISPER_MODEL=large-v3-turbo
ASR_WHISPER_DEVICE=auto
ASR_WHISPER_LANGUAGE=en
```

Rollback:

```bash
ASR_PROVIDER=google
```

The existing Google Speech code remains in place for rollback only.

## Runtime Flow

```text
browser audio blob
  -> POST /api/asr
  -> ffmpeg normalization to mono 16 kHz PCM WAV in a temporary directory
  -> local Python worker
  -> faster-whisper large-v3-turbo
  -> { text, transcript, requestId }
```

The worker is spawned once by the backend and loads the model once. Requests are
sent over stdin/stdout JSON lines, so no public ASR port is opened.

## Device Selection

`ASR_WHISPER_DEVICE=auto` starts with CUDA FP16 when `nvidia-smi` is usable,
otherwise CPU INT8. The production image installs the CUDA 12/cuDNN 9 Python
runtime libraries required by current `ctranslate2`; the VM still needs an
NVIDIA driver and container GPU access. To force production GPU mode:

```bash
ASR_WHISPER_DEVICE=cuda
ASR_WHISPER_COMPUTE_TYPE=float16
```

To force CPU fallback:

```bash
ASR_WHISPER_DEVICE=cpu
ASR_WHISPER_COMPUTE_TYPE=int8
```

## Transcription Settings

Defaults:

```text
language=en
beam_size=5
vad_filter=true
condition_on_previous_text=true
```

The endpoint response remains:

```json
{ "text": "...", "transcript": "...", "requestId": "..." }
```

Temporary normalized audio files are deleted after each request. Logs include
request id, audio duration, model, device, latency, and real-time factor, but not
audio contents or transcript text.
