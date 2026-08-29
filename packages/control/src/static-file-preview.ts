import { extname } from 'node:path';
import {
  parse,
  parseFragment,
  serialize,
  type DefaultTreeAdapterTypes,
} from 'parse5';

const REMOVED_ELEMENTS = new Set([
  'applet',
  'base',
  'embed',
  'fencedframe',
  'frame',
  'frameset',
  'foreignobject',
  'iframe',
  'meta',
  'noscript',
  'object',
  'portal',
  'script',
  // SVG animation can rewrite a previously inert href after sanitization.
  'animate',
  'animatemotion',
  'animatetransform',
  'set',
]);

const URL_ATTRIBUTES = new Set([
  'action',
  'archive',
  'background',
  'cite',
  'classid',
  'codebase',
  'data',
  'formaction',
  'href',
  'longdesc',
  'manifest',
  'ping',
  'poster',
  'profile',
  'src',
  'srcdoc',
  'srcset',
  'usemap',
]);

const ALWAYS_REMOVED_ATTRIBUTES = new Set([
  'download',
  'http-equiv',
  'target',
  'xml:base',
]);

const LOCAL_RESOURCE_BASE = new URL('https://qubicl.invalid/selected/document.html');
const IMAGE_DATA_URL = /^data:image\/(?:avif|bmp|gif|jpeg|png|webp|x-icon)(?:;[^,]*)?,/iu;
const MEDIA_DATA_URL = /^data:(?:audio|video)\/(?:mp4|mpeg|ogg|wav|webm)(?:;[^,]*)?,/iu;

type ParentNode = DefaultTreeAdapterTypes.ParentNode;
type ChildNode = DefaultTreeAdapterTypes.ChildNode;
type Element = DefaultTreeAdapterTypes.Element;

/**
 * Convert an active HTML or SVG document into a static rendering.
 *
 * The caller still supplies a response-enforced CSP and iframe sandbox. This
 * transform is the complementary boundary that removes every executable,
 * embedded, submission, and navigation primitive while retaining ordinary
 * markup plus directory-relative passive assets.
 */
export function staticFilePreview(path: string, data: Buffer): Buffer {
  const extension = extname(path).toLowerCase();
  if (extension !== '.html' && extension !== '.htm' && extension !== '.svg') return data;

  const source = data.toString('utf8');
  const root: ParentNode = extension === '.svg' ? parseFragment(source) : parse(source);
  sanitizeChildren(root);
  return Buffer.from(serialize(root), 'utf8');
}

function sanitizeChildren(parent: ParentNode): void {
  const retained: ChildNode[] = [];
  for (const child of parent.childNodes) {
    if (!isElement(child)) {
      retained.push(child);
      continue;
    }
    const tagName = child.tagName.toLowerCase();
    if (REMOVED_ELEMENTS.has(tagName) || (tagName === 'link' && !isStylesheetLink(child))) continue;
    child.attrs = child.attrs.filter((attribute) => keepAttribute(child, attribute));
    sanitizeChildren(child);
    if (tagName === 'template' && 'content' in child) sanitizeChildren(child.content);
    retained.push(child);
  }
  parent.childNodes = retained;
}

function isElement(node: ChildNode): node is Element {
  return 'tagName' in node;
}

function isStylesheetLink(element: Element): boolean {
  const rel = element.attrs.find((attribute) => attribute.name.toLowerCase() === 'rel')?.value;
  if (!rel) return false;
  const tokens = rel.trim().toLowerCase().split(/\s+/u).filter(Boolean);
  return tokens.includes('stylesheet') && tokens.every((token) => token === 'stylesheet' || token === 'alternate');
}

function keepAttribute(element: Element, attribute: Element['attrs'][number]): boolean {
  const name = attribute.name.toLowerCase();
  const qualifiedName = attribute.prefix ? `${attribute.prefix.toLowerCase()}:${name}` : name;
  if (name.startsWith('on') || ALWAYS_REMOVED_ATTRIBUTES.has(name) || ALWAYS_REMOVED_ATTRIBUTES.has(qualifiedName)) {
    return false;
  }
  if (!URL_ATTRIBUTES.has(name)) return true;

  const tagName = element.tagName.toLowerCase();
  if (name === 'src') {
    if (tagName === 'img') return safePassiveUrl(attribute.value, 'image');
    if (tagName === 'audio' || tagName === 'video' || tagName === 'source' || tagName === 'track') {
      return safePassiveUrl(attribute.value, 'media');
    }
    return false;
  }
  if (name === 'poster' && tagName === 'video') return safePassiveUrl(attribute.value, 'image');
  if (name === 'href') {
    if (tagName === 'link') return safePassiveUrl(attribute.value, 'local');
    if (tagName === 'image' || tagName === 'feimage') return safePassiveUrl(attribute.value, 'image');
    if (tagName === 'use' || tagName === 'mpath' || tagName === 'textpath') return safeFragment(attribute.value);
  }
  return false;
}

function safePassiveUrl(value: string, kind: 'image' | 'media' | 'local'): boolean {
  const candidate = value.trim();
  if (!candidate || hasForbiddenUrlCharacter(candidate, true)) return false;
  if (kind === 'image' && IMAGE_DATA_URL.test(candidate)) return true;
  if (kind === 'media' && MEDIA_DATA_URL.test(candidate)) return true;
  if (candidate.startsWith('/') || /^[a-z][a-z0-9+.-]*:/iu.test(candidate)) return false;
  let parsed: URL;
  try { parsed = new URL(candidate, LOCAL_RESOURCE_BASE); }
  catch { return false; }
  return parsed.origin === LOCAL_RESOURCE_BASE.origin
    && parsed.username === ''
    && parsed.password === ''
    && parsed.pathname.startsWith('/selected/');
}

function safeFragment(value: string): boolean {
  const candidate = value.trim();
  return candidate.startsWith('#') && candidate.length > 1 && !hasForbiddenUrlCharacter(candidate, false);
}

function hasForbiddenUrlCharacter(value: string, rejectBackslash: boolean): boolean {
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code <= 0x1f || code === 0x7f || (rejectBackslash && character === '\\')) return true;
  }
  return false;
}
