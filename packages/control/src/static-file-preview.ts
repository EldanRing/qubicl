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

export interface StaticPreviewAsset {
  data: Buffer;
  mimeType: string;
}

export type StaticPreviewAssetReader = (
  relativePath: string,
  kind: 'stylesheet' | 'image' | 'media',
) => Promise<StaticPreviewAsset | undefined>;

export interface StaticPreviewBundleOptions {
  interactiveSource?: Buffer;
}

export const STATIC_FILE_PREVIEW_CSP = [
  'sandbox',
  "default-src 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "form-action 'none'",
  "connect-src 'none'",
  "img-src data:",
  "media-src data:",
  "font-src data:",
  "style-src 'unsafe-inline'",
  "script-src 'none'",
  "worker-src 'none'",
  "manifest-src 'none'",
].join('; ');

const STATIC_EMBEDDED_FILE_PREVIEW_CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "form-action 'none'",
  "connect-src 'none'",
  'img-src data:',
  'media-src data:',
  'font-src data:',
  "style-src 'unsafe-inline'",
  "script-src 'none'",
  "worker-src 'none'",
  "manifest-src 'none'",
].join('; ');

const INTERACTIVE_EMBEDDED_FILE_PREVIEW_CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "form-action 'none'",
  "script-src 'unsafe-inline' data: blob: http: https:",
  'connect-src http: https: ws: wss:',
  'img-src data: blob: http: https:',
  'media-src data: blob: http: https:',
  'font-src data: http: https:',
  "style-src 'unsafe-inline' http: https:",
  'worker-src data: blob:',
  'manifest-src http: https:',
].join('; ');

export const INTERACTIVE_CONSENT_FILE_PREVIEW_CSP = [
  'sandbox allow-scripts',
  "default-src 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-src 'self' data: blob:",
  "child-src 'self' data: blob:",
  "form-action 'none'",
  "script-src 'unsafe-inline' data: blob: http: https:",
  'connect-src http: https: ws: wss:',
  'img-src data: blob: http: https:',
  'media-src data: blob: http: https:',
  'font-src data: http: https:',
  "style-src 'unsafe-inline' http: https:",
  'worker-src data: blob:',
  'manifest-src http: https:',
].join('; ');

const INTERACTIVE_PREVIEW_BOOTSTRAP = `(()=>{const frame=document.getElementById('qubicl-preview-frame');const button=document.getElementById('qubicl-run-interactive');const source=document.getElementById('qubicl-interactive-source');const notice=document.getElementById('qubicl-interactive-notice');if(!(frame instanceof HTMLIFrameElement)||!(button instanceof HTMLButtonElement)||!(source instanceof HTMLTemplateElement)||!(notice instanceof HTMLElement))return;const expire=()=>{source.removeAttribute('data-source');button.disabled=true;button.textContent='Interactive preview expired';notice.textContent='Reopen the file to review and run it.'};const timer=setTimeout(expire,300000);button.addEventListener('click',()=>{const encoded=source.getAttribute('data-source');if(!encoded)return;const binary=atob(encoded);const bytes=Uint8Array.from(binary,char=>char.charCodeAt(0));frame.setAttribute('sandbox','allow-scripts');frame.title='Trusted interactive file preview';frame.srcdoc=new TextDecoder().decode(bytes);source.removeAttribute('data-source');clearTimeout(timer);notice.remove()},{once:true})})();`;

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

/**
 * Build a self-contained static document for clients that proxy Qubicl through
 * their own origin. Passive local assets are embedded so the browser never has
 * to reach a Qubicl host/port directly or reuse the client's authenticated
 * origin for subresource requests.
 */
export async function staticFilePreviewBundle(
  path: string,
  data: Buffer,
  readAsset: StaticPreviewAssetReader,
  options: StaticPreviewBundleOptions = {},
): Promise<Buffer> {
  const extension = extname(path).toLowerCase();
  if (extension !== '.html' && extension !== '.htm' && extension !== '.svg') return data;

  const source = data.toString('utf8');
  const root: ParentNode = extension === '.svg' ? parseFragment(source) : parse(source);
  sanitizeChildren(root);
  await inlineAssets(root, readAsset);
  const safe = serialize(root);
  if (options.interactiveSource && extension !== '.svg') {
    return interactiveConsentBundle(safe, options.interactiveSource);
  }
  return Buffer.from(safe, 'utf8');
}

