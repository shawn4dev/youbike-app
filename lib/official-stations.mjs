import { fetchStationFeedConditional, normOfficial } from './official-feed.js';

export const CITIES = { '00': ['臺北', 'tp'], '05': ['新北', 'ntpc'], '12': ['高雄', 'kcg'] };
export const LIVE_TTL = 45000;

export function legacyStation(row, receivedAt) {
  const station = normOfficial(row, row);
  const detail = row.available_spaces_detail;
  return { ...station, id: `${CITIES[row.area_code][1]}-${row.station_no}`,
    regularBikes: detail?.yb2 == null || detail.yb2 === '' ? null : Number(detail.yb2),
    ebikes: detail?.eyb == null || detail.eyb === '' ? null : Number(detail.eyb),
    updated: row.updated_at || row.time || null, receivedAt };
}

function validateFeed(rows) {
  if (!Array.isArray(rows) || !rows.length) throw new Error('full feed is empty or invalid');
  const selected = rows.filter(row => row && CITIES[row.area_code]);
  const seen = new Set();
  for (const row of selected) {
    const validNumber = key => row[key] !== '' && row[key] != null && Number.isFinite(Number(row[key]));
    if (typeof row.station_no !== 'string' || !row.station_no || seen.has(row.station_no) ||
      !row.name_tw || !validNumber('lat') || !validNumber('lng') ||
      Number(row.lat) < 21 || Number(row.lat) > 26 || Number(row.lng) < 119 || Number(row.lng) > 123 ||
      ![1, 2].includes(Number(row.status)) ||
      ['parking_spaces', 'available_spaces', 'empty_spaces'].some(key => !validNumber(key) || Number(row[key]) < 0) ||
      ['yb2', 'eyb'].some(key => row.available_spaces_detail?.[key] != null && row.available_spaces_detail[key] !== '' &&
        (!Number.isFinite(Number(row.available_spaces_detail[key])) || Number(row.available_spaces_detail[key]) < 0))) {
      throw new Error('full feed contains an invalid or duplicate station');
    }
    seen.add(row.station_no);
  }
  if (Object.keys(CITIES).some(code => !selected.some(row => row.area_code === code))) throw new Error('full feed missing a required city');
  return selected;
}

// A single full-feed snapshot and conditional request are shared by all city
// views. Filtering never mutates the shared three-city snapshot.
export function createOfficialStations({ fetchImpl = fetch, now = Date.now, liveTtl = LIVE_TTL, timeoutMs = 15000 } = {}) {
  let stations = null;
  let sourceLastModified = null;
  let fetchedAt = null;
  let checkedAt = null;
  let attemptedAt = null;
  let sourceErrors = [];
  let inFlight = null;

  async function refresh() {
    try {
      const result = await fetchStationFeedConditional(sourceLastModified, { fetchImpl, timeoutMs });
      if (result.notModified) {
        if (!stations || !sourceLastModified) throw new Error('unexpected 304 without a valid snapshot');
        // 304 checks the existing representation; it does not fetch new data.
      } else {
        const rows = validateFeed(result.stations);
        const receivedAt = new Date(now()).toISOString();
        const next = rows.map(row => legacyStation(row, receivedAt));
        stations = next;
        fetchedAt = receivedAt;
        // Never advance the validator before the entire payload is accepted.
        sourceLastModified = result.lastModified;
      }
      checkedAt = new Date(now()).toISOString();
      sourceErrors = [];
    } catch (error) { sourceErrors = [String(error?.message || error)]; }
    finally { attemptedAt = now(); }
  }
  function update() {
    if (!inFlight) inFlight = refresh().finally(() => { inFlight = null; });
    return inFlight;
  }
  function snapshot(city, cached) {
    const selected = stations?.filter(station => !city || station.city === city) ?? [];
    return { stations: selected, errors: sourceErrors.length ? (city ? [city] : Object.values(CITIES).map(([name]) => name)) : [],
      fetchedAt, checkedAt, sourceLastModified, sourceErrors, cached,
      stale: !fetchedAt || now() - Date.parse(fetchedAt) >= liveTtl };
  }
  return { async get({ force = false, city } = {}) {
    if (city != null && !Object.values(CITIES).some(([name]) => name === city)) throw new Error('unknown city');
    if (force || attemptedAt === null) {
      await update();
      return snapshot(city, false);
    }
    if (now() - attemptedAt >= liveTtl) void update();
    return snapshot(city, true);
  } };
}
