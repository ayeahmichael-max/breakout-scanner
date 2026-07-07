# CLAUDE.md

Breakout stock screener — full-stack web app. Express backend scans UK (FTSE All-Share proxy: FTSE 100 + 250) and USA (S&P 500 + Nasdaq-100) universes via Yahoo Finance; React frontend renders ranked tables + candlestick charts.

## Run

```powershell
# Backend (port 3001)
npm install            # express, cors, yahoo-finance2
node server.js

# Frontend (port 5173, proxies /api -> 3001)
cd frontend
npm install
npm run dev
```

## Architecture

```
server.js        # Express app: all endpoints, screening logic, concurrency pool, 3-min response cache
tickers.js       # Ticker universes: UK (.L suffix) and USA arrays
frontend/
  src/App.jsx    # Tabs (UK/USA breakout, Pre-Market, Potent, Leaders), scan button, 5-min auto-refresh
  src/Chart.jsx  # lightweight-charts v5 candlestick panel + consolidation band overlay
```

## API endpoints (all POST, JSON)

| Endpoint | Body | Returns |
|----------|------|---------|
| `/api/scan` | `{ market: 'uk' \| 'usa' }` | Top 50 tickers passing all 8 breakout checks, sorted by relative volume desc |
| `/api/chart` | `{ ticker }` | 4h candle array + `consolidationHigh/Low` + breakout candle time |
| `/api/premarket` | `{}` (US-only) | Gappers: preMarket gap ≥ 4%, ADR > 5%, ranked shortlist |
| `/api/potent` | `{ market }` | Previous day's top % gainers with ADR > 5%, ranked shortlist |
| `/api/leaders` | `{ market }` | 1-month performance ranking + breadth count (market-health signal) |

## Screening logic — core 8 checks (on the most recent COMPLETED 4h candle)

4h candles are built by aggregating 4 consecutive 1h Yahoo candles (open=first, high=max, low=min, close=last, volume=sum; only complete groups of 4, oldest remainder dropped).

1. Consolidation: prior 10 completed 4h candles; `high = max(max(o,c))`, `low = min(min(o,c))`; range% ≤ 12
2. Breakout: close ≥ consolidationHigh × 1.02
3. Breakout size: |close − open| / open ≥ 5%
4. Relative volume: volume ≥ 1.5 × avg of prior 10 4h volumes
5. Liquidity: avg last 20 daily volumes ≥ 500k
6. Market cap ≥ $50M (`quoteSummary` summaryDetail)
7. Close within 10% of 20-day OR 50-day high (daily closes)
8. Close > 20-day SMA and > 50-day SMA of daily closes ("EMA" per spec, implemented as simple averages per spec text)

Cost ordering: 1h data is fetched first and checks 1–4 run before any daily/quoteSummary calls — only survivors trigger the extra requests.

## Extra scanners (shared base: ADR20 > 5%)

ADR = mean of (high−low)/low over 20 daily candles × 100. All three scanners then shortlist tickers **holding/reclaiming the 10/20/50 EMA inside a consolidation base** (close ≥ EMA50, close ≥ 0.97×EMA20, 10-day close range ≤ 15%) and apply the final filters: **P/E < 20, volume > 2× 20-day avg, RSI(14) > 50**. Output ranked: ticker, price, P/E, volume ratio, RSI + scanner metric.

- **Pre-Market** (US-only): Yahoo `quote()` preMarketPrice gap ≥ 4% vs prev close
- **Potent**: previous day's % change ranking (top 30 by 1-day gain)
- **Leader**: 1-month % performance ranking; response includes `breadth` = count of stocks up >20%/month — shrinking list ⇒ market weakness

## Conventions & gotchas

- **yahoo-finance2 is pinned to exactly 2.13.3** — 2.14.0 rewrote the API (default export became a class with only `quote`/`autoc` registered; `chart`, `quoteSummary`, `suppressNotices` gone). Do not upgrade without rewriting the data layer.
- **Yahoo 429s any request without a browser User-Agent.** Every call passes `FETCH_OPTS` (moduleOptions third arg with a Chrome UA header) plus `withRetry()` backoff. If everything suddenly returns "Too Many Requests", check the UA is still being sent before blaming rate limits.
- **`chart()` takes `period1` (a Date), not `range`** — passing `range` throws "Validation called with invalid options".
- Backend `package.json` has `"type": "module"`; use `import`.
- UK tickers use the `.L` suffix and are priced in **GBp (pence)** — screening uses ratios so it doesn't matter, but display shows raw values.
- Per-ticker failures (delisted, renamed symbols) are caught and skipped, never fatal — the universe lists in `tickers.js` are curated snapshots and will drift.
- Concurrency pool of 8 parallel Yahoo requests; do not raise aggressively — Yahoo rate-limits/blocks hot IPs.
- Responses cached in-memory for 3 min (keyed endpoint+market) so the 5-min UI auto-refresh doesn't hammer Yahoo.
- `/api/scan` accepts optional `{ tickers: [...] }` override for fast testing with a small universe.
- lightweight-charts is **v5**: `chart.addSeries(CandlestickSeries, opts)`, not v4's `addCandlestickSeries()`. Breakout candle is highlighted via per-bar `color` fields; the consolidation band is an absolutely-positioned div synced with `series.priceToCoordinate()`.

## Frontend styling (dark)

bg-slate-900 page / bg-slate-800 panels / border-slate-700 / text-slate-200; active tab bg-emerald-500; scan button emerald→teal gradient rounded-full; chart container rounded-2xl shadow-xl. Tailwind v4 via `@tailwindcss/vite` plugin (`@import "tailwindcss"` in index.css — no tailwind.config needed).
