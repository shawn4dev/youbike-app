// 官方 YouBike 統一 feed：POST https://apis.youbike.com.tw/tw2/parkingInfo
//
// 本檔保留原有 parkingInfo 工具；2026-10-30 實測完整 station-yb2.json
// 可回傳當日資料、gzip 與 Last-Modified/304。先前「無人維護」推論已撤回；
// 實驗路由現使用下方 fetchStationFeedConditional，不再分區取樣。
//
// 伺服器端把 maxDistance 硬限制在 10000（公尺），無法一次取回全台，
// 因此改以「全台 85 個圓心 × 半徑 10km」分區取樣後以 station_no 去重合併。
// 實測：85 次呼叫可完整取得 9,630 站，與 station-yb2.json 的站號集合完全一致。

export const PARKING_INFO_URL = 'https://apis.youbike.com.tw/tw2/parkingInfo';

// 伺服器端上限：maxDistance 不可大於 10000。
export const MAX_DISTANCE_M = 10000;

// 覆蓋全台 9,630 站的取樣圓心（以 9km 覆蓋半徑求出，留 1km 邊界餘裕）。
export const SAMPLE_CENTERS = [
  [25.0415, 121.5287],
  [24.1501, 120.6575],
  [22.6587, 120.3306],
  [25.0025, 121.3663],
  [22.9830, 120.2419],
  [24.8033, 120.9965],
  [24.9407, 121.2229],
  [23.4908, 120.3969],
  [24.2674, 120.6030],
  [25.1304, 121.4513],
  [22.7969, 120.2909],
  [24.3057, 120.6832],
  [25.0569, 121.6552],
  [22.6175, 120.5232],
  [22.5606, 120.3703],
  [24.6387, 120.8651],
  [23.1210, 120.2365],
  [23.2802, 120.3307],
  [22.7933, 121.1247],
  [25.0566, 121.2097],
  [23.4430, 120.2973],
  [24.1656, 120.5440],
  [24.9611, 121.5100],
  [24.0732, 120.6998],
  [24.4301, 120.6258],
  [24.5393, 120.7897],
  [24.2418, 120.7856],
  [23.5612, 120.4810],
  [22.8849, 120.2425],
  [24.8673, 121.2845],
  [24.7768, 121.0896],
  [21.9923, 120.7471],
  [24.9218, 121.0557],
  [23.0274, 120.3352],
  [22.4571, 120.4796],
  [22.9988, 120.1503],
  [22.8983, 120.4828],
  [23.4199, 120.4422],
  [24.7069, 120.9147],
  [25.2179, 121.6414],
  [25.0590, 121.8519],
  [22.6875, 120.4713],
  [25.2523, 121.4713],
  [22.7098, 120.6364],
  [23.0611, 121.1689],
  [24.3926, 120.7949],
  [23.1882, 120.3374],
  [23.1201, 120.4660],
  [23.2659, 120.1236],
  [22.9561, 121.1587],
  [23.5647, 120.3485],
  [22.7106, 121.0603],
  [23.3623, 120.1780],
  [22.5379, 120.5914],
  [23.0983, 121.3815],
  [25.0795, 121.3057],
  [25.0382, 121.0810],
  [22.3703, 120.5910],
  [24.9755, 121.6562],
  [24.5954, 121.0007],
  [24.5407, 120.6952],
  [23.3262, 120.4051],
  [24.8400, 121.1829],
  [21.9336, 120.8235],
  [24.7930, 121.3668],
  [23.4421, 120.5307],
  [23.1537, 120.1040],
  [23.0186, 121.3244],
  [24.9074, 121.3647],
  [24.8649, 121.5517],
  [24.2029, 121.0054],
  [24.3517, 120.5841],
  [23.4585, 120.1538],
  [23.0824, 120.5870],
  [23.0364, 120.4791],
  [22.0888, 120.7147],
  [22.8716, 121.2260],
  [25.0300, 121.7479],
  [25.1342, 121.8055],
  [24.2240, 120.6966],
  [24.3126, 120.8317],
  [24.6502, 120.7730],
  [24.4475, 120.9060],
  [24.5425, 120.9218],
  [22.7210, 120.2588],
];

