import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AwsCredentials } from './awsSigV4.js';

/**
 * Parse a single profile out of an AWS shared-credentials INI file. Pure +
 * testable. Returns the key/value map for `[profile]` (or `[profile name]`
 * in a config file), or null when the section is absent.
 */
export function parseAwsCredentialsIni(content: string, profile: string): Record<string, string> | null {
  const lines = content.split('\n');
  let active: string | null = null;
  const out: Record<string, string> = {};
  let found = false;
  for (const raw of lines) {
    const line = raw.replace(/[;#].*$/, '').trim(); // strip comments
    if (!line) continue;
    const section = /^\[(.+)\]$/.exec(line);
    if (section) {
      // `config` files use "[profile foo]"; credentials files use "[foo]".
      active = section[1].replace(/^profile\s+/, '').trim();
      continue;
    }
    if (active !== profile) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    found = true;
    out[line.slice(0, eq).trim().toLowerCase()] = line.slice(eq + 1).trim();
  }
  return found ? out : null;
}

/**
 * Resolve AWS credentials the way the AWS SDKs do, in priority order:
 * 1. Environment (`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN`).
 * 2. The shared credentials file (`~/.aws/credentials`) for the active profile
 *    (`AWS_PROFILE`, default `default`).
 * Returns null when no static credentials are found — the caller surfaces a
 * clear "configure AWS credentials" error rather than a cryptic 403.
 *
 * Note: role assumption / SSO / IMDS are not resolved here; those need the AWS
 * SDK. Most local dev setups have static keys or a credentials file.
 */
export function resolveAwsCredentials(
  env: NodeJS.ProcessEnv = process.env,
  credentialsPath: string = path.join(os.homedir(), '.aws', 'credentials'),
): AwsCredentials | null {
  if (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) {
    return {
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      sessionToken: env.AWS_SESSION_TOKEN,
    };
  }
  try {
    const ini = parseAwsCredentialsIni(fs.readFileSync(credentialsPath, 'utf8'), env.AWS_PROFILE || 'default');
    if (ini?.aws_access_key_id && ini?.aws_secret_access_key) {
      return {
        accessKeyId: ini.aws_access_key_id,
        secretAccessKey: ini.aws_secret_access_key,
        sessionToken: ini.aws_session_token,
      };
    }
  } catch {
    // no credentials file — fall through
  }
  return null;
}
