// 官方統一 feed 的單元測試（離線，不連外網）。
//
// 執行：node --test tests/official-feed.test.mjs
//
// 需要真實端點的驗證另外跑：
//   OFFICIAL_FEED_LIVE=1 node --test tests/official-feed.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AREA_NAMES,
  MAX_DISTANCE_M,
  SAMPLE_CENTERS,
  fetchOfficialFeed,
  fetchParkingInfo,
  fetchStationFeedConditional,
  fetchUpdatedAt,
  haversineMeters,
  mergeStaticAndLive,
  normOfficial,
} from '../lib/official-feed.js';

const META = {
  station_no: '500101001',
  area_code: '00',
  name_tw: '捷運科技大樓站',
  name_en: 'MRT Technology Bldg. Sta.',
  district_tw: '大安區',
  address_tw: '復興南路二段235號前',
  lat: '25.02605',
  lng: '121.5436',
  time: '2026-09-28 01:42:31',
};

const LIVE = {
  station_no: '500101001',
  parking_spaces: 26,
  available_spaces: 6,
  available_spaces_detail: { yb1: 0, yb2: 4, eyb: 2 },
  empty_spaces: 20,
  forbidden_spaces: 0,
  available_spaces_level: 20,
  lat: '25.02605',
  lng: '121.5436',
  status: 1,
};

test('圓心常數覆蓋全台且未超出伺服器 maxDistance 上限', () => {
  assert.ok(SAMPLE_CENTERS.length > 0);
  assert.ok(MAX_DISTANCE_M <= 10000, 'maxDistance 不可大於伺服器上限 10000');
  const seen = new Set();
  for (const center of SAMPLE_CENTERS) {
    assert.equal(center.length, 2);
    const [lat, lng] = center;
    assert.ok(lat > 21.5 && lat < 25.5, `圓心緯度超出台灣範圍: ${lat}`);
    assert.ok(lng > 119.5 && lng < 122.5, `圓心經度超出台灣範圍: ${lng}`);
    seen.add(`${lat},${lng}`);
  }
  assert.equal(seen.size, SAMPLE_CENTERS.length, '圓心不應重複');
});

test('haversineMeters 對已知距離給出合理值', () => {
  // 台北車站 → 高雄車站，約 297 公里。
  const d = haversineMeters(25.0478, 121.517, 22.6394, 120.3024);
  assert.ok(d > 290000 && d < 305000, `預期約 297km，得到 ${d}`);
  assert.equal(haversineMeters(25, 121, 25, 121), 0);
});

test('normOfficial 把官方兩個 schema 合成 /api/stations 的站點物件', () => {
  const station = normOfficial(META, LIVE);
  assert.equal(station.id, 'yb-500101001');
  assert.equal(station.city, '臺北');
  assert.equal(station.name, '捷運科技大樓站');
  assert.equal(station.area, '大安區');
  assert.equal(station.active, true);
  assert.equal(station.total, 26);
  assert.equal(station.available, 6);
  assert.equal(station.empty, 20);
  assert.equal(station.regularBikes, 4);
  assert.equal(station.ebikes, 2);
  assert.equal(station.lat, 25.02605);
  assert.equal(station.lng, 121.5436);
  assert.equal(station.source, 'official');
});

test('normOfficial 對暫停營運與缺欄位不臆測數值', () => {
  const paused = normOfficial(META, { ...LIVE, status: 2, available_spaces_detail: undefined });
  assert.equal(paused.active, false);
  // 沒有車型明細時應為 null（未知），不可自動當成 0。
  assert.equal(paused.regularBikes, null);
  assert.equal(paused.ebikes, null);
});

test('merges 以 station_no 串接靜態與即時資料，靜態沒有的站號直接跳過', () => {
  const statics = [META, { ...META, station_no: '999999999' }];
  const lives = [LIVE, { station_no: '000000000', status: 1, available_spaces: 1, empty_spaces: 1, parking_spaces: 2 }];
  const merged = mergeStaticAndLive(statics, lives);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, 'yb-500101001');
});

test('AREA_NAMES 涵蓋官方 14 個服務區', () => {
  const expected = ['00', '01', '05', '07', '08', '09', '0A', '0B', '10', '11', '12', '13', '14', '15'];
  for (const code of expected) {
    assert.ok(AREA_NAMES[code], `缺少 area_code ${code}`);
  }
});

test('fetchParkingInfo 以 station_no 去重並回報失敗的圓心', async () => {
  let calls = 0;
  const failing = SAMPLE_CENTERS[1];
  const fakeFetch = async (url, init) => {
    calls += 1;
    const { lat, lng } = JSON.parse(init.body);
    assert.equal(url, 'https://apis.youbike.com.tw/tw2/parkingInfo');
    assert.equal(init.method, 'POST');
    assert.ok(init.body.includes('"maxDistance":10000'));
    if (lat === failing[0] && lng === failing[1]) {
      return { ok: false, status: 403, json: async () => ({}) };
    }
    // 兩個相鄰圓心重疊回同一站，驗證去重。
    return {
      ok: true,
      status: 200,
      json: async () => ({ retCode: 1, retVal: [LIVE, { ...LIVE, station_no: '500101002' }] }),
    };
  };

  const result = await fetchParkingInfo({ fetchImpl: fakeFetch, centers: SAMPLE_CENTERS.slice(0, 3) });
  assert.equal(calls, 3);
  assert.equal(result.totalCalls, 3);
  assert.equal(result.failures.length, 1);
  assert.equal(result.live.length, 2, '重複回傳的站號應被去重');
});

