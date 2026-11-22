// Očištění WebP kontejneru od metadat bez překódování obrazu.
//
// Jednoduchý WebP (jen chunk VP8 nebo VP8L) žádná metadata nést nemůže.
// Rozšířený formát (VP8X) může obsahovat chunky EXIF a XMP; ty se vypustí
// a v hlavičce se shodí odpovídající příznaky. Obrazová data zůstávají beze změny.

const FLAG_XMP = 0x04;
const FLAG_EXIF = 0x08;

export class WebpFormatError extends Error {}

/**
 * @param {Buffer} input celý soubor WebP
 * @returns {{ data: Buffer, lossless: boolean, animated: boolean }}
 */
export function stripWebpMetadata(input) {
  const len = input.length;
  if (len < 20 || input.toString('latin1', 0, 4) !== 'RIFF' || input.toString('latin1', 8, 12) !== 'WEBP') {
    throw new WebpFormatError('Soubor není WebP');
  }
  const riffEnd = Math.min(len, 8 + input.readUInt32LE(4));

  const chunks = [];
  let lossless = false;
  let lossy = false;
  let animated = false;
  let pos = 12;

  while (pos + 8 <= riffEnd) {
    const fourcc = input.toString('latin1', pos, pos + 4);
    const size = input.readUInt32LE(pos + 4);
    const dataEnd = pos + 8 + size;
    if (dataEnd > riffEnd) throw new WebpFormatError('Chunk přesahuje konec souboru');
    const paddedEnd = Math.min(riffEnd, dataEnd + (size & 1));

    if (fourcc === 'VP8L') lossless = true;
    if (fourcc === 'VP8 ') lossy = true;
    if (fourcc === 'ANIM' || fourcc === 'ANMF') animated = true;

    if (fourcc !== 'EXIF' && fourcc !== 'XMP ') {
      let chunk = input.subarray(pos, paddedEnd);
      if (fourcc === 'VP8X') {
        if (size < 10) throw new WebpFormatError('Neplatná hlavička VP8X');
        chunk = Buffer.from(chunk);
        chunk[8] &= ~(FLAG_EXIF | FLAG_XMP);
      }
      if ((chunk.length & 1) === 1) chunk = Buffer.concat([chunk, Buffer.alloc(1)]);
      chunks.push(chunk);
    }
    pos = paddedEnd;
  }

  if (!lossless && !lossy && !animated) throw new WebpFormatError('WebP neobsahuje obrazová data');

  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(4 + body.length, 4);
  header.write('WEBP', 8, 'latin1');
  return { data: Buffer.concat([header, body]), lossless: lossless && !lossy, animated };
}
