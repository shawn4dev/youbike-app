import { fetchMunicipalStations } from '../../../lib/municipal-stations.mjs';

export const dynamic = 'force-dynamic';

let cache = null;
let inFlight = null;
const CACHE_MS = 45_000;

async function loadStations() {
  const { stations: fresh, failedCities } = await fetchMunicipalStations();
  const stations = [...fresh];
  if (failedCities.length && cache) {
    stations.push(...cache.payload.stations.filter(station => failedCities.includes(station.city)));
  }
  const payload = { stations, errors: failedCities, fetchedAt: new Date().toISOString() };
  if (!failedCities.length && stations.length) cache = { ts: Date.now(), payload };
  return payload;
}

export async function GET(request) {
  const force = new URL(request.url).searchParams.get('force') === '1';
  if (!force && cache && Date.now() - cache.ts < CACHE_MS) {
    return Response.json({ ...cache.payload, cached: true }, { headers: { 'Cache-Control': 'no-store' } });
  }
  if (!inFlight) inFlight = loadStations().finally(() => { inFlight = null; });
  const payload = await inFlight;
  return Response.json(payload, { headers: { 'Cache-Control': 'no-store' } });
}
