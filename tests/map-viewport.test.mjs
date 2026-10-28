import assert from 'node:assert/strict';
import test from 'node:test';
import { markersWithinBounds, paddedMarkerBounds, viewportWithinMarkerBounds } from '../lib/map-viewport.mjs';

const stations = [
  { id: 'banqiao', lat: 25.01, lng: 121.46 },
  { id: 'nearby', lat: 25.035, lng: 121.49 },
  { id: 'taipei', lat: 25.1, lng: 121.6 },
  { id: 'kaohsiung', lat: 22.63, lng: 120.35 },
  { id: 'invalid', lat: NaN, lng: 121.46 },
];

test('地圖僅繪製可視範圍與周邊緩衝區站點，原始資料保持完整', () => {
  const bounds = paddedMarkerBounds({ south: 25.0, west: 121.45, north: 25.02, east: 121.47 });
  assert.deepEqual(markersWithinBounds(stations, bounds).map((s) => s.id), ['banqiao']);
  assert.equal(stations.length, 5);
});

test('可透過視野移動顯示其他縣市，無需捨棄完整站點資料', () => {
  const kaohsiungBounds = paddedMarkerBounds({ south: 22.62, west: 120.34, north: 22.64, east: 120.36 });
  assert.deepEqual(markersWithinBounds(stations, kaohsiungBounds).map((s) => s.id), ['kaohsiung']);
});

test('已選站點在移動視野或開啟分享網址時仍有圖標', () => {
  const bounds = paddedMarkerBounds({ south: 25.0, west: 121.45, north: 25.02, east: 121.47 });
  assert.deepEqual(markersWithinBounds(stations, bounds, 'kaohsiung').map((s) => s.id), ['banqiao', 'kaohsiung']);
});

test('緩衝區包含視野外鄰近站點', () => {
  const bounds = paddedMarkerBounds({ south: 25.0, west: 121.45, north: 25.03, east: 121.48 });
  assert.deepEqual(markersWithinBounds(stations, bounds).map((s) => s.id), ['banqiao', 'nearby']);
});

test('小幅拖曳保持在緩衝區內時可跳過圖標更新，超出時則必須刷新', () => {
  const renderedBounds = paddedMarkerBounds({ south: 25.0, west: 121.45, north: 25.02, east: 121.47 });
  assert.equal(viewportWithinMarkerBounds({ south: 25.004, west: 121.453, north: 25.024, east: 121.473 }, renderedBounds), true);
  assert.equal(viewportWithinMarkerBounds({ south: 25.01, west: 121.47, north: 25.03, east: 121.49 }, renderedBounds), false);
});
