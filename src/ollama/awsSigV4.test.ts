import { describe, it, expect } from 'vitest';
import { createHash, createHmac } from 'crypto';
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

  // More of the same suite: a POST, a signed content-type with a body, and
  // query keys that must be sorted.
  it.each([
    {
      name: 'post-vanilla',
      method: 'POST',
      headers: {} as Record<string, string>,
      body: '',
      query: undefined,
      signature: '5da7c1a2acd57cee7505fc6676e4e544621c30862966e37dddb68e92efbe5d6b',
    },
    {
      name: 'post-x-www-form-urlencoded',
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'Param1=value1',
      query: undefined,
      signature: 'ff11897932ad3f4e8b18135d722051e5ac45fc38421b1da7b9d196a0fe09473a',
    },
    {
      name: 'get-vanilla-query-order-key-case',
      method: 'GET',
      headers: {},
      body: '',
      query: { Param2: 'value2', Param1: 'value1' },
      signature: 'b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500',
    },
  ])('reproduces AWS $name expected signature', ({ method, headers, body, query, signature }) => {
    const signed = signRequest({
      method,
      origin: 'https://example.amazonaws.com',
      rawPath: '/',
      region: VECTOR.region,
      service: VECTOR.service,
      headers,
      body,
      query,
      credentials: { accessKeyId: VECTOR.accessKeyId, secretAccessKey: VECTOR.secretAccessKey },
      date: VECTOR.date,
    });
    expect(signatureFrom(signed.headers.Authorization)).toBe(signature);
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

  // #112: AWS (every service but S3) canonicalizes the path AS SENT, encoding
  // it again. Signing the once-encoded path failed every InvokeModel call with
  // SignatureDoesNotMatch, since every Bedrock model id has a ':'.
  it('signs the path encoded twice and sends it encoded once (non-S3 SigV4)', () => {
    const { url, canonicalRequest } = signRequest({
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
    expect(url).toBe(
      'https://bedrock-runtime.us-east-1.amazonaws.com/model/anthropic.claude-sonnet-4-20250514-v1%3A0/invoke',
    );
    expect(canonicalRequest.split('\n')[1]).toBe('/model/anthropic.claude-sonnet-4-20250514-v1%253A0/invoke');
  });

  // The canonical-URI example from AWS's "Create a canonical request" page:
  // `/documents and settings/` canonicalizes to `/documents%2520and%2520settings/`.
  it("reproduces AWS's double-encoded canonical URI example", () => {
    const { url, canonicalRequest } = signRequest({
      method: 'GET',
      origin: 'https://example.amazonaws.com',
      rawPath: '/documents and settings/',
      region: VECTOR.region,
      service: VECTOR.service,
      headers: {},
      body: '',
      credentials: { accessKeyId: VECTOR.accessKeyId, secretAccessKey: VECTOR.secretAccessKey },
      date: VECTOR.date,
    });
    expect(canonicalRequest.split('\n')[1]).toBe('/documents%2520and%2520settings/');
    expect(url).toBe('https://example.amazonaws.com/documents%20and%20settings/');
  });

  // The signature over a Bedrock path with ':', checked against one computed
  // here from a hand-written canonical request and the spec's derivation steps
  // (the derivation itself is pinned by the AWS vectors above).
  it('signs a Bedrock InvokeModel path to the independently computed signature', () => {
    const body = '{"x":1}';
    const { url, headers, canonicalRequest } = signRequest({
      method: 'POST',
      origin: 'https://bedrock-runtime.us-east-1.amazonaws.com',
      rawPath: '/model/anthropic.claude-x:0/invoke',
      region: 'us-east-1',
      service: 'bedrock',
      headers: { 'Content-Type': 'application/json' },
      body,
      credentials: { accessKeyId: VECTOR.accessKeyId, secretAccessKey: VECTOR.secretAccessKey },
      date: VECTOR.date,
    });
    const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
    const mac = (k: Buffer | string, s: string) => createHmac('sha256', k).update(s, 'utf8').digest();
    const expectedCanonical = [
      'POST',
      '/model/anthropic.claude-x%253A0/invoke',
      '',
      'content-type:application/json',
      'host:bedrock-runtime.us-east-1.amazonaws.com',
      'x-amz-date:20150830T123600Z',
      '',
      'content-type;host;x-amz-date',
      sha(body),
    ].join('\n');
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      '20150830T123600Z',
      '20150830/us-east-1/bedrock/aws4_request',
      sha(expectedCanonical),
    ].join('\n');
    let key = mac(`AWS4${VECTOR.secretAccessKey}`, '20150830');
    for (const part of ['us-east-1', 'bedrock', 'aws4_request']) key = mac(key, part);
    const expectedSignature = createHmac('sha256', key).update(stringToSign, 'utf8').digest('hex');

    expect(canonicalRequest).toBe(expectedCanonical);
    expect(url).toBe('https://bedrock-runtime.us-east-1.amazonaws.com/model/anthropic.claude-x%3A0/invoke');
    expect(signatureFrom(headers.Authorization)).toBe(expectedSignature);
  });

  it('a path with nothing to encode signs the same as before', () => {
    const { canonicalRequest } = signRequest({
      method: 'GET',
      origin: 'https://bedrock.us-east-1.amazonaws.com',
      rawPath: '/inference-profiles',
      region: 'us-east-1',
      service: 'bedrock',
      headers: {},
      body: '',
      credentials: { accessKeyId: 'AKID', secretAccessKey: 'secret' },
      date: new Date('2025-01-01T00:00:00Z'),
    });
    expect(canonicalRequest.split('\n')[1]).toBe('/inference-profiles');
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
