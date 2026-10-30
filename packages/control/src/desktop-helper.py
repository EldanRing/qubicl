#!/usr/bin/python3
"""Guest X11/AT-SPI bridge. Fixed JSON protocol; never executes supplied commands."""
import collections
import hashlib
import json
import secrets
import sys
import time

import gi
gi.require_version('Atspi', '2.0')
from gi.repository import Atspi, GLib
from Xlib import X, display, protocol

Atspi.init()
Atspi.set_timeout(800, 1500)


class Failure(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def bounded(value, length=512):
    return str(value or '')[:length]


class Desktop:
    def __init__(self):
        self.x = display.Display()
        self.root = self.x.screen().root
        self.captures = collections.OrderedDict()
        self.text_captures = collections.OrderedDict()

    def prop(self, window, name):
        value = window.get_full_property(self.x.intern_atom(name), X.AnyPropertyType)
        return None if value is None else value.value

    @staticmethod
    def intersection(left, right):
        x, y = max(left['x'], right['x']), max(left['y'], right['y'])
        return {'x': x, 'y': y,
                'width': max(0, min(left['x'] + left['width'], right['x'] + right['width']) - x),
                'height': max(0, min(left['y'] + left['height'], right['y'] + right['height']) - y)}

    def desktop_bounds(self):
        geometry = self.root.get_geometry()
        screen = {'x': 0, 'y': 0, 'width': geometry.width, 'height': geometry.height}
        areas = self.prop(self.root, '_NET_WORKAREA')
        current = self.prop(self.root, '_NET_CURRENT_DESKTOP')
        index = int(current[0]) * 4 if current is not None and len(current) else 0
        if areas is not None and len(areas) >= index + 4:
            area = dict(zip(('x', 'y', 'width', 'height'), map(int, areas[index:index + 4])))
            area = self.intersection(screen, area)
            if area['width'] > 0 and area['height'] > 0:
                return {'desktopBounds': screen, 'workArea': area, 'workAreaSource': 'window_manager'}
        return {'desktopBounds': screen, 'workArea': screen, 'workAreaSource': 'screen_fallback'}

    def inventory(self):
        ids = self.prop(self.root, '_NET_CLIENT_LIST_STACKING')
        if ids is None:
            ids = self.prop(self.root, '_NET_CLIENT_LIST')
        active = self.prop(self.root, '_NET_ACTIVE_WINDOW')
        bounds = self.desktop_bounds()
        result = []
        for wid in list(ids if ids is not None else [])[:4096]:
            try:
                w = self.x.create_resource_object('window', int(wid))
                geo = w.get_geometry()
                pos = self.root.translate_coords(w, 0, 0)
                title = self.prop(w, '_NET_WM_NAME')
                if isinstance(title, bytes):
                    title = title.decode('utf-8', 'replace')
                pid = self.prop(w, '_NET_WM_PID')
                transient = w.get_wm_transient_for()
                state = self.prop(w, '_NET_WM_STATE')
                kinds = self.prop(w, '_NET_WM_WINDOW_TYPE')
                record = {
                    'id': int(wid), 'title': bounded(title or w.get_wm_name()),
                    'className': bounded(' '.join(w.get_wm_class() or ())),
                    'pid': int(pid[0]) if pid is not None and len(pid) else None,
                    'geometry': {'x': pos.x, 'y': pos.y, 'width': geo.width, 'height': geo.height},
                    'transientFor': transient.id if transient else None,
                    'modal': state is not None and self.x.intern_atom('_NET_WM_STATE_MODAL') in state,
                    'active': active is not None and int(active[0]) == int(wid),
                    'visible': w.get_attributes().map_state == X.IsViewable,
                    'windowTypes': [bounded(self.x.get_atom_name(int(atom)).removeprefix('_NET_WM_WINDOW_TYPE_').lower(), 80)
                                    for atom in list(kinds if kinds is not None else [])[:8]],
                }
                record.update(bounds)
                extents = self.prop(w, '_NET_FRAME_EXTENTS')
                record['frameExtents'] = dict(zip(('left', 'right', 'top', 'bottom'), map(int, extents[:4]))) if extents is not None and len(extents) >= 4 else None
                record['visibleBounds'] = self.intersection(record['geometry'], bounds['workArea'])
                record['clippedToWorkArea'] = record['visibleBounds'] != record['geometry']
                record['clientToScreen'] = {'offsetX': pos.x, 'offsetY': pos.y, 'scale': 1, 'units': 'screen_pixels'}
                record['contentToScreen'] = None  # App chrome is not exposed by X11 geometry.
                identity = [record[k] for k in ('id', 'pid', 'className', 'geometry', 'workArea')]
                record['geometryToken'] = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()[:24]
                result.append(record)
            except Exception:
                continue  # Windows may disappear while the WM list is being read.
        return result

    def window(self, wid):
        found = next((w for w in self.inventory() if w['id'] == wid), None)
        if found is None:
            raise Failure('stale_desktop_window', 'Window no longer exists. Refresh list_desktop_windows.')
        return found

    def windows(self, args):
        windows = self.inventory()
        start = args.get('cursor', 0)
        page = []
        # Long app-controlled titles must not make an observation unbounded.
        for window in windows[start:start + 64]:
            if len(json.dumps(page + [window], ensure_ascii=False).encode()) > 18000:
                break
            page.append(window)
        end = start + len(page)
        return {'windows': page, 'total': len(windows), 'nextCursor': end if end < len(windows) else None,
                'observedAt': time.time(), 'order': 'bottom_to_top', 'cursorConsistency': 'live_inventory', **self.desktop_bounds()}

    def validate(self, args):
        window = self.window(args['windowId'])
        token = args.get('geometryToken')
        if token and token != window['geometryToken']:
            raise Failure('stale_desktop_geometry', 'Window moved, resized or changed identity. Refresh its geometry before input.')
        if args.get('requireVisible', True) and not window['visible']:
            raise Failure('desktop_window_hidden', 'Window is not visible.')
        for point in args.get('points', []):
            x, y = point
            g = window['geometry']
            screen = window['desktopBounds']
            if not (0 <= x < screen['width'] and 0 <= y < screen['height']):
                raise Failure('desktop_point_off_screen', 'Input point is outside the desktop; fit the window or choose a visible point.')
            if not (g['x'] <= x < g['x'] + g['width'] and g['y'] <= y < g['y'] + g['height']):
                raise Failure('desktop_point_outside_window', 'Input point is outside the observed client window.')
            top = next((w for w in reversed(self.inventory()) if w['visible'] and
                        w['geometry']['x'] <= x < w['geometry']['x'] + w['geometry']['width'] and
                        w['geometry']['y'] <= y < w['geometry']['y'] + w['geometry']['height']), None)
            if top is None or top['id'] != window['id']:
                raise Failure('desktop_window_obscured', 'Another window covers this input point; observe it before input.')
        return {'window': window}

    def window_action(self, args):
        window = self.validate({**args, 'requireVisible': False})['window']
        if args['action'] == 'fit':
            area = window['workArea']
            extents = window['frameExtents'] or dict.fromkeys(('left', 'right', 'top', 'bottom'), 0)
            width = max(1, area['width'] - extents['left'] - extents['right'])
            height = max(1, area['height'] - extents['top'] - extents['bottom'])
            for states in [('_NET_WM_STATE_MAXIMIZED_VERT', '_NET_WM_STATE_MAXIMIZED_HORZ'), ('_NET_WM_STATE_FULLSCREEN',)]:
                atoms = [self.x.intern_atom(state) for state in states]
                self.root.send_event(protocol.event.ClientMessage(window=window['id'], client_type=self.x.intern_atom('_NET_WM_STATE'),
                    data=(32, [0, atoms[0], atoms[1] if len(atoms) > 1 else 0, 2, 0])), event_mask=X.SubstructureRedirectMask | X.SubstructureNotifyMask)
            self.root.send_event(protocol.event.ClientMessage(window=window['id'], client_type=self.x.intern_atom('_NET_MOVERESIZE_WINDOW'),
                data=(32, [1 | (15 << 8) | (2 << 12), area['x'], area['y'], width, height])), event_mask=X.SubstructureRedirectMask | X.SubstructureNotifyMask)
            self.x.sync()
            return {'windowId': window['id'], 'action': 'fit', 'dispatch': 'completed', 'verified': False,
                    'requestedClientSize': {'width': width, 'height': height}, 'workArea': area,
                    'note': 'Explicit fit request sent to the window manager. Observe new geometry before coordinate input.'}
        name = '_NET_CLOSE_WINDOW' if args['action'] == 'close' else '_NET_ACTIVE_WINDOW'
        values = [X.CurrentTime, 2, 0, 0, 0] if args['action'] == 'close' else [2, X.CurrentTime, 0, 0, 0]
        self.root.send_event(protocol.event.ClientMessage(window=window['id'], client_type=self.x.intern_atom(name),
                                                         data=(32, values)), event_mask=X.SubstructureRedirectMask | X.SubstructureNotifyMask)
        self.x.sync()
        return {'windowId': window['id'], 'action': args['action'], 'dispatch': 'completed', 'verified': False,
                'note': 'Window-manager request sent. Inspect the resulting window or save dialog before continuing.'}

    def close_process(self, args):
        # A launcher may hand off to a descendant (e.g. soffice.bin).
        def belongs(pid):
            for _ in range(64):
                if pid == args['pid']:
                    return True
                if not pid or pid <= 1:
                    return False
                try:
                    with open(f'/proc/{pid}/stat', encoding='utf-8') as stream:
                        pid = int(stream.read().rsplit(')', 1)[1].split()[1])
                except (OSError, ValueError):
                    return False
            return False
        windows = [w for w in self.inventory() if belongs(w['pid'])]
        if not windows:
            raise Failure('desktop_application_window_not_found', 'No window belongs to this tracked process. Inspect list_desktop_windows; no process was terminated.')
        # Request only primary windows. The app owns its modal/save-dialog lifecycle.
        primary = [w for w in windows if not w['transientFor']] or windows[:1]
        for window in primary:
            self.window_action({'windowId': window['id'], 'action': 'close'})
        return {'requestedWindowIds': [w['id'] for w in primary], 'dispatch': 'completed', 'verified': False}

    def expire(self):
        for captures in (self.captures, self.text_captures):
            for key, capture in list(captures.items()):
                if time.monotonic() - capture['created'] > 300:
                    del captures[key]

    @staticmethod
    def fingerprint(obj):
        obj.clear_cache()
        return (obj.get_process_id(), obj.get_role_name(), obj.get_name())

    def resolve(self, ref):
        self.expire()
        key, _, index = ref.partition('e')
        capture = self.captures.get(key)
        record = capture and capture['refs'].get(ref)
        if not record:
            raise Failure('stale_desktop_ref', 'Native reference expired. Take another desktop_snapshot.')
        self.window(capture['windowId'])
        obj, fingerprint = record
        try:
            if obj.get_state_set().contains(Atspi.StateType.DEFUNCT) or self.fingerprint(obj) != fingerprint:
                raise ValueError('changed')
            parent = obj
            for _ in range(128):
                if parent == capture['root']:
                    return obj, capture
                parent = parent.get_parent()
                if parent is None:
                    break
        except Exception:
            pass
        raise Failure('stale_desktop_ref', 'Element changed or left the observed window. Refresh its snapshot.')

    def accessible_window(self, window):
        desktop = Atspi.get_desktop(0)
        matches = []
        for ai in range(min(desktop.get_child_count(), 256)):
            app = desktop.get_child_at_index(ai)
            if window['pid'] and app.get_process_id() != window['pid']:
                continue
            for wi in range(min(app.get_child_count(), 256)):
                candidate = app.get_child_at_index(wi)
                component = candidate.get_component_iface()
                if not component:
                    continue
                rect = component.get_extents(Atspi.CoordType.SCREEN)
                g = window['geometry']
                near = abs(rect.x - g['x']) < 40 and abs(rect.y - g['y']) < 80 and abs(rect.width - g['width']) < 80 and abs(rect.height - g['height']) < 120
                if near and (window['pid'] or candidate.get_name() == window['title']):
                    matches.append(candidate)
        if len(matches) == 1:
            return matches[0]
        named = [obj for obj in matches if obj.get_name() == window['title']]
        return named[0] if len(named) == 1 else None

    def describe(self, obj, ref, parent, depth):
        fingerprint = self.fingerprint(obj)
        state = obj.get_state_set()
        states = [name for name in ('ENABLED', 'SENSITIVE', 'VISIBLE', 'SHOWING', 'FOCUSED', 'EDITABLE', 'CHECKED', 'SELECTED', 'EXPANDED', 'MODAL')
                  if state.contains(getattr(Atspi.StateType, name))]
        result = {'ref': ref, 'parent': parent, 'depth': depth, 'role': bounded(fingerprint[1], 100),
                  'name': bounded(fingerprint[2]), 'states': [s.lower() for s in states], 'children': obj.get_child_count()}
        action = obj.get_action_iface()
        if action:
            result['actions'] = [bounded(action.get_action_name(i), 80) for i in range(min(action.get_n_actions(), 16))]
            result['keyBindings'] = []
            for i, name in enumerate(result['actions']):
                try:
                    binding = bounded(action.get_key_binding(i), 256) or None
                except Exception:
                    binding = None
                result['keyBindings'].append({'action': name, 'binding': binding})
        component = obj.get_component_iface()
        if component:
            rect = component.get_extents(Atspi.CoordType.SCREEN)
            result['geometry'] = {'x': rect.x, 'y': rect.y, 'width': rect.width, 'height': rect.height}
        text = obj.get_text_iface()
        if text and obj.get_role() != Atspi.Role.PASSWORD_TEXT:
            count = text.get_character_count()
            result.update(text=bounded(Atspi.Text.get_text(text, 0, min(count, 1500)), 1500), textLength=count, textTruncated=count > 1500)
        return result, fingerprint

    @staticmethod
    def snapshot_priority(states, role, in_dialog):
        visible = 'visible' in states and 'showing' in states
        if not visible:
            return 4
        structural = role in ('application', 'frame', 'window', 'filler', 'panel', 'viewport',
                              'scroll pane', 'root pane', 'layered pane', 'tool bar', 'menu bar', 'separator', 'unknown')
        if 'editable' in states or 'focused' in states or role in ('dialog', 'alert') or (in_dialog and not structural):
            return 0
        if structural:
            return 3
        return 2 if role in ('label', 'static', 'text', 'paragraph', 'heading', 'section') else 1

    def collect_snapshot(self, capture, key):
        # Inspect bounded, lightweight metadata before paging. Output budgets
        # must not let earlier hidden widgets/containers bury the editor. Read
        # text, geometry and actions only for the elements actually returned.
        pending = collections.deque([(capture['root'], None, 0, False)])
        candidates = []
        while pending and len(capture['seen']) < 2000:
            obj, parent, depth, in_dialog = pending.popleft()
            if obj in capture['seen']:
                continue
            capture['seen'].add(obj)
            try:
                fingerprint = self.fingerprint(obj)
                state = obj.get_state_set()
                states = [name.lower() for name in ('VISIBLE', 'SHOWING', 'FOCUSED', 'EDITABLE', 'MODAL')
                          if state.contains(getattr(Atspi.StateType, name))]
                children = obj.get_child_count()
            except Exception:
                capture['unreadable'] += 1
                continue
            ref = f"{key}e{len(capture['refs'])}"
            capture['refs'][ref] = (obj, fingerprint)
            in_dialog = in_dialog or 'modal' in states or fingerprint[1] in ('dialog', 'alert')
            priority = self.snapshot_priority(states, fingerprint[1], in_dialog)
            if priority < 4 or capture['includeHidden']:
                candidates.append((priority, obj, ref, parent, depth))
            else:
                capture['hidden'] += 1
            # Some toolkits omit visibility on structural parents while their
            # children are showing. Never prune a subtree solely on that state.
            for ci in range(min(children, 2000)):
                if len(pending) + len(capture['seen']) >= 4000 or depth >= 64:
                    capture['limited'] = True
                    break
                try:
                    child = obj.get_child_at_index(ci)
                    if child is not None:
                        pending.append((child, ref, depth + 1, in_dialog))
                except Exception:
                    capture['unreadable'] += 1
            if children > 2000:
                capture['limited'] = True
        capture['limited'] |= bool(pending)
        # Stable sort retains tree order within each priority. Parent refs are
        # retained even when their records appear on a later page or are hidden.
        capture['queue'] = collections.deque(sorted(candidates, key=lambda item: item[0]))

    def snapshot(self, args):
        self.expire()
        window = self.window(args['windowId'])
        if 'textOffset' in args or args.get('textCursor'):
            return self.read_text(args, window)
        cursor = args.get('cursor')
        if cursor:
            key, _, offset = cursor.partition(':')
            capture = self.captures.get(key)
            if not capture or capture['windowId'] != window['id'] or str(capture['offset']) != offset:
                raise Failure('stale_desktop_cursor', 'Snapshot cursor expired or was already consumed. Start another snapshot.')
            if args.get('ref'):
                raise Failure('invalid_desktop_cursor', 'Continue with windowId, cursor and budgets only.')
            if 'includeHidden' in args and args['includeHidden'] != capture['includeHidden']:
                raise Failure('invalid_desktop_cursor', 'Visibility selection cannot change during pagination. Start another snapshot.')
        else:
            inspection_error = None
            if args.get('ref'):
                root = self.resolve(args['ref'])[0]
            else:
                try:
                    root = self.accessible_window(window)
                except Exception as error:
                    root = None
                    inspection_error = bounded(str(error), 256)
            if args.get('ref') and self.resolve(args['ref'])[1]['windowId'] != window['id']:
                raise Failure('desktop_ref_window_mismatch', 'Reference belongs to a different window.')
            if root is None:
                return {'window': window, 'accessibility': 'unavailable', 'elements': [], 'nextCursor': None,
                        'fallback': {'tool': 'take_screenshot', 'reason': inspection_error or 'No unambiguous AT-SPI window was exposed by this application.'}}
            # Hex identifiers deliberately exclude e, the ref delimiter.
            key = secrets.token_hex(12).replace('e', 'x')
            capture = {'windowId': window['id'], 'root': root, 'queue': collections.deque(),
                       'refs': {}, 'seen': set(), 'created': time.monotonic(), 'offset': 0, 'limited': False,
                       'unreadable': 0, 'hidden': 0, 'includeHidden': args.get('includeHidden', False), 'useful': False}
            self.collect_snapshot(capture, key)
            self.captures[key] = capture
            while len(self.captures) > 4:
                self.captures.popitem(last=False)
        elements = []
        limit = min(args.get('limit', 100), 200)
        # Reserve room for app-controlled window metadata and the response
        # envelope, including JSON escaping, under the shared 24 KB budget.
        budget = min(args.get('maxBytes', 16000), 18000,
                     22000 - len(json.dumps(window, ensure_ascii=False).encode()))
        while capture['queue'] and len(elements) < limit:
            priority, obj, ref, parent, depth = capture['queue'][0]
            try:
                item, fingerprint = self.describe(obj, ref, parent, depth)
                if 'textLength' in item:
                    item['textRead'] = {'windowId': window['id'], 'ref': ref, 'textOffset': 0}
            except Exception:
                capture['queue'].popleft()
                capture['unreadable'] += 1
                continue
            if not capture['includeHidden'] and not {'visible', 'showing'}.issubset(item['states']):
                capture['queue'].popleft()
                capture['hidden'] += 1
                continue
            if len(json.dumps(elements + [item], ensure_ascii=False).encode()) > budget:
                if elements:
                    break
                # Even a single very long element must allow forward progress.
                item.pop('text', None)
                item['textTruncated'] = True
                item['name'] = bounded(item['name'], 128)
                item.pop('actions', None)
                if item.pop('keyBindings', None) is not None: item['keyBindingsTruncated'] = True
            capture['queue'].popleft()
            capture['refs'][ref] = (obj, fingerprint)
            elements.append(item)
            capture['useful'] |= priority < 3
        capture['offset'] += len(elements)
        useful = capture['useful'] or any(item[0] < 3 for item in capture['queue'])
        return {'window': window, 'accessibility': 'at-spi', 'elements': elements,
                'usefulTree': useful,
                **({} if useful else {'fallback': {'tool': 'take_screenshot', 'reason': 'Application exposes only a sparse native tree. Inspect a screenshot or retry after startup.'}}),
                'nextCursor': f"{key}:{capture['offset']}" if capture['queue'] else None,
                'truncated': capture['limited'] or bool(capture['queue']), 'scopeLimitReached': capture['limited'],
                'unreadableElements': capture['unreadable'],
                'includeHidden': capture['includeHidden'], 'hiddenElementsOmitted': capture['hidden'],
                'order': 'visible_controls_first',
                'note': 'Ordering is captured; element content is live. Parent refs may appear later or be hidden. Refs last at most five minutes; refresh to discover new elements or use ref for a smaller subtree when scopeLimitReached.'}

    def read_text(self, args, window):
        if args.get('cursor'):
            raise Failure('invalid_desktop_cursor', 'Text and element continuation are separate.')
        cursor = args.get('textCursor')
        if cursor:
            if 'textOffset' in args or args.get('ref'):
                raise Failure('invalid_desktop_cursor', 'Continue a text capture with windowId, textCursor and maxBytes only.')
            key, _, raw_offset = cursor.partition(':')
            capture = self.text_captures.get(key)
            if not capture or capture['windowId'] != window['id']:
                raise Failure('stale_desktop_text', 'Text capture expired; start a new targeted text read.')
            offset = int(raw_offset)
        else:
            if not args.get('ref'):
                raise Failure('desktop_text_ref_required', 'Text reading requires an observed native ref.')
            obj, source = self.resolve(args['ref'])
            if source['windowId'] != window['id']:
                raise Failure('desktop_ref_window_mismatch', 'Reference belongs to a different window.')
            if obj.get_role() == Atspi.Role.PASSWORD_TEXT:
                raise Failure('desktop_sensitive_text', 'Password text is not exposed.')
            iface = obj.get_text_iface()
            if not iface:
                raise Failure('desktop_text_unavailable', 'This element exposes no native text interface.')
            count = iface.get_character_count()
            if count > 8000000:
                raise Failure('desktop_text_too_large', 'Text capture exceeds 8 MB; use the application document/file interface.')
            text = Atspi.Text.get_text(iface, 0, count)
            size = len(text.encode('utf-8'))
            if size > 8000000:
                raise Failure('desktop_text_too_large', 'Text capture exceeds 8 MB; use the application document/file interface.')
            while self.text_captures and (len(self.text_captures) >= 4 or sum(item['bytes'] for item in self.text_captures.values()) + size > 16000000):
                self.text_captures.popitem(last=False)
            key = secrets.token_hex(12)
            capture = {'windowId': window['id'], 'text': text, 'bytes': size, 'created': time.monotonic(), 'capturedAt': time.time()}
            self.text_captures[key] = capture
            offset = args.get('textOffset', 0)
        text = capture['text']
        if offset < 0 or offset > len(text):
            raise Failure('desktop_text_offset_invalid', 'Offset is outside the captured text.')
        budget = min(args.get('maxBytes', 16000), 18000)
        end = min(len(text), offset + budget)
        while len(json.dumps(text[offset:end], ensure_ascii=False).encode()) > budget:
            end = offset + max(1, (end - offset) * 3 // 4)
        return {'windowId': window['id'], 'text': text[offset:end], 'captureId': key,
                'capturedAt': capture['capturedAt'], 'consistency': 'captured_text', 'offsetUnit': 'unicode_code_points',
                'offset': offset, 'nextOffset': end, 'totalCharacters': len(text), 'totalBytes': capture['bytes'],
                'textTruncated': end < len(text), 'nextTextCursor': f'{key}:{end}' if end < len(text) else None}

    def act(self, args):
        if args['action'] == 'set_text' and 'text' not in args:
            raise Failure('desktop_text_required', 'set_text requires an explicit text value, including an empty string when clearing.')
        obj, capture = self.resolve(args['ref'])
        state = obj.get_state_set()
        if not state.contains(Atspi.StateType.ENABLED) or not state.contains(Atspi.StateType.SENSITIVE):
            raise Failure('desktop_element_disabled', 'Element is disabled; no action was sent.')
        if args['action'] == 'focus':
            iface = obj.get_component_iface()
            accepted = iface and iface.grab_focus()
        elif args['action'] == 'set_text':
            iface = obj.get_editable_text_iface()
            accepted = iface and iface.set_text_contents(args.get('text', ''))
        else:
            iface = obj.get_action_iface()
            names = [iface.get_action_name(i) for i in range(iface.get_n_actions())] if iface else []
            name = args.get('actionName')
            if name is None and len(names) == 1:
                name = names[0]
            if name not in names:
                raise Failure('desktop_action_unavailable', 'Choose an actionName exposed in the element snapshot.')
            accepted = iface.do_action(names.index(name))
        return {'ref': args['ref'], 'windowId': capture['windowId'], 'dispatch': 'completed',
                'acceptedByAccessibilityApi': bool(accepted), 'verified': False,
                'note': 'API acceptance does not prove the intended application effect. Observe the resulting state.'}

    def call(self, method, args):
        context = GLib.MainContext.default()
        for _ in range(100):
            if not context.pending():
                break
            context.iteration(False)
        handlers = {'windows': self.windows, 'validate': self.validate, 'window_action': self.window_action,
                    'snapshot': self.snapshot, 'act': self.act, 'close_process': self.close_process}
        if method not in handlers:
            raise Failure('invalid_desktop_method', 'Unsupported native desktop operation.')
        return handlers[method](args)


def main():
    desktop = Desktop()
    for line in sys.stdin:
        try:
            if len(line) > 512000:
                raise Failure('desktop_request_too_large', 'Native request exceeded its input budget.')
            request = json.loads(line)
            response = {'result': desktop.call(request['method'], request['input'])}
        except Failure as error:
            response = {'error': {'code': error.code, 'message': str(error)}}
        except Exception as error:
            response = {'error': {'code': 'desktop_accessibility_error', 'message': bounded(str(error))}}
        print(json.dumps(response, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
