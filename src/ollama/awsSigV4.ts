import { createHash, createHmac } from 'crypto';

// AWS Signature Version 4 signing — enough for Bedrock Runtime POSTs. Pure
// (no VS Code imports), so it's unit-testable against AWS's published vectors.
// We sign from the RAW path and send the request to the same canonicalized
// path, so there's no double-encoding ambiguity (the S3-only rule).

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface SignInput {
  method: string;
  /** Origin, e.g. https://bedrock-runtime.us-east-1.amazonaws.com */
  origin: string;
  /** Raw (un-encoded) path, e.g. /model/anthropic.claude...:0/invoke */
  rawPath: string;
  region: string;
  service: string; // 'bedrock'
  headers: Record<string, string>;
  body: string;
  credentials: AwsCredentials;
  /** Pass the request time for deterministic tests; defaults to now. */
  date: Date;
}

export interface SignedRequest {
  url: string;
  headers: Record<string, string>;
}

/** RFC 3986 encode a single path segment (unreserved: A-Za-z0-9-_.~). */
function encodeSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/[!*'()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** RFC 3986 encode each path segment (preserving slashes) — the canonical form
 *  used both in the SigV4 signature and the request URL, so bearer-auth requests
 *  can reuse it to build an identically-encoded URL. */
export function canonicalizePath(rawPath: string): string {
  return rawPath
    .split('/')
    .map(encodeSegment)
    .join('/');
}

function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

function amzDate(date: Date): { amzdate: string; datestamp: string } {
  const iso = date.toISOString().replace(/[:-]|\.\d{3}/g, ''); // YYYYMMDDTHHMMSSZ
  return { amzdate: iso, datestamp: iso.slice(0, 8) };
}

/**
 * Sign an AWS request with SigV4. Returns the canonicalized URL to fetch and
 * the full header set (including Authorization, X-Amz-Date, Host, and the
 * session token when present).
 */
export function signRequest(input: SignInput): SignedRequest {
  const { amzdate, datestamp } = amzDate(input.date);
  const host = new URL(input.origin).host;
  const canonicalPath = canonicalizePath(input.rawPath);

  // Headers that go into the signature. Host + x-amz-date are mandatory; fold
  // in any caller headers (content-type) and the session token.
  const signed: Record<string, string> = {
    host,
    'x-amz-date': amzdate,
  };
  for (const [k, v] of Object.entries(input.headers)) signed[k.toLowerCase()] = v.trim();
  if (input.credentials.sessionToken) signed['x-amz-security-token'] = input.credentials.sessionToken;

  const sortedHeaderKeys = Object.keys(signed).sort();
  const canonicalHeaders = sortedHeaderKeys.map((k) => `${k}:${signed[k]}\n`).join('');
  const signedHeaders = sortedHeaderKeys.join(';');

  const payloadHash = sha256Hex(input.body);
  const canonicalRequest = [
    input.method.toUpperCase(),
    canonicalPath,
    '', // canonical query string — none for Bedrock invoke
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const scope = `${datestamp}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzdate, scope, sha256Hex(canonicalRequest)].join('\n');

  const kDate = hmac(`AWS4${input.credentials.secretAccessKey}`, datestamp);
  const kRegion = hmac(kDate, input.region);
  const kService = hmac(kRegion, input.service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const outHeaders: Record<string, string> = {
    ...input.headers,
    Host: host,
    'X-Amz-Date': amzdate,
    Authorization: authorization,
  };
  if (input.credentials.sessionToken) outHeaders['X-Amz-Security-Token'] = input.credentials.sessionToken;

  return { url: `${input.origin}${canonicalPath}`, headers: outHeaders };
}
