"""Exercise the actual native helper with deterministic accessibility objects."""
import collections
import importlib.util
import json
from pathlib import Path
import sys
import types
import unittest

states = ('ENABLED', 'SENSITIVE', 'VISIBLE', 'SHOWING', 'FOCUSED', 'EDITABLE',
          'CHECKED', 'SELECTED', 'EXPANDED', 'MODAL', 'DEFUNCT')
atspi = types.SimpleNamespace(init=lambda: None, set_timeout=lambda *_: None,
                              StateType=types.SimpleNamespace(**{s: s for s in states}),
                              Role=types.SimpleNamespace(PASSWORD_TEXT='password text'),
                              Text=types.SimpleNamespace(get_text=lambda obj, start, end: obj.text[start:end]))
sys.modules['gi'] = types.SimpleNamespace(require_version=lambda *_: None)
sys.modules['gi.repository'] = types.SimpleNamespace(Atspi=atspi, GLib=None)
sys.modules['Xlib'] = types.SimpleNamespace(X=None, display=None, protocol=None)
root_path = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('desktop_helper', root_path / 'packages/control/src/desktop-helper.py')
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


class Node:
    def __init__(self, name, role='panel', children=(), visible=True, showing=True, editable=False, text=''):
        self.name, self.role, self.children, self.text = name, role, list(children), text
        self.states = {'ENABLED', 'SENSITIVE'}
        self.parent = None
        if visible:
            self.states.add('VISIBLE')
        if showing:
            self.states.add('SHOWING')
        if editable:
            self.states.add('EDITABLE')
        for child in self.children:
            child.parent = self

    def clear_cache(self): pass
    def get_process_id(self): return 10
    def get_role_name(self): return self.role
    def get_role(self): return self.role
    def get_name(self): return self.name
    def get_state_set(self): return types.SimpleNamespace(contains=lambda state: state in self.states)
    def get_child_count(self): return len(self.children)
    def get_child_at_index(self, index): return self.children[index]
    def get_parent(self): return self.parent
    def get_action_iface(self): return None
    def get_component_iface(self): return None
    def get_text_iface(self): return self if self.text else None
    def get_character_count(self): return len(self.text)


def desktop(root):
    result = helper.Desktop.__new__(helper.Desktop)
    result.captures = collections.OrderedDict()
    result.text_captures = collections.OrderedDict()
    result.window = lambda wid: {'id': wid, 'title': 'Fixture'}
    result.accessible_window = lambda _: root
    return result


def pages(subject, first):
    result = list(first['elements'])
    while first['nextCursor']:
        first = subject.snapshot({'windowId': 42, 'cursor': first['nextCursor'], 'limit': 2, 'maxBytes': 2048})
        assert len(json.dumps(first, ensure_ascii=False).encode()) < 24000
        result.extend(first['elements'])
    return result


