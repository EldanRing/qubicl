"""Small second-toolkit text receiver; Ctrl+S writes the actual Qt document."""
import sys
from pathlib import Path
from PySide2.QtWidgets import QApplication, QTextEdit, QShortcut
from PySide2.QtGui import QKeySequence

app = QApplication([])
editor = QTextEdit()
editor.setWindowTitle('Qubicl Qt typing fixture')
editor.resize(700, 500)
shortcut = QShortcut(QKeySequence('Ctrl+S'), editor)
shortcut.activated.connect(lambda: Path(sys.argv[1]).write_text(editor.toPlainText(), encoding='utf-8'))
editor.show()
editor.setFocus()
app.exec_()
