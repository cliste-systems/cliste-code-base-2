import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  exportWaitOptionsFromArgv,
  parseCallLogIdFromLatestMarkdown,
} from './sync_latest_call_transcript.js';

describe('exportWaitOptionsFromArgv', () => {
  it('defaults to wait with minCreatedAt filter', () => {
    const before = Date.now();
    const opts = exportWaitOptionsFromArgv([]);
    assert.equal(opts.wait, true);
    assert.ok(Number.isFinite(opts.minCreatedAtMs));
    assert.ok((opts.minCreatedAtMs as number) <= before);
    assert.equal(opts.requireComplete, true);
  });

  it('--no-wait disables wait and freshness filter', () => {
    const opts = exportWaitOptionsFromArgv(['--no-wait']);
    assert.equal(opts.wait, false);
    assert.ok(Number.isNaN(opts.minCreatedAtMs));
  });

  it('--latest --no-wait fetches absolute newest without waiting', () => {
    const opts = exportWaitOptionsFromArgv(['--latest', '--no-wait']);
    assert.equal(opts.wait, false);
    assert.ok(Number.isNaN(opts.minCreatedAtMs));
  });

  it('--latest --wait waits on absolute newest without minCreatedAt', () => {
    const opts = exportWaitOptionsFromArgv(['--latest', '--wait']);
    assert.equal(opts.wait, true);
    assert.ok(Number.isNaN(opts.minCreatedAtMs));
  });

  it('--allow-partial relaxes completeness requirement', () => {
    const opts = exportWaitOptionsFromArgv(['--allow-partial']);
    assert.equal(opts.requireComplete, false);
    assert.equal(opts.allowPartialOnTimeout, true);
  });
});

describe('parseCallLogIdFromLatestMarkdown', () => {
  it('extracts uuid from mirror table row', () => {
    const id = parseCallLogIdFromLatestMarkdown(
      '| Call log ID | 0c959c6d-8c5c-40f6-bedc-3516d3aa880c |\n',
    );
    assert.equal(id, '0c959c6d-8c5c-40f6-bedc-3516d3aa880c');
  });
});
