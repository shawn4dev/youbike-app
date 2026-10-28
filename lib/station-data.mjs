const CITIES = { '00': ['tp', '臺北'], '05': ['ntpc', '新北'], '12': ['kcg', '高雄'] };
const LIVE_URL = 'https://apis.youbike.com.tw/tw2/parkingInfo';
export const METADATA_URL = 'https://apis.youbike.com.tw/json/station-min-yb2.json';

function distance(a, b) {
  const rad = Math.PI / 180;
  const h = Math.sin((b.lat - a.lat) * rad / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin((b.lng - a.lng) * rad / 2) ** 2;
  return 12742000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

function tileKey(lat, lng) { return `${Math.floor(lat * 10)}-${Math.floor(lng * 10)}`; }

export function buildStationIndex(rows) {
  const stations = rows.filter(row => CITIES[row.area_code] && Number.isFinite(Number(row.lat)) && Number.isFinite(Number(row.lng)))
    .map(row => ({ station_no: row.station_no, area_code: row.area_code, name_tw: row.name_tw,
      name_en: row.name_en, district_tw: row.district_tw, address_tw: row.address_tw,
      lat: Number(row.lat), lng: Number(row.lng) }));
  const tiles = {};
  const centers = [];
  for (const station of stations) {
    (tiles[tileKey(station.lat, station.lng)] ??= []).push(station);
    // 留 1.5km 邊界餘裕；背景查詢半徑為官方允許的 10km。
    if (!centers.some(center => distance(center, station) <= 8500)) {
      centers.push({ lat: station.lat, lng: station.lng });
    }
  }
  return { stations, tiles, centers };
}

export function normalizeStation(meta, live, updated = new Date().toISOString()) {
  const [prefix, city] = CITIES[meta.area_code];
  const detail = live.available_spaces_detail;
  return {
    id: `${prefix}-${meta.station_no}`, city, name: meta.name_tw || '', nameEn: meta.name_en || '',
    area: meta.district_tw || '', addr: meta.address_tw || '', active: Number(live.status) === 1,
    total: Number(live.parking_spaces ?? 0), available: Number(live.available_spaces ?? 0),
    empty: live.empty_spaces == null ? null : Number(live.empty_spaces),
    regularBikes: detail?.yb2 == null || detail.yb2 === '' ? null : Number(detail.yb2),
    ebikes: detail?.eyb == null || detail.eyb === '' ? null : Number(detail.eyb),
    lat: Number(meta.lat), lng: Number(meta.lng), updated,
  };
}

export function createStationLoader({ fetchImpl = fetch, onData, onStatus = () => {}, refreshMs = 60000 }) {
  const lifetime = new AbortController();
  const metadata = new Map();
  const stations = new Map();
  const receivedVersions = new Map();
  const updatedIds = new Set();
  const tilePromises = new Map();
  let manifestPromise;
  let nearbyController;
  let focusPoint;
  let fullTask;
  let fullUpdatedAt = 0;
  let nearTask = Promise.resolve();
  let nearError = null;
  let fullError = null;
  let stopped = false;
  let lastFocusAt = 0;
  let requestSequence = 0;
  let fetchedAt = null;

  async function json(url, init = {}, signal = lifetime.signal) {
    const response = await fetchImpl(url, { ...init, signal: AbortSignal.any([signal, lifetime.signal, AbortSignal.timeout(8000)]) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }
  const manifest = () => manifestPromise ??= json('/data/stations/index.json', { cache: 'no-store' }).catch(error => { manifestPromise = null; throw error; });
  function addMetadata(rows) { for (const row of rows) metadata.set(row.station_no, row); }
  function emit() {
    if (!stopped) onData({ stations: [...stations.values()], updatedStations: [...updatedIds].map(id => stations.get(id)), errors: [nearError, fullError].filter(Boolean), fetchedAt });
    updatedIds.clear();
  }
  function applyLive({ rows, sequence }) {
    const updated = new Date().toISOString();
    for (const row of rows) {
      const meta = metadata.get(row.station_no);
      if (meta) {
        const id = `${CITIES[meta.area_code][0]}-${row.station_no}`;
        if ((receivedVersions.get(id) ?? -1) > sequence) continue;
        receivedVersions.set(id, sequence);
        stations.set(id, normalizeStation(meta, row, updated));
        updatedIds.add(id);
      }
    }
    fetchedAt = updated;
  }
  async function live(point, maxDistance, signal) {
    const sequence = requestSequence++;
    const body = await json(LIVE_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'omit', cache: 'no-store',
      body: JSON.stringify({ lat: point.lat, lng: point.lng, maxDistance }),
    }, signal);
    if (body.retCode !== 1 || !Array.isArray(body.retVal)) throw new Error(body.retMsg || '站點資料格式錯誤');
    return { rows: body.retVal, sequence };
  }
  async function nearbyMetadata(point, radius) {
    const index = await manifest();
    const latDelta = radius / 110000;
    const lngDelta = radius / (110000 * Math.cos(point.lat * Math.PI / 180));
    const keys = new Set();
    for (let y = Math.floor((point.lat - latDelta) * 10); y <= Math.floor((point.lat + latDelta) * 10); y++) {
      for (let x = Math.floor((point.lng - lngDelta) * 10); x <= Math.floor((point.lng + lngDelta) * 10); x++) keys.add(`${y}-${x}`);
    }
    await Promise.all(index.tiles.filter(key => keys.has(key)).map(key => {
      if (!tilePromises.has(key)) {
        tilePromises.set(key, json(`/data/stations/${index.version}/${key}.json`).then(addMetadata).catch(error => { tilePromises.delete(key); throw error; }));
      }
      return tilePromises.get(key);
    }));
  }
  function loadAll() {
    if (fullTask || stopped) return fullTask;
    fullTask = (async () => {
      onStatus(true);
      try {
        const index = await manifest();
        addMetadata(await json(`/data/stations/${index.version}/all.json`));
        let cursor = 0;
        let failures = 0;
        let lastEmit = 0;
        // 同時最多三個背景請求；前景附近查詢擁有獨立取消控制。
        await Promise.all(Array.from({ length: Math.min(3, index.centers.length) }, async () => {
          while (cursor < index.centers.length && !stopped) {
            const point = index.centers[cursor++];
            try { applyLive(await live(point, 10000, lifetime.signal)); }
            catch { if (!stopped) failures++; }
            if (Date.now() - lastEmit > 400) { lastEmit = Date.now(); emit(); }
          }
        }));
        fullError = failures ? '部分區域更新失敗，保留上次資料' : null;
        if (!failures) fullUpdatedAt = Date.now();
      } catch { fullError = '背景站點載入失敗，稍後重試'; }
      finally { emit(); if (!stopped) onStatus(false); fullTask = null; }
    })();
    return fullTask;
  }
  function focus(point, { force = false } = {}) {
    if (stopped) return Promise.resolve();
    if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng) || Math.abs(point.lat) > 85 || Math.abs(point.lng) > 180) return Promise.resolve();
    const radius = Math.min(10000, Math.max(2000, Number.isFinite(point.radius) ? point.radius : 4000));
    if (!force && focusPoint && distance(point, focusPoint) < radius / 3 && Date.now() - lastFocusAt < 30000) return nearTask;
    focusPoint = { ...point, radius };
    lastFocusAt = Date.now();
    nearbyController?.abort();
    const controller = new AbortController();
    nearbyController = controller;
    nearTask = (async () => {
      try {
        const [, rows] = await Promise.all([nearbyMetadata(point, radius), live(point, radius, controller.signal)]);
        if (controller.signal.aborted || stopped) return;
        applyLive(rows);
        nearError = null;
        emit();
      } catch {
        if (controller.signal.aborted || stopped) return;
        nearError = '附近站點更新失敗，正在嘗試其他區域';
        emit();
      } finally {
        if (!controller.signal.aborted && !stopped && Date.now() - fullUpdatedAt > 300000) void loadAll();
      }
    })();
    return nearTask;
  }
  const timer = refreshMs > 0 ? setInterval(() => { if (focusPoint) void focus(focusPoint, { force: true }); }, refreshMs) : null;
  return {
    focus,
    refresh: () => focusPoint ? focus(focusPoint, { force: true }) : Promise.resolve(),
    whenIdle: async () => { await nearTask; await fullTask; },
    stop: () => { stopped = true; lifetime.abort(); nearbyController?.abort(); if (timer) clearInterval(timer); },
  };
}
