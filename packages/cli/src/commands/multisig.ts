/**
 * Multisig proposal commands for the Stellar Alerts CLI (#722).
 *
 * Command tree:
 *   multisig inspect   – inspect a proposal envelope: signers, weights, threshold status
 *   multisig sign      – sign a proposal with a local key, a profile secret or a Ledger
 *   multisig broadcast  – submit an envelope to Horizon once the threshold is met
 *   multisig proposals  – list the proposals tracked on this machine
 *
 * Signatures are aggregated through a local proposal store
 * (<configDir>/multisig-proposals.json): every signer signs the same proposal
 * id, and the envelope keeps growing until the collected weight reaches the
 * account's threshold.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import * as fs from 'fs';
import * as readline from 'readline';
import * as StellarSdk from 'stellar-sdk';
import {
  createProfileStore,
  getActiveProfileName,
  getProfile,
  getSecret,
  listSecretKeys,
} from '../lib/profile-store.js';
import { DEFAULT_BIP32_PATH, LedgerStellarApp, openLedgerStellarApp, signWithLedger } from '../lib/ledger.js';
import {
  parseMultisigProposal,
  addSignatureToEnvelope,
  addPrecomputedSignature,
  submitMultisigEnvelope,
  parseEnvelope,
  type ParsedMultisigProposal,
} from '../lib/multisig-builder.js';
import {
  getMultisigProposal,
  listMultisigProposals,
  proposalIdForTxHash,
  upsertMultisigProposal,
} from '../lib/multisig-store.js';

/** Vault key that holds the Stellar signing secret of a profile. */
const SIGNING_SECRET_KEY = 'signingSecret';

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

/**
 * Prompts the user for a secret without echoing it to the terminal.
 * Falls back to visible input when stdin is not a TTY (CI / piped usage).
 */
function promptSecret(question: string): Promise<string> {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer);
      });
      return;
    }

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });

    process.stdout.write(question);
    (process.stdin as any).setRawMode?.(true);
    process.stdin.resume();

    let input = '';

    const cleanup = () => {
      (process.stdin as any).setRawMode?.(false);
      process.stdin.pause();
      process.stdin.removeListener('data', onData);
      rl.close();
    };

    const onData = (char: Buffer) => {
      const c = char.toString();
      if (c === '\r' || c === '\n') {
        process.stdout.write('\n');
        cleanup();
        resolve(input);
      } else if (c === '\u0003') {
        process.stdout.write('\n');
        cleanup();
        process.exit(1);
      } else if (c === '\u007f' || c === '\b') {
        if (input.length > 0) input = input.slice(0, -1);
      } else {
        input += c;
      }
    };

    process.stdin.on('data', onData);
  });
}

function resolvePassphrase(network?: string): string {
  const value = (network ?? 'testnet').toLowerCase();
  if (value === 'public' || value === 'mainnet') return StellarSdk.Networks.PUBLIC;
  if (value === 'testnet') return StellarSdk.Networks.TESTNET;
  if (value === 'futurenet') return StellarSdk.Networks.FUTURENET;
  // Allow a raw passphrase for private networks.
  return network as string;
}

function resolveHorizonUrl(passphrase: string, override?: string): string {
  if (override) return override;
  if (process.env.STELLAR_HORIZON_URL) return process.env.STELLAR_HORIZON_URL;
  return passphrase === StellarSdk.Networks.PUBLIC
    ? 'https://horizon.stellar.org'
    : 'https://horizon-testnet.stellar.org';
}

/** Loads the source account from Horizon so signers and thresholds are known. */
async function loadAccount(
  accountId: string,
  horizonUrl: string,
): Promise<any> {
  const server = new (StellarSdk as any).Server(horizonUrl);
  return server.loadAccount(accountId);
}

