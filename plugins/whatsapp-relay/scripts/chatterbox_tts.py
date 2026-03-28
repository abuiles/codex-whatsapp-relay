#!/usr/bin/env python3

import argparse
import json
import os
from pathlib import Path

import perth
import torch
import torchaudio as ta
from perth.dummy_watermarker import DummyWatermarker
from chatterbox.mtl_tts import ChatterboxMultilingualTTS
from chatterbox.tts_turbo import ChatterboxTurboTTS

if getattr(perth, "PerthImplicitWatermarker", None) is None:
    perth.PerthImplicitWatermarker = DummyWatermarker


def parse_args():
    parser = argparse.ArgumentParser(
        description="Generate local speech with Chatterbox Turbo for WhatsApp Relay."
    )
    parser.add_argument("--text-file", required=True)
    parser.add_argument("--output-file", required=True)
    parser.add_argument("--device", default="auto")
    parser.add_argument("--language-id", default="")
    parser.add_argument("--audio-prompt-path", default="")
    return parser.parse_args()


def resolve_device(requested: str) -> str:
    normalized = (requested or "auto").strip().lower()
    if normalized in {"cpu", "mps"}:
        return normalized
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def main():
    os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
    args = parse_args()
    text = Path(args.text_file).read_text(encoding="utf-8").strip()
    if not text:
        raise ValueError("Voice reply text is empty.")

    device = resolve_device(args.device)

    generate_kwargs = {}
    audio_prompt_path = (args.audio_prompt_path or "").strip()
    if audio_prompt_path:
        generate_kwargs["audio_prompt_path"] = audio_prompt_path

    language_id = (args.language_id or "").strip().lower()
    if language_id and language_id != "en":
        model = ChatterboxMultilingualTTS.from_pretrained(device=device)
        wav = model.generate(text, language_id=language_id, **generate_kwargs)
        model_name = "chatterbox-multilingual"
    else:
        model = ChatterboxTurboTTS.from_pretrained(device=device)
        wav = model.generate(text, **generate_kwargs)
        model_name = "chatterbox-turbo"

    if wav.dim() == 1:
        wav = wav.unsqueeze(0)
    else:
        wav = wav.reshape(1, -1)
    ta.save(args.output_file, wav.cpu(), model.sr)

    print(
        json.dumps(
            {
                "device": device,
                "model": model_name,
                "language_id": language_id or "en",
                "sample_rate": model.sr,
                "voice_mode": "clone" if audio_prompt_path else "builtin",
            }
        )
    )


if __name__ == "__main__":
    main()
