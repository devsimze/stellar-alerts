import { describe, it, expect } from 'vitest';
import * as StellarSdk from 'stellar-sdk';

import {
  addPrecomputedSignature,
  addSignatureToEnvelope,
  computeCollectedWeight,
  determineThresholdLevel,
  extractSigners,
  extractThresholds,
  getInnerTx,
  parseEnvelope,
  parseMultisigProposal,
  thresholdForLevel,
  type MultisigThresholds,
} from './multisig-builder.js';

// ---------------------------------------------------------------------------
// Fixtures — a 2-of-3 multisig treasury made of three Ed25519 keypairs.
// ---------------------------------------------------------------------------

const PASS = StellarSdk.Networks.TESTNET;

const signerA = StellarSdk.Keypair.fromRawEd25519Seed(Buffer.alloc(32, 0x01));
const signerB = StellarSdk.Keypair.fromRawEd25519Seed(Buffer.alloc(32, 0x02));
const signerC = StellarSdk.Keypair.fromRawEd25519Seed(Buffer.alloc(32, 0x03));
const masterKey = StellarSdk.Keypair.fromRawEd25519Seed(Buffer.alloc(32, 0x04));

const DESTINATION = StellarSdk.Keypair.fromRawEd25519Seed(Buffer.alloc(32, 0x05)).publicKey();

const thresholds: MultisigThresholds = {
  lowThreshold: 1,
  medThreshold: 2,
  highThreshold: 3,
};

/** Horizon-shaped account payload for the 2-of-3 multisig account. */
function accountFixture() {
  return {
    account_id: masterKey.publicKey(),
    master_key_weight: 1,
    sequence: '1',
    thresholds: {
      low_threshold: thresholds.lowThreshold,
      med_threshold: thresholds.medThreshold,
      high_threshold: thresholds.highThreshold,
    },
    signers: [
      { key: signerA.publicKey(), weight: 1, type: 'ed25519_public_key' },
      { key: signerB.publicKey(), weight: 1, type: 'ed25519_public_key' },
      { key: signerC.publicKey(), weight: 1, type: 'ed25519_public_key' },
    ],
  };
}

/** Builds an unsigned payment transaction from the multisig source account. */
function buildPayment(source = masterKey.publicKey()) {
  return new StellarSdk.TransactionBuilder(new StellarSdk.Account(source, '1'), {
    fee: '100',
    networkPassphrase: PASS,
  })
    .addOperation(
      StellarSdk.Operation.payment({
        destination: DESTINATION,
        asset: StellarSdk.Asset.native(),
        amount: '10.5',
      }),
    )
    .setTimeout(100)
    .build();
}

function buildSetOptions(source = masterKey.publicKey()) {
  return new StellarSdk.TransactionBuilder(new StellarSdk.Account(source, '1'), {
    fee: '100',
    networkPassphrase: PASS,
  })
    .addOperation(
      StellarSdk.Operation.setOptions({
        setFlags: StellarSdk.AuthRevocableFlag,
      }),
    )
    .setTimeout(100)
    .build();
}

function envelopeOf(tx: StellarSdk.Transaction): string {
  return tx.toEnvelope().toXDR('base64');
}

/** The four byte hint Stellar stores in place of the full signer public key. */
function hintOf(publicKey: string): string {
  return StellarSdk.StrKey.decodeEd25519PublicKey(publicKey).subarray(-4).toString('hex');
}

function signatureHint(signature: any): string {
  return Buffer.from(signature.hint()).toString('hex');
}

// ---------------------------------------------------------------------------
// Weight calculation
// ---------------------------------------------------------------------------

describe('multisig-builder — weight calculation', () => {
  it('extracts signers and thresholds from a Horizon account payload', () => {
    const signers = extractSigners(accountFixture());
    const weights = extractThresholds(accountFixture());

    expect(signers).toHaveLength(4);
    expect(signers.find((s) => s.key === signerA.publicKey())?.weight).toBe(1);
    expect(weights).toEqual(thresholds);
  });

  it('falls back to the master key weight when the account lists no signers', () => {
    const signers = extractSigners({
      account_id: masterKey.publicKey(),
      master_key_weight: 2,
      thresholds: { low_threshold: 1, med_threshold: 2, high_threshold: 3 },
    });

    expect(signers).toEqual([
      {
        key: masterKey.publicKey(),
        weight: 2,
        type: 'ed25519_public_key',
      },
    ]);
  });

  it('reports no collected weight for an unsigned envelope', () => {
    const tx = buildPayment();
    const collected = computeCollectedWeight(tx, extractSigners(accountFixture()));

    expect(collected).toEqual([]);
  });

  it('collects the weight of every signer that signed the envelope', () => {
    const tx = buildPayment();
    tx.sign(signerA);
    tx.sign(signerB);

    const collected = computeCollectedWeight(tx, extractSigners(accountFixture()));

    expect(collected).toHaveLength(2);
    expect(collected.reduce((sum, s) => sum + s.weight, 0)).toBe(2);
    expect(collected.map((s) => s.key).sort()).toEqual(
      [signerA.publicKey(), signerB.publicKey()].sort(),
    );
  });

  it('ignores signatures that do not belong to a known signer', () => {
    const tx = buildPayment();
    tx.sign(signerA);
    tx.sign(
      StellarSdk.Keypair.fromRawEd25519Seed(Buffer.alloc(32, 0x09)),
    );

    const collected = computeCollectedWeight(tx, extractSigners(accountFixture()));

    expect(collected).toHaveLength(1);
    expect(collected[0]!.key).toBe(signerA.publicKey());
  });

  it('parses a proposal and reports the threshold status', () => {
    const tx = buildPayment();
    tx.sign(signerA);

    const proposal = parseMultisigProposal(envelopeOf(tx), accountFixture(), PASS);

    expect(proposal.sourceAccount).toBe(masterKey.publicKey());
    expect(proposal.operationCount).toBe(1);
    expect(proposal.thresholdLevel).toBe('med');
    expect(proposal.requiredThreshold).toBe(2);
    expect(proposal.collectedWeight).toBe(1);
    expect(proposal.remainingWeight).toBe(1);
    expect(proposal.thresholdMet).toBe(false);
    expect(proposal.txHash).toBe(tx.hash().toString('hex'));
  });

  it('reports the threshold as met once the required weight is collected', () => {
    const tx = buildPayment();
    tx.sign(signerA);
    tx.sign(signerB);

    const proposal = parseMultisigProposal(envelopeOf(tx), accountFixture(), PASS);

    expect(proposal.collectedWeight).toBe(2);
    expect(proposal.remainingWeight).toBe(0);
    expect(proposal.thresholdMet).toBe(true);
  });

  it('requires the high threshold for signer-changing operations', () => {
    const tx = buildSetOptions();
    tx.sign(signerA);
    tx.sign(signerB);

    const proposal = parseMultisigProposal(envelopeOf(tx), accountFixture(), PASS);

    expect(proposal.thresholdLevel).toBe('high');
    expect(proposal.requiredThreshold).toBe(3);
    expect(proposal.thresholdMet).toBe(false);
  });

  it('maps threshold levels to the account thresholds', () => {
    expect(thresholdForLevel(thresholds, 'low')).toBe(1);
    expect(thresholdForLevel(thresholds, 'med')).toBe(2);
    expect(thresholdForLevel(thresholds, 'high')).toBe(3);
  });

  it('classifies operations by the threshold they require', () => {
    expect(determineThresholdLevel(buildPayment())).toBe('med');
    expect(determineThresholdLevel(buildSetOptions())).toBe('high');
  });
});

