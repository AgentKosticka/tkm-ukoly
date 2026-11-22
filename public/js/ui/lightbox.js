import { media } from '../api.js';
import { BROKEN_PHOTO, h, icon } from '../dom.js';
import { Spring, VelocityTracker, capturePointer, clamp, project, reducedMotion, rubberband } from '../spring.js';
import { pushLayer } from './overlay.js';

const GAP = 24;
const lerp = (a, b, t) => a + (b - a) * t;

/**
 * Prohlížeč fotek přes celou obrazovku.
 *
 * Fotka se zvětší z náhledu, na který uživatel klepl, a při zavření se do něj
 * vrátí. Tažením do stran se listuje, tažením dolů se zavírá; obojí sleduje
 * prst a po puštění pokračuje jeho rychlostí.
 *
 * @param {{ photos: object[], index: number, thumbFor: (photo) => Element|null,
 *           canDownload: boolean, onDelete?: (photo) => Promise<boolean> }} options
 */
export function openLightbox({ photos, index, thumbFor, canDownload, onDelete }) {
  let current = index;
  let closed = false;
  let stage = { width: 0, height: 0, top: 0, left: 0 };

  const backdrop = h('div', { class: 'lightbox-backdrop' });
  const track = h('div', { class: 'lightbox-track' });
  const counter = h('span', { class: 'mono lightbox-counter', 'aria-live': 'polite' });
  const download = canDownload
    ? h('a', { class: 'btn btn-quiet lightbox-btn', download: '', 'aria-label': 'Stáhnout originál' }, icon('download'), h('span', { class: 'hide-narrow' }, 'Originál'))
    : null;
  const remove = h('button', { class: 'btn btn-quiet btn-icon lightbox-btn', type: 'button', 'aria-label': 'Smazat fotku' }, icon('trash'));
  const closeButton = h('button', { class: 'btn btn-quiet btn-icon lightbox-btn', type: 'button', 'aria-label': 'Zavřít' }, icon('x'));
  const prev = h('button', { class: 'lightbox-nav lightbox-prev', type: 'button', 'aria-label': 'Předchozí fotka' }, icon('chevronLeft'));
  const next = h('button', { class: 'lightbox-nav lightbox-next', type: 'button', 'aria-label': 'Další fotka' }, icon('chevronRight'));
  const bar = h('div', { class: 'lightbox-bar' }, counter, h('span', { class: 'spacer' }), download, remove, closeButton);
  const el = h(
    'div',
    { class: 'lightbox', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Fotky', tabindex: '-1' },
    backdrop,
    track,
    bar,
    prev,
    next,
  );

  let slots = [];

  function buildSlots() {
    slots = photos.map((photo) => {
      const img = h('img', { class: 'lightbox-img', alt: '', draggable: false, decoding: 'async' });
      img.style.backgroundColor = photo.color;
      const slot = h('div', { class: 'lightbox-slot' }, img);
      const s = { photo, slot, img, loaded: false, rect: null };
      img.addEventListener('error', () => showBroken(s), { once: true });
      return s;
    });
    track.replaceChildren(...slots.map((s) => s.slot));
  }

  /**
   * Fotka se nenačetla: na jejím místě zůstane šedé pole s ikonou. Pole
   * převezme polohu i rozměry obrázku, takže se dál otevírá, zavírá a listuje
   * stejně jako fotka.
   */
  function showBroken(s) {
    const box = h('div', { class: 'lightbox-img lightbox-broken', role: 'img', 'aria-label': BROKEN_PHOTO }, icon('imageOff'), h('span', null, BROKEN_PHOTO));
    for (const name of ['left', 'top', 'width', 'height', 'transform', 'clipPath', 'opacity']) box.style[name] = s.img.style[name];
    s.img.replaceWith(box);
    s.img = box;
  }

  /** Fotka se načte, až když je na řadě nebo hned vedle. */
  function ensureLoaded(i) {
    const s = slots[i];
    if (!s || s.loaded) return;
    s.loaded = true;
    // Než dorazí větší verze, je vidět náhled, který už prohlížeč má.
    s.img.style.backgroundImage = `url("${media.thumb(s.photo.id)}")`;
    s.img.src = media.view(s.photo.id);
  }

  function layout() {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const sideways = vw >= 768 ? 72 : 0;
    stage = { left: sideways, top: 56, width: vw - sideways * 2, height: vh - 56 - 16 };
    slots.forEach((s, i) => {
      s.slot.style.transform = `translate3d(${i * (vw + GAP)}px, 0, 0)`;
      const scale = Math.min(stage.width / s.photo.width, stage.height / s.photo.height, 1.5);
      const width = s.photo.width * scale;
      const height = s.photo.height * scale;
      s.rect = { left: stage.left + (stage.width - width) / 2, top: stage.top + (stage.height - height) / 2, width, height };
      Object.assign(s.img.style, { left: `${s.rect.left}px`, top: `${s.rect.top}px`, width: `${width}px`, height: `${height}px` });
    });
  }

  // Tři nezávislé veličiny: listování (x), stažení dolů (y) a míra otevření
  // (0 = v náhledu, 1 = přes celou obrazovku).
  const pan = new Spring(0, { response: 0.34, onUpdate: paint });
  const pull = new Spring(0, { response: 0.34, onUpdate: paint });
  const openness = new Spring(0, { response: 0.36, precision: 0.002, onUpdate: paint });
  let origin = null;

  function measureOrigin() {
    const thumb = thumbFor(photos[current]);
    const rect = thumb?.getBoundingClientRect();
    const visible = rect && rect.width > 0 && rect.bottom > 0 && rect.top < window.innerHeight;
    origin = visible ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height } : null;
  }

  function paint() {
    track.style.transform = `translate3d(${pan.value}px, 0, 0)`;
    const s = slots[current];
    if (!s?.rect) return;
    const p = openness.value;
    const pulled = Math.abs(pull.value);
    const shrink = 1 - Math.min(0.2, pulled / 1600);
    backdrop.style.opacity = String(clamp(p * (1 - pulled / 500), 0, 1));
    bar.style.opacity = prev.style.opacity = next.style.opacity = String(clamp(p * 2 - 1 - pulled / 120, 0, 1));

    if (origin && p < 0.999) {
      // Náhled je čtvercový výřez; fotka se z něj „rozbaluje“ na celý poměr stran.
      const start = Math.max(origin.width / s.rect.width, origin.height / s.rect.height);
      const scale = lerp(start, 1, p) * shrink;
      const dx = lerp(origin.left + origin.width / 2 - (s.rect.left + s.rect.width / 2), 0, p);
      const dy = lerp(origin.top + origin.height / 2 - (s.rect.top + s.rect.height / 2), 0, p) + pull.value;
      const cropX = lerp((s.rect.width - origin.width / start) / 2, 0, p);
      const cropY = lerp((s.rect.height - origin.height / start) / 2, 0, p);
      s.img.style.transform = `translate3d(${dx}px, ${dy}px, 0) scale(${scale})`;
      s.img.style.clipPath = `inset(${Math.max(0, cropY)}px ${Math.max(0, cropX)}px round ${lerp(8 / start, 4, p)}px)`;
      s.img.style.opacity = '1';
    } else {
      s.img.style.transform = `translate3d(0, ${pull.value}px, 0) scale(${shrink * lerp(0.94, 1, p)})`;
      s.img.style.clipPath = '';
      s.img.style.opacity = origin ? '1' : String(clamp(p, 0, 1));
    }
  }

  function update() {
    counter.textContent = `${current + 1} / ${photos.length}`;
    prev.hidden = current === 0;
    next.hidden = current === photos.length - 1;
    if (download) download.href = media.original(photos[current].id);
    remove.hidden = !(onDelete && photos[current].canDelete);
    for (let i = current - 1; i <= current + 1; i += 1) ensureLoaded(i);
  }

  const targetPan = (i) => -i * (window.innerWidth + GAP);

  function go(i, velocity = 0) {
    const nextIndex = clamp(i, 0, photos.length - 1);
    const changed = nextIndex !== current;
    if (changed) {
      // Opuštěná fotka se vrátí do klidové podoby.
      const old = slots[current];
      old.img.style.transform = '';
      old.img.style.clipPath = '';
    }
    current = nextIndex;
    update();
    pan.to(targetPan(current), { velocity, damping: changed && Math.abs(velocity) > 300 ? 0.86 : 1 });
  }

  // ─── Otevření ───
  buildSlots();
  const layer = pushLayer({ elements: [el], container: el, onEscape: () => close() });
  layout();
  update();
  pan.set(targetPan(current));
  measureOrigin();
  const hiddenThumb = () => thumbFor(photos[current]);
  const hideThumb = (hide) => {
    const thumb = hiddenThumb();
    if (thumb) thumb.style.visibility = hide ? 'hidden' : '';
  };
  hideThumb(true);
  openness.set(0);
  if (reducedMotion()) {
    openness.set(1);
    el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160 });
  } else {
    openness.to(1);
  }

  // ─── Zavření ───
  async function close(velocity = 0) {
    if (closed) return;
    closed = true;
    window.removeEventListener('resize', onResize);
    measureOrigin();
    // Fotka se vrací do svého náhledu; ten je po dobu letu schovaný.
    hideThumb(true);
    if (reducedMotion()) {
      await el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 140, fill: 'forwards' }).finished;
    } else {
      // Rychlost stažení se převede na rychlost zavírání.
      await Promise.all([openness.to(0, { velocity: -Math.abs(velocity) / 600, response: 0.32 }), pull.to(0, { velocity, response: 0.32 })]);
    }
    for (const s of slots) {
      const thumb = thumbFor(s.photo);
      if (thumb) thumb.style.visibility = '';
    }
    layer.release();
    layer.remove();
  }

  function onResize() {
    layout();
    pan.set(targetPan(current));
    paint();
  }
  window.addEventListener('resize', onResize);

  // ─── Gesta ───
  const tracker = new VelocityTracker();
  let gesture = null;

  track.addEventListener('pointerdown', (event) => {
    if (closed || (event.button !== undefined && event.button !== 0)) return;
    // Rozjeté listování jde chytit uprostřed pohybu.
    pan.stop();
    pull.stop();
    gesture = { x: event.clientX, y: event.clientY, pan: pan.value, pull: pull.value, axis: null, id: event.pointerId };
    tracker.samples.length = 0;
    tracker.add(event.clientX, event.clientY);
    capturePointer(track, event.pointerId);
  });

  track.addEventListener('pointermove', (event) => {
    if (!gesture || event.pointerId !== gesture.id) return;
    tracker.add(event.clientX, event.clientY);
    const dx = event.clientX - gesture.x;
    const dy = event.clientY - gesture.y;
    if (!gesture.axis) {
      // Směr se určí až po pár pixelech, aby drobné cuknutí nic nespustilo.
      if (Math.hypot(dx, dy) < 10) return;
      gesture.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      hideThumb(true);
    }
    if (gesture.axis === 'x') {
      const raw = gesture.pan + dx;
      const min = targetPan(photos.length - 1);
      const max = 0;
      const width = window.innerWidth;
      // Za první a poslední fotkou klade listování odpor.
      if (raw > max) pan.set(max + rubberband(raw - max, width));
      else if (raw < min) pan.set(min - rubberband(min - raw, width));
      else pan.set(raw);
    } else {
      pull.set(gesture.pull + dy);
    }
  });

  function release(event) {
    if (!gesture || event.pointerId !== gesture.id) return;
    const { axis } = gesture;
    gesture = null;
    const velocity = tracker.get();
    if (axis === 'x') {
      const step = window.innerWidth + GAP;
      const landing = pan.value + project(velocity.x);
      const nearest = Math.round(-landing / step);
      // Jedním švihem nejvýš o jednu fotku.
      go(clamp(nearest, current - 1, current + 1), velocity.x);
    } else if (axis === 'y') {
      const landing = pull.value + project(velocity.y);
      if (Math.abs(landing) > 160) close(velocity.y);
      else pull.to(0, { velocity: velocity.y, damping: Math.abs(velocity.y) > 300 ? 0.82 : 1 });
    } else if (event.type === 'pointerup' && event.target === track) {
      close();
    } else if (event.type === 'pointerup' && event.target.classList?.contains('lightbox-slot')) {
      close();
    } else {
      pan.to(targetPan(current));
      pull.to(0);
    }
  }
  track.addEventListener('pointerup', release);
  track.addEventListener('pointercancel', release);

  el.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      go(current - 1);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      go(current + 1);
    }
  });
  prev.addEventListener('click', () => go(current - 1));
  next.addEventListener('click', () => go(current + 1));
  closeButton.addEventListener('click', () => close());

  remove.addEventListener('click', async () => {
    const photo = photos[current];
    const deleted = await onDelete(photo);
    if (!deleted || closed) return;
    const index = photos.indexOf(photo);
    if (index !== -1) photos.splice(index, 1);
    if (photos.length === 0) {
      origin = null;
      close();
      return;
    }
    current = Math.min(current, photos.length - 1);
    buildSlots();
    layout();
    update();
    pan.set(targetPan(current));
    origin = null;
    paint();
  });

  return { close };
}
