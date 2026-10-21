/**
 * Profile store – manages named configuration profiles for the Stellar Alerts CLI.
 *
 * Files written:
 *   <configDir>/profiles.json  – non-sensitive profile metadata (plaintext)
 *   <configDir>/vault.enc      – AES-256-GCM encrypted secrets (never plaintext)
 *
 * The config directory defaults to ~/.config/stellar-alerts/ (XDG Base Dir convention).
 * Override by setting the STELLAR_ALERTS_CONFIG_DIR environment variable.
 *
 * Backward compatibility:
 *   - When no profiles.json exists, the store treats the current environment variables
 *     (STELLAR_ALERTS_API_URL, STELLAR_ALERTS_API_KEY) as an implicit "default" profile.
 *   - The first explicitly created profile becomes the active profile; the implicit
 *     "default" profile continues to work via env vars until the user migrates.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  ProfileConfig,
  ProfileSecrets,
  ProfilesFile,
  VaultPayload,
  ProfileError,
  isValidProfileName,
} from './profile-types.js';
import { ConfigValidator } from './config-validator.js';
import {
  sealVault,
  sealArgon2Vault,
  openVault,
  parseVaultFile,
  emptyVaultPayload,
} from './vault.js';

// ---------------------------------------------------------------------------
// Configuration directory resolution
// ---------------------------------------------------------------------------

export function getConfigDir(): string {
  return (
    process.env['STELLAR_ALERTS_CONFIG_DIR'] ||
    join(homedir(), '.config', 'stellar-alerts')
  );
}

function getProfilesFilePath(configDir: string): string {
  return join(configDir, 'profiles.json');
}

function getVaultFilePath(configDir: string): string {
  return join(configDir, 'vault.enc');
}

// ---------------------------------------------------------------------------
// Profiles file I/O (plaintext)
// ---------------------------------------------------------------------------

function ensureConfigDir(configDir: string): void {
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
  }
}

function readProfilesFile(configDir: string): ProfilesFile {
  const filePath = getProfilesFilePath(configDir);

  if (!existsSync(filePath)) {
    return ConfigValidator.createDefaultTemplate();
  }

  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new ProfileError(
      'CONFIG_READ_ERROR',
      `Could not read profiles file at ${filePath}: ${(err as Error).message}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ProfileError(
      'CONFIG_READ_ERROR',
      `Profiles file at ${filePath} is not valid JSON. It may be corrupt.`,
    );
  }

  return ConfigValidator.validate(parsed, filePath);
}

function writeProfilesFile(configDir: string, data: ProfilesFile): void {
  ensureConfigDir(configDir);
  const filePath = getProfilesFilePath(configDir);

  try {
    writeFileSync(filePath, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
  } catch (err) {
    throw new ProfileError(
      'CONFIG_WRITE_ERROR',
      `Could not write profiles file at ${filePath}: ${(err as Error).message}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Vault file I/O (encrypted)
// ---------------------------------------------------------------------------

async function readVaultPayload(
  configDir: string,
  password: string,
): Promise<VaultPayload> {
  const vaultPath = getVaultFilePath(configDir);

  if (!existsSync(vaultPath)) {
    throw new ProfileError('VAULT_NOT_FOUND', 'No vault file found. Create a profile with a secret first.');
  }

  let raw: string;
  try {
    raw = readFileSync(vaultPath, 'utf8');
  } catch (err) {
    throw new ProfileError(
      'CONFIG_READ_ERROR',
      `Could not read vault file at ${vaultPath}: ${(err as Error).message}`,
    );
  }

  const vaultFile = parseVaultFile(raw);
  return openVault(vaultFile, password);
}

async function writeVaultPayload(
  configDir: string,
  payload: VaultPayload,
  password: string,
  kdf: 'argon2id' | 'scrypt' = 'argon2id',
): Promise<void> {
  ensureConfigDir(configDir);
  const vaultPath = getVaultFilePath(configDir);

  const vaultFile =
    kdf === 'argon2id'
      ? await sealArgon2Vault(payload, password)
      : await sealVault(payload, password);

  try {
    writeFileSync(vaultPath, JSON.stringify(vaultFile, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
    // Ensure permissions even if file already existed
    chmodSync(vaultPath, 0o600);
  } catch (err) {
    throw new ProfileError(
      'CONFIG_WRITE_ERROR',
      `Could not write vault file at ${vaultPath}: ${(err as Error).message}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Public Profile Store API
// ---------------------------------------------------------------------------

export interface ProfileStore {
  configDir: string;
}

/** Returns a profile store bound to a specific config directory. */
export function createProfileStore(configDir?: string): ProfileStore {
  return { configDir: configDir ?? getConfigDir() };
}

