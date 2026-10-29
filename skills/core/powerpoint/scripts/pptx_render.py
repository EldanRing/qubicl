#!/usr/bin/env python3
"""Render every slide of a .pptx to per-slide PNG images.

Pipeline: LibreOffice (soffice --headless --convert-to pdf) turns the deck
into a PDF, then poppler (pdftoppm, or pdftocairo as an alternate) splits
the PDF into one PNG per slide.

Output is JSON. When both tools are present:
  {"rendered": true, "files": ["render/slide-1.png", ...]}
When either tool is missing the script still exits 0 and reports:
  {"rendered": false, "missing": ["soffice"], "guidance": "..."}
so callers can degrade gracefully (fall back to pptx_read.py --outline).
"""
import argparse
import json
import os
import runpy
import sys


def render(pptx_path, out_dir, prefix, dpi):
    helper = os.environ.get('QUBICL_ARTIFACT_RENDERER', '/opt/qubicl/artifact-render.py')
    return runpy.run_path(helper)['render'](pptx_path, out_dir, prefix, dpi)


def main(argv=None):
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(
        description="Render each slide of a .pptx to a PNG via "
                    "soffice + pdftoppm/pdftocairo.",
        epilog=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("pptx", help="path to the .pptx file")
    parser.add_argument("--outdir", default="render",
                        help="directory for PNGs (default: ./render)")
    parser.add_argument("--prefix", default="slide",
                        help="PNG filename prefix (default: slide)")
    parser.add_argument("--dpi", type=int, default=100,
                        help="render resolution (default: 100)")
    args = parser.parse_args(argv)

    result = render(args.pptx, args.outdir, args.prefix, args.dpi)
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
