import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { OfficePreviewManager } from '../../packages/control/dist/office-preview.js';

const python = process.env.QUBICL_TEST_OFFICE_PYTHON;
const exec = promisify(execFile);

test('real LibreOffice preserves document and slide text and page counts in bounded previews', {
  skip: !python && 'Set QUBICL_TEST_OFFICE_PYTHON to Python with python-docx and python-pptx; requires LibreOffice and Poppler.',
  timeout: 45_000,
}, async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'qubicl-office-real-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  await exec(python!, ['-c', `
import sys
from pathlib import Path
from docx import Document
from pptx import Presentation
root = Path(sys.argv[1])
doc = Document()
doc.add_heading('Qubicl preview document', 0)
doc.add_paragraph('Unicode survives: café')
table = doc.add_table(rows=2, cols=2)
table.cell(0, 0).text = 'Item'
table.cell(0, 1).text = 'Count'
table.cell(1, 0).text = 'Example'
table.cell(1, 1).text = '42'
doc.add_page_break()
doc.add_paragraph('Second document page')
doc.save(root / 'document.docx')
slides = Presentation()
for title in ['First Qubicl slide', 'Second Qubicl slide']:
    slide = slides.slides.add_slide(slides.slide_layouts[1])
    slide.shapes.title.text = title
    slide.placeholders[1].text = 'Preview body text'
slides.save(root / 'slides.pptx')
`, directory]);
  const manager = new OfficePreviewManager({ temporaryRoot: directory });
  for (const [name, extension, expected] of [
    ['document', '.docx', ['Qubicl preview document', 'café', '42', 'Second document page']],
    ['slides', '.pptx', ['First Qubicl slide', 'Second Qubicl slide', 'Preview body text']],
  ] as const) {
    const input = await readFile(join(directory, name + extension));
    const output = await manager.convert(input, extension);
    const pdf = join(directory, `${name}.pdf`);
    await writeFile(pdf, output);
    const { stdout: text } = await exec('pdftotext', [pdf, '-']);
    for (const value of expected) assert.ok(text.includes(value), `${name} PDF must retain ${value}`);
    const info = await exec('pdfinfo', [pdf]);
    assert.match(info.stdout, /Pages:\s+2/u);
    assert.deepEqual(await readFile(join(directory, name + extension)), input);
  }
  assert.ok(!(await readdir(directory)).some((name) => name.startsWith('qubicl-office-')));
});
