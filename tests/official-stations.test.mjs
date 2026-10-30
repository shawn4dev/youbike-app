import test from 'node:test';
import assert from 'node:assert/strict';
import { createOfficialStations, legacyStation } from '../lib/official-stations.mjs';
import { fetchStationFeedConditional } from '../lib/official-feed.js';
import { GET } from '../app/api/stations/route.js';

const rows = [
  { station_no: '500101001', area_code: '00', lat: 25.02, lng: 121.54 },
  { station_no: '500218084', area_code: '05', lat: 25.02, lng: 121.46 },
  { station_no: '501206012', area_code: '12', lat: 22.63, lng: 120.36 },
].map(row => ({ ...row, name_tw: '站點', status: 1, parking_spaces: 10, available_spaces: 4, empty_spaces: 6, updated_at: '2026-10-30 12:00:00' }));
const modified = 'Fri, 30 Oct 2026 04:00:00 GMT';
const response = (body, lm = modified) => new Response(JSON.stringify(body), { headers: { 'last-modified': lm } });

test('single gzip full-feed request serves isolated city and subsequent complete default cache', async () => {
  let calls = 0;
  const service = createOfficialStations({ fetchImpl: async (url, init) => {
    calls++;
    assert.match(url, /\/json\/station-yb2.json$/);
    assert.equal(init.headers['accept-encoding'], 'gzip');
    assert.equal(init.headers['if-modified-since'], undefined);
    return response(rows);
  } });
  const [city, all] = await Promise.all([service.get({ city: '臺北' }), service.get()]);
  assert.equal(calls, 1);
  assert.equal(city.stations.length, 1);
  assert.equal(all.stations.length, 3);
  assert.deepEqual(all.stations.map(row => row.id), ['tp-500101001', 'ntpc-500218084', 'kcg-501206012']);
  assert.equal(all.stations[0].updated, rows[0].updated_at);
  assert.equal(all.stations[0].regularBikes, null);
  assert.equal((await service.get()).stations.length, 3);
  assert.equal(calls, 1);
});

test('304 advances only checkedAt, retains values/fetchedAt/validator, and shares force in-flight', async () => {
  let clock = 1000;
  let calls = 0;
  const service = createOfficialStations({ now: () => clock, liveTtl: 10, fetchImpl: async (url, init) => {
    calls++;
    if (calls === 1) return response(rows);
    assert.equal(init.headers['if-modified-since'], modified);
    return new Response(null, { status: 304, headers: { 'last-modified': modified } });
  } });
  const first = await service.get();
  clock += 20;
  const [a, b] = await Promise.all([service.get({ force: true }), service.get({ force: true })]);
  assert.equal(calls, 2);
  assert.deepEqual(a, b);
  assert.deepEqual(a.stations, first.stations);
  assert.equal(a.fetchedAt, first.fetchedAt);
  assert.equal(a.sourceLastModified, modified);
  assert.equal(a.checkedAt, new Date(clock).toISOString());
  assert.equal(a.stale, true);
  assert.deepEqual(a.errors, []);
});

test('SWR returns immediately and failures throttle retries without pretending old values are fresh', async () => {
  let clock = 1000;
  let calls = 0;
  let fail = false;
  const service = createOfficialStations({ now: () => clock, liveTtl: 10, fetchImpl: async () => {
    calls++;
    if (fail) throw new Error('offline');
    return response(rows);
  } });
  const first = await service.get();
  clock += 20;
  fail = true;
  const stale = await service.get();
  assert.deepEqual(stale.stations, first.stations);
  assert.equal(stale.stale, true);
  await service.get({ force: true });
  const retained = await service.get({ city: '臺北' });
  assert.equal(calls, 2);
  assert.deepEqual(retained.errors, ['臺北']);
  assert.equal(retained.fetchedAt, first.fetchedAt);
  assert.equal(retained.checkedAt, first.checkedAt);
  assert.equal(retained.stale, true);
});

test('invalid/empty/missing-city/duplicate feeds retain previous complete snapshot and validator', async () => {
  let current = rows;
  let validator;
  const service = createOfficialStations({ fetchImpl: async (url, init) => {
    validator = init.headers['if-modified-since'];
    return response(current, current === rows ? modified : 'bad-new-validator');
  } });
  const first = await service.get();
  for (const invalid of [[], {}, rows.slice(0, 2), [...rows, rows[0]], rows.map((row, i) => i ? row : { ...row, lat: 'bad' })]) {
    current = invalid;
    const result = await service.get({ force: true });
    assert.deepEqual(result.stations, first.stations);
    assert.equal(result.sourceLastModified, modified);
    assert.equal(validator, modified);
    assert.equal(result.errors.length, 3);
  }
});

test('cold unexpected304 or malformed JSON reports errors, no fabricated timestamp, no rapid retry', async () => {
  for (const body of [() => new Response(null, { status: 304 }), () => new Response('not json')]) {
    let calls = 0;
    const service = createOfficialStations({ fetchImpl: async () => { calls++; return body(); } });
    const result = await service.get();
    assert.equal(result.fetchedAt, null);
    assert.equal(result.checkedAt, null);
    assert.deepEqual(result.stations, []);
    assert.equal(result.errors.length, 3);
    await service.get();
    assert.equal(calls, 1);
  }
});

test('deadline aborts a pending full-feed download and reports explicit failure', async () => {
  const service = createOfficialStations({ timeoutMs: 5, fetchImpl: async (url, { signal }) =>
    new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true })) });
  const result = await service.get();
  assert.match(result.sourceErrors[0], /timeout/);
  assert.equal(result.errors.length, 3);
});

test('conditional helper propagates external cancellation', async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  await assert.rejects(fetchStationFeedConditional(null, { signal: ctrl.signal, fetchImpl: async (url, { signal }) => {
    assert.equal(signal.aborted, true);
    throw new Error('aborted');
  } }), /aborted/);
});

test('changed 200 replaces accepted data and validator only after validation', async () => {
  let clock = 1000;
  let calls = 0;
  const nextModified = 'Fri, 30 Oct 2026 04:01:00 GMT';
  const service = createOfficialStations({ now: () => clock, fetchImpl: async () => {
    calls++;
    return calls === 1 ? response(rows) : response(rows.map(row => ({ ...row, available_spaces: 9 })), nextModified);
  } });
  const first = await service.get();
  clock += 20;
  const next = await service.get({ force: true });
  assert.notEqual(next.fetchedAt, first.fetchedAt);
  assert.equal(next.sourceLastModified, nextModified);
  assert.ok(next.stations.every(row => row.available === 9));
});

test('route rejects unknown or empty city before network access', async () => {
  for (const city of ['未知', '']) assert.equal((await GET(new Request(`http://localhost/api/stations?city=${encodeURIComponent(city)}`))).status, 400);
  assert.equal(legacyStation({ ...rows[0], available_spaces_detail: { yb2: '', eyb: 0 } }, 'receipt').regularBikes, null);
});