// ---------------------------------------------------------------------------
// Signature addition
// ---------------------------------------------------------------------------

describe('multisig-builder — signature addition', () => {
  it('adds a signature to the envelope and keeps the transaction hash', () => {
    const tx = buildPayment();
    const originalHash = tx.hash().toString('hex');

    const result = addSignatureToEnvelope(envelopeOf(tx), PASS, signerA);

    const parsed = StellarSdk.TransactionBuilder.fromXDR(result.signedXdr, PASS) as StellarSdk.Transaction;
    expect(result.txHash).toBe(originalHash);
    expect(parsed.signatures).toHaveLength(1);
    expect(signatureHint(parsed.signatures[0]!)).toBe(hintOf(signerA.publicKey()));
  });

  it('produces a signature that verifies against the transaction hash', () => {
    const tx = buildPayment();
    const result = addSignatureToEnvelope(envelopeOf(tx), PASS, signerA);

    const parsed = StellarSdk.TransactionBuilder.fromXDR(result.signedXdr, PASS) as StellarSdk.Transaction;
    const signature = parsed.signatures[0]!.signature();

    expect(signerA.verify(parsed.hash(), signature)).toBe(true);
  });

  it('aggregates signatures from several signers on the same envelope', () => {
    const tx = buildPayment();
    const first = addSignatureToEnvelope(envelopeOf(tx), PASS, signerA);
    const second = addSignatureToEnvelope(first.signedXdr, PASS, signerB);

    const parsed = StellarSdk.TransactionBuilder.fromXDR(second.signedXdr, PASS) as StellarSdk.Transaction;
    expect(parsed.signatures).toHaveLength(2);

    const proposal = parseMultisigProposal(second.signedXdr, accountFixture(), PASS);
    expect(proposal.collectedWeight).toBe(2);
    expect(proposal.thresholdMet).toBe(true);
  });

  it('reports the weight status when the account is supplied', () => {
    const tx = buildPayment();
    const result = addSignatureToEnvelope(envelopeOf(tx), PASS, signerA, accountFixture());

    expect(result.collectedWeight).toBe(1);
    expect(result.requiredThreshold).toBe(2);
    expect(result.thresholdMet).toBe(false);
  });

  it('adds a pre-computed signature for air-gapped signing', () => {
    const tx = buildPayment();
    const signature = signerA.sign(tx.hash()).toString('base64');

    const signedXdr = addPrecomputedSignature(
      envelopeOf(tx),
      PASS,
      signerA.publicKey(),
      signature,
    );

    const parsed = StellarSdk.TransactionBuilder.fromXDR(signedXdr, PASS) as StellarSdk.Transaction;
    expect(parsed.signatures).toHaveLength(1);
    expect(signatureHint(parsed.signatures[0]!)).toBe(hintOf(signerA.publicKey()));
    expect(signerA.verify(parsed.hash(), parsed.signatures[0]!.signature())).toBe(true);
  });

  it('keeps fee-bump envelopes intact and signs the outer transaction', () => {
    const inner = buildPayment();
    inner.sign(signerA);
    const feeBump = StellarSdk.TransactionBuilder.buildFeeBumpTransaction(
      masterKey.publicKey(),
      '200',
      inner,
      StellarSdk.Networks.TESTNET,
    );

    const envelopeXdr = feeBump.toEnvelope().toXDR('base64');
    const result = addSignatureToEnvelope(envelopeXdr, PASS, signerB);

    const parsed = parseEnvelope(result.signedXdr, PASS);
    expect('innerTransaction' in parsed).toBe(true);
    expect((parsed as StellarSdk.FeeBumpTransaction).signatures).toHaveLength(1);
    expect(getInnerTx(result.signedXdr, PASS).source).toBe(masterKey.publicKey());
  });
});