// ---- Profile CRUD ----------------------------------------------------------

/**
 * Creates a new named profile with the given configuration.
 * Throws if a profile with that name already exists or the name is invalid.
 */
export function createProfile(
  store: ProfileStore,
  name: string,
  config: Omit<ProfileConfig, 'name' | 'createdAt' | 'updatedAt' | 'hasSecrets'>,
): ProfileConfig {
  if (!isValidProfileName(name)) {
    throw new ProfileError(
      'INVALID_PROFILE_NAME',
      `Profile name '${name}' is invalid. Use only letters, numbers, hyphens, and underscores (1–64 chars).`,
    );
  }

  const data = readProfilesFile(store.configDir);

  if (data.profiles[name]) {
    throw new ProfileError(
      'PROFILE_ALREADY_EXISTS',
      `A profile named '${name}' already exists. Use 'profile update ${name}' to modify it.`,
    );
  }

  const now = new Date().toISOString();
  const profile: ProfileConfig = {
    ...config,
    name,
    createdAt: now,
    updatedAt: now,
    hasSecrets: false,
  };

  data.profiles[name] = profile;

  // First profile created → make it active automatically
  if (data.activeProfile === null) {
    data.activeProfile = name;
  }

  writeProfilesFile(store.configDir, data);
  return profile;
}

/**
 * Lists all profiles. Returns an empty array if none exist.
 */
export function listProfiles(store: ProfileStore): ProfileConfig[] {
  const data = readProfilesFile(store.configDir);
  return Object.values(data.profiles);
}

/**
 * Returns a single profile by name.
 * Throws `PROFILE_NOT_FOUND` if it does not exist.
 */
export function getProfile(store: ProfileStore, name: string): ProfileConfig {
  const data = readProfilesFile(store.configDir);

  const profile = data.profiles[name];
  if (!profile) {
    throw new ProfileError(
      'PROFILE_NOT_FOUND',
      `Profile '${name}' not found. Run 'profile list' to see available profiles.`,
    );
  }

  return profile;
}

/**
 * Returns the name of the currently active profile, or null if none is set.
 */
export function getActiveProfileName(store: ProfileStore): string | null {
  const data = readProfilesFile(store.configDir);
  return data.activeProfile;
}

/**
 * Returns the active profile's full config.
 * Throws `NO_ACTIVE_PROFILE` if no active profile is set.
 */
export function getActiveProfile(store: ProfileStore): ProfileConfig {
  const data = readProfilesFile(store.configDir);

  if (!data.activeProfile) {
    throw new ProfileError(
      'NO_ACTIVE_PROFILE',
      'No active profile is set. Create one with: stellar-alerts-cli profile create <name>',
    );
  }

  const profile = data.profiles[data.activeProfile];
  if (!profile) {
    throw new ProfileError(
      'PROFILE_NOT_FOUND',
      `Active profile '${data.activeProfile}' no longer exists. Use 'profile use <name>' to select another.`,
    );
  }

  return profile;
}

/**
 * Sets the active profile.
 * Throws `PROFILE_NOT_FOUND` if the named profile does not exist.
 */
export function setActiveProfile(store: ProfileStore, name: string): void {
  const data = readProfilesFile(store.configDir);

  if (!data.profiles[name]) {
    throw new ProfileError(
      'PROFILE_NOT_FOUND',
      `Profile '${name}' not found. Run 'profile list' to see available profiles.`,
    );
  }

  data.activeProfile = name;
  writeProfilesFile(store.configDir, data);
}

/**
 * Updates non-sensitive fields on an existing profile.
 * Only the provided fields are changed; omitted fields retain their current values.
 */
