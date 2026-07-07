import { useCallback, useEffect, useMemo, useState } from 'react';
import Chart from './Chart.jsx';

const TABS = [
  { key: 'uk', label: 'UK 🇬🇧', kind: 'breakout' },
  { key: 'usa', label: 'USA 🇺🇸', kind: 'breakout' },
  { key: 'premarket', label: 'Pre-Market 🌅', kind: 'momentum', metric: 'gapPct', metricLabel: 'Gap %' },
  { key: 'potent', label: 'Potent 🔥', kind: 'momentum', metric: 'prevDayPct', metricLabel: 'Prev Day %' },
  { key: 'leaders', label: 'Leaders 🏆', kind: 'momentum', metric: 'monthPct', metricLabel: '1-Mo %' },
];

function endpointFor(tabKey, market, relaxPE) {
  switch (tabKey) {
    case 'uk':
      return ['/api/scan', { market: 'uk' }];
    case 'usa':
      return ['/api/scan', { market: 'usa' }];
    case 'premarket':
      return ['/api/premarket', { relaxPE }];
    case 'potent':
      return ['/api/potent', { market, relaxPE }];
    case 'leaders':
      return ['/api/leaders', { market, relaxPE }];
    default:
      return null;
  }
}

function Spinner() {
  return (
    <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-90" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
    </svg>
  );
}

const fmt = (n, suffix = '') => (n == null ? '—' : `${n.toFixed(2)}${suffix}`);

