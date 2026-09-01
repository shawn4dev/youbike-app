import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const areasSource = await readFile(new URL('../lib/areas.js', import.meta.url), 'utf8');
const { AREA_CENTERS, matchArea } = await import(
  `data:text/javascript;base64,${Buffer.from(areasSource).toString('base64')}`
);

test('每個行政區都接受完整名稱與省略「區」的精確查詢', () => {
  for (const area of Object.keys(AREA_CENTERS)) {
    assert.equal(matchArea(area), area);
    assert.equal(matchArea(area.replace(/區$/, '')), area);
  }
});

test('較長的站名或地址不會被誤判成行政區查詢', () => {
  assert.equal(matchArea('板橋區公所'), null);
  assert.equal(matchArea('捷運板橋站'), null);
  assert.equal(matchArea('位於板橋區文化路'), null);
});