export function hasExecutablePreviewContent(path: string, data: Buffer): boolean {
  const extension = extname(path).toLowerCase();
  if (extension !== '.html' && extension !== '.htm') return false;
  const root = parse(data.toString('utf8'));
  return hasExecutableNode(root);
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

async function inlineAssets(parent: ParentNode, readAsset: StaticPreviewAssetReader): Promise<void> {
  const retained: ChildNode[] = [];
  for (const child of parent.childNodes) {
    if (!isElement(child)) {
      retained.push(child);
      continue;
    }
    const tagName = child.tagName.toLowerCase();
    if (tagName === 'link') {
      const href = attribute(child, 'href');
      const relativePath = href ? localAssetPath(href.value) : undefined;
      const asset = relativePath ? await readAsset(relativePath, 'stylesheet') : undefined;
      if (asset && asset.mimeType === 'text/css') {
        const replacement = styleElement(asset.data.toString('utf8'));
        if (replacement) {
          replacement.parentNode = parent;
          retained.push(replacement);
        }
      }
      continue;
    }

    await inlineAttribute(child, 'src', assetKindForSource(tagName), readAsset);
    if (tagName === 'video') await inlineAttribute(child, 'poster', 'image', readAsset);
    if (tagName === 'image' || tagName === 'feimage') await inlineAttribute(child, 'href', 'image', readAsset);
    await inlineAssets(child, readAsset);
    if (tagName === 'template' && 'content' in child) await inlineAssets(child.content, readAsset);
    retained.push(child);
  }
  parent.childNodes = retained;
}

async function inlineAttribute(
  element: Element,
  name: string,
  kind: 'image' | 'media' | undefined,
  readAsset: StaticPreviewAssetReader,
): Promise<void> {
  if (!kind) return;
  const value = attribute(element, name);
  if (!value || /^(?:data:|#)/iu.test(value.value.trim())) return;
  const relativePath = localAssetPath(value.value);
  const asset = relativePath ? await readAsset(relativePath, kind) : undefined;
  if (!asset || !allowedAssetMimeType(asset.mimeType, kind)) {
    element.attrs = element.attrs.filter((candidate) => candidate !== value);
    return;
  }
  value.value = `data:${asset.mimeType};base64,${asset.data.toString('base64')}`;
}

function assetKindForSource(tagName: string): 'image' | 'media' | undefined {
  if (tagName === 'img') return 'image';
  if (tagName === 'audio' || tagName === 'video' || tagName === 'source' || tagName === 'track') return 'media';
  return undefined;
}

function allowedAssetMimeType(value: string, kind: 'image' | 'media'): boolean {
  if (kind === 'image') return /^image\/(?:avif|bmp|gif|jpeg|png|webp|x-icon)$/u.test(value);
  return /^(?:audio|video)\/(?:mp4|mpeg|ogg|wav|webm)$/u.test(value) || value === 'text/vtt';
}

function attribute(element: Element, name: string): Element['attrs'][number] | undefined {
  return element.attrs.find((candidate) => candidate.name.toLowerCase() === name);
}

function styleElement(css: string): Element | undefined {
  const safeCss = css.replace(/<\/style/giu, '<\\/style');
  return parseFragment(`<style>${safeCss}</style>`).childNodes.find(isElement);
}

function interactiveConsentBundle(safe: string, interactiveSource: Buffer): Buffer {
  const safeDocument = addDocumentPolicy(safe, STATIC_EMBEDDED_FILE_PREVIEW_CSP);
  const interactiveDocument = addDocumentPolicy(interactiveSource.toString('utf8'), INTERACTIVE_EMBEDDED_FILE_PREVIEW_CSP);
  const encodedSource = Buffer.from(interactiveDocument, 'utf8').toString('base64');
  return Buffer.from(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Qubicl file preview</title><style>html,body{width:100%;height:100%;margin:0;overflow:hidden;background:#111}#qubicl-preview-frame{display:block;width:100%;height:100%;border:0;background:white}#qubicl-interactive-notice{position:fixed;z-index:2147483647;top:12px;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:12px;max-width:min(760px,calc(100% - 24px));box-sizing:border-box;padding:10px 12px;border:1px solid #d7a52a;border-radius:10px;background:#fff8dc;color:#372b0b;font:500 13px/1.35 system-ui,sans-serif;box-shadow:0 6px 24px #0003}#qubicl-run-interactive{white-space:nowrap;padding:7px 10px;border:0;border-radius:7px;background:#167c54;color:white;font:700 13px/1 system-ui,sans-serif;cursor:pointer}#qubicl-run-interactive:disabled{background:#777;cursor:not-allowed}.qubicl-warning{color:#6b5315;font-size:12px}</style></head><body><iframe id="qubicl-preview-frame" title="Safe static file preview" sandbox="" referrerpolicy="no-referrer" srcdoc="${escapeAttribute(safeDocument)}"></iframe><aside id="qubicl-interactive-notice" data-qubicl-interactive-preview="true"><span>Interactive code is paused in this safe preview.</span><button id="qubicl-run-interactive" type="button">Run interactive preview</button><span class="qubicl-warning">Trusted content only: it may contact external services using this browser, outside Qubicl's computer network policy.</span></aside><template id="qubicl-interactive-source" data-source="${encodedSource}"></template><script>${INTERACTIVE_PREVIEW_BOOTSTRAP}</script></body></html>`, 'utf8');
}

function addDocumentPolicy(source: string, policy: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(policy)}">`;
  const doctype = source.match(/^\uFEFF?\s*<!doctype[^>]*>/iu)?.[0];
  return doctype ? `${doctype}${meta}${source.slice(doctype.length)}` : `${meta}${source}`;
}

function hasExecutableNode(parent: ParentNode): boolean {
  for (const child of parent.childNodes) {
    if (!isElement(child)) continue;
    if (child.tagName.toLowerCase() === 'script'
      || child.attrs.some(({ name }) => name.toLowerCase().startsWith('on'))) return true;
    if (hasExecutableNode(child)) return true;
    if (child.tagName.toLowerCase() === 'template' && 'content' in child && hasExecutableNode(child.content)) return true;
  }
  return false;
}

function escapeAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
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
  return localAssetPath(candidate) !== undefined;
}

function localAssetPath(value: string): string | undefined {
  let parsed: URL;
  try { parsed = new URL(value.trim(), LOCAL_RESOURCE_BASE); }
  catch { return undefined; }
  if (parsed.origin !== LOCAL_RESOURCE_BASE.origin || parsed.username || parsed.password
    || !parsed.pathname.startsWith('/selected/')) return undefined;
  const encoded = parsed.pathname.slice('/selected/'.length);
  if (!encoded) return undefined;
  let decoded: string;
  try { decoded = decodeURIComponent(encoded); }
  catch { return undefined; }
  if (!decoded || decoded.startsWith('/') || decoded.includes('\\')
    || decoded.split('/').some((part) => !part || part === '.' || part === '..' || part.includes('/'))) return undefined;
  return decoded;
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