export default function App() {
  const [tab, setTab] = useState('usa');
  const [subMarket, setSubMarket] = useState('usa'); // for Potent / Leaders
  const [data, setData] = useState({}); // per data-key results
  const [loading, setLoading] = useState(false);
  const [scanError, setScanError] = useState(null);
  const [selected, setSelected] = useState({}); // per data-key chart ticker
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [relaxPE, setRelaxPE] = useState(false); // momentum tabs: also allow stocks with no P/E

  const tabDef = TABS.find((t) => t.key === tab);
  const needsSubMarket = tab === 'potent' || tab === 'leaders';
  const isMomentum = tabDef.kind === 'momentum';
  let dataKey = needsSubMarket ? `${tab}:${subMarket}` : tab;
  if (isMomentum) dataKey += relaxPE ? ':anype' : ':strict';
  const current = data[dataKey];
  const results = current?.results ?? null;

  const scan = useCallback(async () => {
    const [url, body] = endpointFor(tab, subMarket, relaxPE);
    setLoading(true);
    setScanError(null);
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await r.json();
      if (!r.ok) throw new Error(json.error || `HTTP ${r.status}`);
      setData((d) => ({ ...d, [dataKey]: json }));
      setSelected((s) =>
        s[dataKey] || !json.results?.length ? s : { ...s, [dataKey]: json.results[0].ticker },
      );
    } catch (e) {
      setScanError(e.message);
    } finally {
      setLoading(false);
    }
  }, [tab, subMarket, relaxPE, dataKey]);

  // ?demo=1 pre-fills the USA tab with sample rows (screenshots/UI previews)
  useEffect(() => {
    if (!new URLSearchParams(window.location.search).has('demo')) return;
    import('./demoData.js').then(({ DEMO_SCAN }) => {
      setData((d) => ({ ...d, usa: DEMO_SCAN }));
      setSelected((s) => ({ ...s, usa: DEMO_SCAN.results[0].ticker }));
    });
  }, []);

  // 5-minute auto-refresh of the active tab (backend caches for 3 min, so this is Yahoo-safe)
  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(scan, 5 * 60 * 1000);
    return () => clearInterval(id);
  }, [autoRefresh, scan]);

  const lastScanned = current?.scannedAt
    ? new Date(current.scannedAt).toLocaleTimeString()
    : '—';

  const chartTicker = selected[dataKey] ?? results?.[0]?.ticker ?? null;

  const columns = useMemo(() => {
    if (tabDef.kind === 'breakout') {
      return [
        ['Ticker', (r) => r.ticker],
        ['Price', (r) => fmt(r.price)],
        ['Breakout %', (r) => fmt(r.breakoutPct, '%')],
        ['Breakout Size %', (r) => fmt(r.breakoutSizePct, '%')],
        ['Relative Volume', (r) => fmt(r.relVolume, '×')],
        ['% from 20d/50d High', (r) => `${fmt(r.pctFrom20dHigh, '%')} / ${fmt(r.pctFrom50dHigh, '%')}`],
      ];
    }
    return [
      ['Ticker', (r) => r.ticker],
      ['Price', (r) => fmt(r.price)],
      ['P/E', (r) => fmt(r.pe)],
      ['Volume Ratio', (r) => `${fmt(r.volRatio, '×')}${r.volMode === 'paced' ? ' ⚡' : ''}`],
      ['RSI', (r) => fmt(r.rsi)],
      ['ADR %', (r) => fmt(r.adr, '%')],
      [tabDef.metricLabel, (r) => fmt(r[tabDef.metric], '%')],
    ];
  }, [tabDef]);

  return (
    <div className="min-h-screen bg-slate-900 text-slate-200">
      <div className="mx-auto max-w-6xl px-4 py-6">
        {/* Header */}
        <header className="mb-6 flex flex-wrap items-center gap-4">
          <h1 className="text-2xl font-bold tracking-tight text-white">Breakout Scanner</h1>
          <button
            onClick={scan}
            disabled={loading}
            className="flex items-center gap-2 rounded-full bg-gradient-to-r from-emerald-500 to-teal-500 px-5 py-2 font-semibold text-white hover:opacity-90 disabled:opacity-60"
          >
            {loading && <Spinner />}
            {loading ? 'Scanning…' : 'Scan Now'}
          </button>
          <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-400">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
              className="accent-emerald-500"
            />
            Auto-refresh (5 min)
          </label>
          <span className="ml-auto text-sm text-slate-400">
            Last Scanned: <span className="text-slate-200">{lastScanned}</span>
          </span>
        </header>

        {/* Tabs */}
        <nav className="mb-6 flex flex-wrap gap-2">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
                tab === t.key
                  ? 'bg-emerald-500 text-white'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              {t.label}
            </button>
          ))}
          {isMomentum && (
            <div className="ml-auto flex items-center gap-3">
              <label className="flex cursor-pointer items-center gap-2 text-xs text-slate-400">
                <input
                  type="checkbox"
                  checked={relaxPE}
                  onChange={(e) => setRelaxPE(e.target.checked)}
                  className="accent-emerald-500"
                />
                Include no-P/E stocks
              </label>
              {needsSubMarket && (
                <div className="flex items-center gap-1 rounded-full bg-slate-800 p-1">
                  {['usa', 'uk'].map((m) => (
                    <button
                      key={m}
                      onClick={() => setSubMarket(m)}
                      className={`rounded-full px-3 py-1 text-xs font-medium ${
                        subMarket === m ? 'bg-emerald-500 text-white' : 'text-slate-400 hover:text-white'
                      }`}
                    >
                      {m.toUpperCase()}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </nav>

        {scanError && (
          <div className="mb-4 rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-rose-300">
            Scan failed: {scanError}
          </div>
        )}

        {tab === 'leaders' && current?.breadth != null && (
          <div className="mb-4 rounded-xl border border-slate-700 bg-slate-800 px-4 py-3 text-sm">
            Market breadth:{' '}
            <span className="font-semibold text-emerald-400">{current.breadth}</span> stocks up
            &gt;20% over the last month{' '}
            <span className="text-slate-400">— a shrinking list signals market weakness.</span>
          </div>
        )}
        {tab === 'premarket' && (
          <div className="mb-4 text-xs text-slate-500">
            US market only — pre-market quotes populate roughly 4:00–9:30 AM ET.
          </div>
        )}
        {isMomentum && (
          <div className="mb-4 text-xs text-slate-500">
            ⚡ = intraday pacing: today&apos;s volume vs. the expected volume at this point in the
            session. Without ⚡, the ratio is the last completed session vs. its 20-day average.
          </div>
        )}

        {/* Results table */}
        <div className="overflow-x-auto rounded-2xl border border-slate-700 bg-slate-800 shadow-xl">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-700 text-xs tracking-wide text-slate-400 uppercase">
                {columns.map(([h]) => (
                  <th key={h} className="px-4 py-3 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {results?.length ? (
                results.map((r) => (
                  <tr
                    key={r.ticker}
                    onClick={() => setSelected((s) => ({ ...s, [dataKey]: r.ticker }))}
                    className={`cursor-pointer border-b border-slate-700 hover:bg-slate-700 ${
                      chartTicker === r.ticker ? 'bg-slate-700/60' : ''
                    }`}
                  >
                    {columns.map(([h, cell]) => (
                      <td key={h} className="px-4 py-2.5 first:font-semibold first:text-emerald-400">
                        {cell(r)}
                      </td>
                    ))}
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={columns.length} className="px-4 py-10 text-center text-slate-400">
                    {results
                      ? tabDef.kind === 'breakout'
                        ? 'No breakouts found — try scanning again.'
                        : relaxPE
                          ? 'No matches — filters (P/E < 20 or N/A, 2× volume, RSI > 50, ADR > 5%) are strict.'
                          : 'No matches — try "Include no-P/E stocks"; most high-ADR momentum names have no earnings yet.'
                      : 'Hit Scan Now to run this scanner.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Chart panel */}
        {results?.length > 0 && (
          <div className="mt-6 rounded-2xl bg-slate-800 p-4 shadow-xl">
            <div className="mb-3 flex items-center gap-3">
              <h2 className="font-semibold text-white">4h Chart</h2>
              <select
                value={chartTicker ?? ''}
                onChange={(e) => setSelected((s) => ({ ...s, [dataKey]: e.target.value }))}
                className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-200 focus:border-emerald-500 focus:outline-none"
              >
                {results.map((r) => (
                  <option key={r.ticker} value={r.ticker}>
                    {r.ticker}
                  </option>
                ))}
              </select>
              <span className="text-xs text-slate-500">
                rose band = consolidation range · emerald candle = breakout
              </span>
            </div>
            {chartTicker && <Chart ticker={chartTicker} />}
          </div>
        )}

        <footer className="mt-10 pb-6 text-center text-xs text-slate-500">
          For educational and research purposes only. Not financial advice.
        </footer>
      </div>
    </div>
  );
}
