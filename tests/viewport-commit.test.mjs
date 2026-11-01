import test from 'node:test';
import assert from 'node:assert/strict';
import { attachViewportCommit, formatZoom, zoomMatches } from '../lib/viewport-commit.mjs';

function fixture() {
  const handlers = new Map(), timers = new Map();
  let sequence = 0;
  const window = { setTimeout: callback => { timers.set(++sequence, callback); return sequence; }, clearTimeout: id => timers.delete(id) };
  return { timers, handlers,
    map: { getContainer: () => ({ ownerDocument: { defaultView: window } }),
      on: (types, callback) => { for (const type of types.split(' ')) handlers.set(type, callback); },
      off: types => { for (const type of types.split(' ')) handlers.delete(type); } },
    emit: type => handlers.get(type)?.(),
    flush: () => { const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach(callback => callback()); },
  };
}

test('gesture cancels pending debounce, ignores all intermediate viewport events, commits final exactly once', () => {
  for (const delayMs of [0, 80]) {
    const f = fixture(); let commits = 0;
    const dispose = attachViewportCommit(f.map, () => { commits++; }, { delayMs });
    if (delayMs) { f.emit('moveend'); assert.equal(f.timers.size, 1); }
    f.emit('trackpadzoomstart');
    assert.equal(f.timers.size, 0);
    for (let i = 0; i < 50; i++) { f.emit('moveend'); f.emit('resize'); }
    f.flush(); assert.equal(commits, 0);
    f.emit('trackpadzoomend'); assert.equal(commits, 1);
    f.flush(); assert.equal(commits, 1);
    f.emit('trackpadzoomstart'); f.emit('moveend'); f.emit('trackpadzoomend');
    assert.equal(commits, 2);
    f.emit('moveend'); dispose(); f.flush();
    assert.equal(commits, delayMs ? 2 : 3);
    assert.equal(f.handlers.size, 0);
  }
});

test('fractional URL values round trip within tolerance and old integers remain compatible', () => {
  for (const zoom of [8, 14.3, 15.123456, 18.9999]) {
    const encoded = formatZoom(zoom);
    const restored = Number.parseFloat(encoded);
    assert.ok(zoomMatches(zoom, restored));
    assert.ok(Math.abs(zoom - restored) <= .005);
  }
  assert.equal(formatZoom(15), '15');
  assert.equal(zoomMatches(15.3, 15), false);
  assert.equal(zoomMatches(15.005, 15), true);
});
