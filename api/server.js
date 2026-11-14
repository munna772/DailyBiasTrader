'use strict';

const http = require('node:http');
const { URL } = require('node:url');
const { analyzeStrategy, normalizeCandles } = require('./strategy');

const PORT = Number(process.env.PORT || 10000);
const API_KEY = process.env.DAILY_BIAS_TRADER || process.env.SIFTING_API_KEY || '';
const PROVIDER = 'SiftingIO';
const SYMBOLS = Object.freeze({
  XAUUSD: 'XAUUSD',
  XAGUSD: 'XAGUSD',
  USOIL: 'WTIUSD'
});
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
    time: Number(bar.t),
    open: Number(bar.o),
    high: Number(bar.h),
    low: Number(bar.l),
    close: Number(bar.c),
    volume: Number(bar.v || 0)
  })));
}

async function fetchSeries(symbol, interval, outputsize) {
  const now = Date.now();
  const intervalMs = interval === '1d' ? 86400000 : interval === '1h' ? 3600000 : 300000;
  const start = new Date(now - outputsize * intervalMs).toISOString();
  const url = new URL('https://api.sifting.io/v1/hist/commodities/' + encodeURIComponent(symbol) + '/bars');
  url.searchParams.set('interval', interval);
  url.searchParams.set('start', start);
  url.searchParams.set('end', new Date(now).toISOString());
  url.searchParams.set('limit', String(outputsize));

  let response;
  try {
    response = await fetch(url, {
      signal: AbortSignal.timeout(20000),
      headers: { Accept: 'application/json', 'X-API-Key': API_KEY }
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

async function loadMarket(symbolKey) {
  if (!API_KEY) {
    const error = new Error('SiftingIO API key is not configured. Set DAILY_BIAS_TRADER in Render.');
    error.statusCode = 503;
    throw error;
  }
  const cached = cache.get(symbolKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

  const providerSymbol = SYMBOLS[symbolKey];
  const [dailyRaw, hourlyRaw, fiveMinuteRaw] = await Promise.all([
    fetchSeries(providerSymbol, '1d', 350),
    fetchSeries(providerSymbol, '1h', 1000),
    fetchSeries(providerSymbol, '5m', 500)
  ]);
  const incomplete = [];
  if (dailyRaw.length < 8) incomplete.push('D1=' + dailyRaw.length + ' (need at least 8)');
  if (hourlyRaw.length < 2) incomplete.push('H1=' + hourlyRaw.length + ' (need at least 2)');
  if (fiveMinuteRaw.length < 10) incomplete.push('M5=' + fiveMinuteRaw.length + ' (need at least 10)');
  if (incomplete.length) {
    const error = new Error('SiftingIO returned incomplete OHLC history: ' + incomplete.join(', ') + '. Check instrument coverage and interval access.');
    error.statusCode = 502;
    throw error;
  }

  const now = Date.now();
  const value = {
    d1: completedOnly(dailyRaw, 24 * 60 * 60 * 1000, now),
    h1: completedOnly(hourlyRaw, 60 * 60 * 1000, now),
    m5: fiveMinuteRaw,
    m5Closed: completedOnly(fiveMinuteRaw, 5 * 60 * 1000, now),
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
      supportedMarkets: Object.keys(SYMBOLS),
      timestamp: new Date().toISOString()
    });
  }
  if (req.method !== 'GET' || url.pathname !== '/api/strategy') {
    return send(res, 404, { error: 'Not found' });
  }
  if (!allowRate(req)) return send(res, 429, { error: 'Too many requests. Please wait before refreshing.' });

  const symbol = String(url.searchParams.get('symbol') || 'XAUUSD').toUpperCase();
  if (!Object.prototype.hasOwnProperty.call(SYMBOLS, symbol)) {
    return send(res, 400, { error: 'Unsupported market. Use XAUUSD, XAGUSD, or USOIL.' });
  }
  try {
    const market = await loadMarket(symbol);
    const result = analyzeStrategy(market);
    return send(res, 200, {
      ok: true,
      symbol,
      providerSymbol: market.providerSymbol,
      source: market.source,
      fetchedAt: new Date(market.fetchedAt).toISOString(),
      candles: market.data || { d1: market.d1.length, h1: market.h1.length, m5: market.m5.length },
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

server.listen(PORT, '0.0.0.0', () => {
  console.log('DailyBiasTrader API listening on port ' + PORT);
});
