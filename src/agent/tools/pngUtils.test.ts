import { describe, it, expect, vi, afterEach } from 'vitest';
import * as zlib from 'zlib';
import { resizePngBuffer, MAX_DECODED_PNG_BYTES } from './pngUtils.js';

// A pass-through spy: built-in ESM namespaces can't be spied on directly.
vi.mock('zlib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('zlib')>();
  return { ...actual, inflateSync: vi.fn(actual.inflateSync) };
});
const inflate = vi.mocked(zlib.inflateSync);

/** A minimal 8-bit RGBA PNG: signature, IHDR, one IDAT, IEND (CRCs zeroed; the reader ignores them). */
function png(width: number, height: number, idat: Buffer): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    return Buffer.concat([len, Buffer.from(type, 'ascii'), data, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// #122: decoding had no output limit -- a tiny crafted PNG (a decompression
// bomb) could inflate to gigabytes.
describe('resizePngBuffer decoding limits', () => {
  afterEach(() => inflate.mockClear());

  it('does not inflate an image whose header claims more than the cap', () => {
    const bomb = png(40_000, 40_000, zlib.deflateSync(Buffer.alloc(1024)));
    expect(40_000 * (1 + 40_000 * 4)).toBeGreaterThan(MAX_DECODED_PNG_BYTES);
    expect(resizePngBuffer(bomb, 1_000_000)).toBe(bomb); // left as is
    expect(inflate).not.toHaveBeenCalled();
  });

  it('caps inflate at the size the header implies', () => {
    const w = 2000;
    const h = 1000;
    const img = png(w, h, zlib.deflateSync(Buffer.alloc(h * (1 + w * 4))));
    resizePngBuffer(img, 100_000);
    expect(inflate).toHaveBeenCalledWith(expect.any(Buffer), { maxOutputLength: h * (1 + w * 4) });
  });
});
