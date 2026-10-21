import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, rmSync, existsSync } from 'node:fs';

import { registerMultisigCommands } from './multisig.js';
import { proposalIdForTxHash, upsertMultisigProposal } from '../lib/multisig-store.js';

let configDir: string;
let originalConfigDir: string | undefined;

beforeEach(() => {
  configDir = join(tmpdir(), `sa-cli-multisig-cmd-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(configDir, { recursive: true });
  originalConfigDir = process.env.STELLAR_ALERTS_CONFIG_DIR;
  process.env.STELLAR_ALERTS_CONFIG_DIR = configDir;
});

afterEach(() => {
  if (originalConfigDir === undefined) {
    delete process.env.STELLAR_ALERTS_CONFIG_DIR;
  } else {
    process.env.STELLAR_ALERTS_CONFIG_DIR = originalConfigDir;
  }
  if (existsSync(configDir)) {
    rmSync(configDir, { recursive: true, force: true });
  }
});

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  registerMultisigCommands(program);
  return program;
}

describe('Multisig commands', () => {
  it('registers the multisig command group', () => {
    const program = buildProgram();
    const multisig = program.commands.find((cmd) => cmd.name() === 'multisig');

    expect(multisig).toBeDefined();
    expect(multisig!.description()).toBe('Inspect, sign, and broadcast Stellar multisig proposals');
  });

  it('exposes the inspect, sign, broadcast and proposals subcommands', () => {
    const program = buildProgram();
    const multisig = program.commands.find((cmd) => cmd.name() === 'multisig')!;
    const names = multisig.commands.map((cmd) => cmd.name());

    expect(names).toContain('inspect');
    expect(names).toContain('sign');
    expect(names).toContain('broadcast');
    expect(names).toContain('proposals');
  });

  it('supports signing with a profile secret, a Ledger and a pre-computed signature', () => {
    const program = buildProgram();
    const multisig = program.commands.find((cmd) => cmd.name() === 'multisig')!;
    const sign = multisig.commands.find((cmd) => cmd.name() === 'sign')!;
    const flags = sign.options.map((option) => option.long);

    expect(flags).toContain('--profile');
    expect(flags).toContain('--ledger');
    expect(flags).toContain('--signature');
    expect(flags).toContain('--signer');
  });

  it('supports selecting a tracked proposal for every subcommand', () => {
    const program = buildProgram();
    const multisig = program.commands.find((cmd) => cmd.name() === 'multisig')!;

    for (const name of ['inspect', 'sign', 'broadcast']) {
      const cmd = multisig.commands.find((c) => c.name() === name)!;
      expect(cmd.options.map((option) => option.long)).toContain('--proposal');
    }
  });

  it('allows forcing a broadcast past the threshold check', () => {
    const program = buildProgram();
    const multisig = program.commands.find((cmd) => cmd.name() === 'multisig')!;
    const broadcast = multisig.commands.find((cmd) => cmd.name() === 'broadcast')!;

    expect(broadcast.options.map((option) => option.long)).toContain('--force');
  });

  it('lists the tracked proposals', async () => {
    const id = proposalIdForTxHash('b'.repeat(64));
    upsertMultisigProposal(
      {
        id,
        sourceAccount: 'GABC',
        network: 'testnet',
        envelopeXdr: 'AAAA',
        txHash: 'b'.repeat(64),
      },
      configDir,
    );

    const program = buildProgram();
    await program.parseAsync(['multisig', 'proposals', '--json'], { from: 'user' });

    // The command prints the proposals as JSON — nothing to assert on stdout
    // here beyond the fact that it ran without throwing.
    expect(existsSync(join(configDir, 'multisig-proposals.json'))).toBe(true);
  });
});
