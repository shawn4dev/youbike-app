import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { buildStationIndex, METADATA_URL } from '../lib/station-data.mjs';

const response = await fetch(METADATA_URL, { signal: AbortSignal.timeout(20000) });
if (!response.ok) throw new Error(`站點索引下載失敗: HTTP ${response.status}`);
const rows = await response.json();
if (!Array.isArray(rows) || !rows.length) throw new Error('站點索引沒有資料');
const { stations, tiles, centers } = buildStationIndex(rows);
for (const code of ['00', '05', '12']) {
  if (!stations.some(station => station.area_code === code)) throw new Error(`站點索引缺少服務區 ${code}`);
}
const body = JSON.stringify(stations);
const version = createHash('sha256').update(body).digest('hex').slice(0, 12);
const base = new URL('../public/data/stations/', import.meta.url);
await mkdir(new URL(`${version}/`, base), { recursive: true });
await writeFile(new URL(`${version}/all.json`, base), body);
await Promise.all(Object.entries(tiles).map(([key, value]) => writeFile(new URL(`${version}/${key}.json`, base), JSON.stringify(value))));
await writeFile(new URL('index.json', base), JSON.stringify({ version, tiles: Object.keys(tiles), centers }));
console.log(`已產生 ${stations.length} 站靜態索引、${Object.keys(tiles).length} 區塊、${centers.length} 個背景查詢圓心；即時車位於瀏覽器取得。`);
