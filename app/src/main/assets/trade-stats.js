(function(root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.DailyBiasTradeStats = api;
})(typeof window !== 'undefined' ? window : null, function() {
  'use strict';

  // Pip sizes are quoted-price units. Gold's 0.10 matches the app's
  // existing rule that a 0.40 stop distance equals 4 pips.
  const PIP_SIZES = Object.freeze({ XAUUSD: 0.10, XAGUSD: 0.01, USOIL: 0.01 });
  const MAX_RECORDED_TRADES = 500;

  function roundPips(value) {
    return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
  }

  function makeTradeId(symbol, entry) {
    const numberKey = value => Number(value).toFixed(8);
    return [
      String(symbol).toUpperCase(),
      String(entry.type),
      String(entry.direction),
      String(Number(entry.time)),
      numberKey(entry.entry),
      numberKey(entry.stopLoss),
      numberKey(entry.takeProfit)
    ].join('|');
  }

  function addSignalTrades(existingTrades, symbol, entries, recordedAt) {
    const market = String(symbol || '').toUpperCase();
    const pipSize = PIP_SIZES[market];
    if (!pipSize) return Array.isArray(existingTrades) ? existingTrades.slice() : [];

    const trades = Array.isArray(existingTrades) ? existingTrades.slice() : [];
    const knownIds = new Set(trades.map(trade => trade && trade.id));
    const now = Number.isFinite(Number(recordedAt)) ? Number(recordedAt) : Date.now();

    for (const entry of Array.isArray(entries) ? entries : []) {
      if (!entry || entry.setupValid !== true) continue;
      if (!['BUY', 'SELL'].includes(entry.direction)) continue;
      if (!['FIRST_ENTRY', 'SECOND_ENTRY'].includes(entry.type)) continue;
      const entryTime = Number(entry.time);
      const entryPrice = Number(entry.entry);
      const stopLoss = Number(entry.stopLoss);
      const takeProfit = Number(entry.takeProfit);
      if (![entryTime, entryPrice, stopLoss, takeProfit].every(Number.isFinite)) continue;

      const id = makeTradeId(market, entry);
      if (knownIds.has(id)) continue;
      knownIds.add(id);
      trades.push({
        id,
        symbol: market,
        type: entry.type,
        direction: entry.direction,
        entryTime,
        entry: entryPrice,
        stopLoss,
        takeProfit,
        pipSize,
        recordedAt: now,
        status: 'OPEN',
        exitTime: null,
        exitPrice: null,
        pipsWon: 0,
        pipsLost: 0,
        bothLevelsHitSameCandle: false
      });
    }
    return trades.slice(-MAX_RECORDED_TRADES);
  }

  function resolveTrades(existingTrades, symbol, rawClosedCandles) {
    const market = String(symbol || '').toUpperCase();
    const candles = (Array.isArray(rawClosedCandles) ? rawClosedCandles : [])
      .map(candle => ({
        time: Number(candle && candle.time),
        high: Number(candle && candle.high),
        low: Number(candle && candle.low)
      }))
      .filter(candle => Number.isFinite(candle.time) && Number.isFinite(candle.high) &&
        Number.isFinite(candle.low) && candle.high >= candle.low)
      .sort((a, b) => a.time - b.time);

    return (Array.isArray(existingTrades) ? existingTrades : []).map(trade => {
      if (!trade || trade.symbol !== market || trade.status !== 'OPEN') return trade;
      const pipSize = Number(trade.pipSize) > 0 ? Number(trade.pipSize) : PIP_SIZES[market];
      if (!(pipSize > 0)) return trade;

      for (const candle of candles) {
        // Never infer an exit from the entry candle: OHLC does not reveal
        // whether the entry happened before or after the stop/target touch.
        if (candle.time <= Number(trade.entryTime)) continue;
        const stopHit = trade.direction === 'BUY'
          ? candle.low <= Number(trade.stopLoss)
          : candle.high >= Number(trade.stopLoss);
        const targetHit = trade.direction === 'BUY'
          ? candle.high >= Number(trade.takeProfit)
          : candle.low <= Number(trade.takeProfit);
        if (!stopHit && !targetHit) continue;

        // If both prices fall inside one M5 candle, the order is unknown.
        // Count it as an SL to avoid overstating strategy performance.
        const status = stopHit ? 'SL' : 'TP';
        const entryPrice = Number(trade.entry);
        const exitPrice = status === 'TP' ? Number(trade.takeProfit) : Number(trade.stopLoss);
        const distancePips = roundPips(Math.abs(exitPrice - entryPrice) / pipSize);
        return {
          ...trade,
          status,
          exitTime: candle.time,
          exitPrice,
          pipsWon: status === 'TP' ? distancePips : 0,
          pipsLost: status === 'SL' ? distancePips : 0,
          bothLevelsHitSameCandle: stopHit && targetHit
        };
      }
      return trade;
    });
  }

  function summarizeTrades(trades, symbol) {
    const market = String(symbol || '').toUpperCase();
    const selected = (Array.isArray(trades) ? trades : []).filter(trade => trade && trade.symbol === market);
    const tpHits = selected.filter(trade => trade.status === 'TP').length;
    const slHits = selected.filter(trade => trade.status === 'SL').length;
    const openTrades = selected.filter(trade => trade.status === 'OPEN').length;
    const pipsWon = roundPips(selected.reduce((sum, trade) => sum + (Number(trade.pipsWon) || 0), 0));
    const pipsLost = roundPips(selected.reduce((sum, trade) => sum + (Number(trade.pipsLost) || 0), 0));
    return {
      total: selected.length,
      tpHits,
      slHits,
      openTrades,
      pipsWon,
      pipsLost,
      netPips: roundPips(pipsWon - pipsLost),
      pipSize: PIP_SIZES[market] || null
    };
  }

  return { PIP_SIZES, addSignalTrades, resolveTrades, summarizeTrades };
});
