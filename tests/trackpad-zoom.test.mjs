import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePinchDelta, clampZoom, attachTrackpadZoom } from '../lib/trackpad-zoom.mjs';

const pinch = { ctrlKey: true, cancelable: true, deltaMode: 0, deltaY: -2 };
test('only cancellable Ctrl wheel is normalized; ordinary scroll remains untouched', () => {
  assert.equal(normalizePinchDelta(pinch), 2);
  for (const patch of [{ ctrlKey: false }, { cancelable: false }, { deltaMode: 3 }, { deltaY: NaN }, { deltaY: Infinity }]) {
    assert.equal(normalizePinchDelta({ ...pinch, ...patch }), null);
  }
});
test('direction, fractional input, line/page units and outlier limits are explicit', () => {
  assert.equal(normalizePinchDelta({ ...pinch, deltaY: 0.25 }), -0.25);
  assert.equal(normalizePinchDelta({ ...pinch, deltaMode: 1 }), 32);
  assert.equal(normalizePinchDelta({ ...pinch, deltaMode: 2, deltaY: -0.1 }), 80);
  assert.equal(normalizePinchDelta({ ...pinch, deltaY: -1e9 }), 240);
  assert.equal(normalizePinchDelta({ ...pinch, deltaY: 1e9 }), -240);
  assert.ok(normalizePinchDelta({ ...pinch, deltaY: 0 }) === 0);
});
test('fractional zoom is retained and bounded; invalid bounds cannot escape', () => {
  assert.equal(clampZoom(12.375, 8, 19), 12.375);
  assert.equal(clampZoom(-50, 8, 19), 8);
  assert.equal(clampZoom(80, 8, 19), 19);
  assert.equal(clampZoom(8, 8, 8), 8);
  assert.throws(() => clampZoom(NaN, 8, 19), RangeError);
  assert.throws(() => clampZoom(10, 19, 8), RangeError);
});

function fixture({ nativeEnabled = true } = {}) {
  const window = new EventTarget();
  const document = new EventTarget();
  const container = new EventTarget();
  const frames = new Map(), timers = new Map();
  let sequence = 0;
  window.requestAnimationFrame = callback => { frames.set(++sequence, callback); return sequence; };
  window.cancelAnimationFrame = id => frames.delete(id);
  window.setTimeout = callback => { timers.set(++sequence, callback); return sequence; };
  window.clearTimeout = id => timers.delete(id);
  document.defaultView = window;
  document.visibilityState = 'visible';
  container.ownerDocument = document;
  container.closest = () => null;
  const handlers = new Map();
  const calls = [];
  let stops = 0;
  const map = {
    options: { zoomSnap: .5 }, getContainer: () => container,
    getZoom: () => 14, getMinZoom: () => 8, getMaxZoom: () => 19,
    getSize: () => ({ x: 1000, y: 700 }),
    mouseEventToContainerPoint: event => ({ x: event.clientX, y: event.clientY }),
    containerPointToLatLng: point => ({ x: point.x / 2 ** 14, y: point.y / 2 ** 14 }),
    project: (point, zoom) => ({ x: point.x * 2 ** zoom, y: point.y * 2 ** zoom,
      subtract(offset) { return { x: this.x - offset.x, y: this.y - offset.y }; } }),
    unproject: (point, zoom) => ({ x: point.x / 2 ** zoom, y: point.y / 2 ** zoom }),
    flyTo: (center, zoom, options) => { calls.push({ center, zoom, options }); handlers.get('zoomstart')?.(); handlers.get('movestart')?.(); },
    stop: () => { stops++; },
    on: (types, handler) => { for (const type of types.split(' ')) handlers.set(type, handler); },
    off: types => { for (const type of types.split(' ')) handlers.delete(type); },
    scrollWheelZoom: { enabled: () => nativeEnabled, disable: () => { nativeEnabled = false; }, enable: () => { nativeEnabled = true; } },
  };
  return { map, calls, frames, timers, window, document, container, handlers, stops: () => stops,
    frame() { const callbacks = [...frames.values()]; frames.clear(); for (const callback of callbacks) callback(); },
    settle() { const callbacks = [...timers.values()]; timers.clear(); for (const callback of callbacks) callback(); },
    wheel(patch = {}) {
      const event = new Event('wheel', { cancelable: patch.cancelable ?? true });
      Object.assign(event, { ctrlKey: true, deltaMode: 0, deltaY: -5, clientX: 650, clientY: 270, ...patch });
      container.dispatchEvent(event);
      return event;
    },
  };
}