// area_code 對應服務區名稱（取自 GET /json/area-all.json）。
export const AREA_NAMES = {
  '00': '臺北',
  '01': '臺中',
  '05': '新北',
  '07': '桃園',
  '08': '嘉義市',
  '09': '新竹市',
  '0A': '苗栗',
  '0B': '新竹縣',
  '10': '新竹科學園區',
  '11': '嘉義縣',
  '12': '高雄',
  '13': '臺南',
  '14': '屏東',
  '15': '臺東',
};

// 政府開放資料端點用的城市名稱（本專案 /api/stations 既有介面）。
const CITY_ALIASES = {
  '00': '臺北',
  '05': '新北',
  '12': '高雄',
};

const EARTH_RADIUS_M = 6371000;

export function haversineMeters(aLat, aLng, bLat, bLng) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

function areaName(areaCode) {
  return AREA_NAMES[areaCode] ?? `未知(${areaCode})`;
}

function cityName(areaCode) {
  return CITY_ALIASES[areaCode] ?? areaName(areaCode);
}

// parkingInfo 只回即時狀態（無名稱、地址、行政區），需與 station-min-yb2.json
// 的靜態資料以 station_no 串接，才能組出與 /api/stations 相容的站點物件。
export function mergeStaticAndLive(staticRows, liveRows) {
  const byNo = new Map(staticRows.map((row) => [row.station_no, row]));
  const merged = [];
  for (const live of liveRows) {
    const meta = byNo.get(live.station_no);
    if (!meta) continue;
    merged.push(normOfficial(meta, live));
  }
  return merged;
}

export function normOfficial(meta, live) {
  const detail = live.available_spaces_detail;
  const hasDetail = detail && typeof detail === 'object';
  const available = Number(live.available_spaces ?? 0);
  const empty = Number(live.empty_spaces ?? 0);
  const total = Number(live.parking_spaces ?? 0);
  return {
    id: `yb-${live.station_no}`,
    city: cityName(meta.area_code),
    areaName: areaName(meta.area_code),
    name: meta.name_tw || meta.name_en || '',
    nameEn: meta.name_en || '',
    area: meta.district_tw || '',
    addr: meta.address_tw || '',
    // 官方 status：1 正常、2 暫停營運。
    active: Number(live.status) === 1,
    total,
    available,
    // 車型細分明細：yb2 為一般車、eyb 為電輔車。缺欄位時保留 null 而非 0。
    regularBikes: hasDetail && detail.yb2 !== '' ? Number(detail.yb2 ?? 0) : null,
    ebikes: hasDetail && detail.eyb !== '' ? Number(detail.eyb ?? 0) : null,
    empty,
    lat: Number(meta.lat),
    lng: Number(meta.lng),
    updated: meta.time,
    // 官方狀態分級（0~100），供 UI 判斷滿柱／無車。
    availableLevel: live.available_spaces_level ?? null,
    forbiddenSpaces: Number(live.forbidden_spaces ?? 0),
    source: 'official',
  };
}

async function fetchJsonBody(fetchImpl, url, init, timeoutMs, signal) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const onAbort = () => ctrl.abort();
  if (signal?.aborted) ctrl.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetchImpl(url, { ...init, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

// 併發池：維持固定併發數，避免 85 次請求同時開啟。
async function pooledMap(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

export async function fetchParkingInfo(options = {}) {
  const {
    fetchImpl = fetch,
    centers = SAMPLE_CENTERS,
    maxDistance = MAX_DISTANCE_M,
    concurrency = 5,
    timeoutMs = 15000,
    signal,
  } = options;

  const outcomes = await pooledMap(centers, concurrency, async ([lat, lng]) => {
    try {
      if (signal?.aborted) throw new Error('total deadline exceeded');
      const body = await fetchJsonBody(
        fetchImpl,
        PARKING_INFO_URL,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: 'https://www.youbike.com.tw',
          },
          body: JSON.stringify({ lat, lng, maxDistance }),
          cache: 'no-store',
        },
        timeoutMs,
        signal
      );
      if (body.retCode !== 1) throw new Error(body.retMsg || 'unexpected retCode');
      if (!Array.isArray(body.retVal)) throw new Error('parkingInfo returned invalid rows');
      return { ok: true, rows: body.retVal ?? [] };
    } catch (error) {
      return { ok: false, error: String(error?.message || error), center: [lat, lng] };
    }
  });

  const byNo = new Map();
  const failures = [];
  for (const outcome of outcomes) {
    if (!outcome.ok) {
      failures.push(outcome);
      continue;
    }
    for (const row of outcome.rows) byNo.set(row.station_no, row);
  }
  return { live: [...byNo.values()], failures, totalCalls: centers.length };
}

export async function fetchStaticStations(options = {}) {
  const { fetchImpl = fetch, timeoutMs = 15000, signal } = options;
  const rows = await fetchJsonBody(
    fetchImpl,
    'https://apis.youbike.com.tw/json/station-min-yb2.json',
    { cache: 'no-store' },
    timeoutMs,
    signal
  );
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('station-min-yb2.json returned no stations');
  }
  return rows;
}

