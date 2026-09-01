export const dynamic = 'force-dynamic';

// ---------- 正規化:三個城市成同一格式 ----------
// 臺北:官方 blob JSON(無車型明細);新北:data.ntpc.gov.tw(有 yb2/eyb);高雄:openapi.kcg.gov.tw(有 sbi_detail)
function normTp(s) {
  return {
    id: `tp-${s.sno}`,
    city: '臺北',
    name: s.sna.replace(/^YouBike2\.0_/, ''),
    nameEn: (s.snaen || '').replace(/^YouBike2\.0_/, ''),
    area: s.sarea,
    addr: s.ar,
    active: String(s.act) === '1',
    total: Number(s.Quantity ?? 0),
    available: Number(s.available_rent_bikes ?? 0),
    // 臺北 API 無車型細分欄位
    regularBikes: null,
    ebikes: null,
    empty: s.available_return_bikes === '' ? null : Number(s.available_return_bikes),
    lat: parseFloat(s.latitude),
    lng: parseFloat(s.longitude),
    updated: s.mday,
  };
}

function normNtpc(s) {
  const emptyRaw = s.bemp_quantity ?? s.bemp;
  return {
    id: `ntpc-${s.sno}`,
    city: '新北',
    name: s.sna.replace(/^YouBike2\.0_/, ''),
    nameEn: (s.snaen || '').replace(/^YouBike2\.0_/, ''),
    area: s.sarea,
    addr: s.ar,
    active: String(s.act) === '1',
    total: Number(s.tot_quantity || 0),
    available: Number(s.sbi_quantity || 0),
    regularBikes: s.yb2_quantity === '' ? null : Number(s.yb2_quantity || 0),
    ebikes: s.eyb_quantity === '' ? null : Number(s.eyb_quantity || 0),
    empty: emptyRaw === '' || emptyRaw == null ? null : Number(emptyRaw),
    lat: parseFloat(s.lat ?? s.latitude),
    lng: parseFloat(s.lng ?? s.longitude),
    updated: s.mday,
  };
}

function normKcg(s) {
  let regularBikes = null;
  let ebikes = null;
  if (s.sbi_detail && typeof s.sbi_detail === 'object') {
    regularBikes = s.sbi_detail.yb2 === '' ? null : Number(s.sbi_detail.yb2 || 0);
    ebikes = s.sbi_detail.eyb === '' ? null : Number(s.sbi_detail.eyb || 0);
  }
  return {
    id: `kcg-${s.sno}`,
    city: '高雄',
    name: s.sna.replace(/^YouBike2\.0_/, ''),
    nameEn: (s.snaen || '').replace(/^YouBike2\.0_/, ''),
    area: s.sarea,
    addr: s.ar,
    active: String(s.act) === '1',
    total: Number(s.tot || 0),
    available: Number(s.sbi || 0),
    regularBikes,
    ebikes,
    empty: s.bemp === '' || s.bemp == null ? null : Number(s.bemp),
    lat: parseFloat(s.lat),
    lng: parseFloat(s.lng),
    updated: s.mday,
  };
}

function rowsFrom(value) {
  if (typeof value === 'string') {
    try { return rowsFrom(JSON.parse(value)); } catch { return []; }
  }
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') {
    if (value.data != null) return rowsFrom(value.data);
    if (value.retVal != null) return rowsFrom(value.retVal);
    return Object.values(value);
  }
  return [];
}

// ---------- 抓取工具 ----------
async function fetchJson(url, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    return JSON.parse(text.replace(/^\uFEFF/, ''));
  } finally {
    clearTimeout(t);
  }
}

async function fetchTaipei() {
  const d = await fetchJson('https://tcgbusfs.blob.core.windows.net/dotapp/youbike/v2/youbike_immediate.json');
  const rows = Array.isArray(d) ? d : d?.data ?? d?.retVal ?? [];
  const stations = rowsFrom(rows).map(normTp);
  if (stations.length === 0) throw new Error('Taipei API returned no stations');
  return stations;
}

async function fetchNewTaipei() {
  const base = 'https://data.ntpc.gov.tw/api/datasets/010e5b15-3823-4b20-b401-b1cf000550c5/json';
  const all = [];
  for (let page = 0; page < 5; page++) {
    const batch = await fetchJson(`${base}?size=1000&page=${page}`);
    if (!Array.isArray(batch) || batch.length === 0) break;
    all.push(...batch);
    if (batch.length < 1000) break;
  }
  const stations = all.map(normNtpc);
  if (stations.length === 0) throw new Error('New Taipei API returned no stations');
  return stations;
}

async function fetchKaohsiung() {
  // 高雄市政府目前使用 api.kcg.gov.tw；保留舊網域作為備援，避免單一網域異常時整個城市消失。
  let raw;
  try {
    raw = await fetchJson('https://api.kcg.gov.tw/api/service/Get/b4dd9c40-9027-4125-8666-06bef1756092');
  } catch {
    raw = await fetchJson('https://openapi.kcg.gov.tw/Api/Service/Get/b4dd9c40-9027-4125-8666-06bef1756092');
  }
  // 回應可能是 data.data.retVal、data.retVal 或直接陣列，統一遞迴拆出站點列。
  const rows = rowsFrom(raw);
  if (rows.length === 0) throw new Error('Kaohsiung API returned no stations');
  return rows.map(normKcg);
}

// ---------- 伺服器端快取 45 秒 ----------
let CACHE = null;
const CACHE_MS = 45 * 1000;

export async function GET(request) {
  const force = new URL(request.url).searchParams.get('force') === '1';
  if (!force && CACHE && Date.now() - CACHE.ts < CACHE_MS) {
    return Response.json({ ...CACHE.payload, cached: true }, { headers: { 'Cache-Control': 'no-store' } });
  }

  const results = await Promise.allSettled([
    fetchTaipei(),
    fetchNewTaipei(),
    fetchKaohsiung(),
  ]);

  const cityNames = ['臺北', '新北', '高雄'];
  const failedCities = results
    .map((r, i) => (r.status === 'rejected' ? cityNames[i] : null))
    .filter(Boolean);
  let stations = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));

  // 上游偶發逾時時，沿用該城市上一筆快取，避免台北／高雄整批圓點瞬間消失。
  if (failedCities.length && CACHE?.payload?.stations?.length) {
    const fallback = CACHE.payload.stations.filter((s) => failedCities.includes(s.city));
    stations = stations.concat(fallback);
  }
  const errors = failedCities;

  const payload = { stations, errors, fetchedAt: new Date().toISOString() };
  // 防禦:上游大規模失敗時不覆蓋舊快取
  const prevCount = CACHE?.payload?.stations?.length ?? 0;
  if (failedCities.length === 0 && (!CACHE || stations.length >= prevCount * 0.5 || stations.length > prevCount)) {
    CACHE = { ts: Date.now(), payload };
  }
  return Response.json(payload, { headers: { 'Cache-Control': 'no-store' } });
}
