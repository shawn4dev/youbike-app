import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { stationBootstrapScript, takeStationBootstrap } from '../lib/station-bootstrap.mjs';
import { createStationLoader } from '../lib/station-data.mjs';

const emittedScript = process.env.BOOTSTRAP_RELEASE_HTML
  ? readFileSync(process.env.BOOTSTRAP_RELEASE_HTML, 'utf8').match(/<script id="station-bootstrap">([\s\S]*?)<\/script>/)?.[1]
  : stationBootstrapScript;
assert.ok(emittedScript, 'release HTML contains the actual parser-time bootstrap');

const payload = () => ({ stations: [{ id: 'tp-1' }], errors: [], sourceErrors: [], freshForMs: 1000, fetchedAt: 'old' });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
class Visibility extends EventTarget {
  constructor(state = 'visible') { super(); this.visibilityState = state; }
  hide() { this.visibilityState = 'hidden'; this.dispatchEvent(new Event('visibilitychange')); }
}
function harness({ hidden = false, fetchImpl = async () => Response.json(payload()), script = emittedScript } = {}) {
  const document = new Visibility(hidden ? 'hidden' : 'visible');
  const window = new EventTarget();
  let mono = performance.now();
  let calls = 0;
  let signal;
  const timers = new Map();
  let id = 0;
  vm.runInNewContext(script, { window, document, AbortController, performance: { now: () => mono },
    setTimeout: (fn, delay) => { timers.set(++id, { fn, at: mono + delay }); return id; },
    clearTimeout: id => timers.delete(id),
    fetch: (...args) => { calls++; signal = args[1].signal; return fetchImpl(...args); } });
  return { document, window, timers, get calls() { return calls; }, get signal() { return signal; },
    advance(ms) { mono += ms; for (const [id, timer] of timers) if (timer.at <= mono) { timers.delete(id); timer.fn(); } } };
}

test('exact fixed script does zero hidden work and handles rejection before claim', async () => {
  const hidden = harness({ hidden: true });
  await flush();
  assert.equal(hidden.calls, 0);
  assert.equal(takeStationBootstrap(hidden.window), null);
  const failed = harness({ fetchImpl: async () => { throw Error('offline'); } });
  const result = failed.window.__ybStationBootstrap.result;
  assert.equal(await result, null);
  assert.equal(takeStationBootstrap(failed.window), null);
  assert.equal(failed.timers.size, 0);
});

test('pending and completed early requests each transfer once and avoid a second download', async () => {
  for (const completed of [false, true]) {
    const gate = deferred();
    const h = harness({ fetchImpl: () => gate.promise });
    await flush();
    if (completed) { gate.resolve(Response.json(payload())); await flush(); }
    const initialRequest = takeStationBootstrap(h.window);
    assert.equal(takeStationBootstrap(h.window), null);
    let ordinary = 0;
    const data = [];
    const loader = createStationLoader({ initialRequest, documentImpl: h.document, refreshMs: 0,
      fetchImpl: async () => { ordinary++; return Response.json(payload()); }, onData: x => data.push(x) });
    const work = loader.refresh();
    if (!completed) gate.resolve(Response.json(payload()));
    await work;
    assert.equal(h.calls, 1);
    assert.equal(ordinary, 0);
    assert.equal(data.length, 1);
    assert.equal(data[0].fetchedAt, 'old');
    loader.stop();
    assert.equal(h.timers.size, 0);
  }
});

test('hide, pagehide, timeout and expiry before claim discard the handle and retained data', async () => {
  for (const reason of ['hide', 'pagehide', 'timeout', 'expiry']) {
    const gate = deferred();
    const h = harness({ fetchImpl: () => gate.promise });
    const handle = h.window.__ybStationBootstrap;
    if (reason === 'expiry') { gate.resolve(Response.json(payload())); await flush(); }
    if (reason === 'hide') h.document.hide();
    if (reason === 'pagehide') h.window.dispatchEvent(new Event('pagehide'));
    if (reason === 'timeout') h.advance(15001);
    if (reason === 'expiry') h.advance(1001);
    assert.equal(takeStationBootstrap(h.window), null);
    assert.equal(h.signal?.aborted ?? true, true);
    gate.resolve(Response.json(payload()));
    const result = await handle.result;
    assert.ok(result === null || result.payload === null);
    assert.equal(h.timers.size, 0);
  }
});

test('delayed body, source errors and invalid budgets fall through to exactly one normal request', async () => {
  for (const kind of ['body', 'error', 'zero', 'nan', 'expired']) {
    const body = deferred();
    const h = harness({ fetchImpl: async () => ({ ok: true, json: () => body.promise }) });
    await flush();
    const handle = takeStationBootstrap(h.window);
    const data = [];
    let ordinary = 0;
    const loader = createStationLoader({ initialRequest: handle, refreshMs: 0, onData: x => data.push(x), fetchImpl: async () => {
      ordinary++; return Response.json({ ...payload(), errors: ['upstream failed'], sourceErrors: ['offline'], stale: true });
    } });
    const work = loader.refresh();
    const p = payload();
    if (kind === 'error') p.sourceErrors.push('offline');
    if (kind === 'zero') p.freshForMs = 0;
    if (kind === 'nan') p.freshForMs = NaN;
    if (kind === 'body') h.advance(1001);
    if (kind === 'expired') p.freshForMs = Number.MIN_VALUE;
    body.resolve(p);
    await work;
    assert.equal(ordinary, 1, kind);
    assert.equal(data.length, 1);
    assert.deepEqual(data[0].errors, ['upstream failed']);
    loader.stop();
  }
});

