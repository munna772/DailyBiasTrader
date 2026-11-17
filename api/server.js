'use strict';

const http = require('node:http');
const { URL } = require('node:url');
const { analyzeStrategy, normalizeCandles, assessMarketDataFreshness, gateStrategyOnFreshness, findHistoricalM5Entries } = require('./strategy');
const { SUPPORTED_SYMBOLS, normalizeSymbol } = require('./markets');

const PORT = Number(process.env.PORT || 10000);
const API_KEY = process.env.DAILY_BIAS_TRADER || process.env.SIFTING_API_KEY || '';
const PROVIDER = 'SiftingIO';
const CACHE_TTL_MS = 120000;
const cache = new Map();
const rateBuckets = new Map();
const allowedOrigins = new Set([
  'https://dailybiastrader-preview.onrender.com',
  ...(process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean),
  'null'
]);

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(body);
}

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (origin && allowedOrigins.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  } else if (!origin) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '600');
}

function allowRate(req) {
  const forwarded = req.headers['x-forwarded-for'];
  const ip = (typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : '') || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const bucket = rateBuckets.get(ip) || { start: now, count: 0 };
  if (now - bucket.start >= 60000) {
    bucket.start = now;
    bucket.count = 0;
  }
  bucket.count += 1;
  rateBuckets.set(ip, bucket);
  return bucket.count <= 30;
}

function parseSiftingBars(response) {
  if (!response || !Array.isArray(response.data)) {
    const message = response && (response.message || response.error);
    if (/api.?key|auth|permission|plan|subscription|access/i.test(String(message || ''))) {
      throw new Error('SiftingIO rejected the API key or this account does not have access to the commodities feed.');
    }
    throw new Error(String(message || 'SiftingIO returned no candle array.'));
  }
  return normalizeCandles(response.data.map(bar => ({
    // Preserve the source timestamp; normalizeCandles converts epoch-ms,
    // epoch-second, and ISO representations to UTC milliseconds.
    time: bar.t,
    open: Number(bar.o),
    high: Number(bar.h),
    low: Number(bar.l),
    close: Number(bar.c),
    volume: Number(bar.v || 0)
  })));
}

// These multipliers convert the requested bar count into a calendar lookback
// wide enough to span normal market closures, weekends, and holidays.
// order=desc is essential: SiftingIO otherwise defaults to oldest-first, so
// a wide window plus a small page limit can return old candles instead of
// the latest candles required by the live strategy.
const HISTORY_INTERVALS = Object.freeze({
  '1m': { milliseconds: 60 * 1000, calendarMultiplier: 12 },
  '1d': { milliseconds: 24 * 60 * 60 * 1000, calendarMultiplier: 2 },
  '1h': { milliseconds: 60 * 60 * 1000, calendarMultiplier: 4 },
  '5m': { milliseconds: 5 * 60 * 1000, calendarMultiplier: 20 }
});

function buildSeriesUrl(symbol, interval, outputsize, now = Date.now()) {
  const config = HISTORY_INTERVALS[interval];
  if (!config) throw new TypeError('Unsupported SiftingIO interval: ' + interval);
  if (!Number.isInteger(outputsize) || outputsize < 1 || outputsize > 2000) {
    throw new RangeError('SiftingIO bar limit must be an integer from 1 to 2000.');
  }
  const endTime = Number(now);
  if (!Number.isFinite(endTime)) throw new TypeError('Invalid SiftingIO request timestamp.');
  const start = new Date(endTime - outputsize * config.milliseconds * config.calendarMultiplier).toISOString();
  const url = new URL('https://api.sifting.io/v1/hist/commodities/' + encodeURIComponent(symbol) + '/bars');
  url.searchParams.set('interval', interval);
  url.searchParams.set('start', start);
  url.searchParams.set('end', new Date(endTime).toISOString());
  url.searchParams.set('order', 'desc');
  url.searchParams.set('limit', String(outputsize));
  return url;
}

