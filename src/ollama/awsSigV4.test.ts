import { describe, it, expect } from 'vitest';
import { signRequest } from './awsSigV4.js';

// AWS's published SigV4 test-suite "get-vanilla" vector. If our canonical
// request / string-to-sign / signing-key derivation is correct, we reproduce
// AWS's expected signature exactly.
// https://docs.aws.amazon.com/general/latest/gr/signature-v4-test-suite.html
const VECTOR = {
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  region: 'us-east-1',
  service: 'service',
  date: new Date('2015-08-30T12:36:00Z'),
  expectedSignature: '5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
};

function signatureFrom(authHeader: string): string {
  return /Signature=([0-9a-f]+)/.exec(authHeader)?.[1] ?? '';
}

describe('signRequest (SigV4)', () => {
  it('reproduces AWS get-vanilla expected signature', () => {
    const { headers } = signRequest({
      method: 'GET',
      origin: 'https://example.amazonaws.com',
      rawPath: '/',
      region: VECTOR.region,
      service: VECTOR.service,
      headers: {},
      body: '',
      credentials: { accessKeyId: VECTOR.accessKeyId, secretAccessKey: VECTOR.secretAccessKey },
      date: VECTOR.date,
    });
    expect(signatureFrom(headers.Authorization)).toBe(VECTOR.expectedSignature);
    expect(headers['X-Amz-Date']).toBe('20150830T123600Z');
    expect(headers.Authorization).toContain('SignedHeaders=host;x-amz-date');
    expect(headers.Authorization).toContain(`Credential=${VECTOR.accessKeyId}/20150830/us-east-1/service/aws4_request`);
  });

  it('canonicalizes special characters in the path and signs the same URL it returns', () => {
    const { url, headers } = signRequest({
      method: 'POST',
      origin: 'https://bedrock-runtime.us-east-1.amazonaws.com',
      rawPath: '/model/anthropic.claude-sonnet-4-20250514-v1:0/invoke',
      region: 'us-east-1',
      service: 'bedrock',
      headers: { 'Content-Type': 'application/json' },
      body: '{"x":1}',
      credentials: { accessKeyId: 'AKID', secretAccessKey: 'secret' },
      date: new Date('2025-01-01T00:00:00Z'),
    });
    // The colon in the model id is percent-encoded in both the URL and signature.
    expect(url).toContain('/model/anthropic.claude-sonnet-4-20250514-v1%3A0/invoke');
    expect(headers.Authorization).toContain('content-type'); // content-type folded into signed headers
  });

  it('includes the session token in signed headers when present', () => {
    const { headers } = signRequest({
      method: 'POST',
      origin: 'https://bedrock-runtime.us-east-1.amazonaws.com',
      rawPath: '/model/m/invoke',
      region: 'us-east-1',
      service: 'bedrock',
      headers: {},
      body: '{}',
      credentials: { accessKeyId: 'AKID', secretAccessKey: 'secret', sessionToken: 'TOKEN123' },
      date: new Date('2025-01-01T00:00:00Z'),
    });
    expect(headers.Authorization).toContain('x-amz-security-token');
    expect(headers['X-Amz-Security-Token']).toBe('TOKEN123');
  });
});

describe('signRequest — canonical query strings', () => {
  const base = {
    method: 'GET',
    origin: 'https://bedrock.us-east-1.amazonaws.com',
    rawPath: '/inference-profiles',
    region: 'us-east-1',
    service: 'bedrock',
    headers: {},
    body: '',
    credentials: { accessKeyId: 'AKID', secretAccessKey: 'secret' },
    date: new Date('2026-07-10T12:00:00Z'),
  };

  it('folds query params into the URL, sorted by encoded key', () => {
    const { url } = signRequest({ ...base, query: { nextToken: 'abc/123', maxResults: '1000' } });
    expect(url).toBe('https://bedrock.us-east-1.amazonaws.com/inference-profiles?maxResults=1000&nextToken=abc%2F123');
  });

  it('query participates in the signature (different query, different signature)', () => {
    const a = signRequest({ ...base, query: { maxResults: '1000' } }).headers.Authorization;
    const b = signRequest({ ...base, query: { maxResults: '999' } }).headers.Authorization;
    const none = signRequest({ ...base }).headers.Authorization;
    expect(a).not.toBe(b);
    expect(a).not.toBe(none);
  });

  it('no query keeps the historical signature path (empty canonical query)', () => {
    const { url } = signRequest({ ...base });
    expect(url).toBe('https://bedrock.us-east-1.amazonaws.com/inference-profiles');
  });
});
