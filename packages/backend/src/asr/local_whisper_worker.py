#!/usr/bin/env python3
"""Line-delimited JSON worker for local faster-whisper ASR.

No audio/transcript content is written to stderr. The parent process owns temp
file deletion after each request completes.
"""

import json
import os
import subprocess
import sys
import time
import traceback


def env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    return raw.lower() in ("1", "true", "yes", "on")


def has_nvidia_smi() -> bool:
    try:
        return subprocess.run(
            ["nvidia-smi"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=2,
            check=False,
        ).returncode == 0
    except Exception:
        return False


def resolve_device():
    requested_device = os.environ.get("ASR_WHISPER_DEVICE", "auto").lower()
    requested_compute = os.environ.get("ASR_WHISPER_COMPUTE_TYPE")

    if requested_device == "auto":
        if has_nvidia_smi():
            return "cuda", requested_compute or "float16"
        return "cpu", requested_compute or "int8"
    if requested_device == "cuda":
        return "cuda", requested_compute or "float16"
    return "cpu", requested_compute or "int8"


def write(obj):
    sys.stdout.write(json.dumps(obj, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def load_model():
    try:
        import nvidia.cublas.lib
        import nvidia.cudnn.lib

        lib_paths = [
            os.path.dirname(nvidia.cublas.lib.__file__),
            os.path.dirname(nvidia.cudnn.lib.__file__),
        ]
        existing = os.environ.get("LD_LIBRARY_PATH")
        os.environ["LD_LIBRARY_PATH"] = ":".join(lib_paths + ([existing] if existing else []))
    except Exception:
        pass

    from faster_whisper import WhisperModel

    model_name = os.environ.get("ASR_WHISPER_MODEL", "large-v3-turbo")
    download_root = os.environ.get("ASR_WHISPER_CACHE_DIR") or None
    cpu_threads = int(os.environ.get("ASR_WHISPER_CPU_THREADS") or "0") or 0

    device, compute_type = resolve_device()
    started = time.perf_counter()
    kwargs = {
        "device": device,
        "compute_type": compute_type,
    }
    if download_root:
        kwargs["download_root"] = download_root
    if cpu_threads > 0:
        kwargs["cpu_threads"] = cpu_threads

    try:
        model = WhisperModel(model_name, **kwargs)
    except Exception as exc:
        if os.environ.get("ASR_WHISPER_DEVICE", "auto").lower() != "auto" or device != "cuda":
            raise
        sys.stderr.write(f"cuda_float16_load_failed; falling back to cpu/int8 ({type(exc).__name__})\n")
        sys.stderr.flush()
        device, compute_type = "cpu", "int8"
        kwargs["device"] = device
        kwargs["compute_type"] = compute_type
        model = WhisperModel(model_name, **kwargs)

    load_ms = int((time.perf_counter() - started) * 1000)
    write({
        "type": "ready",
        "model": model_name,
        "device": device,
        "compute_type": compute_type,
        "load_ms": load_ms,
    })
    return model, model_name, device, compute_type


try:
    MODEL, MODEL_NAME, DEVICE, COMPUTE_TYPE = load_model()
except Exception as exc:
    sys.stderr.write(f"model_load_failed:{type(exc).__name__}:{str(exc)[:240]}\n")
    sys.stderr.flush()
    raise


for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    request_id = None
    started = time.perf_counter()
    try:
        msg = json.loads(line)
        request_id = msg.get("request_id")
        if msg.get("type") != "transcribe":
            raise ValueError("unknown worker message")
        audio_path = msg.get("audio_path")
        if not audio_path or not os.path.exists(audio_path):
            raise ValueError("audio file not found")

        segments_iter, info = MODEL.transcribe(
            audio_path,
            language=msg.get("language") or "en",
            beam_size=int(msg.get("beam_size") or 5),
            vad_filter=bool(msg.get("vad_filter", True)),
            condition_on_previous_text=bool(msg.get("condition_on_previous_text", True)),
        )
        segments = []
        parts = []
        for seg in segments_iter:
            text = (seg.text or "").strip()
            if text:
                parts.append(text)
            segments.append({
                "start": float(seg.start),
                "end": float(seg.end),
                "text": text,
            })
        elapsed = time.perf_counter() - started
        write({
            "ok": True,
            "request_id": request_id,
            "text": " ".join(parts).strip(),
            "segments": segments,
            "language": getattr(info, "language", None),
            "language_probability": getattr(info, "language_probability", None),
            "duration": getattr(info, "duration", None),
            "duration_after_vad": getattr(info, "duration_after_vad", None),
            "latency_ms": int(elapsed * 1000),
            "model": MODEL_NAME,
            "device": DEVICE,
            "compute_type": COMPUTE_TYPE,
        })
    except Exception as exc:
        sys.stderr.write(f"transcribe_failed:{type(exc).__name__}:{str(exc)[:240]}\n")
        if env_bool("ASR_DEBUG_TRACEBACKS", False):
            traceback.print_exc(file=sys.stderr)
        sys.stderr.flush()
        write({
            "ok": False,
            "request_id": request_id,
            "error": f"{type(exc).__name__}: {str(exc)[:200]}",
            "latency_ms": int((time.perf_counter() - started) * 1000),
        })
