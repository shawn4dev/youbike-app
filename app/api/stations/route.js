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
  return d.map(normTp);
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
  return all.map(normNtpc);
}

async function fetchKaohsiung() {
  const raw = await fetchJson('https://openapi.kcg.gov.tw/Api/Service/Get/b4dd9c40-9027-4125-8666-06bef1756092');
  const arr = raw?.data?.retVal ?? (Array.isArray(raw) ? raw : []);
  return arr.map(normKcg);
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
  const stations = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
  const errors = results
    .map((r, i) => (r.status === 'rejected' ? cityNames[i] : null))
    .filter(Boolean);

  const payload = { stations, errors, fetchedAt: new Date().toISOString() };
  // 防禦:上游大規模失敗時不覆蓋舊快取
  const prevCount = CACHE?.payload?.stations?.length ?? 0;
  if (!CACHE || stations.length >= prevCount * 0.5 || stations.length > prevCount) {
    CACHE = { ts: Date.now(), payload };
  }
  return Response.json(payload, { headers: { 'Cache-Control': 'no-store' } });
}
