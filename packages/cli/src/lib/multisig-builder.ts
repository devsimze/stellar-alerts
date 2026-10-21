import * as StellarSdk from 'stellar-sdk';

/**
 * Multisig proposal builder and weight/signature utilities (#722).
 *
 * Parses a multisig transaction XDR, inspects the source account's signers
 * and threshold weights, tracks collected Ed25519 signatures, and determines
 * whether the required threshold has been satisfied so the envelope can be
 * broadcast to Horizon.
 */

export interface SignerWeight {
  key: string;
  weight: number;
  type: string;
}

export interface MultisigThresholds {
  lowThreshold: number;
  medThreshold: number;
  highThreshold: number;
}

export interface ParsedMultisigProposal {
  envelopeXdr: string;
  txHash: string;
  sourceAccount: string;
  fee: string;
  sequence: string;
  operationCount: number;
  signers: SignerWeight[];
  thresholds: MultisigThresholds;
  requiredThreshold: number;
  /** The threshold level the transaction operation set implies. */
  thresholdLevel: 'low' | 'med' | 'high';
  /** Weights of signers that have already signed the envelope. */
  collectedSigners: Array<{ key: string; weight: number }>;
  collectedWeight: number;
  /** Remaining weight needed to reach the required threshold. */
  remainingWeight: number;
  thresholdMet: boolean;
}

export interface AddSignatureResult {
  signedXdr: string;
  txHash: string;
  collectedWeight: number;
  requiredThreshold: number;
  thresholdMet: boolean;
}

/** A parsed envelope is either a plain transaction or a fee-bump transaction. */
export type EnvelopeTransaction = StellarSdk.Transaction | StellarSdk.FeeBumpTransaction;

/** Parses an envelope, returning the outermost transaction (fee bump if present). */
export function parseEnvelope(
  envelopeXdr: string,
  passphrase: string,
): EnvelopeTransaction {
  const parsed = StellarSdk.TransactionBuilder.fromXDR(envelopeXdr, passphrase);
  if ('innerTransaction' in parsed) {
    return parsed as StellarSdk.FeeBumpTransaction;
  }
  return parsed as StellarSdk.Transaction;
}

/**
 * Returns the inner transaction of an envelope — the one carrying the source
 * account, sequence number and operations. For fee-bump envelopes the fee bump
 * wraps a regular transaction.
 */
export function getInnerTx(
  envelopeXdr: string,
  passphrase: string,
): StellarSdk.Transaction {
  const parsed = parseEnvelope(envelopeXdr, passphrase);
  if ('innerTransaction' in parsed) {
    return (parsed as StellarSdk.FeeBumpTransaction).innerTransaction;
  }
  return parsed as StellarSdk.Transaction;
}

/**
 * Determines which threshold level a transaction's operation set requires.
 *
 * Source-account threshold rules (see the Stellar multisig documentation):
 *   - high: operations that change the account itself or its signers —
 *     setOptions (signer/threshold/master-key/flags changes), clawback,
 *     setTrustLineFlags and sponsorship revocation.
 *   - med: everything else — payments, path payments, createAccount,
 *     changeTrust, allowTrust, manageData, accountMerge, bumpSequence,
 *     liquidity pool operations and Soroban invocations.
 *   - low: master-key level operations (sequence number and home domain
 *     changes), which are not modelled as operations and therefore never
 *     returned here.
 *
 * The mapping is deliberately conservative: an operation that might need the
 * high threshold is treated as high so the CLI never reports a threshold as
 * met when the network would reject the envelope.
 */
export function determineThresholdLevel(
  tx: StellarSdk.Transaction,
): 'low' | 'med' | 'high' {
  const highThresholdOperations = new Set([
    'setOptions',
    'clawback',
    'setTrustLineFlags',
    'revokeSponsorship',
  ]);

  for (const op of tx.operations as any[]) {
    if (highThresholdOperations.has(op.type)) {
      return 'high';
    }
  }

  return 'med';
}

export function thresholdForLevel(
  thresholds: MultisigThresholds,
  level: 'low' | 'med' | 'high',
): number {
  if (level === 'high') return thresholds.highThreshold;
  if (level === 'low') return thresholds.lowThreshold;
  return thresholds.medThreshold;
}

/**
 * Normalizes signer entries from a Stellar account response into weights.
 *
 * Ed25519 signers are listed as `{ key, weight, type: 'ed25519_public_key' }`.
 * When the account has no additional signers the master key is used with the
 * account's `master_key_weight`.
 */
export function extractSigners(account: any): SignerWeight[] {
  const signers: SignerWeight[] = [];
  const src = account?.signers ?? [];
  for (const s of src) {
    const key = s.key ?? s.publicKey ?? s.account_id;
    const weight = Number(s.weight ?? 0);
    if (key) {
      signers.push({
        key,
        weight: Number.isFinite(weight) ? weight : 0,
        type: s.type ?? 'ed25519_public_key',
      });
    }
  }

  // The master key is a signer too — Horizon only lists it explicitly when
  // the account has additional signers, so add it when it is missing.
  const masterKey = account?.account_id ?? account?.accountId;
  if (masterKey && !signers.some((s) => s.key === masterKey)) {
    const masterWeight = Number(account?.master_key_weight ?? account?.masterKeyWeight ?? 0);
    signers.push({
      key: masterKey,
      weight: Number.isFinite(masterWeight) ? masterWeight : 0,
      type: 'ed25519_public_key',
    });
  }

  return signers;
}

export function extractThresholds(account: any): MultisigThresholds {
  const t = account?.thresholds ?? {};
  return {
    lowThreshold: Number(t.low_threshold ?? t.low ?? 0),
    medThreshold: Number(t.med_threshold ?? t.med ?? 0),
    highThreshold: Number(t.high_threshold ?? t.high ?? 0),
  };
}

