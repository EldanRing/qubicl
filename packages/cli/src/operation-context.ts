import { AsyncLocalStorage } from 'node:async_hooks';

interface OperationContext { root: string; quiet: boolean; locks: Set<string> }
const contexts = new AsyncLocalStorage<OperationContext>();

/** Request-local context; never change process.env or global console in a server. */
export function inHostOperation<T>(root: string, action: () => Promise<T>, quiet = true): Promise<T> {
  if (contexts.getStore()?.root === root) return action();
  return contexts.run({ root, quiet, locks: new Set() }, action);
}
export function operationQuiet(): boolean { return contexts.getStore()?.quiet ?? false; }
export function operationRoot(): string | undefined { return contexts.getStore()?.root; }
export function operationOutput(kind: 'log' | 'warn' | 'error', ...values: unknown[]): void {
  if (!contexts.getStore()?.quiet) console[kind](...values);
}
export function ownsOperationLock(path: string): boolean { return contexts.getStore()?.locks.has(path) ?? false; }
export function inOperationLock<T>(path: string, action: () => Promise<T>): Promise<T> {
  const current = contexts.getStore();
  if (!current) return action();
  return contexts.run({ ...current, locks: new Set([...current.locks, path]) }, action);
}
