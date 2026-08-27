import type { ImageIdentity } from '@qubicl/core';

export interface ImageAcquisitionTarget {
  consumer: string;
  image: Pick<ImageIdentity, 'requested' | 'resolved'>;
  catalogDownloadBytes: number | null;
  catalogExpandedBytes: number | null;
}

export interface ImageAcquisitionTargetEstimate {
  exactTarget: string;
  consumers: string[];
  requestedReferences: string[];
  present: boolean;
  catalog: {
    downloadBytes: number | null;
    expandedBytes: number | null;
  };
  acquisition: {
    basis: 'already-present-exact-target' | 'catalog-full-acquisition-upper-bound';
    downloadBytes: number | null;
    expandedBytes: number | null;
  };
}

export interface ImageAcquisitionEstimate {
  basis: 'deduplicated-conservative-full-acquisition-upper-bound';
  targets: ImageAcquisitionTargetEstimate[];
  downloadBytes: number | null;
  expandedBytes: number | null;
}

/**
 * Models only the bytes attributable to acquiring exact image targets. Catalog
 * sizes intentionally remain whole-image upper bounds: this pure model neither
 * assumes registry cross-image layer reuse nor guesses Docker storage overhead.
 */
export function estimateImageAcquisition(
  targets: readonly ImageAcquisitionTarget[],
  presentExactTargets: ReadonlySet<string>,
): ImageAcquisitionEstimate {
  const unique = new Map<string, {
    consumers: Set<string>;
    requestedReferences: Set<string>;
    downloadBytes: number | null;
    expandedBytes: number | null;
  }>();

  for (const target of targets) {
    assertNonempty(target.consumer, 'Image acquisition consumer');
    assertNonempty(target.image.requested, 'Requested image reference');
    assertNonempty(target.image.resolved, 'Exact image target');
    assertBytes(target.catalogDownloadBytes, 'Catalog download size');
    assertBytes(target.catalogExpandedBytes, 'Catalog expanded size');
    const existing = unique.get(target.image.resolved);
    if (existing) {
      if (existing.downloadBytes !== target.catalogDownloadBytes
        || existing.expandedBytes !== target.catalogExpandedBytes) {
        throw new Error(`Exact image target ${target.image.resolved} has conflicting catalog sizes.`);
      }
      existing.consumers.add(target.consumer);
      existing.requestedReferences.add(target.image.requested);
      continue;
    }
    unique.set(target.image.resolved, {
      consumers: new Set([target.consumer]),
      requestedReferences: new Set([target.image.requested]),
      downloadBytes: target.catalogDownloadBytes,
      expandedBytes: target.catalogExpandedBytes,
    });
  }

  const estimates = [...unique.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([exactTarget, target]): ImageAcquisitionTargetEstimate => {
      const present = presentExactTargets.has(exactTarget);
      return {
        exactTarget,
        consumers: [...target.consumers].sort(),
        requestedReferences: [...target.requestedReferences].sort(),
        present,
        catalog: {
          downloadBytes: target.downloadBytes,
          expandedBytes: target.expandedBytes,
        },
        acquisition: present
          ? {
              basis: 'already-present-exact-target',
              downloadBytes: 0,
              expandedBytes: 0,
            }
          : {
              basis: 'catalog-full-acquisition-upper-bound',
              downloadBytes: target.downloadBytes,
              expandedBytes: target.expandedBytes,
            },
      };
    });

  return {
    basis: 'deduplicated-conservative-full-acquisition-upper-bound',
    targets: estimates,
    downloadBytes: total(estimates.map(({ acquisition }) => acquisition.downloadBytes)),
    expandedBytes: total(estimates.map(({ acquisition }) => acquisition.expandedBytes)),
  };
}

function total(values: Array<number | null>): number | null {
  if (values.some((value) => value === null)) return null;
  return values.reduce<number>((sum, value) => {
    const next = sum + (value ?? 0);
    if (!Number.isSafeInteger(next)) throw new Error('Image acquisition byte total exceeds safe-integer precision.');
    return next;
  }, 0);
}

function assertBytes(value: number | null, label: string): void {
  if (value !== null && (!Number.isSafeInteger(value) || value < 0)) {
    throw new Error(`${label} must be a non-negative safe integer or null.`);
  }
}

function assertNonempty(value: string, label: string): void {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be non-empty.`);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