// ---- 小流量更新檢查（不必下載 6MB 本體）----
//
// 實測（2026-09-29）：
// - HEAD 只要 1,231 bytes，last-modified 直接可得。
// - If-Modified-Since 未變更時回 304（body 0 bytes），且 304 仍帶 last-modified。
// - If-None-Match 在此伺服器失效（帶相符 etag 仍回 200 全量），不可用。
// - Range 取樣必須帶 Accept-Encoding: identity；帶 gzip 時 Range 被忽略、回 200 全量。

export const FULL_BODY_BYTES = 6283063; // 未壓縮大小（每分鐘微幅變動，僅供參考）

// 只要「資料更新時間」：HEAD 一個請求、~1.2KB。
export async function fetchUpdatedAt(options = {}) {
  const { fetchImpl = fetch, timeoutMs = 15000, signal } = options;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(PARKING_INFO_URL.replace('/tw2/parkingInfo', '/json/station-yb2.json'), {
      method: 'HEAD',
      headers: { 'accept-encoding': 'identity' },
      signal: ctrl.signal,
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return {
      lastModified: res.headers.get('last-modified'),
      etag: res.headers.get('etag'),
      contentLength: Number(res.headers.get('content-length') ?? 0),
    };
  } finally {
    clearTimeout(timer);
  }
}

// 條件請求：上次 lastModified 未變更 → 304（0 bytes）；變更 → 200 全量。
// 304 回應仍帶 last-modified，更新時間一樣免費取得。
export async function fetchStationFeedConditional(lastModified, options = {}) {
  const { fetchImpl = fetch, timeoutMs = 30000, signal } = options;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const onAbort = () => ctrl.abort();
  if (signal?.aborted) ctrl.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const headers = { 'accept-encoding': 'gzip' };
    if (lastModified) headers['if-modified-since'] = lastModified;
    const res = await fetchImpl(
      PARKING_INFO_URL.replace('/tw2/parkingInfo', '/json/station-yb2.json'),
      { headers, signal: ctrl.signal, cache: 'no-store' }
    );
    if (res.status === 304) {
      return {
        notModified: true,
        lastModified: res.headers.get('last-modified') ?? lastModified,
        stations: null,
      };
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    return {
      notModified: false,
      lastModified: res.headers.get('last-modified'),
      stations: JSON.parse(text.replace(/^\uFEFF/, '')),
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

// 完整流程：靜態站點 + 分區即時狀態 → 與 /api/stations 相容的站點陣列。
export async function fetchOfficialFeed(options = {}) {
  const { signal, ...rest } = options;
  const [staticRows, liveResult] = await Promise.all([
    fetchStaticStations({ signal, ...rest }),
    fetchParkingInfo({ signal, ...rest }),
  ]);

  const stationNos = new Set(liveResult.live.map((row) => row.station_no));
  const stations = mergeStaticAndLive(staticRows, liveResult.live);
  const missing = staticRows.filter((row) => !stationNos.has(row.station_no));

  return {
    stations,
    staticCount: staticRows.length,
    liveCount: liveResult.live.length,
    failures: liveResult.failures,
    totalCalls: liveResult.totalCalls,
    // 靜態清單有、即時狀態沒取到的站（理論上應為 0，非 0 表示圓心覆蓋破洞）。
    uncovered: missing.map((row) => row.station_no),
  };
}
