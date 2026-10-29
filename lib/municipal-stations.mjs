const TAIPEI_URL = 'https://tcgbusfs.blob.core.windows.net/dotapp/youbike/v2/youbike_immediate.json';
const NEW_TAIPEI_URL = 'https://data.ntpc.gov.tw/api/datasets/010e5b15-3823-4b20-b401-b1cf000550c5/json?size=5000&page=0';
const KAOHSIUNG_URL = 'https://openapi.kcg.gov.tw/Api/Service/Get/b4dd9c40-9027-4125-8666-06bef1756092';
const KAOHSIUNG_BACKUP_URL = 'https://api.kcg.gov.tw/api/service/Get/b4dd9c40-9027-4125-8666-06bef1756092';

function rowsFrom(value) {
  if (typeof value === 'string') {
    try { return rowsFrom(JSON.parse(value)); } catch { return []; }
  }
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') {
    if (value.data != null) return rowsFrom(value.data);
    if (value.retVal != null) return rowsFrom(value.retVal);
  }
  return [];
}

function name(value) { return String(value || '').replace(/^YouBike2\.0_/, ''); }
function count(value) { return Number(value ?? 0); }
function nullableCount(value) { return value == null || value === '' ? null : Number(value); }

function base(s, prefix, city) {
  return {
    id: `${prefix}-${s.sno}`, city,
    name: name(s.sna), nameEn: name(s.snaen), area: s.sarea || '', addr: s.ar || '',
    active: String(s.act) === '1', updated: s.mday,
  };
}

function normalizeTaipei(s) {
  return {
    ...base(s, 'tp', '臺北'), total: count(s.Quantity ?? s.quantity),
    available: count(s.available_rent_bikes), empty: nullableCount(s.available_return_bikes),
    regularBikes: null, ebikes: null,
    lat: Number(s.latitude), lng: Number(s.longitude),
  };
}

function normalizeNewTaipei(s) {
  return {
    ...base(s, 'ntpc', '新北'), total: count(s.tot_quantity),
    available: count(s.sbi_quantity), empty: nullableCount(s.bemp_quantity ?? s.bemp),
    regularBikes: nullableCount(s.yb2_quantity), ebikes: nullableCount(s.eyb_quantity),
    lat: Number(s.lat ?? s.latitude), lng: Number(s.lng ?? s.longitude),
  };
}

function normalizeKaohsiung(s) {
  const detail = s.sbi_detail && typeof s.sbi_detail === 'object' ? s.sbi_detail : {};
  return {
    ...base(s, 'kcg', '高雄'), total: count(s.tot), available: count(s.sbi),
    empty: nullableCount(s.bemp), regularBikes: nullableCount(detail.yb2),
    ebikes: nullableCount(detail.eyb), lat: Number(s.lat), lng: Number(s.lng),
  };
}

async function fetchJson(url, fetchImpl, signal) {
  const response = await fetchImpl(url, { cache: 'no-store', signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return JSON.parse((await response.text()).replace(/^\uFEFF/, ''));
}

async function fetchCity(url, normalize, fetchImpl, signal) {
  const rows = rowsFrom(await fetchJson(url, fetchImpl, signal));
  const stations = rows.filter(s => s && s.sno).map(normalize)
    .filter(s => Number.isFinite(s.lat) && Number.isFinite(s.lng));
  if (stations.length === 0) throw new Error('站點資料為空');
  return stations;
}

export async function fetchMunicipalStations({ fetchImpl = fetch, timeoutMs = 12000 } = {}) {
  const sources = [
    ['臺北', () => fetchCity(TAIPEI_URL, normalizeTaipei, fetchImpl, AbortSignal.timeout(timeoutMs))],
    ['新北', () => fetchCity(NEW_TAIPEI_URL, normalizeNewTaipei, fetchImpl, AbortSignal.timeout(timeoutMs))],
    ['高雄', async () => {
      // 主來源與備援共用逾時額度，避免連續等待兩次而拖慢整頁載入。
      const signal = AbortSignal.timeout(timeoutMs);
      try { return await fetchCity(KAOHSIUNG_URL, normalizeKaohsiung, fetchImpl, signal); }
      catch (error) {
        if (signal.aborted) throw error;
        return fetchCity(KAOHSIUNG_BACKUP_URL, normalizeKaohsiung, fetchImpl, signal);
      }
    }],
  ];
  const results = await Promise.allSettled(sources.map(([, load]) => load()));
  return {
    stations: results.flatMap(result => result.status === 'fulfilled' ? result.value : []),
    failedCities: sources.filter((_, i) => results[i].status === 'rejected').map(([city]) => city),
  };
}
