import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStationIndex, createStationLoader, normalizeStation } from '../lib/station-data.mjs';

const meta = (no, lat, lng, area_code = '05') => ({
  station_no: no, lat, lng, area_code, name_tw: `站點${no}`,
  name_en: 'Station', district_tw: '板橋區', address_tw: '站點地址',
});
const live = (no, available = 3) => ({
  station_no: no, status: 1, parking_spaces: 20, available_spaces: available,
  empty_spaces: 20 - available, available_spaces_detail: { yb2: available, eyb: 0 },
});
const rows = [meta('500218084', 25.0092, 121.4591), meta('500110083', 25.06, 121.54, '00'), meta('501206012', 22.6381, 120.3649, '12')];

test('沿用三市站點 ID，並使用即時回應的時間而非建置時間', () => {
  assert.equal(normalizeStation(rows[0], live('500218084'), '2026-10-28T12:00:00Z').id, 'ntpc-500218084');
  assert.equal(normalizeStation(rows[1], live('500110083')).id, 'tp-500110083');
  assert.equal(normalizeStation(rows[2], live('501206012')).id, 'kcg-501206012');
  assert.equal(normalizeStation(rows[0], live('500218084'), '2026-10-28T12:00:00Z').updated, '2026-10-28T12:00:00Z');
});

test('靜態索引只含既有三市且每個站點都被背景查詢圓心涵蓋', () => {
  const index = buildStationIndex([...rows, meta('outside', 24, 120, '01')]);
  assert.equal(index.stations.length, 3);
  assert.equal(Object.values(index.tiles).flat().length, 3);
  assert.equal(index.centers.length, 3);
});

test('附近資料先顯示，背景補齊不移除附近資料；刷新數量並保留舊 ID', async () => {
  const index = buildStationIndex(rows);
  const snapshots = [];
  let resolveAll;
  let nearAvailable = 3;
  const allGate = new Promise(resolve => { resolveAll = resolve; });
  const fetchImpl = async (url, init = {}) => {
    if (url.endsWith('/index.json')) return Response.json({ version: 'test', tiles: Object.keys(index.tiles), centers: index.centers });
    if (url.endsWith('/all.json')) { await allGate; return Response.json(index.stations); }
    if (url.startsWith('/data/stations/')) {
      const key = url.split('/').at(-1).replace('.json', '');
      return Response.json(index.tiles[key] ?? []);
    }
    const body = JSON.parse(init.body);
    const near = body.maxDistance < 10000;
    return Response.json({ retCode: 1, retVal: near ? [live('500218084', nearAvailable)] : rows.map(row => live(row.station_no)) });
  };
  const loader = createStationLoader({ fetchImpl, onData: data => snapshots.push(data), refreshMs: 0 });
  try {
    await loader.focus({ lat: 25.0092, lng: 121.4591 });
    assert.equal(snapshots[0].stations.length, 1, '全量未完成就要先出現附近站點');
    assert.equal(snapshots[0].stations[0].id, 'ntpc-500218084');
    resolveAll();
    await loader.whenIdle();
    assert.equal(snapshots.at(-1).stations.length, 3);
    nearAvailable = 8;
    await loader.refresh();
    assert.equal(snapshots.at(-1).stations.find(s => s.id === 'ntpc-500218084').available, 8);
    assert.equal(snapshots.at(-1).stations.length, 3);
  } finally { resolveAll(); loader.stop(); }
});

test('附近請求失敗仍能背景載入全量，刷新失敗不清空既有站點', async () => {
  const index = buildStationIndex(rows);
  let failAll = false;
  const snapshots = [];
  const loader = createStationLoader({ refreshMs: 0, onData: data => snapshots.push(data), fetchImpl: async (url, init = {}) => {
    if (url.endsWith('/index.json')) return Response.json({ version: 'test', tiles: Object.keys(index.tiles), centers: index.centers });
    if (url.endsWith('/all.json')) return Response.json(index.stations);
    if (url.startsWith('/data/stations/')) return Response.json([]);
    if (failAll || JSON.parse(init.body).maxDistance < 10000) throw new Error('offline');
    return Response.json({ retCode: 1, retVal: rows.map(row => live(row.station_no)) });
  }});
  try {
    await loader.focus({ lat: 25.0092, lng: 121.4591 });
    await loader.whenIdle();
    assert.equal(snapshots.at(-1).stations.length, 3);
    failAll = true;
    await loader.refresh();
    assert.equal(snapshots.at(-1).stations.length, 3);
    assert.ok(snapshots.at(-1).errors.length > 0);
  } finally { loader.stop(); }
});

test('較早開始的背景請求晚到時，不覆蓋較新的附近車輛數', async () => {
  const index = buildStationIndex([rows[0]]);
  let releaseBackground;
  const gate = new Promise(resolve => { releaseBackground = resolve; });
  let signalBackgroundStarted;
  const started = new Promise(resolve => { signalBackgroundStarted = resolve; });
  let available = 3;
  const snapshots = [];
  const loader = createStationLoader({ refreshMs: 0, onData: data => snapshots.push(data), fetchImpl: async (url, init = {}) => {
    if (url.endsWith('/index.json')) return Response.json({ version: 'test', tiles: Object.keys(index.tiles), centers: index.centers });
    if (url.endsWith('/all.json')) return Response.json(index.stations);
    if (url.startsWith('/data/stations/')) return Response.json(index.stations);
    if (JSON.parse(init.body).maxDistance === 10000) {
      signalBackgroundStarted();
      await gate;
      return Response.json({ retCode: 1, retVal: [live('500218084', 3)] });
    }
    return Response.json({ retCode: 1, retVal: [live('500218084', available)] });
  }});
  try {
    await loader.focus({ lat: 25.0092, lng: 121.4591 });
    await started;
    available = 9;
    await loader.refresh();
    releaseBackground();
    await loader.whenIdle();
    assert.equal(snapshots.at(-1).stations[0].available, 9);
    assert.equal(snapshots.at(-1).updatedStations.length, 0, '失敗或舊回應不能產生新的歷史取樣');
  } finally { releaseBackground(); loader.stop(); }
});

test('停止載入後，即使網路回應晚到也不發布資料', async () => {
  let resolveManifest;
  const gate = new Promise(resolve => { resolveManifest = resolve; });
  const snapshots = [];
  const loader = createStationLoader({ refreshMs: 0, onData: data => snapshots.push(data), fetchImpl: async url => {
    if (url.endsWith('/index.json')) { await gate; return Response.json({ version: 'test', tiles: [], centers: [] }); }
    return Response.json({ retCode: 1, retVal: [] });
  }});
  const task = loader.focus({ lat: 25, lng: 121 });
  loader.stop();
  resolveManifest();
  await task;
  assert.equal(snapshots.length, 0);
});

test('無效或極地座標不進入區塊迴圈與網路查詢', async () => {
  const loader = createStationLoader({ refreshMs: 0, onData: () => assert.fail('無效位置不應發布'), fetchImpl: () => assert.fail('無效位置不應查詢') });
  try {
    await loader.focus({ lat: 90, lng: 121 });
    await loader.focus({ lat: NaN, lng: 121 });
    await loader.focus({ lat: 25, lng: Infinity });
  } finally { loader.stop(); }
});
