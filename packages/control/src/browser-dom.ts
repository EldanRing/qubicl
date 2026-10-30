import type { ElementHandle, Frame } from 'playwright-core';

/** Shared, dependency-free DOM observation, serialized into the selected frame.
 * Keep helpers inside this function: Playwright does not serialize closures.
 */
export interface BrowserDOMRequest {
  mode: 'candidates' | 'describe' | 'describe-many' | 'text' | 'value' | 'control' | 'page' | 'point' | 'watch';
  element?: Element;
  elements?: Element[];
  maxBytes?: number;
  barriers?: { inert: boolean; blockedByModal: boolean };
  x?: number;
  y?: number;
}

export interface BrowserControl extends Record<string, unknown> {
  tag: string;
  role: string;
  name: string;
  disabled: boolean;
  readOnly: boolean;
  inert: boolean;
  blockedByModal: boolean;
  actionable: boolean;
  focused: boolean;
  value?: string;
  valueLength?: number;
  valueTruncated?: boolean;
  options?: Array<{ index: number; label: string; value: string; selected: boolean; disabled: boolean }>;
}

export interface BrowserDOMPage extends Record<string, unknown> {
  text: string;
  textTruncated: boolean;
  focus: Record<string, unknown> | null;
  selection: Record<string, unknown> | null;
}

