import test from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { jsonApiResponse } from '../lib/api-response.mjs';
import { GET } from '../app/api/stations/route.js';

const payload = { stations: [{ id: 'tp-1', name: '臺北站', lat: 25.1, lng: 121.5 }], errors: [], fetchedAt: '2026-11-01T00:00:00Z' };
const request = (encoding, method = 'GET') => new Request('http://localhost/api/stations', {
  method, headers: encoding === undefined ? {} : { 'Accept-Encoding': encoding },
});

for (const [encoding, expected] of [
  [undefined, null], ['', null], ['gzip', 'gzip'], ['GZip;Q=1', 'gzip'],
  ['gzip;q=0', null], ['*', 'gzip'], ['*;q=0.5', null],
  ['gzip;q=0, *;q=1', null], ['identity;q=0, *;q=0.5', 'gzip'],
  ['gzip;q=0.5, identity;q=0.1', 'gzip'], ['gzip;q=0.5, identity;q=0.8', null],
  ['gzip;q=oops', null], ['gzip;q=1.001', null], ['gzip;q=-1', null],
  ['gzip;q=0.1234', null], ['br', null], ['gzip;q=0.5, identity;q=0.5', 'gzip'],
]) {
  test(`complete JSON survives negotiation ${String(encoding)}`, async () => {
    const response = await jsonApiResponse(request(encoding), payload);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Content-Encoding'), expected);
    assert.equal(response.headers.get('Content-Type'), 'application/json');
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.match(response.headers.get('Vary'), /Accept-Encoding/i);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.deepEqual(JSON.parse((expected ? gunzipSync(bytes) : bytes).toString()), payload);
  });
}

for (const whitespace of [' ', '\t']) {
  test(`coding name accepts optional whitespace before quality ${JSON.stringify(whitespace)}`, async () => {
    for (const [encoding, status, contentEncoding] of [
      [`gzip${whitespace};q=1, identity;q=0`, 200, 'gzip'],
      [`gzip${whitespace};q=0, *;q=1`, 200, null],
      [`identity${whitespace};q=0, gzip;q=0`, 406, null],
    ]) {
      const response = await jsonApiResponse(request(encoding), payload);
      assert.equal(response.status, status, encoding);
      assert.equal(response.headers.get('Content-Encoding'), contentEncoding, encoding);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (status === 406) assert.equal(bytes.length, 0);
      else assert.deepEqual(JSON.parse((contentEncoding ? gunzipSync(bytes) : bytes).toString()), payload);
    }
  });
}

test('refusal returns 406 without claiming compression', async () => {
  for (const encoding of ['*;q=0', 'gzip;q=0, identity;q=0', 'identity;q=0', 'gzip;q=bad, identity;q=0']) {
    const response = await jsonApiResponse(request(encoding), payload);
    assert.equal(response.status, 406);
    assert.equal(response.headers.get('Content-Encoding'), null);
    assert.equal(await response.text(), '');
  }
});

test('Vary retains existing tokens and avoids case-insensitive duplicates', async () => {
  for (const vary of ['RSC, Next-Router-State-Tree', 'RSC, accept-encoding', '*']) {
    const response = await jsonApiResponse(request(), payload, { headers: { Vary: vary, 'Content-Length': '1' } });
    const tokens = response.headers.get('Vary').toLowerCase().split(',').map(token => token.trim());
    assert.ok(tokens.includes(vary === '*' ? '*' : 'rsc'));
    assert.equal(tokens.filter(token => token === 'accept-encoding').length, vary === '*' ? 0 : 1);
    assert.equal(response.headers.get('Content-Length'), null);
  }
});

test('HEAD and bodyless statuses have no body or encoding', async () => {
  for (const [method, status] of [['HEAD', 200], ['GET', 204], ['GET', 205], ['GET', 304]]) {
    const response = await jsonApiResponse(request('gzip', method), payload, { status });
    assert.equal(response.status, status);
    assert.equal(response.body, null);
    assert.equal(response.headers.get('Content-Encoding'), null);
  }
});

test('unavailable, constructor failure, and stream failure safely fall back only if identity is allowed', async t => {
  const original = globalThis.CompressionStream;
  t.after(() => { globalThis.CompressionStream = original; });
  for (const implementation of [undefined, class { constructor() { throw new Error('unsupported'); } }, class {
    constructor() { return new TransformStream({ transform() { throw new Error('failed'); } }); }
  }]) {
    globalThis.CompressionStream = implementation;
    const response = await jsonApiResponse(request('gzip'), payload);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Content-Encoding'), null);
    assert.deepEqual(await response.json(), payload);
    const refused = await jsonApiResponse(request('gzip, identity;q=0'), payload);
    assert.equal(refused.status, 503);
    assert.equal(refused.headers.get('Content-Encoding'), null);
    assert.equal(await refused.text(), '');
  }
});

test('route 400 uses real gzip and no-store with complete JSON', async () => {
  const response = await GET(new Request('http://localhost/api/stations?city=unknown', { headers: { 'Accept-Encoding': 'gzip' } }));
  assert.equal(response.status, 400);
  assert.equal(response.headers.get('Content-Encoding'), 'gzip');
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(JSON.parse(gunzipSync(Buffer.from(await response.arrayBuffer())).toString()), { error: 'unknown city' });
});
