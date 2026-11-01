import http from 'node:http';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { performance } from 'node:perf_hooks';
import { jsonApiResponse } from '../lib/api-response.mjs';

const origin = process.argv[2] ?? 'http://127.0.0.1:3315';
const samples = [];
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function get(path, encoding, method = 'GET') {
  const start = performance.now();
  return new Promise((resolve, reject) => {
    const request = http.request(new URL(path, origin), { method, headers: { 'Accept-Encoding': encoding } }, response => {
      const ttfbMs = performance.now() - start;
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => {
        try {
          const body = Buffer.concat(chunks);
          const coding = response.headers['content-encoding'] ?? null;
          assert.ok(coding === null || coding === 'gzip');
          const decoded = coding === 'gzip' ? gunzipSync(body) : body;
          const payload = decoded.length ? JSON.parse(decoded.toString()) : null;
          samples.push({ path, method, encoding, status: response.statusCode, headers: response.headers,
            ttfbMs, totalMs: performance.now() - start, wireBytes: body.length, decodedBytes: decoded.length,
            stationCount: payload?.stations?.length, stationHash: payload?.stations ? hash(payload.stations) : null,
            errors: payload?.errors, sourceErrors: payload?.sourceErrors,
            metadata: payload?.stations ? Object.fromEntries(Object.entries(payload).filter(([key]) => key !== 'stations')) : payload });
          resolve(payload);
        } catch (error) { reject(error); }
      });
    });
    request.on('error', reject);
    request.setTimeout(30000, () => request.destroy(new Error('request timeout')));
    request.end();
  });
}

const initial = await get('/api/stations', 'identity');
assert.ok(initial.stations.length > 0);
assert.deepEqual(initial.errors, []);
assert.deepEqual(initial.sourceErrors, []);
for (let index = 0; index < 5; index++) {
  const pair = index % 2 ? ['identity', 'gzip'] : ['gzip', 'identity'];
  const first = await get('/api/stations', pair[0]);
  const second = await get('/api/stations', pair[1]);
  for (const value of [first, second]) {
    assert.ok(Number.isFinite(value.freshForMs) && value.freshForMs >= 0 && value.freshForMs <= 90000);
  }
  const { freshForMs: firstBudget, ...firstSnapshot } = first;
  const { freshForMs: secondBudget, ...secondSnapshot } = second;
  assert.deepEqual(firstSnapshot, secondSnapshot);
  assert.ok(secondBudget <= firstBudget);
}
for (const encoding of ['gzip', 'identity']) {
  assert.deepEqual(await get('/api/stations?city=unknown', encoding), { error: 'unknown city' });
  assert.equal(samples.at(-1).status, 400);
}
await get('/api/stations', '*;q=0');
assert.equal(samples.at(-1).status, 406);
await get('/api/stations', 'gzip', 'HEAD');
assert.equal(samples.at(-1).wireBytes, 0);
for (const sample of samples) {
  assert.equal(sample.headers['cache-control'], 'no-store');
  assert.match(sample.headers.vary, /Accept-Encoding/i);
  if (sample.method !== 'HEAD' && [200, 400].includes(sample.status)) {
    assert.equal(sample.headers['content-encoding'] ?? null, sample.encoding === 'gzip' ? 'gzip' : null);
  }
}
const costs = [];
for (let index = 0; index < 5; index++) {
  for (const encoding of index % 2 ? ['identity', 'gzip'] : ['gzip', 'identity']) {
    const cpu = process.cpuUsage();
    const start = performance.now();
    const response = await jsonApiResponse(new Request('http://localhost/api/stations', { headers: { 'Accept-Encoding': encoding } }), initial);
    const body = Buffer.from(await response.arrayBuffer());
    const elapsedMs = performance.now() - start;
    const usage = process.cpuUsage(cpu);
    assert.deepEqual(JSON.parse((encoding === 'gzip' ? gunzipSync(body) : body).toString()), initial);
    costs.push({ encoding, elapsedMs, cpuMs: (usage.user + usage.system) / 1000, wireBytes: body.length });
  }
}
console.log(JSON.stringify({ origin, at: new Date().toISOString(), samples, costs, validation: {
  requests: samples.length, failedRequests: 0, completeSnapshotPairsEqualExceptRemainingBudget: 5,
  gzipLayers: 1, helperCostSamples: costs.length,
} }, null, 2));
