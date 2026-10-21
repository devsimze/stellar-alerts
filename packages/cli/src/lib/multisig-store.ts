/**
 * Multisig proposal store (#722).
 *
 * Keeps the multisig envelopes the CLI has seen on disk so that signatures can
 * be aggregated across invocations: a signer runs `multisig sign`, the updated
 * envelope is stored, and the next signer runs `multisig sign` again on the
 * same proposal — the collected weight grows until the threshold is met and
 * the envelope can be broadcast.
 *
 * File written:
 *   <configDir>/multisig-proposals.json
 *
 * The config directory defaults to ~/.config/stellar-alerts/ and can be
 * overridden with STELLAR_ALERTS_CONFIG_DIR.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

import { getConfigDir } from './profile-store.js';

export interface StoredMultisigProposal {
  /** Short, stable identifier derived from the transaction hash. */
  id: string;
  /** Account that must sign (the multisig treasury account). */
  sourceAccount: string;
  /** Network the envelope was built for (`testnet`, `mainnet`, …). */
  network: string;
  /** Base64 transaction envelope XDR, including every signature collected so far. */
  envelopeXdr: string;
  /** Hex transaction hash — stable across signature additions. */
  txHash: string;
  /** ISO timestamp of the first time the proposal was stored. */
  createdAt: string;
  /** ISO timestamp of the last update. */
  updatedAt: string;
}

const PROPOSALS_FILE = 'multisig-proposals.json';

/** Derives the short proposal id from a hex transaction hash. */
export function proposalIdForTxHash(txHash: string): string {
  return txHash.slice(0, 12).toLowerCase();
}

export function getMultisigProposalsPath(configDir?: string): string {
  return join(configDir ?? getConfigDir(), PROPOSALS_FILE);
}

function readProposalsFile(configDir?: string): StoredMultisigProposal[] {
  const path = getMultisigProposalsPath(configDir);
  if (!existsSync(path)) return [];

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is StoredMultisigProposal =>
        !!entry && typeof entry.id === 'string' && typeof entry.envelopeXdr === 'string',
    );
  } catch {
    // A corrupted store must never crash the CLI — treat it as empty.
    return [];
  }
}

function writeProposalsFile(
  proposals: StoredMultisigProposal[],
  configDir?: string,
): void {
  const dir = configDir ?? getConfigDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const path = getMultisigProposalsPath(dir);
  writeFileSync(path, JSON.stringify(proposals, null, 2), { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best effort — some filesystems do not support chmod.
  }
}

/** Returns every stored proposal, newest first. */
export function listMultisigProposals(configDir?: string): StoredMultisigProposal[] {
  return readProposalsFile(configDir).sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt),
  );
}

/** Returns a single proposal by id, or undefined when it is not tracked. */
export function getMultisigProposal(
  id: string,
  configDir?: string,
): StoredMultisigProposal | undefined {
  return readProposalsFile(configDir).find((p) => p.id === id);
}

/**
 * Inserts or updates a proposal. Signatures are aggregated by replacing the
 * stored envelope with the latest one, so the caller must pass the envelope
 * that already contains every previously collected signature.
 */
export function upsertMultisigProposal(
  proposal: Omit<StoredMultisigProposal, 'createdAt' | 'updatedAt'> & {
    createdAt?: string;
  },
  configDir?: string,
): StoredMultisigProposal {
  const proposals = readProposalsFile(configDir);
  const now = new Date().toISOString();
  const index = proposals.findIndex((p) => p.id === proposal.id);

  if (index >= 0) {
    const existing = proposals[index]!;
    const updated: StoredMultisigProposal = {
      ...existing,
      ...proposal,
      createdAt: existing.createdAt,
      updatedAt: now,
    };
    proposals[index] = updated;
    writeProposalsFile(proposals, configDir);
    return updated;
  }

  const created: StoredMultisigProposal = {
    ...proposal,
    createdAt: proposal.createdAt ?? now,
    updatedAt: now,
  };
  proposals.push(created);
  writeProposalsFile(proposals, configDir);
  return created;
}

/** Removes a proposal. Returns true when something was deleted. */
export function removeMultisigProposal(id: string, configDir?: string): boolean {
  const proposals = readProposalsFile(configDir);
  const remaining = proposals.filter((p) => p.id !== id);
  if (remaining.length === proposals.length) return false;
  writeProposalsFile(remaining, configDir);
  return true;
}
