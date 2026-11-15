'use strict';

const DEFAULT_SYMBOL = 'XAUUSD';
const SUPPORTED_SYMBOLS = Object.freeze({
  XAUUSD: 'XAUUSD'
});

function normalizeSymbol(value) {
  const requested = String(value == null ? '' : value).trim();
  const symbol = (requested || DEFAULT_SYMBOL).toUpperCase();
  return Object.prototype.hasOwnProperty.call(SUPPORTED_SYMBOLS, symbol) ? symbol : null;
}

module.exports = { DEFAULT_SYMBOL, SUPPORTED_SYMBOLS, normalizeSymbol };