export function updateProfile(
  store: ProfileStore,
  name: string,
  updates: Partial<Omit<ProfileConfig, 'name' | 'createdAt' | 'updatedAt' | 'hasSecrets'>>,
): ProfileConfig {
  const data = readProfilesFile(store.configDir);

  const existing = data.profiles[name];
  if (!existing) {
    throw new ProfileError(
      'PROFILE_NOT_FOUND',
      `Profile '${name}' not found. Run 'profile list' to see available profiles.`,
    );
  }

  const updated: ProfileConfig = {
    ...existing,
    ...updates,
    name,                           // name is immutable
    createdAt: existing.createdAt,  // creation time is immutable
    updatedAt: new Date().toISOString(),
  };

  data.profiles[name] = updated;
  writeProfilesFile(store.configDir, data);
  return updated;
}

/**
 * Removes a profile and its vault secrets.
 * Throws `PROFILE_NOT_FOUND` if the profile does not exist.
 *
 * If the removed profile was the active one, `activeProfile` is set to the
 * first remaining profile name, or null if none remain.
 */
export async function removeProfile(
  store: ProfileStore,
  name: string,
  vaultPassword?: string,
): Promise<void> {
  const data = readProfilesFile(store.configDir);

  if (!data.profiles[name]) {
    throw new ProfileError(
      'PROFILE_NOT_FOUND',
      `Profile '${name}' not found. Run 'profile list' to see available profiles.`,
    );
  }

  // Clean up vault secrets for this profile (best-effort — requires password)
  if (data.profiles[name]?.hasSecrets && vaultPassword) {
    const vaultPath = getVaultFilePath(store.configDir);
    if (existsSync(vaultPath)) {
      try {
        const payload = await readVaultPayload(store.configDir, vaultPassword);
        delete payload.secrets[name];
        await writeVaultPayload(store.configDir, payload, vaultPassword);
      } catch {
        // Vault clean-up is best-effort; profile removal proceeds regardless
      }
    }
  }

  delete data.profiles[name];

  if (data.activeProfile === name) {
    const remaining = Object.keys(data.profiles);
    data.activeProfile = remaining.length > 0 ? (remaining[0] ?? null) : null;
  }

  writeProfilesFile(store.configDir, data);
}

// ---- Vault / Secrets API ---------------------------------------------------

/**
 * Stores a secret key→value pair for a profile in the encrypted vault.
 * Creates the vault file if it does not yet exist.
 *
 * `key` must be 'apiKey' or an arbitrary string for the `extra` bag.
 */
export async function setSecret(
  store: ProfileStore,
  profileName: string,
  key: string,
  value: string,
  password: string,
): Promise<void> {
  // Verify the profile exists
  const data = readProfilesFile(store.configDir);
  if (!data.profiles[profileName]) {
    throw new ProfileError(
      'PROFILE_NOT_FOUND',
      `Profile '${profileName}' not found.`,
    );
  }

  // Load or create vault payload
  const vaultPath = getVaultFilePath(store.configDir);
  let payload: VaultPayload;

  if (existsSync(vaultPath)) {
    payload = await readVaultPayload(store.configDir, password);
  } else {
    payload = emptyVaultPayload();
  }

  if (!payload.secrets[profileName]) {
    payload.secrets[profileName] = {};
  }

  const secrets = payload.secrets[profileName]!;

  if (key === 'apiKey') {
    secrets.apiKey = value;
  } else {
    if (!secrets.extra) secrets.extra = {};
    secrets.extra[key] = value;
  }

  await writeVaultPayload(store.configDir, payload, password);

  // Mark profile as having secrets (non-sensitive metadata)
  data.profiles[profileName]!.hasSecrets = true;
  data.profiles[profileName]!.updatedAt = new Date().toISOString();
  writeProfilesFile(store.configDir, data);
}

/**
 * Retrieves a secret value from the vault for a specific profile.
 * Returns undefined if the key does not exist.
 */
