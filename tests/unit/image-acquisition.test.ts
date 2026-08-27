import assert from 'node:assert/strict';
import test from 'node:test';
import {
  estimateImageAcquisition,
  type ImageAcquisitionTarget,
} from '../../packages/cli/dist/image-acquisition.js';

test('acquisition estimates deduplicate exact targets and retain conservative catalog bounds', () => {
  const gateway = exactReference('gateway');
  const shared = exactReference('shared-computer');
  const present = exactReference('present');
  const unknown = exactReference('unknown');
  const targets: ImageAcquisitionTarget[] = [
    target('gateway', 'example/gateway:1', gateway, 10, 20),
    target('browser', 'example/browser:1', shared, 30, 40),
    target('computer', 'example/computer:1', shared, 30, 40),
    target('workstation', 'example/workstation:1', present, null, null),
    target('file-system', 'example/file-system:1', unknown, null, 50),
  ];

  const estimate = estimateImageAcquisition(targets, new Set([
    present,
    'example/gateway:1', // A requested tag is not the exact resolved target.
  ]));

  assert.equal(estimate.basis, 'deduplicated-conservative-full-acquisition-upper-bound');
  assert.equal(estimate.targets.length, 4);
  assert.equal(estimate.downloadBytes, null, 'an unknown missing download remains unknown');
  assert.equal(estimate.expandedBytes, 110);

  const sharedEstimate = estimate.targets.find(({ exactTarget }) => exactTarget === shared)!;
  assert.deepEqual(sharedEstimate.consumers, ['browser', 'computer']);
  assert.deepEqual(sharedEstimate.requestedReferences, ['example/browser:1', 'example/computer:1']);
  assert.deepEqual(sharedEstimate.acquisition, {
    basis: 'catalog-full-acquisition-upper-bound',
    downloadBytes: 30,
    expandedBytes: 40,
  });

  const presentEstimate = estimate.targets.find(({ exactTarget }) => exactTarget === present)!;
  assert.deepEqual(presentEstimate.catalog, { downloadBytes: null, expandedBytes: null });
  assert.deepEqual(presentEstimate.acquisition, {
    basis: 'already-present-exact-target',
    downloadBytes: 0,
    expandedBytes: 0,
  });

  const gatewayEstimate = estimate.targets.find(({ exactTarget }) => exactTarget === gateway)!;
  assert.equal(gatewayEstimate.present, false);
  assert.equal(gatewayEstimate.acquisition.downloadBytes, 10);
});

test('acquisition estimates reject conflicting duplicate sizes and invalid inputs', () => {
  const exact = exactReference('same');
  assert.throws(() => estimateImageAcquisition([
    target('browser', 'example/browser:1', exact, 10, 20),
    target('computer', 'example/computer:1', exact, 11, 20),
  ], new Set()), /conflicting catalog sizes/);

  assert.throws(() => estimateImageAcquisition([
    target('gateway', 'example/gateway:1', exact, -1, 20),
  ], new Set()), /non-negative safe integer or null/);
  assert.throws(() => estimateImageAcquisition([
    target('', 'example/gateway:1', exact, 10, 20),
  ], new Set()), /consumer must be non-empty/);

  assert.deepEqual(estimateImageAcquisition([], new Set()), {
    basis: 'deduplicated-conservative-full-acquisition-upper-bound',
    targets: [],
    downloadBytes: 0,
    expandedBytes: 0,
  });
});

function target(
  consumer: string,
  requested: string,
  resolved: string,
  catalogDownloadBytes: number | null,
  catalogExpandedBytes: number | null,
): ImageAcquisitionTarget {
  return {
    consumer,
    image: { requested, resolved },
    catalogDownloadBytes,
    catalogExpandedBytes,
  };
}

function exactReference(label: string): string {
  return `example/${label}@sha256:${label.charCodeAt(0).toString(16).padStart(2, '0').repeat(32)}`;
}
