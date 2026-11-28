import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseAwsCredentialsIni, resolveAwsCredentials } from './awsCredentials.js';

const INI = `
[default]
aws_access_key_id = AKIA_DEFAULT
aws_secret_access_key = secret_default

[profile work]
aws_access_key_id = AKIA_WORK
aws_secret_access_key = secret_work
aws_session_token = tok_work  ; inline comment
`;

describe('parseAwsCredentialsIni', () => {
  it('parses the default profile', () => {
    expect(parseAwsCredentialsIni(INI, 'default')).toEqual({
      aws_access_key_id: 'AKIA_DEFAULT',
      aws_secret_access_key: 'secret_default',
    });
  });

  it('parses a named profile, stripping the "profile " prefix and comments', () => {
    expect(parseAwsCredentialsIni(INI, 'work')).toEqual({
      aws_access_key_id: 'AKIA_WORK',
      aws_secret_access_key: 'secret_work',
      aws_session_token: 'tok_work',
    });
  });

  it('returns null for an unknown profile', () => {
    expect(parseAwsCredentialsIni(INI, 'nope')).toBeNull();
  });
});

describe('resolveAwsCredentials', () => {
  it('prefers environment variables', () => {
    const creds = resolveAwsCredentials(
      { AWS_ACCESS_KEY_ID: 'ENV_KEY', AWS_SECRET_ACCESS_KEY: 'ENV_SECRET', AWS_SESSION_TOKEN: 'ENV_TOK' },
      '/nonexistent/credentials',
      '/nonexistent/config',
    );
    expect(creds).toEqual({ accessKeyId: 'ENV_KEY', secretAccessKey: 'ENV_SECRET', sessionToken: 'ENV_TOK' });
  });

  it('returns null when there are no env vars and no credentials file', () => {
    expect(resolveAwsCredentials({}, '/nonexistent/credentials', '/nonexistent/config')).toBeNull();
  });
});

// #112: AWS_SHARED_CREDENTIALS_FILE (the AWS CLI/SDK override) was ignored.
describe('AWS_SHARED_CREDENTIALS_FILE', () => {
  it('reads the credentials file it names', async () => {
    const fs = await import('fs');
    const os = await import('os');
    const path = await import('path');
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-aws-')), 'creds');
    fs.writeFileSync(file, '[default]\naws_access_key_id = AKIDFROMFILE\naws_secret_access_key = s3cr3t\n');
    const creds = resolveAwsCredentials({ AWS_SHARED_CREDENTIALS_FILE: file } as NodeJS.ProcessEnv);
    expect(creds?.accessKeyId).toBe('AKIDFROMFILE');
  });
});

// Static keys in the shared config file (AWS_CONFIG_FILE, default ~/.aws/config)
// were never read, though the SDKs accept them there.
describe('AWS_CONFIG_FILE', () => {
  function tempFile(name: string, content: string): string {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-aws-')), name);
    fs.writeFileSync(file, content);
    return file;
  }

  it('reads static keys for the active profile from the config file it names', () => {
    const config = tempFile(
      'config',
      '[profile work]\nregion = us-east-1\naws_access_key_id = AKIDCONFIG\naws_secret_access_key = s3cr3t\n',
    );
    const creds = resolveAwsCredentials({
      AWS_CONFIG_FILE: config,
      AWS_SHARED_CREDENTIALS_FILE: '/nonexistent/credentials',
      AWS_PROFILE: 'work',
    } as NodeJS.ProcessEnv);
    expect(creds).toEqual({ accessKeyId: 'AKIDCONFIG', secretAccessKey: 's3cr3t', sessionToken: undefined });
  });

  it('the credentials file wins over the config file, as in the SDKs', () => {
    const credentials = tempFile(
      'credentials',
      '[default]\naws_access_key_id = AKIDCREDS\naws_secret_access_key = a\n',
    );
    const config = tempFile('config', '[default]\naws_access_key_id = AKIDCONFIG\naws_secret_access_key = b\n');
    const creds = resolveAwsCredentials({
      AWS_SHARED_CREDENTIALS_FILE: credentials,
      AWS_CONFIG_FILE: config,
    } as NodeJS.ProcessEnv);
    expect(creds?.accessKeyId).toBe('AKIDCREDS');
  });
});