test('fetchParkingInfo 在 retCode 非 1 時視為失敗而非空資料', async () => {
  const fakeFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ retCode: 0, retMsg: '欄位驗證失敗', retVal: [] }),
  });
  const result = await fetchParkingInfo({ fetchImpl: fakeFetch, centers: [[25, 121]] });
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0].error, /欄位驗證失敗/);
  assert.equal(result.live.length, 0);
});

test('fetchOfficialFeed 回報靜態清單中即時狀態未覆蓋的站號', async () => {
  const fakeFetch = async (url, init) => {
    if (url.includes('station-min-yb2.json')) {
      return { ok: true, status: 200, json: async () => [META, { ...META, station_no: '500101999' }] };
    }
    return { ok: true, status: 200, json: async () => ({ retCode: 1, retVal: [LIVE] }) };
  };
  const feed = await fetchOfficialFeed({ fetchImpl: fakeFetch, centers: [[25.02, 121.54]] });
  assert.equal(feed.staticCount, 2);
  assert.equal(feed.stations.length, 1);
  assert.deepEqual(feed.uncovered, ['500101999']);
});

test('fetchUpdatedAt 從 HEAD 標頭取得更新時間，不下載本體', async () => {
  let calledWith = null;
  const fakeFetch = async (url, init) => {
    calledWith = { url, init };
    return {
      ok: true,
      status: 200,
      headers: new Map([
        ['last-modified', 'Mon, 28 Sep 2026 16:44:38 GMT'],
        ['etag', '"6aba9976-5fdf63"'],
        ['content-length', '6283063'],
      ]),
    };
  };
  const result = await fetchUpdatedAt({ fetchImpl: fakeFetch });
  assert.equal(calledWith.init.method, 'HEAD');
  assert.match(calledWith.url, /station-yb2\.json$/);
  assert.equal(result.lastModified, 'Mon, 28 Sep 2026 16:44:38 GMT');
  assert.equal(result.etag, '"6aba9976-5fdf63"');
  assert.equal(result.contentLength, 6283063);
});

test('fetchStationFeedConditional 未變更時回 304 且仍帶 last-modified', async () => {
  const fakeFetch = async () => ({
    status: 304,
    ok: false,
    headers: new Map([['last-modified', 'Mon, 28 Sep 2026 16:44:38 GMT']]),
  });
  const result = await fetchStationFeedConditional('Mon, 28 Sep 2026 16:31:38 GMT', { fetchImpl: fakeFetch });
  assert.equal(result.notModified, true);
  assert.equal(result.stations, null);
  assert.equal(result.lastModified, 'Mon, 28 Sep 2026 16:44:38 GMT', '304 仍應更新 lastModified');
});

test('fetchStationFeedConditional 變更時回 200 並解析 JSON', async () => {
  const fakeFetch = async (url, init) => {
    assert.equal(init.headers['if-modified-since'], 'Mon, 28 Sep 2026 16:31:38 GMT');
    assert.equal(init.headers['accept-encoding'], 'gzip');
    return {
      status: 200,
      ok: true,
      headers: new Map([['last-modified', 'Mon, 28 Sep 2026 16:44:38 GMT']]),
      text: async () => '\uFEFF[{"station_no":"500101001"}]',
    };
  };
  const result = await fetchStationFeedConditional('Mon, 28 Sep 2026 16:31:38 GMT', { fetchImpl: fakeFetch });
  assert.equal(result.notModified, false);
  assert.deepEqual(result.stations, [{ station_no: '500101001' }]);
  assert.equal(result.lastModified, 'Mon, 28 Sep 2026 16:44:38 GMT');
});

test('fetchStationFeedConditional 首次呼叫（無 lastModified）不送條件標頭', async () => {
  let headers = null;
  const fakeFetch = async (url, init) => {
    headers = init.headers;
    return { status: 200, ok: true, headers: new Map(), text: async () => '[]' };
  };
  await fetchStationFeedConditional(null, { fetchImpl: fakeFetch });
  assert.equal('if-modified-since' in headers, false);
});

// ---- 需要真實端點的驗證（預設跳過）----
test('LIVE：85 個圓心可完整取得全台站點', { skip: !process.env.OFFICIAL_FEED_LIVE }, async () => {
  const started = Date.now();
  const feed = await fetchOfficialFeed();
  const elapsed = Date.now() - started;

  assert.equal(feed.failures.length, 0, `有 ${feed.failures.length} 個圓心失敗`);
  assert.deepEqual(feed.uncovered, [], `有 ${feed.uncovered.length} 站未被即時狀態覆蓋`);
  assert.equal(feed.stations.length, feed.staticCount);
  assert.ok(feed.staticCount > 9000, `站數偏低: ${feed.staticCount}`);

  const ids = new Set(feed.stations.map((s) => s.id));
  assert.equal(ids.size, feed.stations.length, 'id 不應重複');

  for (const station of feed.stations) {
    assert.ok(Number.isFinite(station.lat) && Number.isFinite(station.lng), `${station.id} 座標無效`);
    assert.ok(station.available >= 0 && station.empty >= 0, `${station.id} 數量為負`);
  }

  const byCity = new Map();
  for (const station of feed.stations) {
    byCity.set(station.city, (byCity.get(station.city) ?? 0) + 1);
  }
  console.log(
    `LIVE: ${feed.stations.length} 站 / ${feed.totalCalls} 次呼叫 / ${elapsed}ms`,
    Object.fromEntries([...byCity].sort((a, b) => b[1] - a[1]))
  );
});