/**
 * Returns the signature hint of an Ed25519 signer — the last four bytes of the
 * public key. Stellar stores the hint in the envelope instead of the full key.
 */
export function signerHint(publicKey: string): Buffer | null {
  try {
    return StellarSdk.StrKey.decodeEd25519PublicKey(publicKey).subarray(-4);
  } catch {
    return null;
  }
}

/**
 * Returns the signers that have already signed the envelope.
 *
 * Signatures are matched by their hint (the last four bytes of the signer's
 * public key) and then verified cryptographically against the transaction hash
 * — the signature has to be both labelled and valid.
 */
export function computeCollectedWeight(
  tx: EnvelopeTransaction,
  signers: SignerWeight[],
): Array<{ key: string; weight: number }> {
  const signatures = tx.signatures ?? [];
  if (signatures.length === 0) return [];

  const hash = tx.hash();
  const collected: Array<{ key: string; weight: number }> = [];

  for (const signer of signers) {
    const hint = signerHint(signer.key);
    if (!hint) continue;

    try {
      const keypair = StellarSdk.Keypair.fromPublicKey(signer.key);
      for (const sig of signatures) {
        try {
          const sigHint = Buffer.from((sig as any).hint());
          if (!sigHint.equals(hint)) continue;
          if (keypair.verify(hash, (sig as any).signature())) {
            collected.push({ key: signer.key, weight: signer.weight });
            break;
          }
        } catch {
          // Signature does not belong to this signer — keep looking.
        }
      }
    } catch {
      // Not an Ed25519 key (e.g. a pre-auth or hash-x signer) — skip it.
    }
  }

  return collected;
}

/** Parses a multisig proposal envelope and computes weight vs threshold. */
export function parseMultisigProposal(
  envelopeXdr: string,
  account: any,
  passphrase: string,
): ParsedMultisigProposal {
  const envelope = parseEnvelope(envelopeXdr, passphrase);
  const tx = getInnerTx(envelopeXdr, passphrase);
  const signers = extractSigners(account);
  const thresholds = extractThresholds(account);
  const thresholdLevel = determineThresholdLevel(tx);
  const requiredThreshold = thresholdForLevel(thresholds, thresholdLevel);

  const collected = computeCollectedWeight(envelope, signers);
  const collectedWeight = collected.reduce((sum, s) => sum + s.weight, 0);
  const remainingWeight = Math.max(0, requiredThreshold - collectedWeight);
  const thresholdMet = requiredThreshold > 0 && collectedWeight >= requiredThreshold;

  return {
    envelopeXdr,
    txHash: envelope.hash().toString('hex'),
    sourceAccount: tx.source,
    fee: tx.fee,
    sequence: tx.sequence,
    operationCount: tx.operations?.length ?? 0,
    signers,
    thresholds,
    requiredThreshold,
    thresholdLevel,
    collectedSigners: collected,
    collectedWeight,
    remainingWeight,
    thresholdMet,
  };
}

/**
 * Appends a signature from a keypair (local secret) to the transaction envelope.
 * Returns the updated base64 XDR.
 *
 * When the source account is supplied the collected weight and the threshold
 * status are recomputed, so the caller can immediately tell whether the
 * proposal is ready to be broadcast.
 */
export function addSignatureToEnvelope(
  envelopeXdr: string,
  passphrase: string,
  keypair: StellarSdk.Keypair,
  account?: any,
): AddSignatureResult {
  const envelope = parseEnvelope(envelopeXdr, passphrase);
  envelope.sign(keypair);
  const signedXdr = envelope.toEnvelope().toXDR('base64');

  if (!account) {
    return {
      signedXdr,
      txHash: envelope.hash().toString('hex'),
      collectedWeight: 0,
      requiredThreshold: 0,
      thresholdMet: false,
    };
  }

  const proposal = parseMultisigProposal(signedXdr, account, passphrase);
  return {
    signedXdr,
    txHash: proposal.txHash,
    collectedWeight: proposal.collectedWeight,
    requiredThreshold: proposal.requiredThreshold,
    thresholdMet: proposal.thresholdMet,
  };
}

/**
 * Signs with a pre-computed signature (useful for hardware wallet integrations).
 */
export function addPrecomputedSignature(
  envelopeXdr: string,
  passphrase: string,
  publicKey: string,
  signatureBase64: string,
): string {
  const envelope = parseEnvelope(envelopeXdr, passphrase);
  envelope.addSignature(publicKey, signatureBase64);
  return envelope.toEnvelope().toXDR('base64');
}

/**
 * Submits a signed envelope to Horizon. Uses stellar-sdk Server if available.
 */
export async function submitMultisigEnvelope(
  envelopeXdr: string,
  horizonUrl?: string,
  passphrase?: string,
): Promise<{ successful: boolean; hash?: string; resultXdr?: string; error?: string }> {
  try {
    const server = new (StellarSdk as any).Server(
      horizonUrl ?? process.env.STELLAR_HORIZON_URL ?? 'https://horizon-testnet.stellar.org',
    );
    const tx = parseEnvelope(
      envelopeXdr,
      passphrase ?? StellarSdk.Networks.TESTNET,
    );
    const result = await server.submitTransaction(tx as any);
    return {
      successful: result?.successful ?? true,
      hash: result?.hash,
      resultXdr: result?.result_xdr ?? result?.resultXdr,
    };
  } catch (error: any) {
    const msg = error?.response?.data?.extras?.result_codes
      ? JSON.stringify(error.response.data.extras.result_codes)
      : error?.message ?? String(error);
    return { successful: false, error: msg };
  }
}
