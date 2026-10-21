# CLI Multisig Proposal Inspector & Signature Aggregator

> Added in: [#722](https://github.com/stellar-alerts-labs/stellar-alerts/issues/722)

Treasuries and DAOs run Stellar multi-signature accounts (`2-of-3`, `3-of-5`, …).
Every signer needs the same three things: see what the proposal actually does,
add their own signature to it, and know when the envelope is ready to go on-chain.

`stellar-alerts-cli multisig` does exactly that:

- **inspect** — parse an envelope, pull the account's signers and thresholds from
  Horizon, and show the collected weight next to the weight still required.
- **sign** — add an Ed25519 signature from a local secret, a secret held in the
  encrypted profile vault, a Ledger device, or a pre-computed (air-gapped) signature.
- **broadcast** — submit the envelope to Horizon, refusing to broadcast while the
  threshold is not met.
- **proposals** — list the proposals tracked on this machine, so signatures can be
  aggregated across invocations and signers.

---

## Table of Contents

1. [Concepts](#concepts)
2. [Command Reference](#command-reference)
3. [Signature Aggregation Workflow](#signature-aggregation-workflow)
4. [Signing with a Profile Secret](#signing-with-a-profile-secret)
5. [Signing with a Ledger](#signing-with-a-ledger)
6. [Air-gapped Signing](#air-gapped-signing)
7. [Threshold Levels](#threshold-levels)
8. [Proposal Store](#proposal-store)
9. [Security Considerations](#security-considerations)
10. [Troubleshooting](#troubleshooting)

---

## Concepts

| Term | Meaning |
|------|---------|
| **Envelope** | The base64 XDR of a transaction (or fee-bump transaction) including every signature collected so far. |
| **Signer** | A public key listed on the account with a weight (`1` by default). |
| **Master key** | The account's own key. It is a signer too, with the account's `master_key_weight`. |
| **Threshold** | The weight the account requires for the operations in the transaction (low / medium / high). |
| **Collected weight** | The sum of the weights of the signers whose signature is present *and verifies* against the transaction hash. |

The CLI never trusts the envelope's signature list blindly. Each signature is
matched to a signer by its **hint** (the last four bytes of the signer's public
key, which is what Stellar stores in the envelope) and is then verified
cryptographically against the transaction hash. A signature that does not verify
contributes no weight.

---

## Command Reference

```bash
stellar-alerts-cli multisig inspect   [--xdr <xdr> | --proposal <id>] [--network <net>] [--horizon <url>] [--account <publicKey>]
stellar-alerts-cli multisig sign      [--xdr <xdr> | --proposal <id>] [--secret <S…> | --profile <name> | --ledger | --signature <b64> --signer <pub>] [--out <file>] [--save]
stellar-alerts-cli multisig broadcast [--xdr <xdr> | --proposal <id>] [--network <net>] [--horizon <url>] [--force]
stellar-alerts-cli multisig proposals [--json]
stellar-alerts-cli multisig profiles
```

### `inspect`

```bash
stellar-alerts-cli multisig inspect --xdr <base64-envelope> --network testnet
```

Loads the source account from Horizon, prints the signers with their weights, the
threshold the operations require, the weight already collected and the weight
still missing. The source account is read from the envelope unless `--account`
is given.

### `sign`

Adds one signature and prints the updated envelope. Pick the signer with
exactly one of:

| Flag | Signer |
|------|--------|
| `--secret <S…>` | the given secret key |
| `--profile <name>` | the secret stored in that profile's vault (`--secret-key`, default `signingSecret`) |
| `--ledger` | the Ledger device on the given `--path` (default `44'/148'/0'`) |
| `--signature <b64> --signer <pub>` | a pre-computed signature (air-gapped) |

Use `--out <file>` to write the envelope to disk instead of stdout, and `--save`
to store the signed envelope in the local proposal store.

### `broadcast`

```bash
stellar-alerts-cli multisig broadcast --proposal <id> --network testnet
```

Loads the account from Horizon, recomputes the collected weight and refuses to
submit while the threshold is not met. `--force` bypasses the check (and any
Horizon lookup failure) — use it only when you know the envelope is complete.

### `proposals`

Lists the proposals tracked in the local store (id, source account, network,
transaction hash). `--json` prints them as JSON.

### `profiles`

Lists the active profile and the vault keys available for signing (key names
only — values are never printed).

---

## Signature Aggregation Workflow

A typical 2-of-3 treasury flow:

```bash
# 1. The first signer inspects the proposal and stores it.
stellar-alerts-cli multisig inspect --xdr "$XDR" --network testnet
stellar-alerts-cli multisig sign --xdr "$XDR" --secret "$SIGNER_A_SECRET" --save

# 2. The second signer signs the same proposal — the store keeps the envelope
#    with the first signature, so the second signature is added on top of it.
stellar-alerts-cli multisig sign --proposal <id> --profile treasury-b
stellar-alerts-cli multisig inspect --proposal <id>   # collected weight: 2/2

# 3. Once the threshold is met, broadcast.
stellar-alerts-cli multisig broadcast --proposal <id> --network testnet
```

The proposal id is the first 12 hex characters of the transaction hash, so it
is stable across signers and machines.

---

## Signing with a Profile Secret

Signing keys are stored in the encrypted vault (see
[CLI_PROFILES.md](./CLI_PROFILES.md)) so they never hit the shell history:

```bash
# Store the signing secret once (prompts for the value and the vault password).
stellar-alerts-cli profile secret set signingSecret --profile treasury-b

# Sign with it later.
stellar-alerts-cli multisig sign --proposal <id> --profile treasury-b
```

The vault password is asked interactively; pass `--password <password>` for
non-interactive runs (CI) — prefer `STELLAR_ALERTS_VAULT_PASSWORD` style
environment injection over a command-line flag, since arguments are visible in
the process list.

---

## Signing with a Ledger

```bash
stellar-alerts-cli multisig sign --proposal <id> --ledger --path "44'/148'/1'"
```

The Stellar app renders the operation details on the device and the private key
never leaves it. The Ledger packages are optional dependencies:

```bash
npm install @ledgerhq/hw-transport-node-hid @ledgerhq/hw-app-str
```

---

## Air-gapped Signing

On an offline machine, sign the transaction hash and export the signature:

```bash
stellar-alerts-cli tx-sign --xdr "$XDR" --ledger --out signed.xdr
```

Then, on the online machine, attach the signature to the envelope:

```bash
stellar-alerts-cli multisig sign --xdr "$XDR" --signer "$PUBLIC_KEY" --signature "$BASE64_SIGNATURE"
```

---

## Threshold Levels

Stellar accounts carry three thresholds. The CLI maps the operations in the
transaction to the level they require:

| Level | Operations |
|-------|------------|
| **high** | `setOptions` (signer, threshold, master key, flag, home domain and inflation destination changes), `clawback`, `setTrustLineFlags`, sponsorship revocation |
| **med** | payments, path payments, `createAccount`, `changeTrust`, `allowTrust`, `manageData`, `accountMerge`, `bumpSequence`, liquidity pool operations, Soroban invocations |
| **low** | master-key level operations (sequence number, home domain) — these are not operations and never appear here |

The mapping is deliberately conservative: an operation that might need the high
threshold is treated as high, so the CLI never reports a proposal as ready when
the network would reject it.

---

## Proposal Store

```
~/.config/stellar-alerts/
    multisig-proposals.json   ← tracked envelopes (no private keys)
```

The file holds the envelopes and their metadata — never a secret key. It is
created with `0600` permissions and a corrupted file is treated as empty rather
than crashing the CLI. Override the directory with `STELLAR_ALERTS_CONFIG_DIR`.

---

## Security Considerations

- **The vault password is never stored.** It is only used to decrypt a signing
  secret for the duration of one command.
- **Signatures are verified, not trusted.** A signature that does not verify
  against the transaction hash contributes no weight.
- **`broadcast` is gated.** An envelope below the account threshold is not
  submitted unless `--force` is passed explicitly.
- **Local envelopes are sensitive.** They reveal the operations a treasury is
  about to broadcast. Keep `~/.config/stellar-alerts` on an encrypted volume.

---

## Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| `Could not determine source account` | The envelope could not be parsed — check the network (`--network`) and that the XDR is a complete envelope. |
| `Threshold not met: 1/2` | More signatures are required. Sign with another key of the account. |
| `No 'signingSecret' secret stored for profile …` | Store it first with `profile secret set signingSecret --profile <name>`. |
| `Ledger support requires optional packages` | Install `@ledgerhq/hw-transport-node-hid` and `@ledgerhq/hw-app-str`. |
| Horizon returns `tx_bad_auth` | The envelope does not carry a valid signature for the account — re-run `inspect` to see which signer is missing. |
