"""Real PDF attachment, root and original encryption-policy preservation checks."""
from pathlib import Path
import hashlib
import json
import subprocess
import sys
import tempfile
import unittest

from pypdf import PdfReader, PdfWriter
from pypdf.constants import UserAccessPermissions
from pypdf.generic import NameObject, TextStringObject, DictionaryObject
from reportlab.pdfgen import canvas

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / 'skills/core/pdf/scripts/pdf_meta.py'
sys.path.insert(0, str(SCRIPT.parent))
from pdf_preservation import fingerprint, cloned_writer, write_verified


class Metadata(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)

    def run_meta(self, source, *args, success=True):
        result = subprocess.run([sys.executable, str(SCRIPT), str(source), *map(str, args)], capture_output=True, text=True, timeout=20)
        if success:
            self.assertEqual(result.returncode, 0, result.stderr)
            return json.loads(result.stdout)
        self.assertNotEqual(result.returncode, 0)
        return result

    def test_extract_all_payloads_without_name_collisions_or_overwriting(self):
        source = self.root / 'attachments.pdf'
        writer = PdfWriter();writer.add_blank_page(100, 100)
        for name, value in [('east/receipt.txt', b'EAST'), ('west/receipt.txt', b'WEST'),
                            ('duplicate.txt', b'ONE'), ('duplicate.txt', b'TWO'),
                            ('..\\..\\receipt.txt', b'WINDOWS'), ('../..', b'DOTS')]:
            writer.add_attachment(name, value)
        writer.write(source)
        out = self.root / 'extracted'
        result = self.run_meta(source, '--extract-attachments', out)
        self.assertEqual(result['payloadCount'], 6)
        self.assertEqual({p.read_bytes() for p in out.iterdir()}, {b'EAST', b'WEST', b'ONE', b'TWO', b'WINDOWS', b'DOTS'})
        for item in result['attachments']:
            path = Path(item['destination'])
            self.assertEqual(path.parent, out)
            self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), item['sha256'])
        self.assertEqual([item['payloadIndex'] for item in result['attachments'] if item['sourceName'] == 'duplicate.txt'], [0, 1])
        before = {p.name: p.read_bytes() for p in out.iterdir()}
        self.run_meta(source, '--extract-attachments', out, success=False)
        self.assertEqual({p.name: p.read_bytes() for p in out.iterdir()}, before)
        second = self.run_meta(source, '--extract-attachments', self.root / 'other')
        self.assertEqual([Path(p).name for p in result['extracted']], [Path(p).name for p in second['extracted']])
        symlink = self.root / 'links';symlink.mkdir()
        (symlink / next(iter(before))).symlink_to(self.root / 'nonexistent')
        self.run_meta(source, '--extract-attachments', symlink, success=False)
        self.assertEqual(len(list(symlink.iterdir())), 1)

    def test_nonstructural_edits_keep_root_attachments_and_original_security(self):
        form = self.root / 'form.pdf'
        draw = canvas.Canvas(str(form))
        draw.acroForm.textfield(name='name', x=20, y=100, value='KEEP')
        draw.acroForm.checkbox(name='agree', x=20, y=50, checked=True)
        draw.showPage();draw.save()
        for algorithm in [None, 'AES-256', 'AES-128']:
            with self.subTest(algorithm=algorithm):
                writer = PdfWriter(clone_from=form)
                writer.add_attachment('same.txt', b'FIRST');writer.add_attachment('same.txt', b'SECOND')
                writer.add_metadata({'/Title': 'OLD', '/Author': 'AUTHOR', '/Subject': 'SUBJECT'})
                writer.root_object[NameObject('/QubiclFixture')] = TextStringObject('CUSTOM_ROOT')
                writer.add_outline_item('Bookmark', 0)
                if algorithm:
                    writer.encrypt('user-password', 'distinct-owner', algorithm=algorithm,
                                   permissions_flag=UserAccessPermissions.PRINT)
                source = self.root / f'{algorithm}.pdf';writer.write(source)
                password = ['--password', 'user-password'] if algorithm else []
                out = self.root / 'updated.pdf'
                receipt = self.run_meta(source, '--set-meta', '--title', 'UPDATED_TITLE', '-o', out, *password)
                self.assertTrue(receipt['preservationVerified'])
                original = PdfReader(source)
                result = PdfReader(out)
                self.assertEqual(result.is_encrypted, bool(algorithm))
                if algorithm:
                    original.decrypt('user-password');self.assertTrue(result.decrypt('user-password'))
                    owner = PdfReader(out);self.assertTrue(owner.decrypt('distinct-owner'))
                    self.assertEqual(fingerprint(result.trailer['/Encrypt']), fingerprint(original.trailer['/Encrypt']))
                    self.assertEqual(int(result.trailer['/Encrypt']['/P']), int(original.trailer['/Encrypt']['/P']))
                    self.assertNotIn(b'UPDATED_TITLE', out.read_bytes())
                self.assertEqual(result.metadata.title, 'UPDATED_TITLE')
                self.assertEqual(result.metadata.author, 'AUTHOR')
                self.assertEqual(result.metadata.subject, 'SUBJECT')
                self.assertEqual(result.attachments['same.txt'], [b'FIRST', b'SECOND'])
                self.assertEqual(set(result.get_fields()), {'name', 'agree'})
                self.assertEqual(result.root_object['/QubiclFixture'], 'CUSTOM_ROOT')
                self.assertEqual(result.outline[0].title, 'Bookmark')
                extra = self.root / 'same.txt';extra.write_bytes(b'THIRD')
                self.run_meta(out, '--attach', extra, '-o', out, *password)
                appended = PdfReader(out)
                if algorithm:appended.decrypt('distinct-owner')
                self.assertEqual(appended.attachments['same.txt'], [b'FIRST', b'SECOND', b'THIRD'])
                self.assertEqual(appended.metadata.title, 'UPDATED_TITLE')
                self.run_meta(out, '--clear-meta', '-o', out, *password)
                cleared = PdfReader(out)
                if algorithm:cleared.decrypt('user-password')
                self.assertFalse(cleared.metadata)
                self.assertEqual(cleared.attachments['same.txt'], [b'FIRST', b'SECOND', b'THIRD'])
                before = out.read_bytes()
                self.run_meta(source, '--set-meta', '-o', out, *password, success=False)
                self.assertEqual(out.read_bytes(), before)

    def test_refusal_and_failed_verification_leave_destination_untouched(self):
        source = self.root / 'source.pdf'
        writer = PdfWriter();writer.add_blank_page(100, 100);writer.write(source)
        output = self.root / 'output.pdf';output.write_bytes(b'ORIGINAL_DESTINATION')
        reader = PdfReader(source);changed = cloned_writer(reader)
        changed.pages[0][NameObject('/UnexpectedEdit')] = TextStringObject('changed')
        with self.assertRaisesRegex(ValueError, 'preservation check failed'):
            write_verified(changed, reader, output, None, [])
        self.assertEqual(output.read_bytes(), b'ORIGINAL_DESTINATION')
        self.assertEqual(list(self.root.glob('.qubicl-pdf-*')), [])
        certified = PdfWriter(clone_from=source)
        certified.root_object[NameObject('/Perms')] = DictionaryObject({NameObject('/DocMDP'): DictionaryObject({NameObject('/Type'): NameObject('/Sig')})})
        certified.write(source)
        failure = self.run_meta(source, '--set-meta', '--title', 'Changed', '-o', output, success=False)
        self.assertIn('Signed/certified', failure.stderr)
        self.assertEqual(output.read_bytes(), b'ORIGINAL_DESTINATION')


if __name__ == '__main__':unittest.main()
