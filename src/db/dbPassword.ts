import { getSecretContext } from '../config/settings/secrets.js';
import type { ConnectionProfile } from './provider.js';

/**
 * Database passwords live in VS Code SecretStorage, never in settings. A
 * profile names its key with `secretKey`; without one the key is derived from
 * the profile's id, so a password can be set without inventing a key.
 *
 * Nothing read this before #364: `secretKey` was documented but never looked
 * up, and every connection went out with no password.
 */
export function dbPasswordKey(profile: Pick<ConnectionProfile, 'id' | 'secretKey'>): string {
  return profile.secretKey || `sidecar.dbPassword.${profile.id}`;
}

/** The stored password for a profile, or undefined when none is stored. */
export async function getDbPassword(profile: Pick<ConnectionProfile, 'id' | 'secretKey'>): Promise<string | undefined> {
  const ctx = getSecretContext();
  if (!ctx) return undefined;
  return (await ctx.secrets.get(dbPasswordKey(profile))) || undefined;
}

export async function setDbPassword(
  profile: Pick<ConnectionProfile, 'id' | 'secretKey'>,
  value: string,
): Promise<void> {
  const ctx = getSecretContext();
  if (!ctx) throw new Error('SecretStorage not initialized');
  await ctx.secrets.store(dbPasswordKey(profile), value);
}

export async function clearDbPassword(profile: Pick<ConnectionProfile, 'id' | 'secretKey'>): Promise<void> {
  const ctx = getSecretContext();
  if (!ctx) throw new Error('SecretStorage not initialized');
  await ctx.secrets.delete(dbPasswordKey(profile));
}

/** Network dialects take a password; file dialects don't. */
export function takesPassword(profile: Pick<ConnectionProfile, 'dialect'>): boolean {
  return profile.dialect === 'postgres' || profile.dialect === 'mysql';
}
