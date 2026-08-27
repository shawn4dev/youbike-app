export const dynamic = 'force-dynamic';

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const TIMEOUT_MS = 8 * 1000;
const CACHE_MS = 10 * 60 * 1000;
const CACHE_MAX = 20;

// ---------- 快取:bounds(2位小數)+types 當 key,LRU 上限 20 ----------
const cache = new Map(); // key -> { ts, landmarks }

function cacheKey(south, west, north, east, types) {
  const r = (v) => Number(v).toFixed(2);
  return `${r(south)},${r(west)},${r(north)},${r(east)}|${types.sort().join(',')}`;
}

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > CACHE_MS) {
    cache.delete(key);
    return null;
  }
  // LRU touch:刪掉重插,讓 Map 迭代順序 = 最近使用順序
  cache.delete(key);
  cache.set(key, hit);
  return hit.landmarks;
}

function cacheSet(key, landmarks) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, { ts: Date.now(), landmarks });
  while (cache.size > CACHE_MAX) {
    // Map 第一個 key = 最久沒用的
    cache.delete(cache.keys().next().value);
  }
}

// ---------- Overpass 查詢 ----------
function buildQuery(south, west, north, east) {
  const bbox = `${south},${west},${north},${east}`;
  return `[out:json][timeout:${Math.floor(TIMEOUT_MS / 1000) - 1}];
(
  node["railway"~"station|halt"](${bbox});
  node["station"="subway"](${bbox});
  way["leisure"="park"](${bbox});
  node["shop"~"department_store|mall"](${bbox});
  way["amenity"~"marketplace"](${bbox});
);
out center tags;`;
}

async function fetchOverpass(query) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(OVERPASS_URL, {
      method: 'POST',
      signal: ctrl.signal,
      cache: 'no-store',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'youbike-app/1.0 (landmarks near youbike stations)',
      },
      body: `data=${encodeURIComponent(query)}`,
    });
    if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

// ---------- 正規化 ----------
function normElement(el) {
  const tags = el.tags || {};
  let type = null;
  if (el.type === 'node' && tags.railway && /station|halt/.test(tags.railway)) type = 'station';
  else if (el.type === 'node' && tags.station === 'subway') type = 'station';
  else if (el.type === 'way' && tags.leisure === 'park') type = 'park';
  else if (el.type === 'node' && tags.shop && /department_store|mall/.test(tags.shop)) type = 'market';
  else if (el.type === 'way' && tags.amenity === 'marketplace') type = 'market';
  if (!type) return null;

  // node 直接用座標;way 用 out center 的中心點
  const lat = el.lat ?? el.center?.lat;
  const lng = el.lon ?? el.center?.lon;
  if (typeof lat !== 'number' || typeof lng !== 'number') return null;

  return {
    id: `${type}-${el.type}${el.id}`,
    type,
    name: tags.name || tags['name:en'] || '',
    lat,
    lng,
  };
}

// ---------- GET ----------
export async function GET(request) {
  const sp = new URL(request.url).searchParams;
  const south = parseFloat(sp.get('south'));
  const west = parseFloat(sp.get('west'));
  const north = parseFloat(sp.get('north'));
  const east = parseFloat(sp.get('east'));
  const rawTypes = (sp.get('types') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const types = new Set(
    rawTypes.filter((t) => ['station', 'park', 'market'].includes(t))
  );

  if ([south, west, north, east].some((v) => Number.isNaN(v))) {
    return Response.json({ landmarks: [], error: '缺少或無效的 bounds 參數(south,west,north,east)' });
  }
  if (types.size === 0) {
    return Response.json({ landmarks: [], error: '缺少有效的 types 參數(station,park,market)' });
  }

  const ckey = cacheKey(south, west, north, east, [...types]);
  const cached = cacheGet(ckey);
  if (cached) {
    return Response.json({ landmarks: cached, cached: true }, { headers: { 'Cache-Control': 'no-store' } });
  }

  try {
    const data = await fetchOverpass(buildQuery(south, west, north, east));
    const landmarks = (data.elements || [])
      .map(normElement)
      .filter((l) => l && types.has(l.type));
    cacheSet(ckey, landmarks);
    return Response.json({ landmarks }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    // 失敗回 HTTP 200 空陣列,前端好處理
    const msg =
      err?.name === 'AbortError'
        ? 'Overpass API 查詢逾時'
        : `Overpass API 查詢失敗:${err?.message ?? 'unknown'}`;
    return Response.json({ landmarks: [], error: msg }, { headers: { 'Cache-Control': 'no-store' } });
  }
}
