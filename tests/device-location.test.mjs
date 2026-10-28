import test from 'node:test';
import assert from 'node:assert/strict';
import { requestDeviceLocation } from '../lib/device-location.mjs';

test('先要求快速快取定位，再背景精確定位，取消後不回寫位置', () => {
  const calls = [];
  const positions = [];
  const cancel = requestDeviceLocation({ geolocation: { getCurrentPosition: (...args) => calls.push(args) },
    onPosition: point => positions.push(point), onUnavailable: () => assert.fail('不應啟用備援') });
  assert.equal(calls[0][2].enableHighAccuracy, false);
  assert.equal(calls[0][2].timeout, 2500);
  assert.ok(calls[0][2].maximumAge > 0);
  calls[0][0]({ coords: { latitude: 25, longitude: 121, accuracy: 100 } });
  assert.deepEqual(positions[0], { lat: 25, lng: 121, accuracy: 100 });
  assert.equal(calls[1][2].enableHighAccuracy, true);
  cancel();
  calls[1][0]({ coords: { latitude: 24, longitude: 120, accuracy: 10 } });
  assert.equal(positions.length, 1);
});

test('拒絕定位立即回報備援，不重複要求權限', () => {
  const calls = [];
  const errors = [];
  requestDeviceLocation({ geolocation: { getCurrentPosition: (...args) => calls.push(args) },
    onPosition: () => assert.fail('沒有位置'), onUnavailable: error => errors.push(error) });
  calls[0][1]({ code: 1, message: 'denied' });
  assert.equal(calls.length, 1);
  assert.equal(errors.length, 1);
});
