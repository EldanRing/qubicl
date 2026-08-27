import { emitKeypressEvents } from 'node:readline';

export interface SelectorItem {
  id: string;
  label: string;
  category: string;
  detail?: string;
  locked?: boolean;
}

export class SelectorCancelledError extends Error {
  constructor() { super('Selection cancelled. No policy was changed.'); }
}

export async function checkboxSelector(
  title: string,
  items: readonly SelectorItem[],
  initiallySelected: ReadonlySet<string>,
  options: { searchable?: boolean; single?: boolean; output?: NodeJS.WriteStream; input?: NodeJS.ReadStream } = {},
): Promise<Set<string>> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  if (!input.isTTY || !output.isTTY || !input.setRawMode) throw new Error(`${title} interactive selection requires a TTY; use --enable/--disable/--profile with --yes instead.`);
  const selected = new Set(initiallySelected);
  for (const item of items) if (item.locked) selected.add(item.id);
  let cursor = 0;
  let query = '';
  let searching = false;
  let details = false;
  emitKeypressEvents(input);
  input.setRawMode(true);
  input.resume();
  output.write('\x1b[?25l');
  const visible = (): SelectorItem[] => {
    const normalized = query.toLowerCase();
    return normalized ? items.filter((item) => `${item.label} ${item.category} ${item.detail ?? ''}`.toLowerCase().includes(normalized)) : [...items];
  };
  const render = (): void => {
    const shown = visible();
    cursor = Math.max(0, Math.min(cursor, Math.max(0, shown.length - 1)));
    const lines = [`\x1b[1;33m${title}\x1b[0m`, '↑/↓ or j/k navigate   SPACE toggle   d details   ENTER save   ESC cancel', ...(options.searchable ? [`/ search${query ? `: ${query}` : ''}${searching ? ' ▋' : ''}`] : []), ''];
    let priorCategory = '';
    for (const [index, item] of shown.entries()) {
      if (item.category !== priorCategory) {
        if (priorCategory) lines.push('');
        lines.push(`\x1b[2m${item.category}\x1b[0m`);
        priorCategory = item.category;
      }
      const active = index === cursor;
      const marker = item.locked ? '◆' : selected.has(item.id) ? '✓' : ' ';
      lines.push(`${active ? '\x1b[32m➜' : ' '} [${marker}] ${item.label}${active ? '\x1b[0m' : ''}`);
      if (active && details && item.detail) lines.push(`    \x1b[2m${item.detail}\x1b[0m`);
    }
    if (!shown.length) lines.push('  No matching entries.');
    output.write(`\x1b[H\x1b[2J${lines.join('\n')}\n`);
  };
  render();
  try {
    return await new Promise<Set<string>>((resolvePromise, rejectPromise) => {
      const onKeypress = (text: string, key: { name?: string; ctrl?: boolean; sequence?: string }): void => {
        if (key.ctrl && key.name === 'c') { cleanup(); rejectPromise(new SelectorCancelledError()); return; }
        if (searching) {
          if (key.name === 'escape') { searching = false; query = ''; cursor = 0; }
          else if (key.name === 'return') searching = false;
          else if (key.name === 'backspace') { query = query.slice(0, -1); cursor = 0; }
          else if (text && !key.ctrl && text >= ' ') { query += text; cursor = 0; }
          render();
          return;
        }
        const shown = visible();
        if (key.name === 'escape') { cleanup(); rejectPromise(new SelectorCancelledError()); return; }
        if (key.name === 'return') { cleanup(); resolvePromise(selected); return; }
        if ((key.name === 'up' || text === 'k') && shown.length) cursor = (cursor - 1 + shown.length) % shown.length;
        else if ((key.name === 'down' || text === 'j') && shown.length) cursor = (cursor + 1) % shown.length;
        else if (key.name === 'space' && shown[cursor] && !shown[cursor]!.locked) {
          const id = shown[cursor]!.id;
          if (options.single) { selected.clear(); selected.add(id); }
          else if (selected.has(id)) selected.delete(id); else selected.add(id);
        } else if (text === 'd' || key.name === 'right') details = !details;
        else if (text === '/' && options.searchable) { searching = true; query = ''; cursor = 0; }
        render();
      };
      const cleanup = (): void => {
        input.off('keypress', onKeypress);
        input.setRawMode!(false);
        input.pause();
        output.write('\x1b[?25h\x1b[2J\x1b[H');
      };
      input.on('keypress', onKeypress);
    });
  } finally {
    if (input.isTTY) input.setRawMode(false);
    output.write('\x1b[?25h');
  }
}

export async function singleSelector(title: string, items: readonly SelectorItem[], selected: string): Promise<string> {
  const chosen = await checkboxSelector(title, items.map((item) => ({ ...item, locked: false })), new Set([selected]), { single: true });
  const ordered = items.find(({ id }) => chosen.has(id));
  return ordered?.id ?? selected;
}
