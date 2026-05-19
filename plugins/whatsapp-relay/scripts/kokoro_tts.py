import argparse
import json
import pathlib
import time

import soundfile as sf
from kokoro_onnx import Kokoro


def phonemize_text(text: str, lang: str) -> tuple[str, bool]:
    if lang.startswith("en"):
        return text, False

    try:
        from misaki import espeak
        from misaki.espeak import EspeakG2P
    except ImportError as error:
        raise RuntimeError(
            "Kokoro non-English synthesis requires misaki-fork[en]. "
            "Install it in the Kokoro virtualenv."
        ) from error

    # Initializing the fallback ensures the bundled espeak-ng data is available.
    espeak.EspeakFallback(british=False)
    g2p = EspeakG2P(language=lang)
    phonemes, _ = g2p(text)
    return phonemes, True


def main() -> int:
    parser = argparse.ArgumentParser(description="Synthesize a local TTS reply with Kokoro ONNX.")
    parser.add_argument("--text-file", required=True)
    parser.add_argument("--output-file", required=True)
    parser.add_argument("--model-file", required=True)
    parser.add_argument("--voices-file", required=True)
    parser.add_argument("--voice", required=True)
    parser.add_argument("--lang", required=True)
    parser.add_argument("--speed", type=float, default=1.0)
    args = parser.parse_args()

    text_file = pathlib.Path(args.text_file)
    output_file = pathlib.Path(args.output_file)
    text = text_file.read_text(encoding="utf-8").strip()
    if not text:
        raise ValueError("Kokoro TTS text is empty.")

    start = time.perf_counter()
    kokoro = Kokoro(args.model_file, args.voices_file)
    loaded_at = time.perf_counter()
    speech_input, is_phonemes = phonemize_text(text, args.lang)
    samples, sample_rate = kokoro.create(
        speech_input,
        voice=args.voice,
        speed=args.speed,
        lang=args.lang,
        is_phonemes=is_phonemes,
    )
    synthesized_at = time.perf_counter()
    sf.write(str(output_file), samples, sample_rate)
    written_at = time.perf_counter()

    print(
        json.dumps(
            {
                "provider": "kokoro-onnx",
                "voice": args.voice,
                "lang": args.lang,
                "is_phonemes": is_phonemes,
                "sample_rate": int(sample_rate),
                "load_seconds": round(loaded_at - start, 3),
                "synth_seconds": round(synthesized_at - loaded_at, 3),
                "total_seconds": round(written_at - start, 3),
                "audio_seconds": round(len(samples) / sample_rate, 3),
            },
            ensure_ascii=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