async function fetchSeries(symbol, interval, outputsize) {
  const url = buildSeriesUrl(symbol, interval, outputsize);
  let response;
  try {
    response = await fetch(url, {
      signal: AbortSignal.timeout(20000),
      headers: { Accept: 'application/json', 'Accept-Encoding': 'gzip', 'X-API-Key': API_KEY }
    });
  } catch (error) {
    throw new Error(error && error.name === 'TimeoutError' ? 'SiftingIO market-data request timed out.' : 'Could not connect to SiftingIO.');
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error('SiftingIO rejected the API key or this account does not have access to commodities data.');
    }
    if (response.status === 406) throw new Error('SiftingIO requires gzip-compressed historical bars. Check the server runtime and request headers.');
    if (response.status === 429) throw new Error('SiftingIO request limit reached. Wait before refreshing.');
    const detail = await response.text().catch(() => '');
    throw new Error('SiftingIO returned HTTP ' + response.status + (detail ? ': ' + detail.slice(0, 180) : '.'));
  }
  const json = await response.json();
  return parseSiftingBars(json);
}

function completedOnly(bars, durationMs, now) {
  return bars.filter(bar => bar.time + durationMs <= now);
}

// Rebuild only fully completed 5-minute buckets from five real, consecutive
// one-minute SiftingIO candles. Missing minutes are never guessed or filled.
function buildFiveMinuteBarsFromOneMinute(rawBars, now = Date.now()) {
  const minuteBars = completedOnly(normalizeCandles(rawBars), 60 * 1000, Number(now));
  const groups = new Map();
  for (const bar of minuteBars) {
    const bucketTime = Math.floor(bar.time / (5 * 60 * 1000)) * (5 * 60 * 1000);
    const expectedMinuteTime = bucketTime + Math.floor((bar.time - bucketTime) / 60000) * 60000;
    if (bar.time !== expectedMinuteTime) continue;
    if (!groups.has(bucketTime)) groups.set(bucketTime, new Map());
    groups.get(bucketTime).set(bar.time, bar);
  }

  const result = [];
  for (const [bucketTime, minutes] of groups) {
    if (bucketTime + 5 * 60 * 1000 > Number(now)) continue;
    const ordered = [];
    let complete = true;
    for (let index = 0; index < 5; index += 1) {
      const minute = minutes.get(bucketTime + index * 60 * 1000);
      if (!minute) {
        complete = false;
        break;
      }
      ordered.push(minute);
    }
    if (!complete) continue;
    result.push({
      time: bucketTime,
      open: ordered[0].open,
      high: Math.max(...ordered.map(bar => bar.high)),
      low: Math.min(...ordered.map(bar => bar.low)),
      close: ordered[4].close,
      volume: ordered.reduce((sum, bar) => sum + (Number(bar.volume) || 0), 0)
    });
  }
  return normalizeCandles(result);
}

function latestBarTimestamp(bars) {
  const normalized = normalizeCandles(bars);
  const latest = normalized[normalized.length - 1];
  return latest ? new Date(latest.time).toISOString() : null;
}

function buildLatestBarTimes(dailyBars, hourlyBars, fiveMinuteBars) {
  return {
    D1: latestBarTimestamp(dailyBars),
    H1: latestBarTimestamp(hourlyBars),
    M5: latestBarTimestamp(fiveMinuteBars)
  };
}

// H1 timestamps are candle-open times. Evaluate freshness from the last
// completed H1 close, allowing 90 minutes for ordinary session gaps/provider lag.
function assessH1DataFreshness(rawBars, now = Date.now()) {
  const H1_CANDLE_MS = 60 * 60 * 1000;
  const MAX_H1_AGE_MS = 90 * 60 * 1000;
  const completedBars = normalizeCandles(rawBars)
    .filter(bar => bar.time + H1_CANDLE_MS <= Number(now));
  if (!completedBars.length) {
    return {
      status: 'NO_DATA',
      stale: true,
      ageMinutes: null,
      latestCandleAt: null,
      latestCandleCloseAt: null
    };
  }
  const latest = completedBars[completedBars.length - 1];
  const closeAt = latest.time + H1_CANDLE_MS;
  const ageMs = Math.max(0, Number(now) - closeAt);
  const ageMinutes = Math.floor(ageMs / 60000);
  const stale = ageMs > MAX_H1_AGE_MS;
  return {
    status: stale ? 'STALE' : 'FRESH',
    stale,
    ageMinutes,
    latestCandleAt: new Date(latest.time).toISOString(),
    latestCandleCloseAt: new Date(closeAt).toISOString()
  };
}

