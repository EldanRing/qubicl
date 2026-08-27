export type BrowserProfileDisclosureOperation =
  | 'upgrade'
  | 'backup'
  | 'checkpoint'
  | 'clone'
  | 'delete'
  | 'restore'
  | 'backup-restore'
  | 'purge';

const PROFILE_PATH = '/home/qubicl/.local/share/qubicl/browser-profile';

const DISCLOSURES: Readonly<Record<BrowserProfileDisclosureOperation, string>> = Object.freeze({
  upgrade: `Durable browser profile: this upgrade preserves the full computer home, including ${PROFILE_PATH} if present. Cookies, site data, history, preferences, and sessions survive the runtime replacement.`,
  backup: `Durable browser profile: this full-home backup includes ${PROFILE_PATH} if present, including cookies, site data, history, preferences, and sessions.`,
  checkpoint: `Durable browser profile: this full-home checkpoint includes ${PROFILE_PATH} if present, including cookies, site data, history, preferences, and sessions.`,
  clone: `Durable browser profile: this full-home clone copies ${PROFILE_PATH} if present, including cookies, site data, history, preferences, and sessions.`,
  delete: `Durable browser profile: recoverable trash retains the full computer home, including ${PROFILE_PATH} if present. Restoring the computer restores that browser state.`,
  restore: `Durable browser profile: restoring this computer restores its full home, including ${PROFILE_PATH} and its prior browser state if present.`,
  'backup-restore': `Durable browser profile: this full-home restore includes ${PROFILE_PATH} and its saved cookies, site data, history, preferences, and sessions if present in the backup.`,
  purge: `Durable browser profile: purge permanently removes the entire trashed home, including ${PROFILE_PATH} if present. Existing backups, clones, and external copies are not removed.`,
});

export function browserProfileDisclosure(operation: BrowserProfileDisclosureOperation): string {
  return DISCLOSURES[operation];
}

export function printBrowserProfileDisclosure(
  operation: BrowserProfileDisclosureOperation,
  write: (message: string) => void = console.log,
): void {
  write(browserProfileDisclosure(operation));
}
