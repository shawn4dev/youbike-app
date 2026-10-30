import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchMunicipalStations } from '../lib/municipal-stations.mjs';

const tp = { sno: '500101001', sna: 'YouBike2.0_捷運站', sarea: '大安區', ar: '台北路', act: '1', Quantity: 30, available_rent_bikes: 9, available_return_bikes: 21, latitude: 25.01, longitude: 121.5, mday: '2026-10-29 09:00:00' };
const ntpc = { sno: '500218084', sna: 'YouBike2.0_板橋站', sarea: '板橋區', ar: '新北路', act: '1', tot_quantity: '25', sbi_quantity: '7', bemp: '18', yb2_quantity: '5', eyb_quantity: '2', lat: '25.02', lng: '121.46' };
const kcg = { sno: '501206012', sna: 'YouBike2.0_高雄站', sarea: '三民區', ar: '高雄路', act: '0', tot: '20', sbi: '4', bemp: '16', sbi_detail: { yb2: '3', eyb: '1' }, lat: '22.63', lng: '120.36' };

// 使用者要求暫停：fixture 仍假設高雄 kcg.gov.tw，但市府模組已使用
// workers.dev，現行實驗則走官方完整 feed。待 fixture 對齊市府來源後恢復。
/*
test('三個市府 API 並行取得全市即時車位，不呼叫 YouBike 統一 API', async () => {
  const urls = [];
  const { stations, failedCities } = await fetchMunicipalStations({ fetchImpl: async url => {
    urls.push(url);
    if (url.includes('tcgbusfs')) return Response.json([tp]);
    if (url.includes('ntpc.gov.tw')) return Response.json([ntpc]);
    if (url.includes('kcg.gov.tw')) return Response.json({ data: { data: { retVal: [kcg] } } });
    throw new Error('Unexpected URL: ' + url);
  }});
  assert.deepEqual(failedCities, []);
  assert.equal(urls.length, 3);
  assert.ok(urls.some(url => url.includes('size=5000')));
  assert.deepEqual(stations.map(s => s.id), ['tp-500101001', 'ntpc-500218084', 'kcg-501206012']);
  assert.deepEqual(stations.map(s => s.available), [9, 7, 4]);
  assert.equal(stations[0].empty, 21);
  assert.equal(stations[1].regularBikes, 5);
  assert.equal(stations[1].ebikes, 2);
  assert.equal(stations[2].active, false);
});
*/

test('其中一市失敗時仍提供其他兩市站點，並標出失敗城市', async () => {
  const { stations, failedCities } = await fetchMunicipalStations({ fetchImpl: async url => {
    if (url.includes('ntpc.gov.tw')) throw new Error('offline');
    return Response.json(url.includes('tcgbusfs') ? [tp] : { data: { retVal: [kcg] } });
  }});
  assert.deepEqual(failedCities, ['新北']);
  assert.deepEqual(stations.map(s => s.id), ['tp-500101001', 'kcg-501206012']);
});

// 使用者要求暫停：fixture 假設 api.kcg.gov.tw／openapi.kcg.gov.tw 主備，
// 現有主備皆為同一 workers.dev。待 fixture 與備援行為對齊後恢復。
/*
test('高雄主端點失敗時使用備援，兩次請求共用逾時額度', async () => {
  const calls = [];
  const { stations, failedCities } = await fetchMunicipalStations({ fetchImpl: async (url, options) => {
    if (url.includes('tcgbusfs')) return Response.json([tp]);
    if (url.includes('ntpc.gov.tw')) return Response.json([ntpc]);
    calls.push({ url, signal: options.signal });
    if (url.startsWith('https://api.kcg.gov.tw')) throw new Error('primary offline');
    return Response.json({ data: { retVal: [kcg] } });
  }});
  assert.deepEqual(failedCities, []);
  assert.ok(stations.some(s => s.id === 'kcg-501206012'));
  assert.equal(calls.length, 2);
  assert.ok(calls[1].url.startsWith('https://openapi.kcg.gov.tw'));
  assert.equal(calls[0].signal, calls[1].signal);
});
*/
