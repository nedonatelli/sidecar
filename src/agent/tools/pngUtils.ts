/**
 * Pure-Node PNG resizer — no native deps, no VS Code imports.
 *
 * Exported: resizePngBuffer (called by vision.ts before VLM upload).
 * Internals: paethPredictor, computeCrc32, buildPngChunk, encodePng.
 */

import * as zlib from 'zlib';

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function computeCrc32(buf: Buffer): number {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function buildPngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.allocUnsafe(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.allocUnsafe(4);
  crcBuf.writeUInt32BE(computeCrc32(Buffer.concat([typeBytes, data])), 0);
  return Buffer.concat([lenBuf, typeBytes, data, crcBuf]);
}

/**
 * Encode raw pixel data as a minimal PNG (IHDR + single IDAT + IEND).
 * Uses filter type 0 (None) for every row — simpler and fast for downsampled output.
 * Only supports 8-bit RGB (colorType 2) and 8-bit RGBA (colorType 6).
 */
function encodePng(pixels: Buffer, width: number, height: number, colorType: number): Buffer {
  const channels = colorType === 6 ? 4 : 3;
  // One filter byte (0) per row + pixel data.
  const stride = 1 + width * channels;
  const rawData = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    rawData[y * stride] = 0; // filter None
    pixels.copy(rawData, y * stride + 1, y * width * channels, (y + 1) * width * channels);
  }
  const compressed = zlib.deflateSync(rawData);

  const ihdrData = Buffer.allocUnsafe(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8;
  ihdrData[9] = colorType;
  ihdrData[10] = 0;
  ihdrData[11] = 0;
  ihdrData[12] = 0;

  const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    PNG_SIG,
    buildPngChunk('IHDR', ihdrData),
    buildPngChunk('IDAT', compressed),
    buildPngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Resize a PNG buffer so total pixel count ≤ maxPixels, using nearest-neighbor
 * sampling. Handles 8-bit non-interlaced RGB (color type 2) and RGBA (color type 6).
 * Returns the original buffer unchanged for unsupported formats or if already small.
 * Uses only Node.js built-ins: Buffer + zlib.
 */
export function resizePngBuffer(buf: Buffer, maxPixels: number): Buffer {
  const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) if (buf[i] !== PNG_SIG[i]) return buf;

  // IHDR is always the first chunk, starting at offset 8.
  if (buf.length < 33) return buf;
  const ihdrLen = buf.readUInt32BE(8);
  if (ihdrLen !== 13 || buf.slice(12, 16).toString('ascii') !== 'IHDR') return buf;

  const srcWidth = buf.readUInt32BE(16);
  const srcHeight = buf.readUInt32BE(20);
  const bitDepth = buf[24];
  const colorType = buf[25];
  // IHDR data: width(4)+height(4)+bitDepth(1)+colorType(1)+compression(1)+filter(1)+interlace(1)
  // File offsets: 16+4+4+1+1+1+1 = offset 28 for interlace (29 would be first CRC byte).
  const interlace = buf[28];

  if (bitDepth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6)) return buf;
  if (srcWidth === 0 || srcHeight === 0) return buf;
  if (srcWidth * srcHeight <= maxPixels) return buf;

  // Collect all IDAT chunks.
  const idatParts: Buffer[] = [];
  let offset = 8;
  while (offset + 12 <= buf.length) {
    const chunkLen = buf.readUInt32BE(offset);
    const chunkType = buf.slice(offset + 4, offset + 8).toString('ascii');
    if (chunkType === 'IDAT' && offset + 8 + chunkLen <= buf.length) {
      idatParts.push(buf.slice(offset + 8, offset + 8 + chunkLen));
    }
    if (chunkType === 'IEND') break;
    offset += 12 + chunkLen;
  }
  if (idatParts.length === 0) return buf;

  let raw: Buffer;
  try {
    raw = zlib.inflateSync(Buffer.concat(idatParts));
  } catch {
    return buf;
  }

  const channels = colorType === 6 ? 4 : 3;
  const stride = 1 + srcWidth * channels;
  if (raw.length < srcHeight * stride) return buf;

  // Reconstruct pixel rows (undo PNG per-row filters).
  const pixels = Buffer.alloc(srcWidth * srcHeight * channels);
  for (let y = 0; y < srcHeight; y++) {
    const filter = raw[y * stride];
    const rowIn = y * stride + 1;
    const rowOut = y * srcWidth * channels;
    const prevOut = (y - 1) * srcWidth * channels;
    for (let x = 0; x < srcWidth * channels; x++) {
      const filt = raw[rowIn + x];
      const a = x >= channels ? pixels[rowOut + x - channels] : 0;
      const b = y > 0 ? pixels[prevOut + x] : 0;
      const c = y > 0 && x >= channels ? pixels[prevOut + x - channels] : 0;
      let recon: number;
      switch (filter) {
        case 1:
          recon = (filt + a) & 0xff;
          break;
        case 2:
          recon = (filt + b) & 0xff;
          break;
        case 3:
          recon = (filt + Math.floor((a + b) / 2)) & 0xff;
          break;
        case 4:
          recon = (filt + paethPredictor(a, b, c)) & 0xff;
          break;
        default:
          recon = filt; // filter 0 (None) or unknown
      }
      pixels[rowOut + x] = recon;
    }
  }

  // Compute target dimensions maintaining aspect ratio.
  const scale = Math.sqrt(maxPixels / (srcWidth * srcHeight));
  const dstWidth = Math.max(1, Math.floor(srcWidth * scale));
  const dstHeight = Math.max(1, Math.floor(srcHeight * scale));

  // Nearest-neighbor downsample.
  const dstPixels = Buffer.alloc(dstWidth * dstHeight * channels);
  for (let dy = 0; dy < dstHeight; dy++) {
    const sy = Math.floor((dy / dstHeight) * srcHeight);
    for (let dx = 0; dx < dstWidth; dx++) {
      const sx = Math.floor((dx / dstWidth) * srcWidth);
      const si = (sy * srcWidth + sx) * channels;
      const di = (dy * dstWidth + dx) * channels;
      for (let ch = 0; ch < channels; ch++) dstPixels[di + ch] = pixels[si + ch];
    }
  }

  return encodePng(dstPixels, dstWidth, dstHeight, colorType);
}
