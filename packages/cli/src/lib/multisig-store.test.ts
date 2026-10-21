import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';

import {
  getMultisigProposal,
  getMultisigProposalsPath,
  listMultisigProposals,
  proposalIdForTxHash,
  removeMultisigProposal,
  upsertMultisigProposal,
} from './multisig-store.js';

let configDir: string;

beforeEach(() => {
  configDir = join(tmpdir(), `sa-cli-multisig-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(configDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(configDir)) {
    rmSync(configDir, { recursive: true, force: true });
  }
});

const proposal = (overrides: Partial<Parameters<typeof upsertMultisigProposal>[0]> = {}) => ({
  id: proposalIdForTxHash('a'.repeat(64)),
  sourceAccount: 'GABC',
  network: 'testnet',
  envelopeXdr: 'AAAA',
  txHash: 'a'.repeat(64),
  ...overrides,
});

describe('multisig-store — proposal tracking', () => {
  it('derives a short id from the transaction hash', () => {
    expect(proposalIdForTxHash('ABCDEF0123456789abcdef')).toBe('abcdef012345');
  });

  it('returns an empty list when nothing was tracked yet', () => {
    expect(listMultisigProposals(configDir)).toEqual([]);
  });

  it('stores a proposal and reads it back', () => {
    const stored = upsertMultisigProposal(proposal(), configDir);

    expect(stored.id).toBe(proposalIdForTxHash('a'.repeat(64)));
    expect(listMultisigProposals(configDir)).toHaveLength(1);
    expect(getMultisigProposal(stored.id, configDir)?.envelopeXdr).toBe('AAAA');
  });

  it('aggregates signatures by replacing the stored envelope', () => {
    const id = proposalIdForTxHash('a'.repeat(64));
    upsertMultisigProposal(proposal({ envelopeXdr: 'FIRST' }), configDir);
    upsertMultisigProposal(proposal({ envelopeXdr: 'SECOND' }), configDir);

    const proposals = listMultisigProposals(configDir);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.envelopeXdr).toBe('SECOND');
    expect(getMultisigProposal(id, configDir)?.envelopeXdr).toBe('SECOND');
  });

  it('keeps the original creation timestamp when a proposal is updated', async () => {
    const id = proposalIdForTxHash('a'.repeat(64));
    const created = upsertMultisigProposal(proposal({ envelopeXdr: 'FIRST' }), configDir);

    await new Promise((resolve) => setTimeout(resolve, 5));
    const updated = upsertMultisigProposal(proposal({ envelopeXdr: 'SECOND' }), configDir);

    expect(updated.createdAt).toBe(created.createdAt);
    expect(updated.updatedAt >= created.updatedAt).toBe(true);
    expect(getMultisigProposal(id, configDir)?.createdAt).toBe(created.createdAt);
  });

  it('removes a proposal', () => {
    const stored = upsertMultisigProposal(proposal(), configDir);

    expect(removeMultisigProposal(stored.id, configDir)).toBe(true);
    expect(listMultisigProposals(configDir)).toEqual([]);
    expect(removeMultisigProposal(stored.id, configDir)).toBe(false);
  });

  it('writes the proposals file inside the config directory', () => {
    upsertMultisigProposal(proposal(), configDir);

    expect(getMultisigProposalsPath(configDir)).toBe(join(configDir, 'multisig-proposals.json'));
    expect(existsSync(getMultisigProposalsPath(configDir))).toBe(true);
  });

  it('survives a corrupted proposals file', () => {
    upsertMultisigProposal(proposal(), configDir);
    writeFileSync(getMultisigProposalsPath(configDir), 'not json', 'utf8');

    expect(listMultisigProposals(configDir)).toEqual([]);
  });
});
