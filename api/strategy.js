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

function validateActiveHourlySweep(rawBars, side, afterTime, activeH1, now = Date.now()) {
  if (!activeH1 || typeof activeH1 !== 'object') return null;
  const expectedBias = side === 'bullish' ? 'BULLISH' : 'BEARISH';
  if (String(activeH1.bias || '').toUpperCase() !== expectedBias) return null;
  if (Number(activeH1.biasSelectedAt) !== Number(afterTime)) return null;

  const candleTime = Number(activeH1.candleTime);
  const closeTime = candleTime + H1_CANDLE_MS;
  if (!Number.isFinite(candleTime) || candleTime <= 0 ||
      Number(activeH1.closeTime) !== closeTime || closeTime <= Number(afterTime)) return null;

  const bars = normalizeCandles(rawBars)
    .filter(candle => candle.time + H1_CANDLE_MS <= Number(now));
  const index = bars.findIndex(candle => candle.time === candleTime);
  if (index < 1) return null;

  const current = bars[index];
  const previous = bars[index - 1];
  if (Number(activeH1.referenceCandleTime) !== previous.time) return null;

  if (side === 'bullish') {
    const level = previous.low;
    if (!(current.low < level && current.close > level)) return null;
    return {
      side, level, time: closeTime, candleTime: current.time,
      candle: current, referenceCandleTime: previous.time,
      referenceCandle: previous, lookbackBars: 1, persisted: true
    };
  }

  const level = previous.high;
  if (!(current.high > level && current.close < level)) return null;
  return {
    side, level, time: closeTime, candleTime: current.time,
    candle: current, referenceCandleTime: previous.time,
    referenceCandle: previous, lookbackBars: 1, persisted: true
  };
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

function findM5Entries(rawBars, side, sweepTime, fib, evaluationTime = null) {
  const bars = normalizeCandles(rawBars).filter(c => c.time >= sweepTime);
  const entries = [];
  let first = null;

  // Existing first-entry rule: a recent M5 range touch of Fib 0.5.
  // Do not re-signal a touch after a later candle has already hit SL or TP.
  const firstSearchStart = Math.max(0, bars.length - FIRST_ENTRY_RECENT_BARS);
  for (let index = bars.length - 1; index >= firstSearchStart; index -= 1) {
    const candidate = bars[index];
    if (!candleTouches(candidate, fib['0.5'])) continue;
    if (evaluationTime !== null && evaluationTime !== undefined && Number.isFinite(Number(evaluationTime))) {
      const ageSinceClose = Number(evaluationTime) - (candidate.time + M5_CANDLE_MS);
      if (ageSinceClose > FIRST_ENTRY_MAX_AGE_MS || ageSinceClose < -M5_CANDLE_MS) continue;
    }
    const laterBars = bars.slice(index + 1);
    const alreadyResolved = laterBars.some(candle => {
      const stopHit = side === 'bullish' ? candle.low <= fib['0.618'] : candle.high >= fib['0.618'];
      const targetHit = side === 'bullish' ? candle.high >= fib['0'] : candle.low <= fib['0'];
      return stopHit || targetHit;
    });
    if (!alreadyResolved) { first = candidate; break; }
  }
  if (first) {
    const entry = fib['0.5'], stop = fib['0.618'], takeProfit = fib['0'];
    const stopSideValid = side === 'bullish' ? stop < entry : stop > entry;
    const takeProfitValid = side === 'bullish' ? takeProfit > entry : takeProfit < entry;
    const setupValid = stopSideValid && takeProfitValid;
    const status = !stopSideValid ? 'BLOCKED_INVALID_STOP_SIDE'
      : !takeProfitValid ? 'BLOCKED_INVALID_TARGET_SIDE' : 'SETUP_DETECTED';
    entries.push({
      type: 'FIRST_ENTRY', direction: side === 'bullish' ? 'BUY' : 'SELL',
      time: first.time, entry, stopLoss: stop, takeProfit,
      stopSideValid, stopValid: stopSideValid, takeProfitValid, setupValid, status,
      reason: !stopSideValid ? 'Fib 0.618 stop is on the wrong side of the 0.5 entry'
        : !takeProfitValid ? 'Fib 0 target is not beyond the entry in the trade direction'
          : 'M5 range touched Fibonacci 0.5'
    });
  }
  return entries;
}

function findHistoricalM5Entries(rawBars, side, sweepTime, fib) {
  const bars = normalizeCandles(rawBars).filter(candle => candle.time >= sweepTime);
  const found = [];
  for (const candle of bars) {
    // Reuse the live entry detector for each completed historical candle.
    // Each bar is treated as the latest bar at that point in the replay.
    found.push(...findM5Entries([candle], side, sweepTime, fib));
  }
  const unique = new Map();
  for (const entry of found) {
    const key = [entry.type, entry.direction, entry.time, entry.entry, entry.stopLoss, entry.takeProfit].join('|');
    if (!unique.has(key)) unique.set(key, entry);
  }
  return [...unique.values()].sort((a, b) => a.time - b.time || a.type.localeCompare(b.type));
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
  const evaluationTime = Number.isFinite(suppliedNow) && suppliedNow > 0 ? suppliedNow : Date.now();
  const completedH1 = h1.filter(candle => candle.time + H1_CANDLE_MS <= evaluationTime);
  const requestedManualBias = String(input.manualBias || '').toUpperCase();
  const manualBias = requestedManualBias === 'BULLISH' || requestedManualBias === 'BEARISH' ? requestedManualBias : null;
  const manualBiasSince = Number(input.manualBiasSince);
  const useManualBias = Boolean(manualBias && Number.isFinite(manualBiasSince) && manualBiasSince > 0);
  const requestedManualH1Bias = String(input.manualH1Bias || '').toUpperCase();
  const manualH1Bias = requestedManualH1Bias === 'BULLISH' || requestedManualH1Bias === 'BEARISH' ? requestedManualH1Bias : null;
  const manualH1BiasSince = Number(input.manualH1BiasSince);
  const useManualH1Bias = Boolean(manualH1Bias && Number.isFinite(manualH1BiasSince) && manualH1BiasSince > 0);

  // The user supplies the daily direction; D1 strategy analysis is disabled.
  if (!useManualBias) {
    return {
      bias: 'WAITING', biasMode: 'UNSET',
      biasReason: 'Select your manually determined daily bias (Bullish or Bearish) to start H1 analysis.',
      h1Status: 'WAITING_FOR_DAILY_BIAS',
      h1Mode: useManualH1Bias ? 'MANUAL' : 'AUTO',
      entryStatus: 'DISABLED', fib: null, entries: [], riskWarning: null,
      data: { h1: h1.length, m5: m5.length }
    };
  }

  const bias = manualBias, side = bias === 'BULLISH' ? 'bullish' : 'bearish';
  const biasSelectedAt = manualBiasSince;
  const biasReason = 'Daily bias manually selected; D1 analysis is not performed.';
  const biasMetadata = { biasMode: 'MANUAL', manualBiasSince: biasSelectedAt, biasSelectedAt };

  let h1Sweep;
  let h1Metadata = { h1Mode: 'AUTO' };
  if (useManualH1Bias) {
    if (manualH1Bias !== bias) {
      return {
        bias, biasReason, ...biasMetadata, h1Mode: 'MANUAL', manualH1Bias, manualH1BiasSince,
        h1Status: 'MANUAL_H1_DIRECTION_MISMATCH',
        h1Reason: 'Manual H1 direction must match the daily bias you selected. Change one of the manual directions or return H1 to AUTO.',
        entryStatus: 'DISABLED', fib: null, entries: [], riskWarning: null,
        data: { h1: h1.length, m5: m5.length }
      };
    }
    const anchor = completedH1[completedH1.length - 1] || null;
    if (!anchor) {
      return {
        bias, biasReason, ...biasMetadata, h1Mode: 'MANUAL', manualH1Bias, manualH1BiasSince,
        h1Status: 'WAITING_FOR_MANUAL_H1_CANDLE',
        h1Reason: 'No completed H1 candle is available at the time of manual confirmation, so Fibonacci cannot be anchored safely.',
        entryStatus: 'DISABLED', fib: null, entries: [], riskWarning: null,
        data: { h1: h1.length, m5: m5.length }
      };
    }
    const anchorCloseTime = anchor.time + H1_CANDLE_MS;
    const manualH1MonitoringSince = Math.max(manualH1BiasSince, anchorCloseTime);
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
    const newestH1Sweep = findHourlySweep(h1, side, biasSelectedAt, evaluationTime);
    const retainedH1Sweep = newestH1Sweep ? null
      : validateActiveHourlySweep(h1, side, biasSelectedAt, input.activeH1, evaluationTime);
    h1Sweep = newestH1Sweep || retainedH1Sweep;
    h1Metadata = { h1Mode: 'AUTO', h1ConfirmationSource: retainedH1Sweep ? 'PERSISTED' : 'LATEST_COMPLETED_CANDLE' };
    if (!h1Sweep) {
      const latestCandidate = completedH1[completedH1.length - 1] || null;
      const previousReference = completedH1.length > 1 ? completedH1[completedH1.length - 2] : null;
      const candidateIsEligible = Boolean(latestCandidate && latestCandidate.time + H1_CANDLE_MS > biasSelectedAt);
      return {
        bias, biasReason, ...biasMetadata, ...h1Metadata,
        h1Status: 'WAITING_FOR_H1_SWEEP',
        h1SearchAfter: biasSelectedAt,
        h1BarsChecked: candidateIsEligible ? 1 : 0,
        h1CandidateTime: candidateIsEligible ? latestCandidate.time : null,
        h1CandidateCloseTime: candidateIsEligible ? latestCandidate.time + H1_CANDLE_MS : null,
        h1ReferenceTime: candidateIsEligible && previousReference ? previousReference.time : null,
        h1ReferenceCloseTime: candidateIsEligible && previousReference ? previousReference.time + H1_CANDLE_MS : null,
        entryStatus: 'WAITING', fib: null, entries: [], riskWarning: null,
        data: { h1: h1.length, m5: m5.length }
      };
    }
  }

  const fib = calculateFib(h1Sweep.candle, side);
  const entries = findM5Entries(m5, side, h1Sweep.time, fib, evaluationTime);
  const blockedEntries = entries.filter(entry => !entry.setupValid);
  const riskIssues = [];
  if (blockedEntries.some(entry => !entry.stopSideValid)) riskIssues.push('a stop-loss is on the wrong side of its entry');
  if (blockedEntries.some(entry => !entry.takeProfitValid)) riskIssues.push('the Fib 0 target is not beyond the entry in the trade direction');
  return {
    bias, biasReason, ...biasMetadata, ...h1Metadata,
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
  normalizeCandles, findHourlySweep, validateActiveHourlySweep, calculateFib, candleTouches,
  findM5Entries, findHistoricalM5Entries, analyzeStrategy,
  assessMarketDataFreshness, gateStrategyOnFreshness
};
