import test from 'node:test';
import assert from 'node:assert/strict';
import { isMapBackgroundClick, withoutStation } from '../lib/map-selection.mjs';

test('清除分享站號保留最新地圖位置與其他查詢條件', () => {
  const url = withoutStation('https://example.test/?station=tp-500101001&lat=25.1234&lng=121.5678&z=15&city=all#map');
  assert.equal(url.searchParams.has('station'), false);
  assert.equal(url.searchParams.get('lat'), '25.1234');
  assert.equal(url.searchParams.get('lng'), '121.5678');
  assert.equal(url.searchParams.get('z'), '15');
  assert.equal(url.searchParams.get('city'), 'all');
  assert.equal(url.hash, '#map');
});

test('只有使用者點擊地圖空白可取消，圖標、popup、控制列與程式事件不取消', () => {
  assert.equal(isMapBackgroundClick({}), false);
  assert.equal(isMapBackgroundClick({ originalEvent: { target: { closest: () => null } } }), true);
  for (const selector of ['.leaflet-marker-icon', '.leaflet-popup', '.leaflet-control', '.leaflet-interactive']) {
    const event = { originalEvent: { target: { closest: selectors => selectors.includes(selector) ? {} : null } } };
    assert.equal(isMapBackgroundClick(event), false);
  }
});
