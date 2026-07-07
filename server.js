import express from 'express';
import cors from 'cors';
import { pathToFileURL } from 'url';
import yahooFinance from 'yahoo-finance2';
import { UK_TICKERS, USA_TICKERS } from './tickers.js';

yahooFinance.suppressNotices(['yahooSurvey', 'ripHistorical']);
yahooFinance.setGlobalConfig({ validation: { logErrors: false, logOptionsErrors: false } });

// Yahoo 429s requests without a browser User-Agent — pass on every call.
const FETCH_OPTS = {
  fetchOptions: {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    },
  },
};

// Retry transient Yahoo throttling (429) with backoff; other errors bubble up.
async function withRetry(fn, tries = 3) {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= tries - 1 || !/Too Many Requests|429/i.test(String(e?.message))) throw e;
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
}

const app = express();
app.use(cors());
app.use(express.json());

const PORT = 3001;
const CONCURRENCY = 8;
const CACHE_TTL_MS = 3 * 60 * 1000;

// ---------- utilities ----------

const cache = new Map();
function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.time < CACHE_TTL_MS) return Promise.resolve(hit.data);
  return fn().then((data) => {
    cache.set(key, { time: Date.now(), data });
    return data;
  });
}

// Run fn over items with a fixed number of parallel workers; errors → null.
async function pool(items, fn, concurrency = CONCURRENCY) {
  const results = new Array(items.length).fill(null);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = await fn(items[i]);
      } catch {
        results[i] = null;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

const sma = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;

function ema(values, period) {
  const k = 2 / (period + 1);
  let e = sma(values.slice(0, period));
  for (let i = period; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

function rsi14(closes) {
  const period = 14;
  if (closes.length < period + 1) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  let avgGain = gain / period, avgLoss = loss / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function validBars(quotes) {
  return quotes.filter(
    (q) => q && q.open != null && q.high != null && q.low != null && q.close != null && q.volume != null,
  );
}

// Aggregate 1h bars into 4h bars. Complete groups of 4 only; in-progress
// hourly bar (period not yet elapsed) is dropped first.
function aggregate4h(hourly) {
  const now = Date.now();
  const bars = validBars(hourly).filter((q) => new Date(q.date).getTime() + 3600_000 <= now);
  const out = [];
  for (let i = 0; i + 3 < bars.length; i += 4) {
    const g = bars.slice(i, i + 4);
    out.push({
      time: Math.floor(new Date(g[0].date).getTime() / 1000),
      open: g[0].open,
      high: Math.max(...g.map((b) => b.high)),
      low: Math.min(...g.map((b) => b.low)),
      close: g[3].close,
      volume: g.reduce((a, b) => a + b.volume, 0),
    });
  }
  return out;
}

const daysAgo = (d) => new Date(Date.now() - d * 24 * 3600 * 1000);

async function fetch4h(ticker) {
  // '3mo' range equivalent — chart() requires period1 rather than range
  const res = await withRetry(() =>
    yahooFinance.chart(ticker, { interval: '1h', period1: daysAgo(90) }, FETCH_OPTS),
  );
  return aggregate4h(res.quotes || []);
}

async function fetchDaily(ticker) {
  const res = await withRetry(() =>
    yahooFinance.chart(ticker, { interval: '1d', period1: daysAgo(180) }, FETCH_OPTS),
  );
  return { bars: validBars(res.quotes || []), meta: res.meta };
}

// Fraction of today's regular session elapsed (0..1), from chart metadata —
// exchange- and DST-agnostic. null when the metadata is missing.
function sessionElapsedFrac(meta) {
  const reg = meta?.currentTradingPeriod?.regular;
  if (!reg?.start || !reg?.end) return null;
  const toSec = (v) => (v instanceof Date ? v.getTime() / 1000 : v);
  const start = toSec(reg.start);
  const end = toSec(reg.end);
  const now = Date.now() / 1000;
  if (end <= start) return null;
  return Math.min(1, Math.max(0, (now - start) / (end - start)));
}

// ---------- core 8-check breakout screen ----------

// Checks 1–4 on 4h candles. Returns null on failure, stats object on pass.
function check4hBreakout(candles4h) {
  if (candles4h.length < 11) return null;
  const cur = candles4h[candles4h.length - 1];
  const prior = candles4h.slice(-11, -1); // prior 10 completed candles

  // 1. Consolidation range (bodies only) ≤ 12%
  const consolidationHigh = Math.max(...prior.map((c) => Math.max(c.open, c.close)));
  const consolidationLow = Math.min(...prior.map((c) => Math.min(c.open, c.close)));
  const rangePct = ((consolidationHigh - consolidationLow) / consolidationLow) * 100;
  if (rangePct > 12) return null;

  // 2. Close ≥ 2% above the top of the range
  if (cur.close < consolidationHigh * 1.02) return null;

  // 3. Breakout candle body ≥ 5%
  const breakoutSizePct = (Math.abs(cur.close - cur.open) / cur.open) * 100;
  if (breakoutSizePct < 5) return null;

  // 4. Relative volume ≥ 1.5×
  const avgVol = sma(prior.map((c) => c.volume));
  if (avgVol <= 0) return null;
  const relVolume = cur.volume / avgVol;
  if (relVolume < 1.5) return null;

  const breakoutPct = ((cur.close - consolidationHigh) / consolidationHigh) * 100;
  return { cur, consolidationHigh, consolidationLow, rangePct, breakoutPct, breakoutSizePct, relVolume };
}

// Checks 5, 7, 8 on daily bars.
function checkDaily(daily, close) {
  if (daily.length < 50) return null;

  // 5. Liquidity: avg of last 20 daily volumes ≥ 500k
  const avgDailyVol = sma(daily.slice(-20).map((b) => b.volume));
  if (avgDailyVol < 500_000) return null;

  const closes = daily.map((b) => b.close);
  // 7. Within 10% of the 20-day or 50-day high (daily closes)
  const high20 = Math.max(...closes.slice(-20));
  const high50 = Math.max(...closes.slice(-50));
  const pctFrom20 = ((high20 - close) / high20) * 100;
  const pctFrom50 = ((high50 - close) / high50) * 100;
  if (pctFrom20 > 10 && pctFrom50 > 10) return null;

  // 8. Above 20-day and 50-day moving averages (simple averages per spec)
  const ma20 = sma(closes.slice(-20));
  const ma50 = sma(closes.slice(-50));
  if (close <= ma20 || close <= ma50) return null;

  return { avgDailyVol, pctFrom20, pctFrom50, ma20, ma50 };
}

async function screenTicker(ticker) {
  const c4h = check4hBreakout(await fetch4h(ticker));
  if (!c4h) return null;

  const d = checkDaily((await fetchDaily(ticker)).bars, c4h.cur.close);
  if (!d) return null;

  // 6. Market cap ≥ $50M
  const qs = await withRetry(() =>
    yahooFinance.quoteSummary(ticker, { modules: ['summaryDetail'] }, FETCH_OPTS),
  );
  const marketCap = qs?.summaryDetail?.marketCap ?? 0;
  if (marketCap < 50_000_000) return null;

  return {
    ticker,
    price: round2(c4h.cur.close),
    breakoutPct: round2(c4h.breakoutPct),
    breakoutSizePct: round2(c4h.breakoutSizePct),
    relVolume: round2(c4h.relVolume),
    rangePct: round2(c4h.rangePct),
    pctFrom20dHigh: round2(d.pctFrom20),
    pctFrom50dHigh: round2(d.pctFrom50),
    marketCap,
  };
}

const round2 = (n) => (n == null ? null : Math.round(n * 100) / 100);

app.post('/api/scan', async (req, res) => {
  const { market, tickers } = req.body || {};
  if (!tickers && market !== 'uk' && market !== 'usa') {
    return res.status(400).json({ error: "market must be 'uk' or 'usa'" });
  }
  const universe = tickers || (market === 'uk' ? UK_TICKERS : USA_TICKERS);
  const key = tickers ? `scan:custom:${tickers.join(',')}` : `scan:${market}`;
  try {
    const data = await cached(key, async () => {
      const results = (await pool(universe, screenTicker)).filter(Boolean);
      results.sort((a, b) => b.relVolume - a.relVolume);
      return { market, scanned: universe.length, results: results.slice(0, 50), scannedAt: new Date().toISOString() };
    });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/chart', async (req, res) => {
  const { ticker } = req.body || {};
  if (!ticker) return res.status(400).json({ error: 'ticker required' });
  try {
    const candles = await fetch4h(ticker);
    if (candles.length < 11) return res.status(422).json({ error: 'not enough 4h data' });
    const prior = candles.slice(-11, -1);
    const consolidationHigh = Math.max(...prior.map((c) => Math.max(c.open, c.close)));
    const consolidationLow = Math.min(...prior.map((c) => Math.min(c.open, c.close)));
    res.json({
      ticker,
      candles,
      consolidationHigh,
      consolidationLow,
      consolidationStart: prior[0].time,
      breakoutTime: candles[candles.length - 1].time,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- extra scanners (Pre-Market / Potent / Leader) ----------
// Shared base: ADR(20) > 5%, then holding/reclaiming the 10/20/50 EMA inside a
// consolidation base, then final filters P/E < 20, volume > 2× 20d avg, RSI > 50.

function dailyStats(daily, liveSession = null, elapsedFrac = null) {
  if (daily.length < 55) return null;
  const closes = daily.map((b) => b.close);
  const last = daily[daily.length - 1];

  const adr = sma(daily.slice(-20).map((b) => ((b.high - b.low) / b.low) * 100));
  const ema10 = ema(closes.slice(-60), 10);
  const ema20 = ema(closes.slice(-60), 20);
  const ema50 = ema(closes.slice(-60), 50);
  const rsi = rsi14(closes.slice(-60));

  // liveSession comes from quote.marketState; fall back to a
  // same-calendar-day heuristic when the quote is unavailable.
  const today = new Date().toISOString().slice(0, 10);
  const live =
    liveSession != null ? liveSession : new Date(last.date).toISOString().slice(0, 10) === today;
  const lastIdx = daily.length - 1;
  const i = live ? lastIdx - 1 : lastIdx; // most recent COMPLETED session
  if (i < 21) return null;

  // Volume spike: mid-session, pace today's partial volume against the
  // expected volume at this point in the session (avg of the last 20 completed
  // sessions × elapsed fraction). The 10% floor keeps the open from producing
  // noise ratios. When the market is closed (or session metadata is missing),
  // use the completed session's full-day ratio.
  let volRatio, volMode;
  if (live && elapsedFrac != null && elapsedFrac > 0) {
    const base = sma(daily.slice(i - 19, i + 1).map((b) => b.volume));
    volRatio = base > 0 ? last.volume / (base * Math.max(elapsedFrac, 0.1)) : 0;
    volMode = 'paced';
  } else {
    const base = sma(daily.slice(i - 20, i).map((b) => b.volume));
    volRatio = base > 0 ? daily[i].volume / base : 0;
    volMode = 'eod';
  }

  // Prev-day change always compares completed sessions.
  const prevDayPct = ((daily[i].close - daily[i - 1].close) / daily[i - 1].close) * 100;

  // Consolidation base: last 10 closes trade in a ≤15% band
  const base10 = closes.slice(-10);
  const basePct = ((Math.max(...base10) - Math.min(...base10)) / Math.min(...base10)) * 100;

  // 1-month performance (~21 trading days)
  const monthAgo = closes[Math.max(0, closes.length - 22)];
  const monthPct = ((last.close - monthAgo) / monthAgo) * 100;

  return { close: last.close, adr, ema10, ema20, ema50, rsi, volRatio, volMode, basePct, prevDayPct, monthPct };
}

function holdingMAs(s) {
  // Holding or reclaiming the key EMAs within a consolidation base
  return s.close >= s.ema50 && s.close >= s.ema20 * 0.97 && s.basePct <= 15;
}

async function momentumRow(ticker) {
  const [{ bars: daily, meta }, quote] = await Promise.all([
    fetchDaily(ticker),
    withRetry(() => yahooFinance.quote(ticker, {}, FETCH_OPTS)).catch(() => null),
  ]);
  const live = quote ? quote.marketState === 'REGULAR' : null;
  const s = dailyStats(daily, live, live ? sessionElapsedFrac(meta) : null);
  if (!s || s.adr <= 5) return null;

  const pe = quote?.trailingPE ?? null;
  const prevClose = quote?.regularMarketPreviousClose ?? null;
  const preMarketPrice = quote?.preMarketPrice ?? null;
  const gapPct =
    preMarketPrice != null && prevClose ? ((preMarketPrice - prevClose) / prevClose) * 100 : null;

  return { ticker, s, pe, gapPct };
}

// relaxPE: stocks with no earnings (null P/E) pass; a real P/E ≥ 20 still fails.
function finalFilter(rows, relaxPE = false) {
  return rows.filter((r) => {
    const peOk = relaxPE
      ? r.pe == null || (r.pe > 0 && r.pe < 20)
      : r.pe != null && r.pe > 0 && r.pe < 20;
    return peOk && r.s.volRatio > 2 && r.s.rsi != null && r.s.rsi > 50 && holdingMAs(r.s);
  });
}

const rowOut = (r, metricName, metricValue) => ({
  ticker: r.ticker,
  price: round2(r.s.close),
  pe: round2(r.pe),
  volRatio: round2(r.s.volRatio),
  volMode: r.s.volMode,
  rsi: round2(r.s.rsi),
  adr: round2(r.s.adr),
  [metricName]: round2(metricValue),
});

async function scanMomentum(universe) {
  return (await pool(universe, momentumRow)).filter(Boolean);
}

// Pre-Market (US-only): gapping ≥ 4% pre-market on high-ADR names
app.post('/api/premarket', async (req, res) => {
  const relaxPE = !!req.body?.relaxPE;
  try {
    const data = await cached(`premarket:${relaxPE}`, async () => {
      const rows = (await scanMomentum(USA_TICKERS)).filter((r) => r.gapPct != null && r.gapPct >= 4);
      const passed = finalFilter(rows, relaxPE)
        .sort((a, b) => b.gapPct - a.gapPct)
        .map((r) => rowOut(r, 'gapPct', r.gapPct));
      return { results: passed, candidates: rows.length, relaxPE, scannedAt: new Date().toISOString() };
    });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Potent: previous session's strongest performers (sector rotation / theme momentum)
app.post('/api/potent', async (req, res) => {
  const market = req.body?.market === 'uk' ? 'uk' : 'usa';
  const relaxPE = !!req.body?.relaxPE;
  try {
    const data = await cached(`potent:${market}:${relaxPE}`, async () => {
      const rows = await scanMomentum(market === 'uk' ? UK_TICKERS : USA_TICKERS);
      const top = rows.sort((a, b) => b.s.prevDayPct - a.s.prevDayPct).slice(0, 30);
      const passed = finalFilter(top, relaxPE).map((r) => rowOut(r, 'prevDayPct', r.s.prevDayPct));
      return { market, results: passed, candidates: top.length, relaxPE, scannedAt: new Date().toISOString() };
    });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Leader: monthly performance ranking; breadth = market-health signal
app.post('/api/leaders', async (req, res) => {
  const market = req.body?.market === 'uk' ? 'uk' : 'usa';
  const relaxPE = !!req.body?.relaxPE;
  try {
    const data = await cached(`leaders:${market}:${relaxPE}`, async () => {
      const rows = await scanMomentum(market === 'uk' ? UK_TICKERS : USA_TICKERS);
      const ranked = rows.sort((a, b) => b.s.monthPct - a.s.monthPct);
      const breadth = ranked.filter((r) => r.s.monthPct > 20).length;
      const passed = finalFilter(ranked.slice(0, 50), relaxPE).map((r) => rowOut(r, 'monthPct', r.s.monthPct));
      return { market, results: passed, breadth, candidates: rows.length, relaxPE, scannedAt: new Date().toISOString() };
    });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));

// Only listen when run directly (node server.js) — keeps the module importable for tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  app.listen(PORT, () => console.log(`Breakout scanner API on http://localhost:${PORT}`));
}

export { finalFilter, dailyStats, aggregate4h, check4hBreakout, sessionElapsedFrac, momentumRow };
