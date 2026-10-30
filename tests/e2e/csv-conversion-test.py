"""CLI save/reopen checks for explicit CSV typing and UTF-8 BOMs."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from openpyxl import load_workbook

SCRIPT = Path(__file__).resolve().parents[2] / 'skills/core/xlsx/scripts/csv_to_xlsx.py'


class CsvConversion(unittest.TestCase):
    def test_overflow_never_succeeds_or_replaces_existing_output(self):
        with tempfile.TemporaryDirectory() as directory:
            source, output = Path(directory) / 'input.csv', Path(directory) / 'output.xlsx'
            output.write_bytes(b'original')
            for value in ('1e309', '-1e309', 'NaN', 'Infinity', '9' * 310):
                source.write_text(f'Value\n{value}\n2\n')
                result = subprocess.run([sys.executable, str(SCRIPT), str(source), str(output), '--column-types', '{"A":"number"}'], capture_output=True, text=True)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('A2', json.loads(result.stderr)['error'])
                self.assertEqual(output.read_bytes(), b'original')

    def test_bom_nullable_values_and_contextual_strict_errors(self):
        with tempfile.TemporaryDirectory() as directory:
            source, output = Path(directory) / 'input.csv', Path(directory) / 'output.xlsx'
            source.write_text('\ufeffName,Value\none,1\ninner\ufeffname,\nthree,3\n', encoding='utf-8')
            command = [sys.executable, str(SCRIPT), str(source), str(output), '--column-types', '{"B":"number"}']
            result = subprocess.run(command, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            workbook = load_workbook(output)
            self.assertEqual(list(workbook.active.values), [('Name', 'Value'), ('one', 1), ('inner\ufeffname', None), ('three', 3)])
            workbook.close()
            original = output.read_bytes()
            result = subprocess.run(command + ['--empty-cells', 'reject'], capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('CSV row 3, column 2 (B3)', json.loads(result.stderr)['error'])
            self.assertEqual(output.read_bytes(), original)


if __name__ == '__main__': unittest.main()
