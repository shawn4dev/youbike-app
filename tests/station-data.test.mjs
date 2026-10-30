import test from 'node:test';
import assert from 'node:assert/strict';
import { createStationLoader } from '../lib/station-data.mjs';

const station = (available = 3) => ({ id: 'ntpc-500218084', city: '新北', available });

test('初次直接取得三市全量站點，不依照地圖位置分段請求', async () => {
  const urls = [];
  const snapshots = [];
  const statuses = [];
  const loader = createStationLoader({
    refreshMs: 0,
    onData: data => snapshots.push(data),
    onStatus: value => statuses.push(value),
    fetchImpl: async url => {
      urls.push(url);
      return Response.json({ stations: [station()], errors: [], fetchedAt: '2026-10-29T01:00:00Z' });
    },
  });
  try {
    await loader.refresh();
    assert.deepEqual(urls, ['/api/stations']);
    assert.deepEqual(snapshots[0].updatedStations, [station()]);
    assert.equal(snapshots[0].stations[0].id, 'ntpc-500218084');
    assert.deepEqual(statuses, [true, false]);
  } finally { loader.stop(); }
});

test('手動刷新可繞過快取，並更新收藏站的即時資料取樣', async () => {
  const urls = [];
  const snapshots = [];
  let available = 3;
  const loader = createStationLoader({
    refreshMs: 0,
    onData: data => snapshots.push(data),
    fetchImpl: async url => {
      urls.push(url);
      return Response.json({ stations: [station(available)], errors: [], fetchedAt: '2026-10-29T01:00:00Z' });
    },
  });
  try {
    await loader.refresh();
    available = 8;
    await loader.refresh({ force: true });
    assert.deepEqual(urls, ['/api/stations', '/api/stations?force=1']);
    assert.equal(snapshots.at(-1).stations[0].available, 8);
    assert.equal(snapshots.at(-1).updatedStations[0].available, 8);
  } finally { loader.stop(); }
});

test('更新失敗時保留原有站點，不再清空地圖', async () => {
  let offline = false;
  const snapshots = [];
  const loader = createStationLoader({
    refreshMs: 0,
    onData: data => snapshots.push(data),
    fetchImpl: async () => {
      if (offline) throw new Error('offline');
      return Response.json({ stations: [station()], errors: [], fetchedAt: '2026-10-29T01:00:00Z' });
    },
  });
  try {
    await loader.refresh();
    offline = true;
    await loader.refresh();
    assert.deepEqual(snapshots.at(-1).stations, [station()]);
    assert.deepEqual(snapshots.at(-1).updatedStations, []);
    assert.ok(snapshots.at(-1).errors.length > 0);
  } finally { loader.stop(); }
});

test('多個同時的刷新共用請求，停止後不發布遲到資料', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const snapshots = [];
  let calls = 0;
  const loader = createStationLoader({
    refreshMs: 0,
    onData: data => snapshots.push(data),
    fetchImpl: async () => {
      calls++;
      await gate;
      return Response.json({ stations: [station()], errors: [], fetchedAt: null });
    },
  });
  const first = loader.refresh();
  const second = loader.refresh();
  assert.equal(calls, 1);
  loader.stop();
  release();
  await Promise.all([first, second]);
  assert.deepEqual(snapshots, []);
});

class VisibilityDocument extends EventTarget {
  constructor(state) { super(); this.visibilityState = state; }
  setVisibility(state) { this.visibilityState = state; this.dispatchEvent(new Event('visibilitychange')); }
}

