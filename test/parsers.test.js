import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import sharp from 'sharp';
import { JpegFormatError, stripJpegMetadata } from '../src/media/jpeg.js';
import { PngFormatError, stripPngMetadata } from '../src/media/png.js';
import { WebpFormatError, stripWebpMetadata } from '../src/media/webp.js';
import { sniffImageType } from '../src/media/store.js';
import { AttemptLimiter } from '../src/util/limiter.js';
import { BusyError, Semaphore } from '../src/util/semaphore.js';
import { passwordProblem, usernameProblem, hashPassword, verifyPassword } from '../src/auth/passwords.js';
import { SECRET_MARKER, jpegWithExif, lossyWebp, pngWithAlpha } from './helpers.js';

// Jednoduchý deterministický generátor, ať jsou testy opakovatelné.
function prng(seed) {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
}

describe('očištění JPEG', () => {
  test('odstraní EXIF, zachová pixely, profil a orientaci', async () => {
    const input = await jpegWithExif({ orientation: 8 });
    const clean = stripJpegMetadata(input, { orientation: 8 });
    assert.ok(clean.length < input.length);
    assert.ok(!clean.includes(SECRET_MARKER));
    const [a, b] = await Promise.all([sharp(input).raw().toBuffer(), sharp(clean).raw().toBuffer()]);
    assert.ok(a.equals(b));
    const meta = await sharp(clean).metadata();
    assert.equal(meta.orientation, 8);
    assert.ok(meta.icc);
    assert.equal(meta.exif.length, 32, 'zbyl jen tag orientace');
  });

  test('bez orientace nevkládá žádný EXIF a je idempotentní', async () => {
    const input = await jpegWithExif({ orientation: 1 });
    const clean = stripJpegMetadata(input, { orientation: 1 });
    assert.equal((await sharp(clean).metadata()).exif, undefined);
    assert.ok(stripJpegMetadata(clean).equals(clean));
  });

  test('zahodí data připojená za koncem obrázku', async () => {
    const input = await jpegWithExif({ orientation: 1 });
    const withTrailer = Buffer.concat([input, Buffer.from('TAJNE-VIDEO-ZA-KONCEM')]);
    const clean = stripJpegMetadata(withTrailer);
    assert.ok(!clean.includes('TAJNE-VIDEO'));
    assert.ok(clean.equals(stripJpegMetadata(input)));
  });

  test('progresivní JPEG s více skeny projde beze změny pixelů', async () => {
    const input = await sharp(await jpegWithExif({ orientation: 1 })).jpeg({ progressive: true, quality: 80 }).toBuffer();
    const clean = stripJpegMetadata(input);
    const [a, b] = await Promise.all([sharp(input).raw().toBuffer(), sharp(clean).raw().toBuffer()]);
    assert.ok(a.equals(b));
  });

  test('na poškozeném vstupu skončí řízenou chybou, nikdy nespadne ani nezamrzne', async () => {
    const input = await jpegWithExif({ width: 96, height: 96, orientation: 3 });
    const next = prng(42);
    const started = Date.now();
    let rejected = 0;
    for (let i = 0; i < 4000; i += 1) {
      let mutated;
      const kind = i % 4;
      if (kind === 0) {
        mutated = input.subarray(0, next() % input.length);
      } else if (kind === 1) {
        mutated = Buffer.from(input);
        for (let k = 0; k < 1 + (next() % 8); k += 1) mutated[next() % mutated.length] = next() & 0xff;
      } else if (kind === 2) {
        mutated = Buffer.from(input);
        const at = next() % (mutated.length - 4);
        mutated.writeUInt16BE(next() & 0xffff, at);
        mutated[at + 2] = 0xff;
      } else {
        mutated = Buffer.alloc(next() % 64);
        for (let k = 0; k < mutated.length; k += 1) mutated[k] = next() & 0xff;
        if (mutated.length > 2) mutated.set([0xff, 0xd8], 0);
      }
      try {
        const out = stripJpegMetadata(mutated, { orientation: 1 + (next() % 8) });
        assert.ok(out.length <= mutated.length + 36, 'výstup nikdy nenaroste víc než o tag orientace');
      } catch (err) {
        assert.ok(err instanceof JpegFormatError, `nečekaná chyba: ${err.stack}`);
        rejected += 1;
      }
    }
    assert.ok(rejected > 500, 'většina zkrácených vstupů se odmítne');
    assert.ok(Date.now() - started < 10_000);
  });
});

