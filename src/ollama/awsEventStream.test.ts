import { describe, it, expect } from 'vitest';
import { parseFrame, decodeHeaders, streamBedrockChunks } from './awsEventStream.js';

function strHeader(name: string, value: string): Buffer {
  const nameBuf = Buffer.from(name, 'utf8');
  const valBuf = Buffer.from(value, 'utf8');
  const out = Buffer.alloc(1 + nameBuf.length + 1 + 2 + valBuf.length);
  let o = 0;
  out.writeUInt8(nameBuf.length, o);
  o += 1;
  nameBuf.copy(out, o);
  o += nameBuf.length;
  out.writeUInt8(7, o);
  o += 1; // string type
  out.writeUInt16BE(valBuf.length, o);
  o += 2;
  valBuf.copy(out, o);
  return out;
}

function buildFrame(headers: Record<string, string>, payload: object): Buffer {
  const headerBuf = Buffer.concat(Object.entries(headers).map(([k, v]) => strHeader(k, v)));
  const payloadBuf = Buffer.from(JSON.stringify(payload), 'utf8');
  const totalLen = 12 + headerBuf.length + payloadBuf.length + 4;
  const out = Buffer.alloc(totalLen);
  out.writeUInt32BE(totalLen, 0);
  out.writeUInt32BE(headerBuf.length, 4);
  out.writeUInt32BE(0, 8); // prelude CRC (unchecked)
  headerBuf.copy(out, 12);
  payloadBuf.copy(out, 12 + headerBuf.length);
  out.writeUInt32BE(0, totalLen - 4); // message CRC (unchecked)
  return out;
}

/** A Bedrock chunk wraps the model event as base64 under `bytes`. */
function chunkFrame(innerEvent: object): Buffer {
  const bytes = Buffer.from(JSON.stringify(innerEvent), 'utf8').toString('base64');
  return buildFrame({ ':message-type': 'event', ':event-type': 'chunk' }, { bytes });
}

describe('decodeHeaders', () => {
  it('parses string headers', () => {
    const h = Buffer.concat([strHeader(':event-type', 'chunk'), strHeader(':message-type', 'event')]);
    expect(decodeHeaders(h)).toEqual({ ':event-type': 'chunk', ':message-type': 'event' });
  });
});

describe('parseFrame', () => {
  it('returns null when the buffer is shorter than the declared message', () => {
    const frame = chunkFrame({ type: 'x' });
    expect(parseFrame(frame.subarray(0, frame.length - 5))).toBeNull();
  });

  it('parses one frame and returns the remainder', () => {
    const a = chunkFrame({ type: 'a' });
    const b = chunkFrame({ type: 'b' });
    const res = parseFrame(Buffer.concat([a, b]));
    expect(res).not.toBeNull();
    expect(res!.rest.length).toBe(b.length);
  });
});

async function* once<T>(items: T[]): AsyncGenerator<T> {
  for (const i of items) yield i;
}

function readerFrom(chunks: Buffer[]): {
  reader: ReadableStreamDefaultReader<Uint8Array>;
  read: (r: ReadableStreamDefaultReader<Uint8Array>) => Promise<ReadableStreamReadResult<Uint8Array>>;
} {
  const gen = once(chunks);
  const read = async (): Promise<ReadableStreamReadResult<Uint8Array>> => {
    const { value, done } = await gen.next();
    return done ? { done: true, value: undefined } : { done: false, value: new Uint8Array(value) };
  };
  return { reader: {} as ReadableStreamDefaultReader<Uint8Array>, read };
}

describe('streamBedrockChunks', () => {
  it('unwraps base64 bytes and yields the inner model events', async () => {
    const { reader, read } = readerFrom([
      chunkFrame({ type: 'message_start' }),
      chunkFrame({ type: 'content_block_delta' }),
    ]);
    const out: unknown[] = [];
    for await (const ev of streamBedrockChunks(reader, read)) out.push(ev);
    expect(out).toEqual([{ type: 'message_start' }, { type: 'content_block_delta' }]);
  });

  it('reassembles a frame split across two reads', async () => {
    const frame = chunkFrame({ type: 'text_delta' });
    const { reader, read } = readerFrom([frame.subarray(0, 10), frame.subarray(10)]);
    const out: unknown[] = [];
    for await (const ev of streamBedrockChunks(reader, read)) out.push(ev);
    expect(out).toEqual([{ type: 'text_delta' }]);
  });

  it('throws on an exception frame', async () => {
    const exc = buildFrame(
      { ':message-type': 'exception', ':exception-type': 'throttlingException' },
      { message: 'Rate exceeded' },
    );
    const { reader, read } = readerFrom([exc]);
    await expect(async () => {
      for await (const _ of streamBedrockChunks(reader, read)) void _;
    }).rejects.toThrow(/throttlingException: Rate exceeded/);
  });
});