export function browserDOM(request: BrowserDOMRequest): unknown {
  const root = request.element ?? document.body ?? document.documentElement;
  const clean = (value: string | null | undefined): string => (value ?? '').replace(/\s+/gu, ' ').trim();
  const clip = (value: string, length: number): string => value.slice(0, length).replace(/[\uD800-\uDBFF]$/u, '');
  const styles = new WeakMap<Element, CSSStyleDeclaration>();
  const style = (element: Element): CSSStyleDeclaration => {
    let result = styles.get(element);
    if (!result) { result = getComputedStyle(element); styles.set(element, result); }
    return result;
  };
  const parent = (element: Element): Element | null => element.assignedSlot ?? element.parentElement
    ?? ((element.getRootNode() as ShadowRoot).host ?? null);
  const ancestors = function* (element: Element): Generator<Element> {
    for (let current: Element | null = element; current; current = parent(current)) yield current;
  };
  const children = (node: Node): Node[] => {
    if (node instanceof HTMLSlotElement) {
      const assigned = node.assignedNodes({ flatten: true });
      return assigned.length ? assigned : [...node.childNodes];
    }
    return [...(node instanceof Element && node.shadowRoot ? node.shadowRoot.childNodes : node.childNodes)];
  };
  const nodes = function* (start: Node): Generator<Node> {
    const pending = [start];
    while (pending.length) {
      const node = pending.pop()!;
      yield node;
      const nested = children(node);
      for (let i = nested.length - 1; i >= 0; i--) pending.push(nested[i]!);
    }
  };
  const visible = (element: Element): boolean => {
    for (const current of ancestors(element)) {
      const css = style(current);
      if (css.display === 'none' || css.visibility === 'hidden' || css.visibility === 'collapse') return false;
      if (current instanceof HTMLDetailsElement && !current.open && current !== element) {
        const summary = [...current.children].find((child) => child.tagName === 'SUMMARY');
        if (!summary || ![...ancestors(element)].includes(summary)) return false;
      }
    }
    return true;
  };
  const ignored = (element: Element): boolean => ['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName);
  const renderedText = (start: Node, includeHidden = false, naming = false): string => {
    const output: string[] = [];
    const pending: Array<{ node: Node; end?: boolean }> = [{ node: start }];
    while (pending.length) {
      const { node, end } = pending.pop()!;
      if (end) { output.push('\n'); continue; }
      if (node.nodeType === Node.TEXT_NODE) {
        const owner = node.parentElement;
        if (!owner || includeHidden || visible(owner)) output.push(owner && /^(pre|break-spaces)/u.test(style(owner).whiteSpace)
          ? node.textContent ?? '' : (node.textContent ?? '').replace(/[\t\n\r ]+/gu, ' '));
        continue;
      }
      if (node instanceof Element) {
        if (!includeHidden && !visible(node)) continue;
        const alternative = naming && node !== start ? node.getAttribute('aria-label') || node.getAttribute('alt') : null;
        if (alternative) { output.push(alternative); continue; }
        if (ignored(node)) continue;
        if (node.tagName === 'BR') { output.push('\n'); continue; }
        const block = /^(block|flex|grid|list-item|table-row|table-caption)/u.test(style(node).display);
        if (block) { output.push('\n'); pending.push({ node, end: true }); }
      }
      const nested = children(node);
      for (let i = nested.length - 1; i >= 0; i--) pending.push({ node: nested[i]! });
    }
    return output.join('').replace(/ *\n */gu, '\n').replace(/\n{3,}/gu, '\n\n').trim();
  };
  const idText = (element: Element, attribute: string): string => clean((element.getAttribute(attribute) ?? '').split(/\s+/u)
    .filter(Boolean).map((id) => (element.getRootNode() as Document | ShadowRoot).getElementById(id))
    .filter((node): node is HTMLElement => Boolean(node)).map((node) => renderedText(node, true)).join(' '));
  const nameOf = (element: Element): string => {
    const labelled = idText(element, 'aria-labelledby');
    if (labelled) return clip(labelled, 160);
    const aria = clean(element.getAttribute('aria-label'));
    if (aria) return clip(aria, 160);
    const field = element as HTMLInputElement;
    const labels = clean([...(field.labels ?? [])].map((label) => renderedText(label, true)).join(' '));
    if (labels) return clip(labels, 160);
    if (element instanceof HTMLInputElement && ['submit', 'reset', 'button'].includes(element.type)) {
      return clip(element.value || (element.type === 'submit' ? 'Submit' : element.type === 'reset' ? 'Reset' : ''), 160);
    }
    const alt = clean(element.getAttribute('alt'));
    const content = renderedText(element, false, true);
    return clip(alt || content || clean(element.getAttribute('title')) || clean(element.getAttribute('placeholder')), 160);
  };
  const roleOf = (element: Element): string => {
    const explicit = element.getAttribute('role')?.split(/\s+/u)[0];
    if (explicit) return clip(explicit, 64);
    const tag = element.tagName.toLowerCase();
    if (element instanceof HTMLInputElement) {
      return ({ checkbox: 'checkbox', radio: 'radio', number: 'spinbutton', range: 'slider', button: 'button', submit: 'button', reset: 'button', file: 'button' } as Record<string, string>)[element.type] ?? 'textbox';
    }
    if (element instanceof HTMLSelectElement) return element.multiple || element.size > 1 ? 'listbox' : 'combobox';
    if (tag === 'textarea' || (element as HTMLElement).isContentEditable) return 'textbox';
    return ({ a: 'link', button: 'button', summary: 'button', option: 'option', dialog: 'dialog' } as Record<string, string>)[tag] ?? tag;
  };
  const activeElement = (): Element | null => {
    let element = document.activeElement;
    while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
    return element;
  };
  const focused = activeElement();
  const all = (): Element[] => [...nodes(document.documentElement)].filter((node): node is Element => node instanceof Element);
  let modal: Element | undefined;
  let modalChecked = false;
  const activeModal = (): Element | undefined => {
    if (modalChecked) return modal;
    modalChecked = true;
    const isModal = (element: Element): boolean => element.matches('dialog:modal') || (element.matches('[role=dialog][aria-modal=true],[role=alertdialog][aria-modal=true]') && visible(element));
    modal = focused ? [...ancestors(focused)].find(isModal) : undefined;
    modal ??= all().findLast(isModal);
    return modal;
  };
  const scrollState = (element: Element): Record<string, unknown> | undefined => {
    const x = element.scrollWidth > element.clientWidth + 1 && /^(auto|scroll|hidden|overlay)$/u.test(style(element).overflowX);
    const y = element.scrollHeight > element.clientHeight + 1 && /^(auto|scroll|hidden|overlay)$/u.test(style(element).overflowY);
    if (!x && !y) return undefined;
    return { x: element.scrollLeft, y: element.scrollTop, clientWidth: element.clientWidth, clientHeight: element.clientHeight,
      scrollWidth: element.scrollWidth, scrollHeight: element.scrollHeight, canScrollX: x, canScrollY: y };
  };
  const selectionOf = (element: Element): Record<string, unknown> | undefined => {
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) return undefined;
    if (element instanceof HTMLInputElement && element.type === 'password') return { redacted: true };
    if (element.selectionStart === null) return undefined;
    const start = element.selectionStart, end = element.selectionEnd ?? start;
    return { start, end, direction: element.selectionDirection, text: clip(element.value.slice(start, end), 256),
      textTruncated: end - start > 256, offsetUnit: 'utf16' };
  };
  const describe = (element: Element, full = false): BrowserControl => {
    const field = element as HTMLInputElement;
    const isField = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement;
    const password = element instanceof HTMLInputElement && element.type === 'password';
    const scroll = scrollState(element);
    const currentModal = activeModal();
    const inert = Boolean(request.barriers?.inert) || [...ancestors(element)].some((current) => current.hasAttribute('inert'));
    const blockedByModal = Boolean(request.barriers?.blockedByModal) || Boolean(currentModal && ![...ancestors(element)].includes(currentModal));
    const disabled = element.matches(':disabled') || [...ancestors(element)].some((current) => current.getAttribute('aria-disabled') === 'true');
    const textControl = isField || roleOf(element) === 'textbox' || roleOf(element) === 'searchbox' || element.hasAttribute('contenteditable');
    const editable = textControl && (isField || (element as HTMLElement).isContentEditable);
    const readOnly = Boolean(field.readOnly) || element.getAttribute('aria-readonly') === 'true' || (textControl && !editable);
    const result: BrowserControl = {
      tag: clip(element.tagName.toLowerCase(), 64), role: roleOf(element), name: nameOf(element) || (scroll ? 'Scrollable region' : ''),
      disabled, readOnly, ...(textControl ? { editable: editable && !readOnly && !disabled && !inert && !blockedByModal } : {}), inert, blockedByModal, actionable: !disabled && !inert && !blockedByModal && visible(element),
      focused: element === focused,
      ...(element.getAttribute('type') ? { type: clip(element.getAttribute('type')!, 64) } : {}),
      ...(scroll ? { scroll } : {}),
    };
    const value = password || field.type === 'file' ? undefined : isField ? field.value
      : (element as HTMLElement).isContentEditable ? (element as HTMLElement).innerText : undefined;
    if (value !== undefined) Object.assign(result, { value: full ? value : clip(value, 1500), valueLength: value.length, valueTruncated: !full && value.length > 1500 });
    const description = idText(element, 'aria-describedby');
    if (description) result.description = clip(description, full ? description.length : 512);
    if (field.validity && field.willValidate) result.validation = { valid: field.validity.valid, message: clip(field.validationMessage, 512),
      ...(field.required ? { required: true } : {}) };
    if (element instanceof HTMLInputElement && ['number', 'range'].includes(element.type)) {
      result.constraints = { min: clip(element.min, 128) || (element.type === 'range' ? '0' : null),
        max: clip(element.max, 128) || (element.type === 'range' ? '100' : null), step: clip(element.step, 128) || '1' };
    } else if (['slider', 'spinbutton'].includes(result.role)) {
      result.constraints = { min: clip(element.getAttribute('aria-valuemin') ?? '', 128) || null, max: clip(element.getAttribute('aria-valuemax') ?? '', 128) || null, step: clip(element.getAttribute('step') ?? '', 128) || null };
    }
    if (element instanceof HTMLInputElement && ['checkbox', 'radio'].includes(element.type)) {
      result.checked = element.checked; result.indeterminate = element.indeterminate;
    } else if (element.hasAttribute('aria-checked')) result.checked = element.getAttribute('aria-checked') === 'mixed' ? 'mixed' : element.getAttribute('aria-checked') === 'true';
    if (element.tagName === 'SUMMARY' && element.parentElement instanceof HTMLDetailsElement) result.expanded = element.parentElement.open;
    else if (element.hasAttribute('aria-expanded')) result.expanded = element.getAttribute('aria-expanded') === 'true';
    if (element instanceof HTMLSelectElement) {
      const options = [...element.options];
      result.multiple = element.multiple;
      result.options = options.slice(0, full ? options.length : 20).map((option, index) => ({ index,
        label: full ? option.label : clip(option.label, 160), value: full ? option.value : clip(option.value, 512),
        selected: option.selected, disabled: option.disabled || Boolean(option.parentElement instanceof HTMLOptGroupElement && option.parentElement.disabled),
        ...(option.value.length > 512 && !full ? { valueTruncated: true } : {}),
      }));
      result.optionsTotal = options.length; result.optionsTruncated = !full && options.length > 20;
    }
    if (element instanceof HTMLInputElement && element.type === 'file') {
      const files = [...element.files ?? []];
      result.accept = clip(element.accept, 512); result.multiple = element.multiple;
      result.files = files.slice(0, full ? files.length : 20).map((file) => ({ name: clip(file.name, 256), size: file.size, type: clip(file.type, 128), lastModified: file.lastModified }));
      result.filesTotal = files.length; result.filesTruncated = !full && files.length > 20;
    }
    const selection = element === focused ? selectionOf(element) : undefined;
    if (selection) result.selection = selection;
    return result;
  };
  const fitText = (text: string, maxBytes: number): { text: string; bytes: number; truncated: boolean } => {
    const bytes = new TextEncoder().encode(text).length;
    let end = Math.min(text.length, maxBytes);
    while (new TextEncoder().encode(clip(text, end)).length > maxBytes) end = Math.floor(end * .8);
    const selected = bytes <= maxBytes ? text : clip(text, end);
    return { text: selected, bytes, truncated: bytes > maxBytes };
  };
  const page = (): BrowserDOMPage => {
    const text = fitText(renderedText(document.body ?? document.documentElement), request.maxBytes ?? 6000);
    const current = activeElement();
    const focusedRoot = current?.getRootNode() as (ShadowRoot & { getSelection?(): Selection | null }) | undefined;
    const selection = focusedRoot?.getSelection?.() ?? document.getSelection();
    const fieldSelection = current ? selectionOf(current) : undefined;
    const control = current ? describe(current) : undefined;
    return { text: text.text, textTruncated: text.truncated,
      focus: current ? { tag: current.tagName.toLowerCase(), role: roleOf(current), name: nameOf(current), id: clip(current.id, 160), ...(fieldSelection ? { selection: fieldSelection } : {}),
        ...(control ? { readOnly: control.readOnly, blockedByModal: control.blockedByModal, validation: control.validation, checked: control.checked, expanded: control.expanded, value: control.value, valueTruncated: control.valueTruncated } : {}) } : null,
      selection: fieldSelection ?? (selection ? { text: clip(selection.toString(), 256), textTruncated: selection.toString().length > 256,
        collapsed: selection.isCollapsed, anchorOffset: selection.anchorOffset, focusOffset: selection.focusOffset, offsetUnit: 'utf16' } : null),
    };
  };
  switch (request.mode) {
    case 'candidates': return all().filter((element) => element.matches('a[href],button,input:not([type=hidden]),textarea,select,summary,[contenteditable=true],[contenteditable=""],[contenteditable=plaintext-only],[aria-expanded],[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=option],[role=textbox],[role=slider],[role=spinbutton]') || Boolean(scrollState(element)));
    case 'describe': return describe(root);
    case 'describe-many': return (request.elements ?? []).map((element) => describe(element));
    case 'control': {
      const text = JSON.stringify(describe(root, true));
      const bytes = new TextEncoder().encode(text).length;
      return { text: bytes <= (request.maxBytes ?? 8_000_000) ? text : null, bytes };
    }
    case 'value': {
      if (root instanceof HTMLInputElement && (root.type === 'password' || root.type === 'file')) return { error: 'sensitive_value' };
      if (!(root instanceof HTMLInputElement || root instanceof HTMLTextAreaElement || (root as HTMLElement).isContentEditable)) return { error: 'not_value_control' };
      const text = root instanceof HTMLInputElement || root instanceof HTMLTextAreaElement ? root.value : (root as HTMLElement).innerText;
      const bytes = new TextEncoder().encode(text).length;
      return { text: bytes <= (request.maxBytes ?? 8_000_000) ? text : null, bytes };
    }
    case 'text': {
      const text = renderedText(root), bytes = new TextEncoder().encode(text).length;
      return { text: bytes <= (request.maxBytes ?? 8_000_000) ? text : null, bytes };
    }
    case 'page': return page();
    case 'point': {
      const found: Element[] = [];
      const visited = new Set<Document | ShadowRoot>();
      const collect = (tree: Document | ShadowRoot): void => {
        if (visited.has(tree)) return;
        visited.add(tree);
        for (const element of tree.elementsFromPoint(request.x!, request.y!)) {
          if (found.includes(element)) continue;
          if (element.shadowRoot) collect(element.shadowRoot);
          if (!found.includes(element)) found.push(element);
        }
      };
      collect(document);
      return found.slice(0, 12).map((element) => {
        const box = element.getBoundingClientRect();
        return { ...describe(element), id: clip(element.id, 160), classes: [...element.classList].slice(0, 12).map((name) => clip(name, 128)), cursor: style(element).cursor,
          box: { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) } };
      });
    }
    case 'watch': {
      const feedback: string[] = [];
      const watched = new Set<Node>();
      const observers: MutationObserver[] = [];
      const flushers: Array<() => void> = [];
      const remember = (text: string): void => { const bounded = clip(clean(text), 256); if (bounded && feedback.at(-1) !== bounded) { feedback.push(bounded); if (feedback.length > 8) feedback.shift(); } };
      const live = (element: Element): boolean => [...ancestors(element)].some((node) => node.matches('[role=status],[role=alert],[aria-live=polite],[aria-live=assertive]'));
      const attach = (tree: Node): void => {
        if (watched.has(tree)) return;
        watched.add(tree);
        const consume = (records: MutationRecord[]): void => {
          for (const record of records) {
            const target = record.target instanceof Element ? record.target : record.target.parentElement;
            if (target && visible(target) && ![...ancestors(target)].some(ignored)) {
              if (record.type === 'characterData') {
                if (record.oldValue) remember(record.oldValue);
                remember(record.target.textContent ?? '');
              }
              // Retain transient inserted text even if it is removed before the
              // action returns, including toasts without ARIA live semantics.
              for (const node of record.addedNodes) remember(renderedText(node));
              if (live(target)) remember(renderedText(target));
            }
            for (const node of record.addedNodes) if (node instanceof Element) {
              for (const nested of nodes(node)) if (nested instanceof Element) {
                if (live(nested)) remember(nested.textContent ?? '');
                if (nested.shadowRoot) attach(nested.shadowRoot);
              }
            }
          }
        };
        const observer = new MutationObserver(consume);
        flushers.push(() => consume(observer.takeRecords()));
        observer.observe(tree, { subtree: true, childList: true, characterData: true, characterDataOldValue: true, attributes: true, attributeFilter: ['role', 'aria-live'] });
        observers.push(observer);
      };
      attach(document);
      for (const element of all()) if (element.shadowRoot) attach(element.shadowRoot);
      return { finish: () => { for (const flush of flushers) flush(); for (const observer of observers) observer.disconnect(); return { feedback, observedAt: new Date().toISOString() }; } };
    }
  }
}

/** Parent-frame modals/inertness also block controls inside child frames. */
export async function frameBarriers(frame: Frame): Promise<{ inert: boolean; blockedByModal: boolean }> {
  let inert = false, blockedByModal = false;
  for (let current: Frame | null = frame; current?.parentFrame?.(); current = current.parentFrame()) {
    const parent = current.parentFrame()!;
    const element = await current.frameElement();
    try {
      const state = await parent.evaluate(browserDOM, { mode: 'describe' as const, element: element as ElementHandle<Element> }) as BrowserControl;
      inert ||= state.inert;
      blockedByModal ||= state.blockedByModal;
    } finally { await element.dispose(); }
  }
  return { inert, blockedByModal };
}
