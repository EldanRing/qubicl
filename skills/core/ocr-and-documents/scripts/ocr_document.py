#!/usr/bin/env python3
"""Bounded local OCR for Qubicl image and PDF documents."""

from __future__ import annotations

import argparse
import shutil
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, UnidentifiedImageError

MAX_INPUT_BYTES = 100 * 1024 * 1024
MAX_PAGES = 200
MAX_OUTPUT_CHARS = 2_000_000
MAX_IMAGE_PIXELS = 50_000_000
MAX_DOCUMENT_PIXELS = 500_000_000
IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".tif", ".tiff", ".webp", ".bmp"}
Image.MAX_IMAGE_PIXELS = MAX_IMAGE_PIXELS


def command(*args: str, timeout: int = 180) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, check=True, capture_output=True, text=True, timeout=timeout)


def require(name: str) -> str:
    path = shutil.which(name)
    if not path:
        raise RuntimeError(f"Required Qubicl image command is unavailable: {name}")
    return path


def ocr_image(path: Path, language: str) -> str:
    result = command(require("tesseract"), str(path), "stdout", "-l", language, timeout=180)
    return result.stdout.strip()


def validate_image(path: Path) -> int:
    try:
        with Image.open(path) as image:
            total = 0
            frames = getattr(image, "n_frames", 1)
            for frame in range(frames):
                image.seek(frame)
                pixels = image.width * image.height
                if pixels > MAX_IMAGE_PIXELS:
                    raise RuntimeError(f"Image frame exceeds the {MAX_IMAGE_PIXELS}-pixel limit")
                total += pixels
                if total > MAX_DOCUMENT_PIXELS:
                    raise RuntimeError(f"Image exceeds the {MAX_DOCUMENT_PIXELS}-pixel aggregate limit")
            image.verify()
            return total
    except (Image.DecompressionBombError, Image.DecompressionBombWarning, UnidentifiedImageError) as error:
        raise RuntimeError(f"Image is invalid or exceeds Qubicl's pixel limit: {error}") from error


def pdf_pages(path: Path) -> int:
    result = command(require("pdfinfo"), str(path), timeout=30)
    for line in result.stdout.splitlines():
        if line.lower().startswith("pages:"):
            pages = int(line.split(":", 1)[1].strip())
            if pages < 1 or pages > MAX_PAGES:
                raise RuntimeError(f"PDF has {pages} pages; supported range is 1-{MAX_PAGES}")
            return pages
    raise RuntimeError("Unable to determine PDF page count")


def ocr_pdf(path: Path, language: str, dpi: int) -> tuple[str, list[int]]:
    pages = pdf_pages(path)
    missing: list[int] = []
    chunks: list[str] = []
    with tempfile.TemporaryDirectory(prefix="qubicl-ocr-") as temporary:
        total_pixels = 0
        for index in range(1, pages + 1):
            prefix = Path(temporary) / f"page-{index}"
            command(
                require("pdftoppm"),
                "-f", str(index),
                "-l", str(index),
                "-singlefile",
                "-png",
                "-r", str(dpi),
                "-scale-to", "7000",
                str(path),
                str(prefix),
                timeout=180,
            )
            image = prefix.with_suffix(".png")
            if not image.is_file():
                raise RuntimeError(f"PDF page {index} did not render")
            total_pixels += validate_image(image)
            if total_pixels > MAX_DOCUMENT_PIXELS:
                raise RuntimeError(f"Rendered PDF exceeds the {MAX_DOCUMENT_PIXELS}-pixel aggregate limit")
            text = ocr_image(image, language)
            image.unlink()
            if not text:
                missing.append(index)
            chunks.append(f"--- Page {index} ---\n{text}".rstrip())
    return "\n\n".join(chunks), missing


def main() -> None:
    parser = argparse.ArgumentParser(description="Extract bounded local OCR text from a PDF or image.")
    parser.add_argument("input", help="PDF or image beneath /home/qubicl")
    parser.add_argument("--output", required=True, help="UTF-8 output text path beneath /home/qubicl")
    parser.add_argument("--language", default="eng", help="Installed Tesseract language code (default: eng)")
    parser.add_argument("--dpi", type=int, default=150, choices=range(72, 301), metavar="72-300")
    args = parser.parse_args()

    source = Path(args.input).expanduser().resolve(strict=True)
    output = Path(args.output).expanduser().resolve()
    home = Path("/home/qubicl").resolve()
    if home not in source.parents or home not in output.parents:
        raise RuntimeError("Input and output must remain beneath /home/qubicl")
    if not source.is_file() or source.stat().st_size > MAX_INPUT_BYTES:
        raise RuntimeError("Input must be a regular file no larger than 100 MiB")
    if source.suffix.lower() == ".pdf":
        text, empty_pages = ocr_pdf(source, args.language, args.dpi)
    elif source.suffix.lower() in IMAGE_SUFFIXES:
        validate_image(source)
        text, empty_pages = ocr_image(source, args.language), []
    else:
        raise RuntimeError("Supported inputs are PDF, PNG, JPEG, TIFF, WebP, and BMP")
    truncated = len(text) > MAX_OUTPUT_CHARS
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(text[:MAX_OUTPUT_CHARS] + ("\n\n[Qubicl OCR output truncated]\n" if truncated else "\n"), encoding="utf-8")
    print({"output": str(output), "characters": min(len(text), MAX_OUTPUT_CHARS), "truncated": truncated, "emptyPages": empty_pages})


if __name__ == "__main__":
    main()
