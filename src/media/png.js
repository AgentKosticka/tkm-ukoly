// Očištění PNG od metadat bez překódování obrazu.
//
// PNG je řada bloků (chunků). Ponechají se jen ty, které určují, jak obraz
// vypadá: rozměry, paleta, obrazová data, průhlednost a barevný prostor.
// Textové poznámky, EXIF, čas úpravy a všechno neznámé se vypustí. Bloky se
// kopírují celé i s kontrolním součtem, takže se nic nepřepočítává.

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const KEEP = new Set([
  'IHDR', 'PLTE', 'IDAT', 'IEND',
  'tRNS', 'gAMA', 'cHRM', 'sRGB', 'iCCP', 'cICP', 'sBIT', 'pHYs',
]);
const ANIMATION = new Set(['acTL', 'fcTL', 'fdAT']);

export class PngFormatError extends Error {}

/**
 * @param {Buffer} input celý soubor PNG
 * @returns {{ data: Buffer, animated: boolean }}
 */
export function stripPngMetadata(input) {
  if (input.length < 8 + 12 || !input.subarray(0, 8).equals(SIGNATURE)) {
    throw new PngFormatError('Soubor není PNG');
  }
  const parts = [SIGNATURE];
  let pos = 8;
  let animated = false;
  let sawHeader = false;
  let sawData = false;
  let sawEnd = false;

  while (pos + 12 <= input.length) {
    const length = input.readUInt32BE(pos);
    const type = input.toString('latin1', pos + 4, pos + 8);
    const end = pos + 12 + length;
    if (length > 0x7fffffff || end > input.length) throw new PngFormatError('Blok přesahuje konec souboru');
    if (!sawHeader && type !== 'IHDR') throw new PngFormatError('PNG nezačíná hlavičkou');

    if (type === 'IHDR') sawHeader = true;
    if (type === 'IDAT') sawData = true;
    if (ANIMATION.has(type)) animated = true;
    if (KEEP.has(type)) parts.push(input.subarray(pos, end));
    pos = end;

    if (type === 'IEND') {
      // Cokoliv za koncem obrázku se zahodí.
      sawEnd = true;
      break;
    }
  }

  if (!sawHeader || !sawData || !sawEnd) throw new PngFormatError('PNG je neúplné');
  return { data: Buffer.concat(parts), animated };
}