function displayProposal(proposal: ParsedMultisigProposal): void {
  console.log(chalk.bold.blue('\n🔐 Multisig Proposal'));
  console.log(chalk.gray('─'.repeat(60)));
  console.log(chalk.white(`TX Hash: ${proposal.txHash}`));
  console.log(chalk.white(`Source:  ${proposal.sourceAccount}`));
  console.log(chalk.white(`Fee:     ${proposal.fee} stroops`));
  console.log(chalk.white(`Seq:     ${proposal.sequence}`));
  console.log(chalk.white(`Ops:     ${proposal.operationCount}`));
  console.log(chalk.white(`Threshold level: ${proposal.thresholdLevel}`));
  console.log(chalk.white(`Required threshold: ${proposal.requiredThreshold}`));
  console.log(chalk.white(`Collected weight:   ${proposal.collectedWeight}`));
  console.log(chalk.white(`Remaining weight:   ${proposal.remainingWeight}`));
  console.log(chalk.gray('─'.repeat(60)));
  console.log(chalk.bold('Signers:'));
  for (const s of proposal.signers) {
    const collected = proposal.collectedSigners.find((c) => c.key === s.key);
    const marker = collected ? chalk.green('✓') : chalk.gray('○');
    console.log(`  ${marker} ${s.key} (weight: ${s.weight})`);
  }
  console.log(chalk.gray('─'.repeat(60)));
  if (proposal.thresholdMet) {
    console.log(chalk.green('✅ Threshold met — ready to broadcast'));
  } else {
    console.log(chalk.yellow(`⏳ Need ${proposal.remainingWeight} more weight`));
  }
  console.log();
}

/** Resolves the envelope to work on: either `--xdr` or a stored `--proposal`. */
function resolveEnvelope(
  xdr: string | undefined,
  proposalId: string | undefined,
): { envelopeXdr: string; proposalId?: string } {
  if (xdr) return { envelopeXdr: xdr.trim() };
  if (proposalId) {
    const stored = getMultisigProposal(proposalId);
    if (!stored) {
      throw new Error(`Proposal '${proposalId}' not found. Run 'multisig proposals' to list tracked proposals.`);
    }
    return { envelopeXdr: stored.envelopeXdr, proposalId: stored.id };
  }
  throw new Error('Provide --xdr <xdr> or --proposal <id>');
}