class Snapshots(unittest.TestCase):
    def test_targeted_text_is_useful_and_directory_gaps_are_explicit(self):
        text = Node('Document', 'panel', text='A complete editable document of 40 chars.')
        pane = Node('Icon view', 'directory pane', [Node('')])
        subject = desktop(Node('Window', 'frame', [text, pane]))
        snapshot = subject.snapshot({'windowId': 42})
        self.assertEqual(snapshot['contentCoverage'], 'partial')
        self.assertEqual(snapshot['coverageGaps'][0]['contentPresence'], 'unknown')
        ref = next(item['ref'] for item in snapshot['elements'] if item['name'] == 'Document')
        targeted = subject.snapshot({'windowId': 42, 'ref': ref})
        self.assertTrue(targeted['usefulTree'])
        self.assertNotIn('fallback', targeted)
        self.assertEqual(targeted['usefulnessScope'], 'subtree')
        self.assertEqual(targeted['elements'][0]['text'], text.text)
        self.assertFalse(targeted['elements'][0]['textTruncated'])
        child = next(item['ref'] for item in snapshot['elements'] if item['parent'] and item['name'] == '')
        self.assertEqual(subject.snapshot({'windowId': 42, 'ref': child})['contentCoverage'], 'partial')
        file = Node('example.txt', 'icon')
        subject = desktop(Node('Icon view', 'directory pane', [file]))
        exposed = subject.snapshot({'windowId': 42})
        self.assertEqual(exposed['coverageGaps'], [])
        self.assertTrue(any(item['name'] == 'example.txt' for item in exposed['elements']))

    def test_text_continuation_is_captured_unicode_and_passwords_are_excluded(self):
        text = 'line 🧪\n' * 900 + 'END'
        editor = Node('Editor', 'text', editable=True, text=text)
        password = Node('Password', 'password text', text='NEVER READ')
        subject = desktop(Node('Window', 'frame', [editor, password]))
        snapshot = subject.snapshot({'windowId': 42})
        ref = next(item['ref'] for item in snapshot['elements'] if item['name'] == 'Editor')
        part = subject.snapshot({'windowId': 42, 'ref': ref, 'textOffset': 0, 'maxBytes': 2048})
        self.assertEqual(part['offsetUnit'], 'unicode_code_points')
        self.assertEqual(part['totalCharacters'], len(text))
        actual = part['text']
        editor.text = 'Edited after capture'
        while part['nextTextCursor']:
            part = subject.snapshot({'windowId': 42, 'textCursor': part['nextTextCursor'], 'maxBytes': 2048})
            actual += part['text']
        self.assertEqual(actual, text)
        private = next(item['ref'] for item in snapshot['elements'] if item['name'] == 'Password')
        with self.assertRaises(helper.Failure) as error:
            subject.snapshot({'windowId': 42, 'ref': private, 'textOffset': 0})
        self.assertEqual(error.exception.code, 'desktop_sensitive_text')

    def test_provided_keybinding_is_separate_from_name_and_unknown_is_null(self):
        node = Node('Save', 'menu item')
        node.get_action_iface = lambda: types.SimpleNamespace(get_n_actions=lambda: 1, get_action_name=lambda _: 'click', get_key_binding=lambda _: ';;<Control>s')
        subject = desktop(Node('Window', 'frame', [node]))
        item = subject.snapshot({'windowId': 42})['elements'][0]
        self.assertEqual(item['name'], 'Save')
        self.assertEqual(item['keyBindings'], [{'action': 'click', 'binding': ';;<Control>s'}])

    def test_editor_and_dialog_precede_hidden_and_structural_clutter(self):
        hidden = [Node(f'Hidden {i}', 'button', showing=False) for i in range(120)]
        structure = [Node(f'Container {i}') for i in range(120)]
        editor = Node('Document', 'text', editable=True, text='Document contents')
        save = Node('Save', 'button')
        dialog = Node('Save As', 'dialog', [save])
        # Missing SHOWING on a parent must not suppress a visible child.
        root = Node('Window', 'frame', [*hidden, *structure, Node('Wrapper', children=[editor], showing=False), dialog])
        subject = desktop(root)
        first = subject.snapshot({'windowId': 42, 'limit': 3})
        self.assertEqual({item['name'] for item in first['elements']}, {'Save As', 'Document', 'Save'})
        self.assertEqual(first['hiddenElementsOmitted'], 121)
        self.assertTrue(first['usefulTree'])
        self.assertFalse(first['scopeLimitReached'])
        record = next(item for item in first['elements'] if item['name'] == 'Document')
        self.assertIs(subject.resolve(record['ref'])[0], editor)
        self.assertIs(subject.resolve(record['parent'])[0], editor.parent)
        all_visible = pages(subject, first)
        self.assertEqual(len(all_visible), 124)
        self.assertEqual(len({item['ref'] for item in all_visible}), 124)
        self.assertTrue(all({'visible', 'showing'} <= set(item['states']) for item in all_visible))
        expanded = subject.snapshot({'windowId': 42, 'includeHidden': True, 'limit': 3})
        with self.assertRaises(helper.Failure) as error:
            subject.snapshot({'windowId': 42, 'cursor': expanded['nextCursor'], 'includeHidden': False})
        self.assertEqual(error.exception.code, 'invalid_desktop_cursor')
        all_nodes = pages(subject, expanded)
        self.assertEqual(len(all_nodes), 245)
        self.assertEqual(len({item['ref'] for item in all_nodes}), 245)
        self.assertTrue(all('showing' not in item['states'] for item in all_nodes[124:]))
        self.assertIs(subject.resolve(record['ref'])[0], editor, 'later snapshots retain earlier refs')

    def test_byte_pages_do_not_skip_controls_and_cursor_cannot_be_replayed(self):
        nodes = [Node(f'Field {i}', 'text', editable=True, text='界' * 1500) for i in range(8)]
        subject = desktop(Node('Window', 'frame', nodes))
        first = subject.snapshot({'windowId': 42, 'limit': 8, 'maxBytes': 2048})
        self.assertEqual(len(first['elements']), 1)
        self.assertTrue(first['elements'][0]['textTruncated'])
        cursor = first['nextCursor']
        all_nodes = pages(subject, first)
        self.assertEqual([n['name'] for n in all_nodes], [*(n.name for n in nodes), 'Window'])
        with self.assertRaises(helper.Failure) as error:
            subject.snapshot({'windowId': 42, 'cursor': cursor})
        self.assertEqual(error.exception.code, 'stale_desktop_cursor')

    def test_newly_hidden_nodes_are_skipped_and_scope_is_bounded(self):
        nodes = [Node(f'Button {i}', 'button') for i in range(3)]
        subject = desktop(Node('Window', 'frame', nodes))
        first = subject.snapshot({'windowId': 42, 'limit': 1})
        nodes[1].states.remove('SHOWING')
        self.assertEqual([n['name'] for n in pages(subject, first)], ['Button 0', 'Button 2', 'Window'])
        subject = desktop(Node('Window', 'frame', [Node(str(i)) for i in range(2100)]))
        snapshot = subject.snapshot({'windowId': 42})
        self.assertTrue(snapshot['scopeLimitReached'])
        self.assertLessEqual(len(next(iter(subject.captures.values()))['refs']), 2000)


unittest.main()
