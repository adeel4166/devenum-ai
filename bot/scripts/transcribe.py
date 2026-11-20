"""Offline speech-to-text for Discord voice notes, audio and video soundtracks (faster-whisper, CPU int8).

Usage: transcribe.py <audio-file>   → prints JSON {"language", "probability", "duration", "text"}
Env:   WHISPER_MODEL (default "base"; "small" is more accurate for Urdu but ~3x slower)
       WHISPER_LANGUAGE (optional, e.g. "ur" or "en"; default: auto-detect)
"""
import json, os, sys, wave

import numpy as np
from faster_whisper import WhisperModel

path = sys.argv[1]
audio = path
if path.endswith(".wav"):
    # The bot always hands us 16 kHz mono PCM WAV (converted by ffmpeg); load it directly so decoding does not
    # depend on the installed PyAV version.
    with wave.open(path, "rb") as w:
        if w.getframerate() != 16000 or w.getnchannels() != 1 or w.getsampwidth() != 2:
            raise SystemExit("expected 16 kHz mono 16-bit WAV")
        audio = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0
model = WhisperModel(os.environ.get("WHISPER_MODEL", "base"), device="cpu", compute_type="int8", cpu_threads=os.cpu_count() or 2)
segments, info = model.transcribe(audio, language=os.environ.get("WHISPER_LANGUAGE") or None, vad_filter=True, beam_size=5)
text = " ".join(s.text.strip() for s in segments).strip()
print(json.dumps({"language": info.language, "probability": round(info.language_probability, 3), "duration": round(info.duration, 1), "text": text}, ensure_ascii=False))