export function registerMultisigCommands(program: Command): void {
  const multisig = program
    .command('multisig')
    .description('Inspect, sign, and broadcast Stellar multisig proposals');

  // -------------------------------------------------------------------------
  // inspect
  // -------------------------------------------------------------------------
  multisig
    .command('inspect')
    .description('Inspect a pending multisig proposal from an envelope XDR')
    .option('-x, --xdr <xdr>', 'Transaction envelope XDR (base64)')
    .option('-i, --proposal <id>', 'Tracked proposal id (see: multisig proposals)')
    .option('-n, --network <network>', 'Network passphrase or name', 'testnet')
    .option('-u, --horizon <url>', 'Horizon URL to fetch account signers/thresholds')
    .option('-a, --account <publicKey>', 'Treasury/source account (auto-detected from XDR if omitted)')
    .action(async (opts) => {
      try {
        const passphrase = resolvePassphrase(opts.network);
        const { envelopeXdr } = resolveEnvelope(opts.xdr, opts.proposal);

        // Determine the source account from the envelope when not given.
        let accountPubkey = opts.account;
        if (!accountPubkey) {
          const tx: any = parseEnvelope(envelopeXdr, passphrase);
          accountPubkey = ('innerTransaction' in tx) ? tx.innerTransaction.source : tx.source;
        }

        if (!accountPubkey) {
          throw new Error('Could not determine source account; provide --account');
        }

        const horizonUrl = resolveHorizonUrl(passphrase, opts.horizon);
        const account = await loadAccount(accountPubkey, horizonUrl);

        const proposal = parseMultisigProposal(envelopeXdr, account, passphrase);
        displayProposal(proposal);

        console.log(chalk.gray('Envelope XDR:'));
        console.log(proposal.envelopeXdr);
      } catch (error) {
        console.error(chalk.red(`❌ ${(error as Error).message}`));
        process.exit(1);
      }
    });

  // -------------------------------------------------------------------------
  // sign
  // -------------------------------------------------------------------------
  multisig
    .command('sign')
    .description('Sign a multisig proposal with a local key, a profile secret or a Ledger')
    .option('-x, --xdr <xdr>', 'Transaction envelope XDR (base64)')
    .option('-i, --proposal <id>', 'Tracked proposal id to sign (see: multisig proposals)')
    .option('-n, --network <network>', 'Network passphrase or name', 'testnet')
    .option('-s, --secret <secret>', 'Secret key (S...) to sign with')
    .option('--profile <name>', 'Profile whose vault secret should sign the envelope')
    .option('--secret-key <key>', `Vault key holding the signing secret (default: ${SIGNING_SECRET_KEY})`)
    .option('--password <password>', 'Vault password (non-interactive use)')
    .option('-p, --path <bip32>', 'Ledger BIP32 path', DEFAULT_BIP32_PATH)
    .option('--ledger', 'Sign with Ledger hardware wallet')
    .option('--signer <publicKey>', 'Public key of the signer (required with --signature)')
    .option('--signature <base64>', 'Pre-computed signature for air-gapped signing')
    .option('-o, --out <file>', 'Write updated signed XDR to file')
    .option('--save', 'Store the signed envelope in the local proposal store')
    .action(async (opts) => {
      try {
        const passphrase = resolvePassphrase(opts.network);
        const { envelopeXdr, proposalId } = resolveEnvelope(opts.xdr, opts.proposal);

        let signedXdr: string;
        let signerPublicKey: string | undefined;

        if (opts.signature) {
          if (!opts.signer) {
            throw new Error('--signature requires --signer <publicKey>');
          }
          signedXdr = addPrecomputedSignature(
            envelopeXdr,
            passphrase,
            opts.signer,
            opts.signature,
          );
          signerPublicKey = opts.signer;
        } else if (opts.ledger) {
          const app: LedgerStellarApp = await openLedgerStellarApp();
          try {
            const tx: any = parseEnvelope(envelopeXdr, passphrase);
            const result = await signWithLedger(app, tx, opts.path);
            signedXdr = result.signedXdr;
            signerPublicKey = result.signerPublicKey;
          } finally {
            await app.close().catch(() => undefined);
          }
        } else if (opts.secret) {
          const keypair = StellarSdk.Keypair.fromSecret(opts.secret);
          const result = addSignatureToEnvelope(envelopeXdr, passphrase, keypair);
          signedXdr = result.signedXdr;
          signerPublicKey = keypair.publicKey();
        } else if (opts.profile) {
          const store = createProfileStore();
          const profile = getProfile(store, opts.profile);
          const secretKey = opts.secretKey ?? SIGNING_SECRET_KEY;
          const password = opts.password ?? (await promptSecret(`Vault password for '${profile.name}': `));
          const secret = await getSecret(store, profile.name, secretKey, password);
          if (!secret) {
            throw new Error(
              `No '${secretKey}' secret stored for profile '${profile.name}'. ` +
                `Store it with: stellar-alerts-cli profile secret set ${secretKey} --profile ${profile.name}`,
            );
          }
          const keypair = StellarSdk.Keypair.fromSecret(secret);
          const result = addSignatureToEnvelope(envelopeXdr, passphrase, keypair);
          signedXdr = result.signedXdr;
          signerPublicKey = keypair.publicKey();
        } else {
          const secret = await promptSecret('Enter secret key (S...): ');
          const keypair = StellarSdk.Keypair.fromSecret(secret.trim());
          const result = addSignatureToEnvelope(envelopeXdr, passphrase, keypair);
          signedXdr = result.signedXdr;
          signerPublicKey = keypair.publicKey();
        }

        if (signerPublicKey) {
          console.log(chalk.green(`✅ Signed by ${signerPublicKey}`));
        }

        if (opts.out) {
          fs.writeFileSync(opts.out, signedXdr + '\n', 'utf8');
          console.log(chalk.green(`Signed XDR written to ${opts.out}`));
        } else {
          console.log(signedXdr);
        }

        // Persist the envelope so the next signer can aggregate onto it.
        if (opts.save || proposalId) {
          const envelope: any = parseEnvelope(signedXdr, passphrase);
          const tx: any = ('innerTransaction' in envelope) ? envelope.innerTransaction : envelope;
          const txHash = envelope.hash().toString('hex');
          const id = proposalId ?? proposalIdForTxHash(txHash);
          upsertMultisigProposal({
            id,
            sourceAccount: tx.source,
            network: opts.network ?? 'testnet',
            envelopeXdr: signedXdr,
            txHash,
          });
          console.log(chalk.gray(`Proposal ${id} updated in the local store.`));
        }
      } catch (error) {
        console.error(chalk.red(`❌ ${(error as Error).message}`));
        process.exit(1);
      }
    });

  // -------------------------------------------------------------------------
  // broadcast
  // -------------------------------------------------------------------------
  multisig
    .command('broadcast')
    .description('Broadcast a fully-signed multisig envelope to Horizon')
    .option('-x, --xdr <xdr>', 'Transaction envelope XDR (base64)')
    .option('-i, --proposal <id>', 'Tracked proposal id to broadcast (see: multisig proposals)')
    .option('-n, --network <network>', 'Network passphrase or name', 'testnet')
    .option('-u, --horizon <url>', 'Horizon URL')
    .option('--force', 'Broadcast even when the threshold is not met')
    .action(async (opts) => {
      try {
        const passphrase = resolvePassphrase(opts.network);
        const { envelopeXdr } = resolveEnvelope(opts.xdr, opts.proposal);
        const horizonUrl = resolveHorizonUrl(passphrase, opts.horizon);

        // Verify the threshold before submitting so an under-signed envelope is
        // never broadcast.
        const envelope: any = parseEnvelope(envelopeXdr, passphrase);
        const tx: any = ('innerTransaction' in envelope) ? envelope.innerTransaction : envelope;

        let account: any = null;
        try {
          account = await loadAccount(tx.source, horizonUrl);
        } catch (error) {
          if (!opts.force) throw error;
          console.log(chalk.yellow(`⚠️  Could not load account: ${(error as Error).message}`));
        }

        if (account) {
          const proposal = parseMultisigProposal(envelopeXdr, account, passphrase);
          displayProposal(proposal);
          if (!proposal.thresholdMet) {
            if (!opts.force) {
              throw new Error(
                `Threshold not met: ${proposal.collectedWeight}/${proposal.requiredThreshold}. ` +
                  'Collect more signatures or re-run with --force.',
              );
            }
            console.log(chalk.yellow('⚠️  Threshold not met — broadcasting anyway (--force)'));
          }
        }

        console.log(chalk.yellow('Submitting to Horizon...'));
        const result = await submitMultisigEnvelope(envelopeXdr, horizonUrl, passphrase);
        if (result.successful) {
          console.log(chalk.green('✅ Transaction broadcast successfully'));
          if (result.hash) console.log(chalk.white(`Hash: ${result.hash}`));
        } else {
          console.log(chalk.red('❌ Broadcast failed'));
          if (result.error) console.log(chalk.red(result.error));
          process.exit(1);
        }
      } catch (error) {
        console.error(chalk.red(`❌ ${(error as Error).message}`));
        process.exit(1);
      }
    });

  // -------------------------------------------------------------------------
  // proposals
  // -------------------------------------------------------------------------
  multisig
    .command('proposals')
    .description('List the multisig proposals tracked on this machine')
    .option('--json', 'Print the proposals as JSON')
    .action(async (opts) => {
      try {
        const proposals = listMultisigProposals();

        if (opts.json) {
          console.log(JSON.stringify(proposals, null, 2));
          return;
        }

        if (proposals.length === 0) {
          console.log(chalk.yellow('No proposals tracked yet.'));
          console.log(chalk.gray('Store one with: stellar-alerts-cli multisig sign --xdr <xdr> --save'));
          return;
        }

        console.log(chalk.bold.blue('\n📋 Tracked multisig proposals'));
        console.log(chalk.gray('─'.repeat(90)));
        for (const proposal of proposals) {
          console.log(
            `${chalk.cyan(proposal.id)}  ${chalk.white(proposal.sourceAccount)}  ` +
              `${chalk.gray(proposal.network)}  ${chalk.gray(proposal.txHash.slice(0, 16))}…`,
          );
        }
        console.log(chalk.gray('─'.repeat(90)));
        console.log(chalk.gray('Inspect one with: stellar-alerts-cli multisig inspect --proposal <id>'));
        console.log();
      } catch (error) {
        console.error(chalk.red(`❌ ${(error as Error).message}`));
        process.exit(1);
      }
    });

  // -------------------------------------------------------------------------
  // profiles (helper: which profile holds a signing secret)
  // -------------------------------------------------------------------------
  multisig
    .command('profiles')
    .description('List profiles and the vault keys available for signing')
    .option('--password <password>', 'Vault password (non-interactive use)')
    .action(async (opts) => {
      try {
        const store = createProfileStore();
        const active = getActiveProfileName(store);
        const names = active ? [active] : [];
        console.log(chalk.bold.blue('\n🔑 Profiles with signing material'));
        console.log(chalk.gray('─'.repeat(60)));
        if (names.length === 0) {
          console.log(chalk.yellow('No active profile set.'));
        }
        for (const name of names) {
          try {
            const keys = await listSecretKeys(store, name, opts.password ?? '');
            console.log(`  ${chalk.white(name)}: ${keys.length > 0 ? keys.join(', ') : chalk.gray('no secrets')}`);
          } catch {
            console.log(`  ${chalk.white(name)}: ${chalk.gray('vault locked or unreadable')}`);
          }
        }
        console.log(chalk.gray('─'.repeat(60)));
        console.log();
      } catch (error) {
        console.error(chalk.red(`❌ ${(error as Error).message}`));
        process.exit(1);
      }
    });
}
