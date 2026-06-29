// Decoder for the AWS event-stream binary framing that Bedrock's
// `invoke-with-response-stream` uses. Each message:
//
//   [4B total length][4B headers length][4B prelude CRC]
//   [headers...][payload...][4B message CRC]
//
// Headers are length-prefixed name/value pairs; Bedrock only emits string
// (type 7) headers. We validate nothing cryptographic (CRCs are skipped — the
// transport already guarantees integrity); we just frame, read headers enough
// to spot `:exception-type`, and hand back the payload.
//
// Pure framing helpers have no VS Code / network imports so they're unit-tested
// with hand-built buffers.

export interface EventStreamFrame {
  headers: Record<string, string>;
  payload: Uint8Array;
}

const HEADER_TYPE_STRING = 7;

/** Parse the length-prefixed header block (string-typed headers only). */
export function decodeHeaders(buf: Buffer): Record<string, string> {
  const headers: Record<string, string> = {};
  let offset = 0;
  while (offset < buf.length) {
    const nameLen = buf.readUInt8(offset);
    offset += 1;
    const name = buf.toString('utf8', offset, offset + nameLen);
    offset += nameLen;
    const valueType = buf.readUInt8(offset);
    offset += 1;
    if (valueType !== HEADER_TYPE_STRING) break; // Bedrock uses only string headers
    const valueLen = buf.readUInt16BE(offset);
    offset += 2;
    headers[name] = buf.toString('utf8', offset, offset + valueLen);
    offset += valueLen;
  }
  return headers;
}

/**
 * Parse one frame from the front of `buf`. Returns the frame plus the
 * remaining bytes, or `null` when the buffer doesn't yet hold a full message.
 */
export function parseFrame(buf: Buffer): { frame: EventStreamFrame; rest: Buffer } | null {
  if (buf.length < 12) return null; // need the prelude
  const totalLen = buf.readUInt32BE(0);
  if (buf.length < totalLen) return null; // wait for the rest of the message
  const headersLen = buf.readUInt32BE(4);

  const headersStart = 12; // 4 total + 4 headers-len + 4 prelude CRC
  const headersEnd = headersStart + headersLen;
  const headers = decodeHeaders(buf.subarray(headersStart, headersEnd));
  const payload = buf.subarray(headersEnd, totalLen - 4); // trailing 4 = message CRC

  return { frame: { headers, payload: new Uint8Array(payload) }, rest: buf.subarray(totalLen) };
}

/**
 * Stream Bedrock chunks: reads the response body, frames it, surfaces
 * `:exception-type` frames as thrown errors, and yields each chunk's inner
 * payload — already base64-unwrapped from the `{"bytes": "..."}` envelope and
 * JSON-parsed into the model's native streaming event.
 */
export async function* streamBedrockChunks(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  read: (r: ReadableStreamDefaultReader<Uint8Array>) => Promise<ReadableStreamReadResult<Uint8Array>>,
): AsyncGenerator<unknown> {
  let buf: Buffer = Buffer.alloc(0);
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await read(reader);
    if (value) buf = Buffer.concat([buf, Buffer.from(value)]);
    let parsed = parseFrame(buf);
    while (parsed) {
      buf = parsed.rest;
      const { headers, payload } = parsed.frame;
      const text = decoder.decode(payload);
      const obj = text ? (JSON.parse(text) as Record<string, unknown>) : {};
      if (headers[':message-type'] === 'exception' || headers[':exception-type']) {
        throw new Error(
          `Bedrock ${headers[':exception-type'] ?? 'exception'}: ${(obj.message as string) ?? text}`,
        );
      }
      if (typeof obj.bytes === 'string') {
        yield JSON.parse(Buffer.from(obj.bytes, 'base64').toString('utf8'));
      } else if (Object.keys(obj).length > 0) {
        yield obj;
      }
      parsed = parseFrame(buf);
    }
    if (done) break;
  }
}
