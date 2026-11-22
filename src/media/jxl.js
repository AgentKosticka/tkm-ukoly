import { execFile } from 'node:child_process';

const TIMEOUT_MS = 120_000;

function run(binary, args) {
  return new Promise((resolve, reject) => {
    execFile(
      binary,
      args,
      { timeout: TIMEOUT_MS, maxBuffer: 256 * 1024, windowsHide: true, killSignal: 'SIGKILL' },
      (err, stdout, stderr) => {
        if (err) {
          err.message = `${binary} selhal: ${String(stderr || err.message).slice(0, 400)}`;
          reject(err);
        } else {
          resolve(String(stdout));
        }
      },
    );
  });
}

/**
 * Tenká obálka nad nástroji cjxl a djxl z libjxl. Cesty, které se jim
 * předávají, si aplikace generuje sama; od uživatele v nich nic není.
 */
export async function createJxl(config, log) {
  let available = false;
  if (config.jxlEnabled) {
    try {
      const version = await run(config.cjxlPath, ['--version']);
      await run(config.djxlPath, ['--version']);
      available = true;
      log.info(`JPEG XL: ${version.split('\n')[0].trim()}`);
    } catch {
      log.warn('Nástroje cjxl/djxl nejsou k dispozici; originály se archivují záložní cestou');
    }
  }

  return {
    available,
    /** Bezeztrátová rekomprese JPEG; původní soubor lze vrátit bajt po bajtu. */
    encodeJpeg: (input, output) =>
      run(config.cjxlPath, [input, output, '--lossless_jpeg=1', '-e', '7', '--num_threads=2', '--quiet']),
    /** Bezeztrátové zakódování pixelů (vstupem je PNG). */
    encodePixels: (input, output) =>
      run(config.cjxlPath, [input, output, '-d', '0', '-e', '7', '--num_threads=2', '--quiet']),
    /** Výstupní formát určuje přípona cílového souboru (.jpg nebo .png). */
    decode: (input, output) => run(config.djxlPath, [input, output, '--num_threads=2', '--quiet']),
  };
}
