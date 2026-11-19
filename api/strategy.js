'use strict';

const H1_CANDLE_MS = 60 * 60 * 1000;
const M5_CANDLE_MS = 5 * 60 * 1000;
const FIRST_ENTRY_RECENT_BARS = 2;
const FIRST_ENTRY_MAX_AGE_MS = 15 * 60 * 1000;
function candleTime(c) {
  const raw = c && c.time;
  if (raw === null || raw === undefined || raw === '') return NaN;
  const isNumericValue = typeof raw === 'number' ||
    (typeof raw === 'string' && raw.trim() !== '' && Number.isFinite(Number(raw)));
  const numeric = isNumericValue ? Number(raw) : NaN;
  if (Number.isFinite(numeric)) {
    if (numeric >= 1e9 && numeric < 1e11) return numeric * 1000;
    if (numeric >= 1e14 && numeric < 1e17) return numeric / 1000;
    return numeric;
  }
  const value = String(raw).trim().replace(' ', 'T');
  const hasTimezone = /(?:Z|[+-][0-9]{2}:?[0-9]{2})$/i.test(value);
  const parsed = Date.parse(hasTimezone ? value : value + 'Z');
  return Number.isFinite(parsed) ? parsed : NaN;
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

function findHourlySweep(rawBars, side, afterTime, now = Date.now()) {
  // Provider timestamps are candle OPEN times. Ignore any still-forming H1 bar.
  const bars = normalizeCandles(rawBars)
    .filter(candle => candle.time + H1_CANDLE_MS <= Number(now));
  if (bars.length < 2) return null;

  // Never revive an old sweep from the history. Only the latest completed
  // H1 candle can qualify; compare it with the immediately preceding candle.
  const current = bars[bars.length - 1];
  const previous = bars[bars.length - 2];
  const closeTime = current.time + H1_CANDLE_MS;
  if (closeTime <= Number(afterTime)) return null;

  if (side === 'bullish') {
    const level = previous.low;
    if (current.low < level && current.close > level) {
      return {
        side, level, time: closeTime, candleTime: current.time,
        candle: current, referenceCandleTime: previous.time,
        referenceCandle: previous, lookbackBars: 1
      };
    }
  } else if (side === 'bearish') {
    const level = previous.high;
    if (current.high > level && current.close < level) {
      return {
        side, level, time: closeTime, candleTime: current.time,
        candle: current, referenceCandleTime: previous.time,
        referenceCandle: previous, lookbackBars: 1
      };
    }
  }
  return null;
}

function findIndependentHourlySweep(rawBars, now = Date.now()) {
  const bullish = findHourlySweep(rawBars, 'bullish', 0, now);
  const bearish = findHourlySweep(rawBars, 'bearish', 0, now);
  if (bullish && bearish) return { ambiguous: true, bullish, bearish };
  return bullish || bearish;
}

function validateActiveHourlySweep(rawBars, activeH1, now = Date.now()) {
  if (!activeH1 || typeof activeH1 !== 'object' || activeH1.mode !== 'H1_INDEPENDENT_V1') return null;
  const bias = String(activeH1.bias || '').toUpperCase();
  const side = bias === 'BULLISH' ? 'bullish' : bias === 'BEARISH' ? 'bearish' : null;
  if (!side) return null;
  const candleTime = Number(activeH1.candleTime);
  const closeTime = candleTime + H1_CANDLE_MS;
  if (!Number.isFinite(candleTime) || candleTime <= 0 ||
      Number(activeH1.closeTime) !== closeTime || closeTime > Number(now)) return null;
  const bars = normalizeCandles(rawBars).filter(c => c.time + H1_CANDLE_MS <= Number(now));
  const index = bars.findIndex(c => c.time === candleTime);
  if (index < 1) return null;
  const current = bars[index], previous = bars[index - 1];
  if (Number(activeH1.referenceCandleTime) !== previous.time) return null;
  if (side === 'bullish') {
    const level = previous.low;
    if (!(current.low < level && current.close > level)) return null;
    return { side, level, time: closeTime, candleTime: current.time, candle: current,
      referenceCandleTime: previous.time, referenceCandle: previous, lookbackBars: 1, persisted: true };
  }
  const level = previous.high;
  if (!(current.high > level && current.close < level)) return null;
  return { side, level, time: closeTime, candleTime: current.time, candle: current,
    referenceCandleTime: previous.time, referenceCandle: previous, lookbackBars: 1, persisted: true };
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

function entrySetupId(side, sweepTime, fib) {
  const priceKey = value => Number(value).toFixed(8);
  return [
    'XAUUSD', 'FIRST_ENTRY', side === 'bullish' ? 'BUY' : 'SELL',
    Number(sweepTime), priceKey(fib['0.5']), priceKey(fib['0.618']), priceKey(fib['0'])
  ].join('|');
}

function buildFirstEntry(candidate, side, sweepTime, fib) {
  const entry = fib['0.5'], stop = fib['0.618'], takeProfit = fib['0'];
  const stopSideValid = side === 'bullish' ? stop < entry : stop > entry;
  const takeProfitValid = side === 'bullish' ? takeProfit > entry : takeProfit < entry;
  const setupValid = stopSideValid && takeProfitValid;
  const status = !stopSideValid ? 'BLOCKED_INVALID_STOP_SIDE'
    : !takeProfitValid ? 'BLOCKED_INVALID_TARGET_SIDE' : 'SETUP_DETECTED';
  return {
    type: 'FIRST_ENTRY', direction: side === 'bullish' ? 'BUY' : 'SELL',
    time: candidate.time, entry, stopLoss: stop, takeProfit,
    setupId: entrySetupId(side, sweepTime, fib),
    stopSideValid, stopValid: stopSideValid, takeProfitValid, setupValid, status,
    reason: !stopSideValid ? 'Fib 0.618 stop is on the wrong side of the 0.5 entry'
      : !takeProfitValid ? 'Fib 0 target is not beyond the entry in the trade direction'
        : 'First M5 range touch of Fibonacci 0.5 for this H1 setup'
  };
}

function findM5Entries(rawBars, side, sweepTime, fib, evaluationTime = null) {
  const bars = normalizeCandles(rawBars).filter(c => c.time >= Number(sweepTime));
  if (!bars.length) return [];

  // The first 0.5 touch consumes this H1 Fibonacci setup. Later touches are
  // never new entries, even after the original trade reaches SL or TP.
  const firstTouchIndex = bars.findIndex(candle => candleTouches(candle, fib['0.5']));
  if (firstTouchIndex < 0) return [];

  // Live signals are only actionable while the original first touch is recent.
  const recentStart = Math.max(0, bars.length - FIRST_ENTRY_RECENT_BARS);
  if (firstTouchIndex < recentStart) return [];

  const firstTouch = bars[firstTouchIndex];
  if (evaluationTime !== null && evaluationTime !== undefined && Number.isFinite(Number(evaluationTime))) {
    const ageSinceClose = Number(evaluationTime) - (firstTouch.time + M5_CANDLE_MS);
    if (ageSinceClose > FIRST_ENTRY_MAX_AGE_MS || ageSinceClose < -M5_CANDLE_MS) return [];
  }
  return [buildFirstEntry(firstTouch, side, sweepTime, fib)];
}

function findHistoricalM5Entries(rawBars, side, sweepTime, fib) {
  const bars = normalizeCandles(rawBars).filter(candle => candle.time >= Number(sweepTime));
  const firstTouch = bars.find(candle => candleTouches(candle, fib['0.5']));
  return firstTouch ? [buildFirstEntry(firstTouch, side, sweepTime, fib)] : [];
}

function assessMarketDataFreshness(rawBars, now = Date.now()) {
  const bars = normalizeCandles(rawBars);
  if (!bars.length) {
    return { status: 'NO_DATA', stale: true, ageMinutes: null, latestCandleAt: null };
  }
  const latest = bars[bars.length - 1];
  // Provider timestamps are candle-open times. Measure age from the expected
  // close of the latest 5-minute candle, not from when the API was fetched.
  const ageMs = Math.max(0, now - (latest.time + 5 * 60 * 1000));
  const ageMinutes = Math.floor(ageMs / 60000);
  const stale = ageMs > 15 * 60 * 1000;
  return {
    status: stale ? 'STALE' : 'FRESH',
    stale,
    ageMinutes,
    latestCandleAt: new Date(latest.time).toISOString()
  };
}

function gateStrategyOnFreshness(strategy, m5Freshness, h1Freshness) {
  if (!strategy || strategy.h1Status !== 'CONFIRMED') return strategy;

  // H1 data determines the active confirmation/Fibonacci reference; M5 data
  // determines entry timing. Missing or stale data from either feed blocks entries.
  const h1Stale = !h1Freshness || h1Freshness.stale === true || h1Freshness.status !== 'FRESH';
  const m5Stale = !m5Freshness || m5Freshness.stale === true || m5Freshness.status !== 'FRESH';
  if (!h1Stale && !m5Stale) return strategy;

  return {
    ...strategy,
    entryStatus: h1Stale ? 'WAITING_FOR_FRESH_H1_DATA' : 'WAITING_FOR_FRESH_M5_DATA',
    entries: [],
    riskWarning: null
  };
}

function analyzeStrategy(input) {
  const h1 = normalizeCandles(input.h1), m5 = normalizeCandles(input.m5);
  const suppliedNow = Number(input.now);
  const now = Number.isFinite(suppliedNow) && suppliedNow > 0 ? suppliedNow : Date.now();
  const completedH1 = h1.filter(c => c.time + H1_CANDLE_MS <= now);

  // D1 bias is optional reference information; it never gates H1 direction or timing.
  const requestedDailyBias = String(input.manualBias || '').toUpperCase();
  const dailyBias = requestedDailyBias === 'BULLISH' || requestedDailyBias === 'BEARISH' ? requestedDailyBias : null;
  const dailyBiasSince = Number(input.manualBiasSince);
  const hasManualDailyBias = Boolean(dailyBias && Number.isFinite(dailyBiasSince) && dailyBiasSince > 0);
  const dailyMetadata = {
    bias: hasManualDailyBias ? dailyBias : 'WAITING',
    biasMode: hasManualDailyBias ? 'MANUAL' : 'UNSET',
    manualBiasSince: hasManualDailyBias ? dailyBiasSince : null,
    biasReason: hasManualDailyBias
      ? 'Daily bias is manually selected for reference only; it does not control H1 confirmation.'
      : 'Daily bias is optional. H1 confirmation works independently in either direction.'
  };

  const requestedManualH1Bias = String(input.manualH1Bias || '').toUpperCase();
  const manualH1Bias = requestedManualH1Bias === 'BULLISH' || requestedManualH1Bias === 'BEARISH' ? requestedManualH1Bias : null;
  const manualH1BiasSince = Number(input.manualH1BiasSince);
  const useManualH1Bias = Boolean(manualH1Bias && Number.isFinite(manualH1BiasSince) && manualH1BiasSince > 0);

  let h1Sweep, h1Bias = null;
  let h1Metadata = { h1Mode: 'AUTO' };
  if (useManualH1Bias) {
    // Manual H1 direction is independent of the optional D1 direction.
    const side = manualH1Bias === 'BULLISH' ? 'bullish' : 'bearish';
    const anchor = completedH1[completedH1.length - 1] || null;
    if (!anchor) {
      return { ...dailyMetadata, h1Bias: null, h1Mode: 'MANUAL', manualH1Bias, manualH1BiasSince,
        h1Status: 'WAITING_FOR_MANUAL_H1_CANDLE',
        h1Reason: 'No completed H1 candle is available to anchor Fibonacci.',
        entryStatus: 'DISABLED', fib: null, entries: [], riskWarning: null,
        data: { h1: h1.length, m5: m5.length } };
    }
    const anchorCloseTime = anchor.time + H1_CANDLE_MS;
    const manualH1MonitoringSince = Math.max(manualH1BiasSince, anchorCloseTime);
    h1Bias = manualH1Bias;
    h1Sweep = {
      side, level: side === 'bullish' ? anchor.low : anchor.high, time: manualH1MonitoringSince,
      candleTime: anchor.time, candle: anchor, lookbackBars: 0, manual: true
    };
    h1Metadata = {
      h1Mode: 'MANUAL', manualH1Bias, manualH1BiasSince,
      manualH1AnchorTime: anchor.time, manualH1AnchorCloseTime: anchorCloseTime,
      manualH1MonitoringSince,
      manualH1Reference: 'Latest completed H1 candle immediately before current evaluation'
    };
  } else {
    const newest = findIndependentHourlySweep(h1, now);
    if (newest && newest.ambiguous) {
      const latest = completedH1[completedH1.length - 1] || null;
      const previous = completedH1.length > 1 ? completedH1[completedH1.length - 2] : null;
      return {
        ...dailyMetadata, h1Bias: null, h1Mode: 'AUTO',
        h1ConfirmationSource: 'LATEST_COMPLETED_CANDLE',
        h1Status: 'AMBIGUOUS_H1_SWEEP',
        h1Reason: 'The latest completed H1 candle swept both the previous H1 high and low. Direction is ambiguous, so no H1 direction or M5 entry is selected.',
        h1CandidateTime: latest ? latest.time : null,
        h1ReferenceTime: previous ? previous.time : null,
        entryStatus: 'WAITING', fib: null, entries: [], riskWarning: null,
        data: { h1: h1.length, m5: m5.length }
      };
    }
    const retained = newest ? null : validateActiveHourlySweep(h1, input.activeH1, now);
    h1Sweep = newest || retained;
    if (!h1Sweep) {
      const latest = completedH1[completedH1.length - 1] || null;
      const previous = completedH1.length > 1 ? completedH1[completedH1.length - 2] : null;
      return {
        ...dailyMetadata, h1Bias: null, h1Mode: 'AUTO',
        h1ConfirmationSource: 'LATEST_COMPLETED_CANDLE',
        h1Status: 'WAITING_FOR_H1_SWEEP',
        h1BarsChecked: latest && previous ? 1 : 0,
        h1CandidateTime: latest ? latest.time : null,
        h1CandidateCloseTime: latest ? latest.time + H1_CANDLE_MS : null,
        h1ReferenceTime: previous ? previous.time : null,
        h1ReferenceCloseTime: previous ? previous.time + H1_CANDLE_MS : null,
        entryStatus: 'WAITING', fib: null, entries: [], riskWarning: null,
        data: { h1: h1.length, m5: m5.length }
      };
    }
    h1Bias = h1Sweep.side === 'bullish' ? 'BULLISH' : 'BEARISH';
    h1Metadata = { h1Mode: 'AUTO', h1ConfirmationSource: retained ? 'PERSISTED' : 'LATEST_COMPLETED_CANDLE' };
  }

  const side = h1Bias === 'BULLISH' ? 'bullish' : 'bearish';
  const fib = calculateFib(h1Sweep.candle, side);
  const entries = findM5Entries(m5, side, h1Sweep.time, fib, now);
  const blockedEntries = entries.filter(entry => !entry.setupValid);
  const riskIssues = [];
  if (blockedEntries.some(entry => !entry.stopSideValid)) riskIssues.push('a stop-loss is on the wrong side of its entry');
  if (blockedEntries.some(entry => !entry.takeProfitValid)) riskIssues.push('the Fib 0 target is not beyond the entry in the trade direction');
  return {
    ...dailyMetadata, h1Bias, ...h1Metadata,
    h1Status: 'CONFIRMED',
    entryStatus: entries.length ? (blockedEntries.length ? 'SETUP_BLOCKED_BY_RISK_RULE' : 'ENTRY_DETECTED') : 'WAITING_FOR_M5',
    h1Sweep: {
      level: h1Sweep.level, time: h1Sweep.time, candle: h1Sweep.candle, lookbackBars: h1Sweep.lookbackBars,
      ...(h1Sweep.manual ? { manual: true, referenceCandleTime: h1Sweep.candleTime }
        : { referenceCandleTime: h1Sweep.referenceCandleTime, persisted: Boolean(h1Sweep.persisted) })
    },
    fib, entries,
    riskWarning: blockedEntries.length
      ? 'Risk validation blocked ' + blockedEntries.length + ' detected setup(s): ' + riskIssues.join('; ') + '. Requested levels are preserved; blocked setups must not be treated as executable trades.'
      : null,
    data: { h1: h1.length, m5: m5.length }
  };
}



module.exports = {
  normalizeCandles, findHourlySweep, findIndependentHourlySweep, validateActiveHourlySweep, calculateFib, candleTouches,
  findM5Entries, findHistoricalM5Entries, analyzeStrategy,
  assessMarketDataFreshness, gateStrategyOnFreshness
};
