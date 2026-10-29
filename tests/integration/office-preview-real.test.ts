import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
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
  let externalRequests = 0;
  const remote = createServer((_request, response) => { externalRequests++; response.end(); });
  await new Promise<void>(resolve => remote.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise<void>(resolve => { remote.close(() => resolve()); remote.closeAllConnections(); }));
  const externalImage = `http://127.0.0.1:${(remote.address() as { port: number }).port}/external.png`;
  await exec(python!, ['-c', `
import sys
from io import BytesIO
from pathlib import Path
from PIL import Image
from docx import Document
from pptx import Presentation
from pptx.chart.data import CategoryChartData
from pptx.enum.chart import XL_CHART_TYPE
from pptx.util import Inches
from pptx.opc.constants import RELATIONSHIP_TYPE as RT
from pptx.oxml.ns import qn
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
    data = CategoryChartData()
    data.categories = ['Quarter One', 'Quarter Two']
    data.add_series('Chart Revenue', [10, 25])
    chart = slide.shapes.add_chart(XL_CHART_TYPE.COLUMN_CLUSTERED, Inches(1), Inches(3), Inches(8), Inches(3), data)
    group = slide.shapes.add_group_shape([chart])
    slide.shapes.add_group_shape([group])
    image = BytesIO()
    Image.new('RGB', (2, 2), 'red').save(image, format='PNG'); image.seek(0)
    picture = slide.shapes.add_picture(image, Inches(9), Inches(1), width=Inches(.1))
    blip = picture._element.blipFill.blip
    blip.attrib.pop(qn('r:embed'))
    blip.set(qn('r:link'), slide.part.relate_to(sys.argv[2], RT.IMAGE, is_external=True))
slides.save(root / 'slides.pptx')
`, directory, externalImage]);
  const manager = new OfficePreviewManager({ temporaryRoot: directory });
  for (const [name, extension, expected] of [
    ['document', '.docx', ['Qubicl preview document', 'café', '42', 'Second document page']],
    ['slides', '.pptx', ['First Qubicl slide', 'Second Qubicl slide', 'Preview body text', 'Chart Revenue', 'Quarter One', 'Quarter Two']],
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
  const { stdout: receipt } = await exec(python!, [fileURLToPath(new URL('../../packages/control/src/artifact-render.py', import.meta.url)), join(directory, 'slides.pptx'), '--outdir', join(directory, 'render')]);
  const rendered = JSON.parse(receipt) as { pdf: { path: string } };
  const { stdout: chartText } = await exec('pdftotext', [rendered.pdf.path, '-']);
  for (const label of ['Chart Revenue', 'Quarter One', 'Quarter Two']) assert.ok(chartText.includes(label), `Artifact renderer must retain ${label}`);
  assert.equal(externalRequests, 0, 'Rendering embedded charts must not fetch linked external images');
  assert.ok(!(await readdir(directory)).some((name) => name.startsWith('qubicl-office-')));
});