describe('očištění WebP', () => {
  test('odstraní EXIF a shodí příznak v hlavičce', async () => {
    const input = await lossyWebp();
    assert.ok(input.includes(SECRET_MARKER));
    const { data, lossless, animated } = stripWebpMetadata(input);
    assert.equal(lossless, false);
    assert.equal(animated, false);
    assert.ok(!data.includes(SECRET_MARKER));
    assert.equal(data.readUInt32LE(4), data.length - 8, 'délka v hlavičce RIFF sedí');
    assert.equal((await sharp(data).metadata()).exif, undefined);
    const [a, b] = await Promise.all([sharp(input).raw().toBuffer(), sharp(data).raw().toBuffer()]);
    assert.ok(a.equals(b));
  });

  test('pozná bezeztrátový WebP', async () => {
    const input = await sharp(await lossyWebp()).webp({ lossless: true }).toBuffer();
    assert.equal(stripWebpMetadata(input).lossless, true);
  });

  test('na poškozeném vstupu skončí řízenou chybou', async () => {
    const input = await lossyWebp({ width: 48, height: 48 });
    const next = prng(7);
    for (let i = 0; i < 4000; i += 1) {
      let mutated = Buffer.from(input);
      if (i % 3 === 0) mutated = mutated.subarray(0, next() % mutated.length);
      else if (i % 3 === 1) mutated.writeUInt32LE(next(), 12 + 4 + (next() % 3) * 4);
      else for (let k = 0; k < 4; k += 1) mutated[next() % mutated.length] = next() & 0xff;
      try {
        const out = stripWebpMetadata(mutated);
        assert.ok(out.data.length <= mutated.length + 1);
      } catch (err) {
        assert.ok(err instanceof WebpFormatError, `nečekaná chyba: ${err.stack}`);
      }
    }
  });
});

describe('očištění PNG', () => {
  test('odstraní EXIF a text, zachová pixely, průhlednost i profil', async () => {
    const input = await pngWithAlpha();
    assert.ok(input.includes(SECRET_MARKER));
    const { data, animated } = stripPngMetadata(Buffer.concat([input, Buffer.from('ZA-KONCEM')]));
    assert.equal(animated, false);
    assert.ok(!data.includes(SECRET_MARKER));
    assert.ok(!data.includes('ZA-KONCEM'));
    const [a, b] = await Promise.all([
      sharp(input).raw().toBuffer({ resolveWithObject: true }),
      sharp(data).raw().toBuffer({ resolveWithObject: true }),
    ]);
    assert.equal(b.info.channels, 4);
    assert.ok(a.data.equals(b.data));
    const meta = await sharp(data).metadata();
    assert.equal(meta.exif, undefined);
    assert.ok(meta.icc);
    assert.ok(stripPngMetadata(data).data.equals(data), 'druhé očištění už nic nezmění');
  });

  test('na poškozeném vstupu skončí řízenou chybou', async () => {
    const input = await pngWithAlpha({ width: 24, height: 24 });
    const next = prng(99);
    for (let i = 0; i < 4000; i += 1) {
      let mutated = Buffer.from(input);
      if (i % 3 === 0) mutated = mutated.subarray(0, next() % mutated.length);
      else if (i % 3 === 1) mutated.writeUInt32BE(next(), 8 + (next() % 4) * 4);
      else for (let k = 0; k < 4; k += 1) mutated[next() % mutated.length] = next() & 0xff;
      try {
        assert.ok(stripPngMetadata(mutated).data.length <= mutated.length);
      } catch (err) {
        assert.ok(err instanceof PngFormatError, `nečekaná chyba: ${err.stack}`);
      }
    }
  });
});

