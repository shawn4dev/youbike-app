import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const script = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8');
function worker() {
  const handlers = {};
  const cached = new Map();
  const puts = [];
  const deletes = [];
  let networkCalls = 0;
  let claimed = false;
  const network = async () => { networkCalls++; return new Response('network fresh'); };
  vm.runInNewContext(script, {
    URL, Response,
    self: { location: { origin: 'https://example.test' }, addEventListener: (type, handler) => { handlers[type] = handler; },
      clients: { claim: () => { claimed = true; } }, skipWaiting: () => {} },
    fetch: network,
    caches: {
      keys: async () => ['youbike-runtime-v3', 'youbike-static-v3', 'youbike-runtime-v4', 'youbike-static-v4', 'other-app-cache'],
      delete: async key => { deletes.push(key); },
      match: async request => cached.get(request.url ?? request)?.clone(),
      open: async () => ({ put: async (request, response) => { puts.push(request.url); cached.set(request.url, response); }, addAll: async () => {} }),
    },
  });
  return { cached, puts, deletes, networkCalls: () => networkCalls, claimed: () => claimed,
    async request(path) {
      const request = new Request(`https://example.test${path}`, { cache: 'no-store' });
      let intercepted;
      handlers.fetch({ request, respondWith: promise => { intercepted = promise; } });
      const response = await (intercepted ?? network(request));
      return { response, intercepted: intercepted !== undefined };
    },
    async activate() { let work; handlers.activate({ waitUntil: promise => { work = promise; } }); await work; },
  };
}

test('API and force requests bypass cached stale entries and never enter SW cache', async () => {
  const sw = worker();
  for (const path of ['/api', '/api/stations', '/api/stations?force=1', '/api/other']) {
    sw.cached.set(`https://example.test${path}`, new Response('stale'));
    const result = await sw.request(path);
    assert.equal(result.intercepted, false);
    assert.equal(await result.response.text(), 'network fresh');
  }
  assert.equal(sw.networkCalls(), 4);
  assert.deepEqual(sw.puts, []);
});

test('static cache-first hit and miss behavior remains unchanged', async () => {
  const sw = worker();
  sw.cached.set('https://example.test/icon-192.png', new Response('cached icon'));
  const hit = await sw.request('/icon-192.png');
  assert.equal(hit.intercepted, true);
  assert.equal(await hit.response.text(), 'cached icon');
  assert.equal(sw.networkCalls(), 0);
  const miss = await sw.request('/apiary.png');
  assert.equal(miss.intercepted, true);
  assert.equal(await miss.response.text(), 'network fresh');
  assert.equal(sw.networkCalls(), 1);
  assert.deepEqual(sw.puts, ['https://example.test/apiary.png']);
});

test('v4 activation removes only obsolete YouBike caches and claims clients', async () => {
  const sw = worker();
  await sw.activate();
  assert.deepEqual(sw.deletes.sort(), ['youbike-runtime-v3', 'youbike-static-v3']);
  assert.equal(sw.claimed(), true);
});
