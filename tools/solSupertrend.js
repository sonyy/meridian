import { ATR } from 'technicalindicators';

const BINANCE_URL = 'https://api.binance.com/api/v3/klines';
const SYMBOL = 'SOLUSDT';

async function checkInterval(interval) {
  const res = await fetch(`${BINANCE_URL}?symbol=${SYMBOL}&interval=${interval}&limit=100`);
  if (!res.ok) throw new Error(`Binance API ${res.status}`);
  const data = await res.json();

  const highs = data.map(d => parseFloat(d[2]));
  const lows = data.map(d => parseFloat(d[3]));
  const closes = data.map(d => parseFloat(d[4]));

  const atrValues = ATR.calculate({ high: highs, low: lows, close: closes, period: 10 });
  const multiplier = 3;
  const hl2 = highs.map((h, i) => (h + lows[i]) / 2);
  const startIdx = closes.length - atrValues.length;

  let finalUpper = 0;
  let finalLower = 0;
  let direction = 1;

  for (let i = startIdx; i < closes.length; i++) {
    const atr = atrValues[i - startIdx];
    const basicUpper = hl2[i] + multiplier * atr;
    const basicLower = hl2[i] - multiplier * atr;

    if (i === startIdx) {
      finalUpper = basicUpper;
      finalLower = basicLower;
      direction = closes[i] > finalLower ? 1 : -1;
    } else {
      const prevFU = finalUpper;
      const prevFL = finalLower;
      finalUpper = (basicUpper < prevFU || closes[i - 1] > prevFU) ? basicUpper : prevFU;
      finalLower = (basicLower > prevFL || closes[i - 1] < prevFL) ? basicLower : prevFL;

      if (direction === 1) {
        direction = closes[i] > finalLower ? 1 : -1;
      } else {
        direction = closes[i] < finalUpper ? -1 : 1;
      }
    }
  }

  return {
    interval,
    bullish: direction === 1,
    price: closes[closes.length - 1],
    supertrend: direction === 1 ? finalLower : finalUpper,
  };
}

export async function checkSolSupertrend(timeframe = 'both') {
  const intervals = timeframe === '5m' ? ['5m'] : timeframe === '15m' ? ['15m'] : ['5m', '15m'];
  const results = await Promise.all(intervals.map(checkInterval));

  const tf5m = results.find(r => r.interval === '5m');
  const tf15m = results.find(r => r.interval === '15m');

  return {
    bullish: timeframe === 'both'
      ? (tf5m?.bullish ?? true) && (tf15m?.bullish ?? true)
      : results[0]?.bullish ?? true,
    price: tf5m?.price ?? results[0]?.price ?? 0,
    price15m: tf15m?.price ?? 0,
    supertrend: tf5m?.supertrend ?? results[0]?.supertrend ?? 0,
    supertrend15m: tf15m?.supertrend ?? 0,
    tf5m: tf5m?.bullish ?? null,
    tf15m: tf15m?.bullish ?? null,
  };
}
