'use strict';

const http = require('node:http');
const { URL } = require('node:url');
const { analyzeStrategy, normalizeCandles } = require('./strategy');

const PORT = Number(process.env.PORT || 10000);
const API_KEY = process.env.TWELVEDATA_API_KEY || '';
const PROVIDER = 'Twelve Data';
const SYMBOLS = Object.freeze({
  XAUUSD: 'XAU/USD',
  XAGUSD: 'XAG/USD',
  USOIL: 'WTI/USD'
});
const CACHE_TTL_MS = 10000;
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

function parseTwelveData(response) {
  if (!response || !Array.isArray(response.values)) {
    const providerMessage = response && typeof response.message === 'string' ? response.message : '';
    if (/apikey|api key|credits|plan|permission|access|symbol/i.test(providerMessage)) {
      throw new Error('Twelve Data rejected the API key or this account does not have access to the requested commodity feed.');
    }
    throw new Error(providerMessage || 'The market-data provider returned no candle array.');
  }
  const candles = response.values.map(value => ({
    time: value.datetime,
    open: Number(value.open),
    high: Number(value.high),
    low: Number(value.low),
    close: Number(value.close),
    volume: Number(value.volume || 0)
  }));
  return normalizeCandles(candles);
}

async function fetchSeries(symbol, interval, outputsize) {
  const url = new URL('https://api.twelvedata.com/time_series');
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('interval', interval);
  url.searchParams.set('outputsize', String(outputsize));
  url.searchParams.set('timezone', 'UTC');
  url.searchParams.set('format', 'JSON');
  url.searchParams.set('apikey', API_KEY);

  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(15000), headers: { Accept: 'application/json' } });
  } catch (error) {
    throw new Error(error && error.name === 'TimeoutError' ? 'The market-data provider timed out.' : 'Could not connect to the market-data provider.');
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error('Twelve Data rejected the API key or the account plan does not include this feed.');
    }
    if (response.status === 429) throw new Error('Twelve Data request limit reached. Wait before refreshing.');
    throw new Error('Twelve Data returned HTTP ' + response.status + '.');
  }
  const json = await response.json();
  if (json && json.status === 'error') {
    const message = typeof json.message === 'string' ? json.message : '';
    if (/apikey|api key|credits|plan|permission|access|symbol/i.test(message)) {
      throw new Error('Twelve Data rejected the API key or this account does not have access to the requested commodity feed.');
    }
    if (/limit|credit|call/i.test(message)) throw new Error('Twelve Data request limit reached. Wait before refreshing.');
    throw new Error(message || 'Twelve Data could not provide this instrument.');
  }
  return parseTwelveData(json);
}

function completedOnly(bars, durationMs, now) {
  return bars.filter(bar => bar.time + durationMs <= now);
}

async function loadMarket(symbolKey) {
  if (!API_KEY) {
    const error = new Error('Market-data API key is not configured on the server.');
    error.statusCode = 503;
    throw error;
  }
  const cached = cache.get(symbolKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

  const providerSymbol = SYMBOLS[symbolKey];
  const [dailyRaw, hourlyRaw, fiveMinuteRaw] = await Promise.all([
    fetchSeries(providerSymbol, '1day', 350),
    fetchSeries(providerSymbol, '1h', 1000),
    fetchSeries(providerSymbol, '5min', 500)
  ]);
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
