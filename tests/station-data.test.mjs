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
