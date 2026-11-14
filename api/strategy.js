'use strict';

const H1_LOOKBACK_BARS = Number.POSITIVE_INFINITY;
const DAILY_SWEEP_SCAN_BARS = 260;
const EQ_LOOKBACK_BARS = 60;

function candleTime(c) {
  const value = String(c.time);
  const t = typeof c.time === 'number' ? c.time : Date.parse(value.replace(' ', 'T') + (value.endsWith('Z') ? '' : 'Z'));
  return Number.isFinite(t) ? t : NaN;
}

function validCandle(c) {
  return c && [c.open, c.high, c.low, c.close].every(Number.isFinite) &&
    c.high >= Math.max(c.open, c.close, c.low) &&
    c.low <= Math.min(c.open, c.close, c.high) &&
    Number.isFinite(candleTime(c));
}

function normalizeCandles(candles) {
  const byTime = new Map();
  for (const c of candles || []) {
    if (!validCandle(c)) continue;
    byTime.set(candleTime(c), {
      time: candleTime(c),
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close),
      volume: Number.isFinite(Number(c.volume)) ? Number(c.volume) : 0
    });
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

function mean(values) {
  return values.length ? values.reduce((sum, n) => sum + n, 0) / values.length : 0;
}
function range(c) { return c.high - c.low; }
function body(c) { return Math.abs(c.close - c.open); }
function isBull(c) { return c.close > c.open; }
function isBear(c) { return c.close < c.open; }

function isoWeekKey(time) {
  const d = new Date(time);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}
function monthKey(time) { return new Date(time).toISOString().slice(0, 7); }

function previousGroupedRange(bars, currentIndex, keyFn) {
  const currentKey = keyFn(bars[currentIndex].time);
  const groups = new Map();
  for (let i = 0; i < currentIndex; i++) {
    const key = keyFn(bars[i].time);
    if (key === currentKey) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(bars[i]);
  }
  const keys = [...groups.keys()].sort();
  if (!keys.length) return null;
  const previous = groups.get(keys[keys.length - 1]);
  return {
    high: Math.max(...previous.map(c => c.high)),
    low: Math.min(...previous.map(c => c.low)),
    key: keys[keys.length - 1]
  };
}

function pivotLevels(priorBars, side) {
  const out = [];
  for (let i = 2; i < priorBars.length - 2; i++) {
    const value = side === 'high' ? priorBars[i].high : priorBars[i].low;
    const left = priorBars.slice(i - 2, i);
    const right = priorBars.slice(i + 1, i + 3);
    const isPivot = side === 'high'
      ? left.every(c => value > c.high) && right.every(c => value >= c.high)
      : left.every(c => value < c.low) && right.every(c => value <= c.low);
    if (isPivot) out.push({ price: value, name: side === 'high' ? 'Major Swing High' : 'Major Swing Low' });
  }
  return out;
}

function equalLevels(priorBars, side) {
  const sample = priorBars.slice(-EQ_LOOKBACK_BARS);
  if (sample.length < 4) return [];
  const atrLike = mean(sample.slice(-14).map(range));
  const tolerance = Math.max(atrLike * 0.05, Math.abs(mean(sample.map(c => side === 'high' ? c.high : c.low))) * 0.00005);
  const prices = sample.map((c, i) => ({ price: side === 'high' ? c.high : c.low, i }));
  const result = [];
  for (let i = 0; i < prices.length; i++) {
    const matches = prices.filter(p => Math.abs(p.price - prices[i].price) <= tolerance && Math.abs(p.i - i) >= 2);
    if (!matches.length) continue;
    const level = mean([prices[i].price, ...matches.map(p => p.price)]);
    if (!result.some(x => Math.abs(x.price - level) <= tolerance)) {
      result.push({ price: level, name: side === 'high' ? 'EQH' : 'EQL' });
    }
  }
  return result;
}

function buildDailyLevels(bars, currentIndex) {
  const prior = bars.slice(0, currentIndex);
  if (!prior.length) return { highs: [], lows: [] };
  const previousDay = prior[prior.length - 1];
  const previousWeek = previousGroupedRange(bars, currentIndex, isoWeekKey);
  const previousMonth = previousGroupedRange(bars, currentIndex, monthKey);
  const highs = [{ price: previousDay.high, name: 'PDH' }];
  const lows = [{ price: previousDay.low, name: 'PDL' }];
  if (previousWeek) {
    highs.push({ price: previousWeek.high, name: 'PWH' });
    lows.push({ price: previousWeek.low, name: 'PWL' });
  }
  if (previousMonth) {
    highs.push({ price: previousMonth.high, name: 'PMH' });
    lows.push({ price: previousMonth.low, name: 'PML' });
  }
  highs.push(...equalLevels(prior, 'high'), ...pivotLevels(prior, 'high'));
  lows.push(...equalLevels(prior, 'low'), ...pivotLevels(prior, 'low'));
  const dedupe = list => {
    const seen = new Set();
    return list.filter(item => {
      const key = item.name + ':' + item.price.toFixed(8);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };
  return { highs: dedupe(highs), lows: dedupe(lows) };
}

function findSweep(candle, levels) {
  const lowSweeps = (levels.lows || []).filter(level => candle.low < level.price && candle.close > level.price)
    .sort((a, b) => b.price - a.price);
  const highSweeps = (levels.highs || []).filter(level => candle.high > level.price && candle.close < level.price)
    .sort((a, b) => a.price - b.price);
  return {
    bullish: lowSweeps.length ? { side: 'bullish', level: lowSweeps[0].price, levelName: lowSweeps[0].name } : null,
    bearish: highSweeps.length ? { side: 'bearish', level: highSweeps[0].price, levelName: highSweeps[0].name } : null
  };
}

function isBullishEngulfing(current, previous) {
  return isBull(current) && isBear(previous) && current.open <= previous.close && current.close >= previous.open;
}
function isBearishEngulfing(current, previous) {
  return isBear(current) && isBull(previous) && current.open >= previous.close && current.close <= previous.open;
}
function isBullishRejection(c) {
  const lowerWick = Math.min(c.open, c.close) - c.low;
  return isBull(c) && body(c) > 0 && lowerWick >= body(c) * 2 && c.close >= c.low + range(c) * 0.6;
}
function isBearishRejection(c) {
  const upperWick = c.high - Math.max(c.open, c.close);
  return isBear(c) && body(c) > 0 && upperWick >= body(c) * 2 && c.close <= c.low + range(c) * 0.4;
}
function isBullishDisplacement(bars, i) {
  const c = bars[i];
  const averageBody = mean(bars.slice(Math.max(0, i - 10), i).map(body));
  return isBull(c) && averageBody > 0 && body(c) >= averageBody * 1.5 && c.close >= c.low + range(c) * 0.75;
}
function isBearishDisplacement(bars, i) {
  const c = bars[i];
  const averageBody = mean(bars.slice(Math.max(0, i - 10), i).map(body));
  return isBear(c) && averageBody > 0 && body(c) >= averageBody * 1.5 && c.close <= c.low + range(c) * 0.25;
}
function isInsideThreeBullish(bars, i) {
  if (i < 2) return false;
  const first = bars[i - 2], inside = bars[i - 1], third = bars[i];
  return isBull(first) && isBear(inside) && inside.high <= first.high && inside.low >= first.low && isBull(third);
}
function isInsideThreeBearish(bars, i) {
  if (i < 2) return false;
  const first = bars[i - 2], inside = bars[i - 1], third = bars[i];
  return isBear(first) && isBull(inside) && inside.high <= first.high && inside.low >= first.low && isBear(third);
}

function dailyConfirmation(bars, i, side) {
  const current = bars[i], previous = bars[i - 1];
  if (!previous) return null;
  if (side === 'bullish') {
    if (current.close > previous.high) return 'D1 close above previous high';
    if (isBullishEngulfing(current, previous)) return 'Bullish engulfing';
    if (isBullishRejection(current)) return 'Bullish rejection';
    if (isBullishDisplacement(bars, i)) return 'Bullish displacement';
    if (isInsideThreeBullish(bars, i)) return 'Bullish 3-candle inside-bar pattern';
  } else {
    if (current.close < previous.low) return 'D1 close below previous low';
    if (isBearishEngulfing(current, previous)) return 'Bearish engulfing';
    if (isBearishRejection(current)) return 'Bearish rejection';
    if (isBearishDisplacement(bars, i)) return 'Bearish displacement';
    if (isInsideThreeBearish(bars, i)) return 'Bearish 3-candle inside-bar pattern';
  }
  return null;
}

function findDailyBias(rawBars) {
  const bars = normalizeCandles(rawBars);
  if (bars.length < 8) return { bias: 'WAITING', reason: 'Not enough completed D1 candles', sweep: null, confirmation: null };
  const start = Math.max(1, bars.length - DAILY_SWEEP_SCAN_BARS);
  const events = [];
  for (let i = start; i < bars.length; i++) {
    const found = findSweep(bars[i], buildDailyLevels(bars, i));
    if (found.bullish) events.push({ ...found.bullish, index: i, time: bars[i].time });
    if (found.bearish) events.push({ ...found.bearish, index: i, time: bars[i].time });
  }
  if (!events.length) return { bias: 'WAITING', reason: 'No qualifying D1 liquidity sweep found', sweep: null, confirmation: null };
  events.sort((a, b) => a.index - b.index);
  const latestIndex = events[events.length - 1].index;
  const latestEvents = events.filter(event => event.index === latestIndex);
  if (latestEvents.length > 1) {
    return { bias: 'WAITING', reason: 'Latest D1 candle swept both sides; directional bias is ambiguous', sweep: null, confirmation: null };
  }
  const latestEvent = latestEvents[0];
  let confirmation = null;
  for (let i = latestEvent.index; i < bars.length; i++) {
    const pattern = dailyConfirmation(bars, i, latestEvent.side);
    if (pattern) {
      confirmation = { pattern, time: bars[i].time + 24 * 60 * 60 * 1000, candleTime: bars[i].time, index: i };
      break;
    }
  }
  if (!confirmation) {
    return { bias: 'WAITING', reason: 'Latest ' + latestEvent.side + ' D1 sweep has no confirmation yet', sweep: latestEvent, confirmation: null };
  }
  return {
    bias: latestEvent.side === 'bullish' ? 'BULLISH' : 'BEARISH',
    reason: latestEvent.levelName + ' sweep + ' + confirmation.pattern,
    sweep: { level: latestEvent.level, levelName: latestEvent.levelName, time: latestEvent.time },
    confirmation: { pattern: confirmation.pattern, time: confirmation.time }
  };
}

function findHourlySweep(rawBars, side, afterTime, lookback = H1_LOOKBACK_BARS) {
  const bars = normalizeCandles(rawBars);
  if (bars.length < 2) return null;
  const foundAt = bars.findIndex(c => c.time >= afterTime);
  if (foundAt < 0) return null;
  const startAt = Math.max(1, foundAt);
  if (startAt >= bars.length) return null;
  for (let i = startAt; i < bars.length; i++) {
    const current = bars[i];
    const prior = bars.slice(Math.max(0, i - lookback), i);
    if (side === 'bullish') {
      const swept = prior.map(c => c.low).filter(level => current.low < level && current.close > level);
      if (swept.length) {
        return { side, level: Math.max(...swept), time: current.time + 60 * 60 * 1000, candleTime: current.time, candle: current, lookbackBars: Math.min(lookback, i) };
      }
    } else {
      const swept = prior.map(c => c.high).filter(level => current.high > level && current.close < level);
      if (swept.length) {
        return { side, level: Math.min(...swept), time: current.time + 60 * 60 * 1000, candleTime: current.time, candle: current, lookbackBars: Math.min(lookback, i) };
      }
    }
  }
  return null;
}

function calculateFib(sweep, side) {
  const high = sweep.high, low = sweep.low, distance = high - low;
  if (!(distance > 0)) throw new Error('Cannot calculate Fibonacci levels from a zero-range candle');
  const priceAt = fraction => side === 'bullish' ? high - distance * fraction : low + distance * fraction;
  return {
    '0': side === 'bullish' ? high : low,
    '0.5': priceAt(0.5),
    '0.618': priceAt(0.618),
    '1': side === 'bullish' ? low : high
  };
}

function candleTouches(candle, price) { return candle.low <= price && candle.high >= price; }

function findM5Entries(rawBars, side, sweepTime, fib, rawClosedBars = rawBars) {
  const bars = normalizeCandles(rawBars).filter(c => c.time >= sweepTime);
  const closedBars = normalizeCandles(rawClosedBars).filter(c => c.time >= sweepTime);
  const entries = [];
  const first = bars.length ? bars[bars.length - 1] : null;
  if (first && candleTouches(first, fib['0.5'])) {
    const stop = fib['0.618'];
    const stopValid = side === 'bullish' ? stop < fib['0.5'] : stop > fib['0.5'];
    entries.push({
      type: 'FIRST_ENTRY', direction: side === 'bullish' ? 'BUY' : 'SELL',
      time: first.time, entry: fib['0.5'], stopLoss: stop, takeProfit: fib['0'],
      stopValid, status: stopValid ? 'SETUP_DETECTED' : 'BLOCKED_INVALID_STOP_SIDE',
      reason: 'M5 range touched Fibonacci 0.5'
    });
  }
  const secondCandidates = closedBars.filter(c => side === 'bullish'
    ? c.low < fib['0.618'] && c.close > fib['0.618']
    : c.high > fib['0.618'] && c.close < fib['0.618']);
  const second = secondCandidates.length ? secondCandidates[secondCandidates.length - 1] : null;
  if (second) {
    const stop = side === 'bullish' ? second.high : second.low;
    const entry = fib['0.618'];
    const stopValid = side === 'bullish' ? stop < entry : stop > entry;
    entries.push({
      type: 'SECOND_ENTRY', direction: side === 'bullish' ? 'BUY' : 'SELL',
      time: second.time, entry, stopLoss: stop, takeProfit: fib['0'],
      stopValid, status: stopValid ? 'SETUP_DETECTED' : 'BLOCKED_INVALID_STOP_SIDE',
      reason: 'M5 swept Fibonacci 0.618 and closed back across it'
    });
  }
  return entries.sort((a, b) => a.time - b.time);
}

function analyzeStrategy(input) {
  const d1 = normalizeCandles(input.d1), h1 = normalizeCandles(input.h1), m5 = normalizeCandles(input.m5);
  const daily = findDailyBias(d1);
  if (daily.bias === 'WAITING') {
    return { bias: daily.bias, biasReason: daily.reason, h1Status: 'WAITING_FOR_D1', entryStatus: 'DISABLED', fib: null, entries: [], riskWarning: null, data: { d1: d1.length, h1: h1.length, m5: m5.length } };
  }
  const side = daily.bias === 'BULLISH' ? 'bullish' : 'bearish';
  const h1Sweep = findHourlySweep(h1, side, daily.confirmation.time);
  if (!h1Sweep) {
    return { bias: daily.bias, biasReason: daily.reason, h1Status: 'WAITING_FOR_H1_SWEEP', entryStatus: 'WAITING', fib: null, entries: [], riskWarning: null, daily, data: { d1: d1.length, h1: h1.length, m5: m5.length } };
  }
  const fib = calculateFib(h1Sweep.candle, side);
  const entries = findM5Entries(m5, side, h1Sweep.time, fib, input.m5Closed || input.m5);
  const blocked = entries.some(entry => !entry.stopValid);
  return {
    bias: daily.bias, biasReason: daily.reason, h1Status: 'CONFIRMED',
    entryStatus: entries.length ? (blocked ? 'SETUP_BLOCKED_BY_STOP_RULE' : 'ENTRY_DETECTED') : 'WAITING_FOR_M5',
    daily,
    h1Sweep: { level: h1Sweep.level, time: h1Sweep.time, candle: h1Sweep.candle, lookbackBars: h1Sweep.lookbackBars },
    fib, entries,
    riskWarning: blocked ? 'The configured stop-loss is on the wrong side of the entry for at least one detected setup. The requested stop rule is preserved, but the setup is blocked and must not be treated as a trade.' : null,
    data: { d1: d1.length, h1: h1.length, m5: m5.length }
  };
}

module.exports = {
  normalizeCandles, buildDailyLevels, findSweep, dailyConfirmation, findDailyBias,
  findHourlySweep, calculateFib, candleTouches, findM5Entries, analyzeStrategy,
  isInsideThreeBullish, isInsideThreeBearish
};
