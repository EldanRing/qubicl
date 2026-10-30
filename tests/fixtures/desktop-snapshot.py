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
                              CoordType=types.SimpleNamespace(SCREEN='screen'),
                              Text=types.SimpleNamespace(get_text=lambda obj, start, end: obj.text[start:end]))
sys.modules['gi'] = types.SimpleNamespace(require_version=lambda *_: None)
sys.modules['gi.repository'] = types.SimpleNamespace(Atspi=atspi, GLib=None)
sys.modules['Xlib'] = types.SimpleNamespace(X=None, XK=None, Xutil=None, display=None, protocol=None)
sys.modules['Xlib.ext'] = types.SimpleNamespace(xtest=None)
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
    def test_compact_windows_preserve_targeting_and_full_geometry_is_addressable(self):
        subject = desktop(Node('Window'))
        bounds = {'x': 0, 'y': 0, 'width': 1440, 'height': 900}
        full = {'id': 42, 'pid': 10, 'title': 'Editor', 'active': True, 'visible': True,
                'modal': False, 'transientFor': None, 'geometry': bounds,
                'geometryToken': 'a' * 24, 'desktopBounds': bounds, 'workArea': bounds,
                'frameExtents': {'top': 30, 'left': 0, 'right': 0, 'bottom': 0},
                'clientToScreen': {'offsetX': 0, 'offsetY': 0, 'scale': 1}}
        subject.inventory = lambda: [full, {**full, 'id': 43, 'active': False}]
        subject.desktop_bounds = lambda: {'desktopBounds': bounds, 'workArea': bounds}
        subject.window = lambda _: full
        compact = subject.windows({'detail': 'compact'})
        self.assertEqual(compact['windows'][0]['geometry'], full['geometry'])
        self.assertEqual(compact['windows'][0]['geometryToken'], full['geometryToken'])
        self.assertNotIn('clientToScreen', compact['windows'][0])
        self.assertNotIn('workArea', compact['windows'][0])
        self.assertEqual(compact['workArea'], bounds)
        self.assertEqual(subject.windows({'windowId': 42})['windows'], [full])
        self.assertEqual(subject.windows({'windowId': 99})['windows'], [])
        subject.validate({'windowId': 42, 'geometryToken': compact['windows'][0]['geometryToken']})
        full['geometryToken'] = 'b' * 24
        with self.assertRaises(helper.Failure) as error:
            subject.validate({'windowId': 42, 'geometryToken': compact['windows'][0]['geometryToken']})
        self.assertEqual(error.exception.code, 'stale_desktop_geometry')

    def test_target_observation_is_small_live_exact_and_does_not_replace_refs(self):
        text = ('line 界\n' * 600) + 'tail'
        editor = Node('Editor', 'text', editable=True, text=text)
        editor.states.add('FOCUSED')
        password = Node('Password', 'password text', text='private')
        subject = desktop(Node('Window', 'frame', [editor, password, *[Node('Menu') for _ in range(60)]]))
        subject.inventory = lambda: [{'id': 42, 'title': 'Editor'}, {'id': 43, 'title': 'Save', 'transientFor': 42}]
        subject.desktop_bounds = lambda: {}
        snapshot = subject.snapshot({'windowId': 42})
        ref = next(item['ref'] for item in snapshot['elements'] if item['name'] == 'Editor')
        refs = list(subject.captures)
        result = subject.observe({'ref': ref, 'maxBytes': 2048})
        self.assertEqual(result['element']['ref'], ref)
        self.assertIn('focused', result['element']['states'])
        self.assertTrue(result['element']['textTruncated'])
        self.assertLessEqual(len(json.dumps(result['element'], ensure_ascii=False).encode()), 2048)
        self.assertEqual(result['relatedWindows'][0]['id'], 43)
        self.assertNotIn('elements', result)
        self.assertEqual(list(subject.captures), refs)
        condition = {'state': 'text', 'ref': ref, 'text': text}
        self.assertTrue(subject.observe({'waitFor': condition})['conditionMatched'])
        editor.text = text[:-4] + 'DIFFERENT TAIL'
        self.assertFalse(subject.observe({'waitFor': condition})['conditionMatched'])
        secret = next(item['ref'] for item in snapshot['elements'] if item['name'] == 'Password')
        self.assertNotIn('text', subject.observe({'ref': secret})['element'])
        with self.assertRaises(helper.Failure) as error:
            subject.observe({'waitFor': {'state': 'text', 'ref': secret, 'text': 'private'}})
        self.assertEqual(error.exception.code, 'desktop_sensitive_text')
        value = types.SimpleNamespace(get_current_value=lambda: 3, get_minimum_value=lambda: 1,
                                      get_maximum_value=lambda: 10, get_minimum_increment=lambda: 1)
        editor.get_value_iface = lambda: value
        self.assertTrue(subject.observe({'waitFor': {'state': 'value', 'ref': ref, 'value': 3}})['conditionMatched'])
        self.assertFalse(subject.observe({'waitFor': {'state': 'value', 'ref': ref, 'value': 4}})['conditionMatched'])
        subject.captures.clear()
        missing = subject.observe({'waitFor': condition})
        self.assertEqual(missing['targetStatus'], 'unavailable')
        self.assertFalse(missing['conditionMatched'])

    def test_window_closed_predicate_checks_beyond_first_inventory_page(self):
        subject = desktop(Node('Window'))
        inventory = [{'id': i, 'title': f'Window {i}'} for i in range(1, 80)]
        subject.inventory = lambda: inventory
        subject.desktop_bounds = lambda: {}
        request = {'waitFor': {'state': 'window_closed', 'windowId': 79}}
        self.assertFalse(subject.observe(request)['conditionMatched'])
        inventory.pop()
        self.assertTrue(subject.observe(request)['conditionMatched'])

    def test_closed_popup_children_are_hidden_without_pruning_generic_structural_parents(self):
        ghost = Node('Autodetect', 'list item')
        ghost.states.add('FOCUSED')
        popup = Node('Popup', 'list', [ghost], visible=False, showing=False)
        popup.get_component_iface = lambda: types.SimpleNamespace(get_extents=lambda _: types.SimpleNamespace(x=0, y=0, width=0, height=0))
        editor = Node('Document', 'text', editable=True)
        wrapper = Node('Structural wrapper', 'panel', [editor], visible=False, showing=False)
        subject = desktop(Node('Window', 'frame', [popup, wrapper]))
        normal = subject.snapshot({'windowId': 42})
        self.assertNotIn('Autodetect', [item['name'] for item in normal['elements']])
        self.assertIn('Document', [item['name'] for item in normal['elements']])
        hidden = subject.snapshot({'windowId': 42, 'includeHidden': True})
        item = next(item for item in hidden['elements'] if item['name'] == 'Autodetect')
        self.assertEqual(item['visibility'], {'effectiveShowing': False, 'reason': 'hidden_popup_ancestor'})
        with self.assertRaises(helper.Failure) as error:
            subject.act({'ref': item['ref'], 'action': 'focus'})
        self.assertEqual(error.exception.code, 'desktop_element_hidden')
        # An opened popup's visible child becomes discoverable again.
        popup.states.update(('VISIBLE', 'SHOWING'))
        self.assertIn('Autodetect', [item['name'] for item in subject.snapshot({'windowId': 42})['elements']])

    def test_window_matching_refreshes_cached_modal_roots_and_refuses_ambiguity(self):
        def candidate(name, role, x, y, width, height):
            node = Node(name, role)
            node.get_component_iface = lambda: types.SimpleNamespace(get_extents=lambda _: types.SimpleNamespace(x=x, y=y, width=width, height=height))
            return node
        main = candidate('Main', 'frame', 0, 27, 570, 454)
        dialog = candidate('Modal', 'dialog', 75, 186, 430, 194)
        app = Node('App', children=[main])
        app.clear_cache = lambda: setattr(app, 'children', [main, dialog])
        atspi.get_desktop = lambda _: Node('Desktop', children=[app])
        subject = helper.Desktop.__new__(helper.Desktop)
        request = {'id': 42, 'pid': 10, 'title': 'Modal', 'geometry': {'x': 75, 'y': 186, 'width': 430, 'height': 194}, 'modal': True}
        self.assertIs(subject.accessible_window(request), dialog)
        self.assertEqual(subject.last_window_match['status'], 'matched')
        self.assertIs(subject.accessible_window({**request, 'title': 'Main', 'modal': False, 'geometry': {'x': 0, 'y': 27, 'width': 570, 'height': 454}}), main)
        app.clear_cache = lambda: setattr(app, 'children', [dialog, candidate('Modal', 'dialog', 75, 186, 430, 194)])
        self.assertIsNone(subject.accessible_window(request))
        self.assertEqual(subject.last_window_match['status'], 'ambiguous')

    def test_virtual_table_reads_bounded_cells_and_explicit_offscreen_ranges(self):
        grid = Node('Sheet', 'table')
        cells = {}
        def cell(row, column):
            key = (row, column)
            if key not in cells:
                value = Node(f'Cell {row},{column}', 'table cell', text=f'Value {row},{column}', showing=row < 12 and column < 8)
                value.parent = grid
                value.get_index_in_parent = lambda: row * 16384 + column
                cells[key] = value
            return cells[key]
        grid.get_child_count = lambda: 2147483647
        grid.get_child_at_index = lambda _: self.fail('virtual table must not enumerate generic children')
        grid.get_selection_iface = lambda: None
        grid.get_table_iface = lambda: types.SimpleNamespace(get_n_rows=lambda: 1048576, get_n_columns=lambda: 16384, get_accessible_at=cell, get_row_at_index=lambda index: index // 16384, get_column_at_index=lambda index: index % 16384)
        subject = desktop(grid)
        observed = subject.snapshot({'windowId': 42, 'limit': 200})
        self.assertEqual(observed['tableRanges'][0]['range'], {'row': 0, 'column': 0, 'rows': 12, 'columns': 8})
        self.assertEqual(observed['contentCoverage'], 'partial')
        self.assertFalse(observed['scopeLimitReached'])
        self.assertEqual(len(cells), 96)
        table = next(item for item in observed['elements'] if item['role'] == 'table')
        grid.get_selection_iface = lambda: types.SimpleNamespace(get_n_selected_children=lambda: 1, get_selected_child=lambda _: cell(0, 0))
        targeted = subject.snapshot({'windowId': 42, 'ref': table['ref'], 'tableRange': {'row': 4999, 'column': 4, 'rows': 1, 'columns': 1}})
        actual_cells = [item for item in targeted['elements'] if item.get('tableCell')]
        self.assertEqual(len(actual_cells), 1, 'Selection outside an explicit rectangle must not extend the read')
        self.assertEqual(targeted['tableRanges'][0]['selection'], [{'row': 0, 'column': 0}])
        result = actual_cells[0]
        self.assertEqual(result['text'], 'Value 4999,4')
        self.assertEqual(result['tableCell']['row'], 4999)
        self.assertIs(subject.resolve(result['ref'])[0], cells[4999, 4])
        with self.assertRaises(helper.Failure) as error:
            subject.snapshot({'windowId': 42, 'ref': table['ref'], 'tableRange': {'row': 0, 'column': 0, 'rows': 200, 'columns': 2}})
        self.assertEqual(error.exception.code, 'desktop_table_range_invalid')

    def test_value_update_reads_committed_model_and_bounds_before_dispatch(self):
        spin = Node('Width', 'spin button', text='400', editable=True)
        model = {'value': 400, 'sets': 0}
        def set_value(value):
            model.update(value=value, sets=model['sets'] + 1)
            return True
        spin.get_value_iface = lambda: types.SimpleNamespace(get_current_value=lambda: model['value'], get_minimum_value=lambda: 1, get_maximum_value=lambda: 400, get_minimum_increment=lambda: 1, set_current_value=set_value)
        subject = desktop(Node('Window', 'frame', [spin]))
        item = subject.snapshot({'windowId': 42})['elements'][0]
        self.assertEqual(item['value']['current'], 400)
        result = subject.act({'ref': item['ref'], 'action': 'set_value', 'value': 200})
        self.assertTrue(result['valueReadbackMatches'])
        self.assertEqual(model['value'], 200)
        with self.assertRaises(helper.Failure):
            subject.act({'ref': item['ref'], 'action': 'set_value', 'value': 500})
        self.assertEqual(model['sets'], 1)
        iface = spin.get_value_iface()
        def remove_control(value):
            set_value(value)
            spin.get_value_iface = lambda: None
            return True
        iface.set_current_value = remove_control
        spin.get_value_iface = lambda: iface
        missing = subject.act({'ref': item['ref'], 'action': 'set_value', 'value': 100})
        self.assertTrue(missing['acceptedByAccessibilityApi'])
        self.assertEqual(missing['dispatch'], 'completed')
        self.assertEqual(missing['valueReadbackStatus'], 'unavailable')
        self.assertIsNone(missing['valueReadbackMatches'])
        self.assertIsNone(missing['value'])

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
