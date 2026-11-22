import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { HttpError } from '../http/errors.js';
import { Semaphore } from '../util/semaphore.js';
import { createJxl } from './jxl.js';
import { stripJpegMetadata } from './jpeg.js';
import { stripPngMetadata } from './png.js';
import { stripWebpMetadata } from './webp.js';

sharp.cache(false);
sharp.concurrency(2);

// Zmenšené verze pro zobrazení. Jsou ztrátové a malé; originál je v archivu.
const VIEW_SIZE = 1600;
const THUMB_SIZE = 400;
const COMPARE_STRIP_PIXELS = 8_000_000;
const PHOTO_ID = /^[A-Za-z0-9_-]{22}$/;

const EXTENSION = { jxl: 'jxl', jpeg: 'jpg', png: 'png', webp: 'webp' };
const CONTENT_TYPE = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

const unsupported = () =>
  new HttpError(415, 'unsupported_type', 'Nahrát lze jen fotky ve formátu JPEG, PNG nebo WebP');
const unreadable = () =>
  new HttpError(422, 'invalid_image', 'Soubor se nepodařilo přečíst jako fotku. Možná je poškozený');

/** Typ se určuje z obsahu souboru, nikdy z názvu ani z hlavičky od klienta. */
export function sniffImageType(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) return 'png';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
    return 'webp';
  }
  return null;
}

export const isPhotoId = (value) => typeof value === 'string' && PHOTO_ID.test(value);

/**
 * Přesune soubor. Složka pro fotky může být na jiném disku než dočasné
 * soubory a tam přejmenování nejde (EXDEV); pak se soubor zkopíruje.
 * Existující cíl se nikdy nepřepíše.
 */
export async function moveFile(source, target) {
  try {
    await fsp.link(source, target);
  } catch (err) {
    if (err.code === 'EEXIST') throw err;
    await fsp.copyFile(source, target, fsp.constants.COPYFILE_EXCL);
  }
  await fsp.rm(source, { force: true });
}

// Chyby, které znamenají špatné nastavení: s nimi se aplikace nespustí.
// Všechno ostatní (síťový disk neodpovídá, chyba čtení) je výpadek úložiště.
const SETUP_ERRORS = new Set(['EACCES', 'EPERM', 'EROFS', 'ENOTDIR']);
const PROBE_TIMEOUT_MS = 10_000;

const storageUnavailable = () =>
  new HttpError(503, 'storage_unavailable', 'Úložiště fotek teď není dostupné. Zkuste to prosím později');

/**
 * Ověří, že složka pro fotky existuje a jde do ní zapisovat.
 *
 * Když do ní aplikace zapisovat nesmí, jde o chybu nastavení a start skončí
 * s návodem, jak ji opravit. Když složka jen neodpovídá (typicky síťový disk
 * mimo provoz), aplikace se spustí i tak: úkoly fungují dál, místo fotek je
 * v rozhraní šedé pole a nahrávání hlásí chybu, dokud se úložiště nevrátí.
 */
async function preparePhotosDir(config, log) {
  // Na hostiteli se složka může jmenovat jinak než v kontejneru; v hlášení
  // je ta, kterou správce zná ze souboru .env.
  const shown = config.photosHostDir ?? config.photosDir;
  const probe = path.join(config.photosDir, `.zapis-${crypto.randomBytes(6).toString('hex')}`);
  const attempt = (async () => {
    await fsp.mkdir(config.photosDir, { recursive: true, mode: 0o700 });
    await fsp.writeFile(probe, '', { flag: 'wx', mode: 0o600 });
    await fsp.rm(probe, { force: true });
  })();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(Object.assign(new Error('složka neodpověděla včas'), { code: 'ETIMEDOUT' })),
      config.photosProbeMs ?? PROBE_TIMEOUT_MS,
    );
  });
  try {
    await Promise.race([attempt, timeout]);
    return true;
  } catch (err) {
    if (SETUP_ERRORS.has(err.code)) {
      const owner = typeof process.getuid === 'function' ? `${process.getuid()}:${process.getgid()}` : null;
      const hint = owner ? ` Složka musí patřit uživateli, pod kterým aplikace běží: chown -R ${owner} ${shown}` : '';
      throw new Error(`Do složky pro fotky ${shown} nejde zapisovat (${err.code}).${hint}`, { cause: err });
    }
    log.error(
      `Složka pro fotky ${shown} teď není dostupná (${err.code ?? err.message}). ` +
        'Aplikace běží dál; fotky se nezobrazí a nepůjdou nahrávat, dokud se úložiště nevrátí',
    );
    return false;
  } finally {
    clearTimeout(timer);
    // Pokus, který doběhne až po limitu, už nikoho nezajímá.
    attempt.catch(() => {});
  }
}