describe('pomocné funkce', () => {
  test('typ souboru se pozná z prvních bajtů', () => {
    assert.equal(sniffImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'jpeg');
    assert.equal(sniffImageType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'png');
    assert.equal(sniffImageType(Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'latin1')), 'webp');
    for (const other of ['GIF89a', '<svg', '%PDF-1.7', 'II*\0', 'RIFF\0\0\0\0WAVEfmt ', '\0\0\0 ftypavif', '']) {
      assert.equal(sniffImageType(Buffer.from(other, 'latin1')), null, other);
    }
  });

  test('počítadlo pokusů blokuje po dosažení limitu a po čase pustí', () => {
    const limiter = new AttemptLimiter({ limit: 3, windowMs: 1000, maxKeys: 2 });
    assert.equal(limiter.retryAfter('a', 0), 0);
    limiter.fail('a', 0);
    limiter.fail('a', 100);
    assert.equal(limiter.retryAfter('a', 200), 0);
    limiter.fail('a', 200);
    assert.equal(limiter.retryAfter('a', 300), 1);
    assert.equal(limiter.retryAfter('a', 1000), 0, 'okno vypršelo');
    limiter.fail('b', 0);
    limiter.fail('c', 0);
    limiter.fail('d', 0);
    assert.equal(limiter.retryAfter('b', 1), 0, 'počet klíčů má strop');
  });

  test('semafor pouští po jednom a přeplněnou frontu odmítá', async () => {
    const gate = new Semaphore(1, 1);
    let running = 0;
    let peak = 0;
    const job = () =>
      gate.run(async () => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 10));
        running -= 1;
      });
    const first = job();
    const second = job();
    await assert.rejects(job(), BusyError);
    await Promise.all([first, second]);
    assert.equal(peak, 1);
    await job();
  });

  test('pravidla pro jména a hesla', () => {
    for (const ok of ['pepa', 'Jan.Novak', 'tkm_2026', 'a-b-c', '1abc']) assert.equal(usernameProblem(ok), null, ok);
    for (const bad of ['ab', '.tecka', '-pomlcka', 'a'.repeat(33), 'jiří', 'a b', 'a/b', 'a\u0000b', '', null, 42]) {
      assert.ok(usernameProblem(bad), String(bad));
    }
    assert.equal(passwordProblem('spravne-dlouhe-heslo', 'pepa'), null);
    assert.equal(passwordProblem('příliš žluťoučký kůň', 'pepa'), null, 'diakritika a mezery jsou v pořádku');
    assert.ok(passwordProblem('kratke', 'pepa'));
    assert.ok(passwordProblem('a'.repeat(129), 'pepa'));
    assert.ok(passwordProblem('aaaaaaaaaaaa', 'pepa'));
    assert.ok(passwordProblem('heslo-novakova-1', 'novakova'));
    assert.ok(passwordProblem(undefined, 'pepa'));
  });

  test('ověření hesla odmítne špatné heslo i poškozený otisk', async () => {
    const hash = await hashPassword('spravne-dlouhe-heslo', 10);
    assert.equal(await verifyPassword('spravne-dlouhe-heslo', hash), true);
    assert.equal(await verifyPassword('spravne-dlouhe-heslO', hash), false);
    for (const broken of ['', 'scrypt$10$8$2$x$y', 'bcrypt$10$8$2$a$b', hash.replace('scrypt$10', 'scrypt$99'), null, undefined]) {
      assert.equal(await verifyPassword('spravne-dlouhe-heslo', broken), false, String(broken));
    }
    assert.notEqual(await hashPassword('spravne-dlouhe-heslo', 10), hash, 'každý otisk má vlastní sůl');
  });
});