test('claim removes visibility ownership, stop suppresses late result and remount cannot reclaim', async () => {
  const gate = deferred();
  const h = harness({ fetchImpl: () => gate.promise });
  await flush();
  const initialRequest = takeStationBootstrap(h.window);
  const data = [];
  const loader = createStationLoader({ initialRequest, refreshMs: 0, onData: x => data.push(x) });
  const work = loader.refresh();
  h.document.hide();
  assert.equal(h.signal.aborted, false);
  loader.stop();
  assert.equal(h.signal.aborted, true);
  gate.resolve(Response.json(payload()));
  await work;
  assert.deepEqual(data, []);
  assert.equal(takeStationBootstrap(h.window), null);
});

test('pending bootstrap and ordinary flight each queue one force, double clicks share completion', async () => {
  for (const early of [true, false]) {
    const gate = deferred();
    const forceGate = deferred();
    const h = early ? harness({ fetchImpl: () => gate.promise }) : null;
    if (h) await flush();
    const urls = [];
    const data = [];
    const loader = createStationLoader({ initialRequest: h && takeStationBootstrap(h.window), refreshMs: 0,
      onData: x => data.push(x), fetchImpl: async url => {
        urls.push(url);
        if (url.endsWith('force=1')) await forceGate.promise;
        else await gate.promise;
        return Response.json(payload());
      } });
    const first = loader.refresh();
    const force = loader.refresh({ force: true });
    assert.equal(loader.refresh({ force: true }), force);
    gate.resolve(Response.json(payload()));
    await first;
    await flush();
    assert.deepEqual(data, []);
    assert.equal(loader.refresh({ force: true }), force);
    forceGate.resolve();
    await force;
    assert.deepEqual(urls, early ? ['/api/stations?force=1'] : ['/api/stations', '/api/stations?force=1']);
    assert.equal(data.length, 1);
    loader.stop();
  }
});

test('wall clock skew does not alter bootstrap freshness and consumption checks its monotonic deadline', async () => {
  const original = Date.now;
  const h = harness();
  await flush();
  const handle = takeStationBootstrap(h.window);
  Date.now = () => -999999999999;
  let requests = 0;
  const data = [];
  const loader = createStationLoader({ initialRequest: handle, refreshMs: 0, onData: x => data.push(x),
    fetchImpl: async () => { requests++; return Response.json(payload()); } });
  try { await loader.refresh(); assert.equal(requests, 0); assert.equal(data.length, 1); }
  finally { Date.now = original; loader.stop(); }
  let fallback = 0;
  const expired = createStationLoader({ initialRequest: { startedAtMono: 0, result: Promise.resolve({ payload: payload(), expiresAtMono: 0 }), cancel() {} },
    refreshMs: 0, onData() {}, fetchImpl: async () => { fallback++; return Response.json(payload()); } });
  await expired.refresh();
  assert.equal(fallback, 1);
  expired.stop();
});

test('adoption keeps the polling deadline measured from the actual early attempt', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let calls = 0;
  const loader = createStationLoader({ refreshMs: 1000, initialRequest: {
    startedAtMono: performance.now() - 400,
    result: Promise.resolve({ payload: payload(), expiresAtMono: performance.now() + 10000 }), cancel() {},
  }, onData() {}, fetchImpl: async () => { calls++; return Response.json(payload()); } });
  try {
    await loader.refresh();
    t.mock.timers.tick(599);
    assert.equal(calls, 0);
    t.mock.timers.tick(2);
    await loader.whenIdle();
    assert.equal(calls, 1);
  } finally { loader.stop(); }
});

test('queued force waits for foreground and resolves only after forced validation, or stop', async () => {
  for (const early of [false, true]) for (const stop of [false, true]) {
    const gate = deferred();
    const forcedGate = deferred();
    const h = early ? harness({ fetchImpl: () => gate.promise }) : null;
    if (h) await flush();
    const documentImpl = h?.document ?? new Visibility();
    const urls = [];
    const snapshots = [];
    const loader = createStationLoader({ documentImpl, initialRequest: h && takeStationBootstrap(h.window), refreshMs: 0, onData: x => snapshots.push(x),
      fetchImpl: async url => { urls.push(url); await (url.includes('force=1') ? forcedGate.promise : gate.promise); return Response.json(payload()); } });
    const normal = loader.refresh();
    let completed = false;
    const force = loader.refresh({ force: true });
    force.then(() => { completed = true; });
    documentImpl.hide();
    assert.equal(loader.refresh({ force: true }), force);
    gate.resolve();
    await normal;
    await flush();
    assert.equal(completed, false);
    assert.deepEqual(urls, early ? [] : ['/api/stations']);
    assert.deepEqual(snapshots, []);
    if (stop) loader.stop();
    else {
      documentImpl.visibilityState = 'visible';
      documentImpl.dispatchEvent(new Event('visibilitychange'));
      await flush();
      assert.deepEqual(urls, early ? ['/api/stations?force=1'] : ['/api/stations', '/api/stations?force=1']);
      assert.equal(completed, false);
      assert.equal(loader.refresh({ force: true }), force);
      forcedGate.resolve();
    }
    await force;
    assert.equal(snapshots.length, stop ? 0 : 1);
    loader.stop();
  }
});