test('coalesces deltas once per frame, accumulates desired zoom independently and preserves public anchor', () => {
  const f = fixture();
  let starts = 0, ends = 0;
  const dispose = attachTrackpadZoom(f.map, { onGestureStart: () => { starts++; }, onGestureEnd: () => { ends++; } });
  assert.equal(f.wheel().defaultPrevented, true);
  f.wheel();
  assert.equal(f.frames.size, 1);
  assert.equal(f.map.scrollWheelZoom.enabled(), false);
  assert.equal(f.map.options.zoomSnap, 0);
  f.frame();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].zoom, 14.1);
  f.wheel({ deltaY: -10 });
  f.frame();
  assert.ok(Math.abs(f.calls[1].zoom - 14.2) < 1e-9);
  const { center, zoom } = f.calls[1];
  const anchor = { x: 650 / 2 ** 14, y: 270 / 2 ** 14 };
  assert.ok(Math.abs((anchor.x - center.x) * 2 ** zoom + 500 - 650) < 1e-9);
  assert.ok(Math.abs((anchor.y - center.y) * 2 ** zoom + 350 - 270) < 1e-9);
  assert.equal(starts, 1);
  f.settle();
  assert.equal(ends, 1);
  assert.equal(f.map.options.zoomSnap, .5);
  assert.equal(f.map.scrollWheelZoom.enabled(), true);
  dispose();
});

test('ordinary scroll/controls are untouched, interrupting input restores native wheel before bubbling', () => {
  const f = fixture();
  const dispose = attachTrackpadZoom(f.map);
  assert.equal(f.wheel({ ctrlKey: false }).defaultPrevented, false);
  f.container.closest = () => ({});
  assert.equal(f.wheel().defaultPrevented, false);
  f.container.closest = () => null;
  f.wheel(); f.frame();
  assert.equal(f.wheel({ ctrlKey: false }).defaultPrevented, false);
  assert.equal(f.map.scrollWheelZoom.enabled(), true);
  assert.equal(f.map.options.zoomSnap, .5);
  assert.equal(f.frames.size + f.timers.size, 0);
  dispose();
});

test('limits consume no hidden overshoot so reversal responds immediately', () => {
  const f = fixture();
  f.map.getMinZoom = () => 13.9;
  f.map.getMaxZoom = () => 14.1;
  const dispose = attachTrackpadZoom(f.map);
  f.wheel({ deltaY: -1000 }); f.frame();
  assert.equal(f.calls.at(-1).zoom, 14.1);
  f.wheel({ deltaY: 10 }); f.frame();
  assert.equal(f.calls.at(-1).zoom, 14);
  f.wheel({ deltaY: 1000 }); f.frame();
  assert.equal(f.calls.at(-1).zoom, 13.9);
  dispose();
});

test('blur, visibility, external motion and disposal cancel pending work and restore original disabled state', () => {
  const f = fixture({ nativeEnabled: false });
  const ends = [];
  const dispose = attachTrackpadZoom(f.map, { onGestureEnd: value => ends.push(value) });
  f.wheel(); f.window.dispatchEvent(new Event('blur'));
  assert.equal(f.frames.size + f.timers.size, 0);
  f.wheel(); f.document.visibilityState = 'hidden'; f.document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(f.frames.size + f.timers.size, 0);
  f.document.visibilityState = 'visible'; f.wheel(); f.handlers.get('zoomstart')();
  assert.equal(f.frames.size + f.timers.size, 0);
  f.wheel(); dispose(); dispose();
  f.frame(); f.settle();
  assert.equal(f.wheel().defaultPrevented, false);
  assert.equal(f.calls.length, 0);
  assert.equal(f.handlers.size, 0);
  assert.equal(f.map.options.zoomSnap, .5);
  assert.equal(f.map.scrollWheelZoom.enabled(), false);
  assert.equal(ends.length, 4);
  assert.ok(ends.every(value => value.cancelled));
});
