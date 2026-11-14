'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { findSweep, calculateFib, candleTouches, findHourlySweep, findM5Entries, isInsideThreeBullish, isInsideThreeBearish } = require('./strategy');

function c(time, open, high, low, close) {
  return { time: Date.parse(time + 'Z'), open, high, low, close, volume: 1 };
}

test('recognizes a low-level rejection as a bullish liquidity sweep', () => {
  const result = findSweep(c('2026-11-10T00:00:00', 102, 108, 95, 105), { lows: [{ price: 100, name: 'PDL' }], highs: [] });
  assert.equal(result.bullish.levelName, 'PDL');
  assert.equal(result.bullish.level, 100);
  assert.equal(result.bearish, null);
});

test('recognizes a high-level rejection as a bearish liquidity sweep', () => {
  const result = findSweep(c('2026-11-10T00:00:00', 98, 105, 90, 94), { lows: [], highs: [{ price: 100, name: 'PDH' }] });
  assert.equal(result.bearish.levelName, 'PDH');
  assert.equal(result.bearish.level, 100);
  assert.equal(result.bullish, null);
});

test('maps bullish and bearish Fibonacci anchors in the requested direction', () => {
  const candle = { high: 120, low: 100 };
  const bull = calculateFib(candle, 'bullish'), bear = calculateFib(candle, 'bearish');
  assert.equal(bull['0'], 100);
  assert.equal(bull['1'], 120);
  assert.equal(bull['0.5'], 110);
  assert.ok(Math.abs(bull['0.618'] - 112.36) < 1e-9);
  assert.equal(bear['0'], 120);
  assert.equal(bear['1'], 100);
  assert.ok(Math.abs(bear['0.618'] - 107.64) < 1e-9);
});

test('detects a touch when the candle range includes the entry level', () => {
  assert.equal(candleTouches({ high: 111, low: 109 }, 110), true);
  assert.equal(candleTouches({ high: 109.9, low: 108 }, 110), false);
});

test('H1 confirmation can sweep a low from more than the immediately previous candle', () => {
  const bars = [
    c('2026-11-10T01:00:00', 110, 112, 100, 108),
    c('2026-11-10T02:00:00', 108, 110, 104, 106),
    c('2026-11-10T03:00:00', 106, 109, 103, 107),
    c('2026-11-10T04:00:00', 105, 108, 98, 105)
  ];
  const result = findHourlySweep(bars, 'bullish', bars[0].time);
  assert.ok(result);
  assert.equal(result.level, 104);
  assert.equal(result.time, bars[3].time);
});

test('second entry preserves the specified candle-high stop for BUY and blocks its wrong side', () => {
  const fib = { '0': 100, '0.5': 110, '0.618': 112.36, '1': 120 };
  const bars = [c('2026-11-10T05:00:00', 113, 115, 111, 113)];
  const entries = findM5Entries(bars, 'bullish', bars[0].time, fib);
  const second = entries.find(e => e.type === 'SECOND_ENTRY');
  assert.ok(second);
  assert.equal(second.stopLoss, 115);
  assert.equal(second.stopValid, false);
  assert.equal(second.status, 'BLOCKED_INVALID_STOP_SIDE');
});

test('recognizes the three-candle inside pattern in both directions', () => {
  const bullish = [
    c('2026-11-10T00:00:00', 10, 15, 9, 14),
    c('2026-11-11T00:00:00', 14, 14.5, 10, 11),
    c('2026-11-12T00:00:00', 11, 14, 10, 13)
  ];
  const bearish = [
    c('2026-11-10T00:00:00', 14, 15, 9, 10),
    c('2026-11-11T00:00:00', 11, 14, 10, 13),
    c('2026-11-12T00:00:00', 13, 14, 10, 11)
  ];
  assert.equal(isInsideThreeBullish(bullish, 2), true);
  assert.equal(isInsideThreeBearish(bearish, 2), true);
});