function mergeFiveMinuteBars(primaryBars, minuteBars, now = Date.now()) {
  const merged = new Map(normalizeCandles(primaryBars).map(bar => [bar.time, bar]));
  const fallbackBars = buildFiveMinuteBarsFromOneMinute(minuteBars, now);
  let added = 0;
  for (const bar of fallbackBars) {
    if (merged.has(bar.time)) continue;
    merged.set(bar.time, bar);
    added += 1;
  }
  return { bars: normalizeCandles([...merged.values()]).slice(-500), added, fallbackBars };
}

async function loadMarket(symbolKey) {
  if (!API_KEY) {
    const error = new Error('SiftingIO API key is not configured. Set DAILY_BIAS_TRADER in Render.');
    error.statusCode = 503;
    throw error;
  }
  const cached = cache.get(symbolKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

  const providerSymbol = SUPPORTED_SYMBOLS[symbolKey];
  const [dailyRaw, hourlyRaw, fiveMinuteRaw] = await Promise.all([
    fetchSeries(providerSymbol, '1d', 350),
    fetchSeries(providerSymbol, '1h', 1000),
    fetchSeries(providerSymbol, '5m', 500)
  ]);

  let m5Fallback = {
    attempted: false,
    addedBars: 0,
    latestM1At: null,
    error: null
  };
  let usableFiveMinuteRaw = fiveMinuteRaw;
  if (!fiveMinuteRaw.length || assessMarketDataFreshness(fiveMinuteRaw, Date.now()).stale) {
    m5Fallback.attempted = true;
    try {
      // Some provider snapshots can lag on the aggregated 5m interval while
      // the underlying 1m series is current. Use actual 1m OHLC as a fallback.
      const oneMinuteRaw = await fetchSeries(providerSymbol, '1m', 1000);
      const latestMinute = oneMinuteRaw[oneMinuteRaw.length - 1];
      m5Fallback.latestM1At = latestMinute ? new Date(latestMinute.time).toISOString() : null;
      const merged = mergeFiveMinuteBars(fiveMinuteRaw, oneMinuteRaw, Date.now());
      usableFiveMinuteRaw = merged.bars;
      m5Fallback.addedBars = merged.added;
    } catch (error) {
      m5Fallback.error = error && error.message ? error.message : 'One-minute fallback request failed.';
    }
  }

  const incomplete = [];
  if (dailyRaw.length < 8) incomplete.push('D1=' + dailyRaw.length + ' (need at least 8)');
  if (hourlyRaw.length < 2) incomplete.push('H1=' + hourlyRaw.length + ' (need at least 2)');
  if (usableFiveMinuteRaw.length < 10) incomplete.push('M5=' + usableFiveMinuteRaw.length + ' (need at least 10)');
  if (incomplete.length) {
    const error = new Error('SiftingIO returned incomplete OHLC history: ' + incomplete.join(', ') + '. Check instrument coverage and interval access.');
    error.statusCode = 502;
    throw error;
  }

  const now = Date.now();
  const value = {
    d1: completedOnly(dailyRaw, 24 * 60 * 60 * 1000, now),
    h1: completedOnly(hourlyRaw, 60 * 60 * 1000, now),
    m5: usableFiveMinuteRaw,
    m5Closed: completedOnly(usableFiveMinuteRaw, 5 * 60 * 1000, now),
    m5Source: m5Fallback.addedBars ? 'SiftingIO 5m + complete SiftingIO 1m aggregates' : 'SiftingIO 5m',
    m5Fallback,
    barTimes: buildLatestBarTimes(dailyRaw, hourlyRaw, usableFiveMinuteRaw),
    source: PROVIDER,
    providerSymbol,
    fetchedAt: now,
    timezone: 'UTC'
  };
  cache.set(symbolKey, { at: now, value });
  return value;
}

function strategyErrorMessage(error) {
  return error && typeof error.message === 'string' ? error.message : 'Unexpected strategy service error.';
}

const server = http.createServer(async (req, res) => {
  applyCors(req, res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/api/health')) {
    return send(res, 200, {
      ok: true,
      service: 'dailybiastrader-api',
      provider: PROVIDER,
      feedConfigured: Boolean(API_KEY),
      supportedMarkets: Object.keys(SUPPORTED_SYMBOLS),
      timestamp: new Date().toISOString()
    });
  }
  if (req.method !== 'GET' || url.pathname !== '/api/strategy') {
    return send(res, 404, { error: 'Not found' });
  }
  if (!allowRate(req)) return send(res, 429, { error: 'Too many requests. Please wait before refreshing.' });

  const symbol = normalizeSymbol(url.searchParams.get('symbol'));
  if (!symbol) {
    return send(res, 400, { error: 'This app supports XAUUSD (Gold) only.' });
  }
  const manualBiasParam = String(url.searchParams.get('manualBias') || '').toUpperCase();
  let manualBias = null;
  let manualBiasSince = null;
  if (manualBiasParam) {
    if (manualBiasParam !== 'BULLISH' && manualBiasParam !== 'BEARISH') {
      return send(res, 400, { error: 'manualBias must be BULLISH or BEARISH.' });
    }
    const requestedSince = Number(url.searchParams.get('manualBiasSince'));
    if (!Number.isFinite(requestedSince) || requestedSince <= 0 || requestedSince > Date.now() + 5 * 60 * 1000) {
      return send(res, 400, { error: 'A valid manualBiasSince timestamp is required. Reapply the manual D1 bias.' });
    }
    manualBias = manualBiasParam;
    manualBiasSince = requestedSince;
  }
  const manualH1BiasParam = String(url.searchParams.get('manualH1Bias') || '').toUpperCase();
  let manualH1Bias = null;
  let manualH1BiasSince = null;
  if (manualH1BiasParam) {
    if (manualH1BiasParam !== 'BULLISH' && manualH1BiasParam !== 'BEARISH') {
      return send(res, 400, { error: 'manualH1Bias must be BULLISH or BEARISH.' });
    }
    const requestedSince = Number(url.searchParams.get('manualH1BiasSince'));
    if (!Number.isFinite(requestedSince) || requestedSince <= 0 || requestedSince > Date.now() + 5 * 60 * 1000) {
      return send(res, 400, { error: 'A valid manualH1BiasSince timestamp is required. Reapply the manual H1 confirmation.' });
    }
    manualH1Bias = manualH1BiasParam;
    manualH1BiasSince = requestedSince;
  }
  try {
    const market = await loadMarket(symbol);
    const strategyNow = Date.now();
    const freshness = assessMarketDataFreshness(market.m5, strategyNow);
    const h1Freshness = assessH1DataFreshness(market.h1, strategyNow);
    const rawStrategy = analyzeStrategy({ ...market, symbol, manualBias, manualBiasSince, manualH1Bias, manualH1BiasSince, now: strategyNow });
    const result = gateStrategyOnFreshness(rawStrategy, freshness, h1Freshness);
    const strategySide = rawStrategy.bias === 'BULLISH' ? 'bullish' : rawStrategy.bias === 'BEARISH' ? 'bearish' : null;
    const historicalEntries = rawStrategy.h1Status === 'CONFIRMED' && strategySide && rawStrategy.fib && rawStrategy.h1Sweep
      ? findHistoricalM5Entries(market.m5Closed, strategySide, rawStrategy.h1Sweep.time, rawStrategy.fib, symbol)
      : [];
    return send(res, 200, {
      ok: true,
      symbol,
      providerSymbol: market.providerSymbol,
      source: market.source,
      fetchedAt: new Date(market.fetchedAt).toISOString(),
      dataFreshness: freshness,
      h1Freshness,
      barTimes: market.barTimes,
      candles: market.data || { d1: market.d1.length, h1: market.h1.length, m5: market.m5.length },
      m5Source: market.m5Source,
      m5Fallback: market.m5Fallback,
      // Closed M5 history lets the client resolve previously recorded strategy setups.
      // The UI only uses candles after each trade's entry candle.
      m5Closed: market.m5Closed,
      historicalEntries,
      strategy: result
    });
  } catch (error) {
    const status = Number.isInteger(error.statusCode) ? error.statusCode : 502;
    return send(res, status, {
      ok: false,
      source: PROVIDER,
      error: strategyErrorMessage(error),
      feedConfigured: Boolean(API_KEY)
    });
  }
});

if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => {
    console.log('DailyBiasTrader API listening on port ' + PORT);
  });
}

module.exports = { buildSeriesUrl, parseSiftingBars, buildFiveMinuteBarsFromOneMinute, mergeFiveMinuteBars, buildLatestBarTimes, assessH1DataFreshness };