export async function getSecret(
  store: ProfileStore,
  profileName: string,
  key: string,
  password: string,
): Promise<string | undefined> {
  const data = readProfilesFile(store.configDir);
  if (!data.profiles[profileName]) {
    throw new ProfileError(
      'PROFILE_NOT_FOUND',
      `Profile '${profileName}' not found.`,
    );
  }

  const payload = await readVaultPayload(store.configDir, password);
  const secrets = payload.secrets[profileName];

  if (!secrets) return undefined;

  if (key === 'apiKey') return secrets.apiKey;
  return secrets.extra?.[key];
}

/**
 * Returns all secret keys for a profile (without their values).
 * Safe to display — does not expose actual secret values.
 */
export async function listSecretKeys(
  store: ProfileStore,
  profileName: string,
  password: string,
): Promise<string[]> {
  const payload = await readVaultPayload(store.configDir, password);
  const secrets = payload.secrets[profileName];

  if (!secrets) return [];

  const keys: string[] = [];
  if (secrets.apiKey !== undefined) keys.push('apiKey');
  if (secrets.extra) keys.push(...Object.keys(secrets.extra));
  return keys;
}

/**
 * Deletes a secret key from the vault for a specific profile.
 */
export async function deleteSecret(
  store: ProfileStore,
  profileName: string,
  key: string,
  password: string,
): Promise<void> {
  const data = readProfilesFile(store.configDir);
  if (!data.profiles[profileName]) {
    throw new ProfileError(
      'PROFILE_NOT_FOUND',
      `Profile '${profileName}' not found.`,
    );
  }

  const payload = await readVaultPayload(store.configDir, password);
  const secrets = payload.secrets[profileName];

  if (secrets) {
    if (key === 'apiKey') {
      delete secrets.apiKey;
    } else if (secrets.extra) {
      delete secrets.extra[key];
    }
  }

  await writeVaultPayload(store.configDir, payload, password);

  // Update hasSecrets flag
  const updatedKeys = await listSecretKeys(store, profileName, password);
  if (data.profiles[profileName]) {
    data.profiles[profileName]!.hasSecrets = updatedKeys.length > 0;
    data.profiles[profileName]!.updatedAt = new Date().toISOString();
    writeProfilesFile(store.configDir, data);
  }
}

/**
 * Loads the resolved configuration for the effective profile.
 *
 * Precedence (highest to lowest):
 *  1. Explicit environment variables (STELLAR_ALERTS_API_URL, STELLAR_ALERTS_API_KEY)
 *  2. Profile specified by --profile CLI flag (passed as `profileName`)
 *  3. Currently active profile
 *  4. Built-in defaults (http://localhost:3001, no API key)
 *
 * Sensitive values (apiKey) are only loaded when a `vaultPassword` is supplied.
 */
export async function resolveEffectiveConfig(
  store: ProfileStore,
  profileName?: string,
  vaultPassword?: string,
): Promise<{ apiUrl: string; apiKey?: string; logLevel: string }> {
  // Env-var overrides always win
  const envApiUrl = process.env['STELLAR_ALERTS_API_URL'];
  const envApiKey = process.env['STELLAR_ALERTS_API_KEY'];

  let apiUrl = envApiUrl;
  let apiKey: string | undefined = envApiKey;
  let logLevel = process.env['STELLAR_ALERTS_LOG_LEVEL'] ?? 'info';

  if (!apiUrl || !apiKey) {
    // Try to load from profile
    let profile: ProfileConfig | null = null;

    try {
      if (profileName) {
        profile = getProfile(store, profileName);
      } else {
        const activeName = getActiveProfileName(store);
        if (activeName) {
          profile = getProfile(store, activeName);
        }
      }
    } catch {
      // No profiles configured — fall through to defaults
    }

    if (profile) {
      if (!apiUrl) apiUrl = profile.apiUrl;
      if (profile.logLevel && !process.env['STELLAR_ALERTS_LOG_LEVEL']) {
        logLevel = profile.logLevel;
      }

      if (!apiKey && profile.hasSecrets && vaultPassword) {
        try {
          apiKey = await getSecret(store, profile.name, 'apiKey', vaultPassword);
        } catch {
          // Vault not accessible — continue without apiKey
        }
      }
    }
  }

  return {
    apiUrl: apiUrl ?? 'http://localhost:3001',
    apiKey,
    logLevel,
  };
}