test('初始隱藏不下載，回到前景立即普通刷新並恢復輪詢，隱藏再次暫停', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const documentImpl = new VisibilityDocument('hidden');
  const urls = [];
  const loader = createStationLoader({ documentImpl, refreshMs: 100, onData: () => {}, fetchImpl: async url => {
    urls.push(url);
    return Response.json({ stations: [station()], fetchedAt: null });
  } });
  try {
    await loader.refresh({ force: true });
    t.mock.timers.tick(500);
    assert.deepEqual(urls, []);
    documentImpl.setVisibility('visible');
    await loader.whenIdle();
    assert.deepEqual(urls, ['/api/stations']);
    t.mock.timers.tick(100);
    await loader.whenIdle();
    assert.equal(urls.length, 2);
    documentImpl.setVisibility('hidden');
    t.mock.timers.tick(500);
    await loader.refresh();
    assert.equal(urls.length, 2);
    documentImpl.setVisibility('visible');
    await loader.whenIdle();
    assert.equal(urls.length, 3);
    assert.ok(urls.every(url => url === '/api/stations'));
  } finally { loader.stop(); }
});

test('前景恢復合併未完成請求，停止後移除事件並取消請求與輪詢', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const documentImpl = new VisibilityDocument('visible');
  let calls = 0;
  let release;
  let requestSignal;
  let removed = 0;
  const remove = documentImpl.removeEventListener.bind(documentImpl);
  documentImpl.removeEventListener = (...args) => { removed++; remove(...args); };
  const gate = new Promise(resolve => { release = resolve; });
  const snapshots = [];
  const loader = createStationLoader({ documentImpl, refreshMs: 100, onData: data => snapshots.push(data), fetchImpl: async (url, { signal }) => {
    calls++;
    requestSignal = signal;
    await gate;
    return Response.json({ stations: [station()], fetchedAt: null });
  } });
  const request = loader.refresh();
  documentImpl.setVisibility('hidden');
  documentImpl.setVisibility('visible');
  t.mock.timers.tick(100);
  assert.equal(calls, 1);
  loader.stop();
  assert.equal(removed, 1);
  assert.equal(requestSignal.aborted, true);
  release();
  await request;
  documentImpl.setVisibility('hidden');
  documentImpl.setVisibility('visible');
  t.mock.timers.tick(500);
  await loader.refresh();
  assert.equal(calls, 1);
  assert.deepEqual(snapshots, []);
});

test('預設5分鐘：4分鐘返回等待剩餘1分鐘，超過5分鐘立即刷新', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const documentImpl = new VisibilityDocument('visible');
  let calls = 0;
  const loader = createStationLoader({ documentImpl, onData: () => {}, fetchImpl: async () => {
    calls++;
    return Response.json({ stations: [station()], fetchedAt: null });
  } });
  try {
    await loader.refresh();
    documentImpl.setVisibility('hidden');
    t.mock.timers.tick(240000);
    documentImpl.setVisibility('visible');
    await loader.whenIdle();
    assert.equal(calls, 1);
    t.mock.timers.tick(59999);
    assert.equal(calls, 1);
    t.mock.timers.tick(1);
    await loader.whenIdle();
    assert.equal(calls, 2);
    documentImpl.setVisibility('hidden');
    t.mock.timers.tick(300001);
    assert.equal(calls, 2);
    documentImpl.setVisibility('visible');
    await loader.whenIdle();
    assert.equal(calls, 3);
  } finally { loader.stop(); }
});

test('手動刷新與失敗都重設自動期限，不因返回前景連續重試', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const documentImpl = new VisibilityDocument('visible');
  const urls = [];
  const loader = createStationLoader({ documentImpl, refreshMs: 60000, onData: () => {}, fetchImpl: async url => {
    urls.push(url);
    if (urls.length === 2) throw new Error('offline');
    return Response.json({ stations: [station()], fetchedAt: null });
  } });
  try {
    await loader.refresh();
    t.mock.timers.tick(30000);
    await loader.refresh({ force: true });
    assert.deepEqual(urls, ['/api/stations', '/api/stations?force=1']);
    documentImpl.setVisibility('hidden');
    t.mock.timers.tick(30000);
    documentImpl.setVisibility('visible');
    await loader.whenIdle();
    assert.equal(urls.length, 2);
    t.mock.timers.tick(29999);
    assert.equal(urls.length, 2);
    t.mock.timers.tick(1);
    await loader.whenIdle();
    assert.equal(urls.length, 3);
  } finally { loader.stop(); }
});