export async function createPhotoStore(config, log) {
  const storageReady = await preparePhotosDir(config, log);
  // Po pádu mohly zůstat rozpracované soubory.
  await fsp.rm(config.tmpDir, { recursive: true, force: true });
  await fsp.mkdir(config.tmpDir, { recursive: true, mode: 0o700 });

  const jxl = await createJxl(config, log);
  // Zpracování obrázků je paměťově náročné, proto běží po jednom.
  const gate = new Semaphore(1, 12);
  const decodeOptions = { limitInputPixels: config.maxImagePixels, failOn: 'error', sequentialRead: true };
  const open = (input) => sharp(input, decodeOptions);

  function fileFor(id, variant, archiveFormat) {
    const dir = path.join(config.photosDir, id.slice(0, 2));
    if (variant === 'thumb' || variant === 'view') return path.join(dir, `${id}.${variant}.webp`);
    return path.join(dir, `${id}.orig.${EXTENSION[archiveFormat]}`);
  }

  /** Porovná dva obrázky pixel po pixelu, po pásech kvůli paměti. */
  async function sameImage(a, b, depth) {
    const [ma, mb] = await Promise.all([open(a).metadata(), open(b).metadata()]);
    if (ma.width !== mb.width || ma.height !== mb.height || ma.channels !== mb.channels) return false;
    if (Boolean(ma.hasAlpha) !== Boolean(mb.hasAlpha)) return false;
    const iccA = ma.icc ?? Buffer.alloc(0);
    const iccB = mb.icc ?? Buffer.alloc(0);
    if (!iccA.equals(iccB)) return false;
    const rows = Math.max(1, Math.floor(COMPARE_STRIP_PIXELS / ma.width));
    for (let top = 0; top < ma.height; top += rows) {
      const region = { left: 0, top, width: ma.width, height: Math.min(rows, ma.height - top) };
      const [pa, pb] = await Promise.all([
        open(a).extract(region).raw({ depth }).toBuffer(),
        open(b).extract(region).raw({ depth }).toBuffer(),
      ]);
      if (!pa.equals(pb)) return false;
    }
    return true;
  }

  // `direct` znamená, že se archiv bude rovnou i zobrazovat (malé fotky),
  // takže musí zůstat ve formátu, který prohlížeč umí: bez JPEG XL.
  async function archiveJpeg(input, meta, work, direct) {
    let clean;
    try {
      clean = stripJpegMetadata(input, { orientation: meta.orientation ?? 1 });
      const check = await open(clean).metadata();
      if (check.format !== 'jpeg' || check.width !== meta.width || check.height !== meta.height) {
        throw new Error('očištěný JPEG se liší od původního');
      }
    } catch (err) {
      log.warn({ err: err.message }, 'JPEG nejde očistit beze ztráty, ukládám pixely');
      return archivePixels(input, meta, work, null, direct);
    }

    if (!direct && jxl.available && meta.width * meta.height <= config.jxlMaxPixels) {
      try {
        const source = path.join(work, 'clean.jpg');
        const packed = path.join(work, 'archive.jxl');
        const restored = path.join(work, 'restored.jpg');
        await fsp.writeFile(source, clean, { mode: 0o600 });
        await jxl.encodeJpeg(source, packed);
        await jxl.decode(packed, restored);
        // Archiv se použije jen tehdy, když z něj jde původní soubor vrátit
        // bajt po bajtu a opravdu je menší.
        const [back, stat] = await Promise.all([fsp.readFile(restored), fsp.stat(packed)]);
        if (back.equals(clean) && stat.size < clean.length) {
          return { format: 'jxl', restoresTo: 'jpeg', file: packed, bytes: stat.size };
        }
        log.warn('JPEG XL archiv neprošel kontrolou, ukládám očištěný JPEG');
      } catch (err) {
        log.warn({ err: err.message }, 'Rekomprese do JPEG XL selhala, ukládám očištěný JPEG');
      }
    }
    return { format: 'jpeg', restoresTo: 'jpeg', data: clean, bytes: clean.length };
  }

  /**
   * Bezeztrátové uložení pixelů. `keepAsIs` je už očištěný původní soubor
   * (bezeztrátový WebP), který se použije, pokud vyjde nejmenší.
   */
  async function archivePixels(input, meta, work, keepAsIs, direct) {
    const depth = meta.depth === 'ushort' ? 'ushort' : 'uchar';
    // Referenční podoba: otočená podle EXIF, bez metadat, se zachovaným barevným profilem.
    const reference = await open(input).rotate().keepIccProfile().png({ compressionLevel: 6 }).toBuffer();
    const candidates = [];
    if (keepAsIs) {
      try {
        // I očištěný originál musí dát přesně stejné pixely jako vstup.
        if (await sameImage(reference, keepAsIs.data, depth)) {
          candidates.push({ format: keepAsIs.format, restoresTo: keepAsIs.format, data: keepAsIs.data });
        }
      } catch (err) {
        log.warn({ err: err.message }, 'Očištěný originál nejde přečíst');
      }
    }

    if (!direct && jxl.available && meta.width * meta.height <= config.jxlMaxPixels / 2) {
      try {
        const source = path.join(work, 'pixels.png');
        const packed = path.join(work, 'archive.jxl');
        const restored = path.join(work, 'restored.png');
        await fsp.writeFile(source, reference, { mode: 0o600 });
        await jxl.encodePixels(source, packed);
        await jxl.decode(packed, restored);
        if (await sameImage(reference, restored, depth)) {
          candidates.push({ format: 'jxl', restoresTo: 'png', file: packed });
        } else {
          log.warn('JPEG XL archiv neprošel kontrolou pixelů');
        }
      } catch (err) {
        log.warn({ err: err.message }, 'Kódování do JPEG XL selhalo');
      }
    }

    if (!candidates.some((c) => c.format === 'jxl') && depth === 'uchar') {
      try {
        const webp = await open(reference).keepIccProfile().webp({ lossless: true, effort: 4 }).toBuffer();
        if (await sameImage(reference, webp, depth)) {
          candidates.push({ format: 'webp', restoresTo: 'webp', data: webp });
        }
      } catch (err) {
        log.warn({ err: err.message }, 'Bezeztrátový WebP se nepodařilo vytvořit');
      }
    }

    if (candidates.length === 0) {
      const png = await open(reference).keepIccProfile().png({ compressionLevel: 9, effort: 7 }).toBuffer();
      candidates.push({ format: 'png', restoresTo: 'png', data: png });
    }

    for (const candidate of candidates) {
      candidate.bytes = candidate.data ? candidate.data.length : (await fsp.stat(candidate.file)).size;
    }
    candidates.sort((x, y) => x.bytes - y.bytes);
    return candidates[0];
  }

  async function archivePng(input, meta, work, direct) {
    let stripped;
    try {
      stripped = stripPngMetadata(input);
    } catch {
      throw unreadable();
    }
    if (stripped.animated) throw unsupported();
    // Původní soubor bez metadat je záloha pro případ, že by nové zakódování
    // vyšlo větší (typicky u obrázků s paletou).
    const upright = (meta.orientation ?? 1) === 1;
    return archivePixels(input, meta, work, upright ? { format: 'png', data: stripped.data } : null, direct);
  }

  async function archiveWebp(input, meta, work, direct) {
    let stripped;
    try {
      stripped = stripWebpMetadata(input);
    } catch {
      throw unreadable();
    }
    if (stripped.animated) throw unsupported();
    const rotated = (meta.orientation ?? 1) !== 1;
    if (stripped.lossless || rotated) {
      const keep = stripped.lossless && !rotated ? { format: 'webp', data: stripped.data } : null;
      return archivePixels(input, meta, work, keep, direct);
    }
    // Ztrátový WebP by bezeztrátovým překódováním několikanásobně narostl,
    // proto zůstává, jak je, jen bez metadat.
    const check = await open(stripped.data).metadata();
    if (check.format !== 'webp' || check.width !== meta.width || check.height !== meta.height) throw unreadable();
    return { format: 'webp', restoresTo: 'webp', data: stripped.data, bytes: stripped.data.length };
  }

  async function ingestNow(uploadPath) {
    const input = await fsp.readFile(uploadPath);
    if (input.length === 0) throw unreadable();
    if (input.length > config.maxUploadBytes) {
      throw new HttpError(413, 'too_large', 'Fotka je větší než 20 MB');
    }
    const type = sniffImageType(input);
    if (!type) throw unsupported();

    // Čte se jen hlavička, proto zatím bez limitu na počet pixelů; ten se
    // kontroluje hned pod tím, ještě před jakýmkoliv dekódováním.
    let meta;
    try {
      meta = await sharp(input, { failOn: 'error', limitInputPixels: false }).metadata();
    } catch {
      throw unreadable();
    }
    if (meta.format !== type) throw unsupported();
    if ((meta.pages ?? 1) > 1) throw unsupported();
    if (!meta.width || !meta.height) throw unreadable();
    if (meta.width * meta.height > config.maxImagePixels) {
      throw new HttpError(413, 'too_many_pixels', 'Fotka má příliš velké rozlišení');
    }

    const id = crypto.randomBytes(16).toString('base64url');
    const work = path.join(config.tmpDir, id);
    await fsp.mkdir(work, { mode: 0o700 });
    try {
      // Malá fotka se zobrazuje rovnou z archivu; zvláštní zobrazovací verze
      // by zabrala skoro tolik místa jako ona sama.
      const direct = Math.max(meta.width, meta.height) <= VIEW_SIZE;

      // Vytvoření náhledů zároveň ověří, že soubor jde celý dekódovat.
      let view = null;
      let thumb;
      let color;
      try {
        const resize = (size) => ({ width: size, height: size, fit: 'inside', withoutEnlargement: true });
        if (!direct) {
          view = await open(input).rotate().resize(resize(VIEW_SIZE)).webp({ quality: 80, effort: 5 }).toBuffer();
        }
        thumb = await open(input).rotate().resize(resize(THUMB_SIZE)).webp({ quality: 72, effort: 5 }).toBuffer();
        const pixel = await sharp(thumb).flatten({ background: '#ffffff' }).resize(1, 1, { fit: 'fill' }).raw().toBuffer();
        color = `#${pixel.subarray(0, 3).toString('hex')}`;
      } catch (err) {
        log.info({ err: err.message }, 'Nahraný soubor nejde dekódovat');
        throw unreadable();
      }

      // Rozměry po otočení podle EXIF, tedy tak, jak se fotka zobrazí.
      const turned = (meta.orientation ?? 1) >= 5;
      const width = turned ? meta.height : meta.width;
      const height = turned ? meta.width : meta.height;

      let archive;
      if (type === 'jpeg') archive = await archiveJpeg(input, meta, work, direct);
      else if (type === 'webp') archive = await archiveWebp(input, meta, work, direct);
      else archive = await archivePng(input, meta, work, direct);

      try {
        const dir = path.dirname(fileFor(id, 'thumb'));
        await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
        const archiveTarget = fileFor(id, 'orig', archive.format);
        if (archive.file) await moveFile(archive.file, archiveTarget);
        else await fsp.writeFile(archiveTarget, archive.data, { mode: 0o600, flag: 'wx' });
        if (view) await fsp.writeFile(fileFor(id, 'view'), view, { mode: 0o600, flag: 'wx' });
        await fsp.writeFile(fileFor(id, 'thumb'), thumb, { mode: 0o600, flag: 'wx' });
      } catch (err) {
        // Fotka je zpracovaná, jen ji není kam uložit.
        log.error({ err: err.message, code: err.code }, 'Fotku se nepodařilo uložit do složky pro fotky');
        throw storageUnavailable();
      }

      return {
        id,
        width,
        height,
        color,
        sourceFormat: type,
        sourceBytes: input.length,
        archiveFormat: archive.format,
        archiveRestoresTo: archive.restoresTo,
        archiveBytes: archive.bytes,
      };
    } catch (err) {
      await removeFiles(id);
      throw err;
    } finally {
      await fsp.rm(work, { recursive: true, force: true });
    }
  }

  async function removeFiles(id) {
    if (!isPhotoId(id)) return;
    const dir = path.join(config.photosDir, id.slice(0, 2));
    const names = await fsp.readdir(dir).catch(() => []);
    await Promise.all(
      names.filter((name) => name.startsWith(`${id}.`)).map((name) => fsp.rm(path.join(dir, name), { force: true })),
    );
  }

  return {
    jxlAvailable: jxl.available,
    /** Jestli složka pro fotky při startu odpovídala. */
    storageReady,

    /** Zpracuje nahraný dočasný soubor a uloží náhled, zobrazovací verzi a archiv. */
    ingest: (uploadPath) => gate.run(() => ingestNow(uploadPath)),

    remove: removeFiles,

    /**
     * Kolik ze zadaných fotek nemá na disku náhled. Slouží ke kontrole po
     * startu: fotky v databázi, které ve složce nejsou, znamenají nejspíš
     * přesměrovanou složku bez zkopírovaných souborů.
     */
    async countMissing(ids) {
      const present = await Promise.all(
        ids.filter(isPhotoId).map((id) => fsp.access(fileFor(id, 'thumb')).then(() => true, () => false)),
      );
      return present.filter((ok) => !ok).length;
    },

    /**
     * Soubor pro zobrazení na stránce: náhled, nebo větší verze. Malé fotky
     * větší verzi nemají a zobrazují se rovnou z archivu.
     */
    async displayFile(photo, variant) {
      if (!isPhotoId(photo.id) || (variant !== 'thumb' && variant !== 'view')) return null;
      const stat = (file) => fsp.stat(file).then((info) => info, () => null);
      const derived = fileFor(photo.id, variant);
      let info = await stat(derived);
      if (info) return { file: derived, size: info.size, contentType: 'image/webp' };
      if (variant !== 'view' || photo.archive_format === 'jxl') return null;
      const archived = fileFor(photo.id, 'orig', photo.archive_format);
      info = await stat(archived);
      return info ? { file: archived, size: info.size, contentType: CONTENT_TYPE[photo.archive_format] } : null;
    },

    /**
     * Připraví původní soubor ke stažení. U archivu v JPEG XL ho nejdřív
     * rozbalí do dočasného souboru; `cleanup` ho po odeslání smaže.
     */
    async original(photo) {
      const restoresTo = photo.archive_restores_to;
      const source = fileFor(photo.id, 'orig', photo.archive_format);
      const result = { contentType: CONTENT_TYPE[restoresTo], extension: EXTENSION[restoresTo] };
      if (photo.archive_format !== 'jxl') {
        return { ...result, file: source, cleanup: async () => {} };
      }
      if (!jxl.available) {
        throw new HttpError(503, 'jxl_unavailable', 'Originál teď nejde připravit, na serveru chybí nástroj djxl');
      }
      return gate.run(async () => {
        const work = path.join(config.tmpDir, `dl-${crypto.randomBytes(12).toString('base64url')}`);
        await fsp.mkdir(work, { mode: 0o700 });
        const target = path.join(work, `original.${result.extension}`);
        try {
          await jxl.decode(source, target);
        } catch (err) {
          await fsp.rm(work, { recursive: true, force: true });
          throw err;
        }
        return { ...result, file: target, cleanup: () => fsp.rm(work, { recursive: true, force: true }) };
      });
    },
  };
}
