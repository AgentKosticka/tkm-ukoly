// Bezeztrátové očištění JPEG souboru od metadat.
//
// Obrazová data (kvantizační tabulky, Huffmanovy tabulky, skeny) zůstávají
// bajt po bajtu stejná. Odstraní se EXIF včetně GPS a vloženého náhledu, XMP,
// IPTC, komentáře, MPF a cokoliv za koncem obrázku (např. video u „živých“
// fotek). Zachová se JFIF, ICC profil a značka Adobe, bez kterých by se barvy
// dekódovaly špatně. Orientace se vrací zpět jako miniaturní EXIF s jediným
// tagem, aby se fotka po stažení zobrazila správně otočená.

const SOI = 0xd8;
const EOI = 0xd9;
const SOS = 0xda;
const APP0 = 0xe0;
const APP2 = 0xe2;
const APP14 = 0xee;
const COM = 0xfe;

const ICC_SIGNATURE = Buffer.from('ICC_PROFILE\0', 'latin1');
const JFIF_SIGNATURE = Buffer.from('JFIF\0', 'latin1');
const ADOBE_SIGNATURE = Buffer.from('Adobe', 'latin1');

export class JpegFormatError extends Error {}

function startsWith(buf, offset, end, signature) {
  if (end - offset < signature.length) return false;
  return buf.compare(signature, 0, signature.length, offset, offset + signature.length) === 0;
}

function keepSegment(marker, buf, dataStart, dataEnd) {
  if (marker === COM) return false;
  if (marker >= 0xe0 && marker <= 0xef) {
    if (marker === APP0) return startsWith(buf, dataStart, dataEnd, JFIF_SIGNATURE);
    if (marker === APP2) return startsWith(buf, dataStart, dataEnd, ICC_SIGNATURE);
    if (marker === APP14) return startsWith(buf, dataStart, dataEnd, ADOBE_SIGNATURE);
    return false;
  }
  return true;
}

function orientationSegment(orientation) {
  // APP1: "Exif\0\0", hlavička TIFF (big endian), jedno IFD s tagem Orientation.
  const seg = Buffer.alloc(36);
  seg.writeUInt16BE(0xffe1, 0);
  seg.writeUInt16BE(34, 2);
  seg.write('Exif\0\0', 4, 'latin1');
  seg.write('MM', 10, 'latin1');
  seg.writeUInt16BE(42, 12);
  seg.writeUInt32BE(8, 14);
  seg.writeUInt16BE(1, 18);
  seg.writeUInt16BE(0x0112, 20);
  seg.writeUInt16BE(3, 22);
  seg.writeUInt32BE(1, 24);
  seg.writeUInt16BE(orientation, 28);
  seg.writeUInt16BE(0, 30);
  seg.writeUInt32BE(0, 32);
  return seg;
}

/**
 * @param {Buffer} input celý JPEG soubor
 * @param {{ orientation?: number }} [options] orientace 1–8 z původního EXIF
 * @returns {Buffer} očištěný JPEG
 */
export function stripJpegMetadata(input, { orientation = 1 } = {}) {
  const len = input.length;
  if (len < 4 || input[0] !== 0xff || input[1] !== SOI) {
    throw new JpegFormatError('Soubor nezačíná značkou SOI');
  }

  const parts = [input.subarray(0, 2)];
  let insertAt = 1;
  let pos = 2;
  let sawScan = false;

  while (true) {
    if (pos >= len) throw new JpegFormatError('Soubor končí před značkou EOI');
    if (input[pos] !== 0xff) throw new JpegFormatError('Očekávána značka segmentu');
    while (pos < len && input[pos] === 0xff) pos += 1;
    if (pos >= len) throw new JpegFormatError('Soubor končí uvnitř značky');
    const marker = input[pos];
    pos += 1;

    if (marker === EOI) {
      if (!sawScan) throw new JpegFormatError('Soubor neobsahuje obrazová data');
      parts.push(Buffer.from([0xff, EOI]));
      break;
    }
    if (marker === 0x00 || marker === SOI) {
      throw new JpegFormatError('Neplatná značka mimo sken');
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      parts.push(Buffer.from([0xff, marker]));
      continue;
    }

    if (pos + 2 > len) throw new JpegFormatError('Zkrácená délka segmentu');
    const segLen = input.readUInt16BE(pos);
    if (segLen < 2 || pos + segLen > len) throw new JpegFormatError('Neplatná délka segmentu');
    const dataStart = pos + 2;
    const dataEnd = pos + segLen;

    if (keepSegment(marker, input, dataStart, dataEnd)) {
      parts.push(Buffer.from([0xff, marker]), input.subarray(pos, dataEnd));
      if (marker === APP0 && !sawScan && insertAt === 1) insertAt = parts.length;
    }
    pos = dataEnd;

    if (marker === SOS) {
      sawScan = true;
      // Entropicky kódovaná data: 0xFF následuje buď 0x00 (výplň), RSTn,
      // nebo další 0xFF. Cokoliv jiného je začátek dalšího segmentu.
      const scanStart = pos;
      while (true) {
        const ff = input.indexOf(0xff, pos);
        if (ff === -1 || ff + 1 >= len) throw new JpegFormatError('Sken není ukončen');
        const next = input[ff + 1];
        if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
          pos = ff + 2;
        } else if (next === 0xff) {
          pos = ff + 1;
        } else {
          pos = ff;
          break;
        }
      }
      parts.push(input.subarray(scanStart, pos));
    }
  }

  if (Number.isInteger(orientation) && orientation >= 2 && orientation <= 8) {
    parts.splice(insertAt, 0, orientationSegment(orientation));
  }
  return Buffer.concat(parts);
}
