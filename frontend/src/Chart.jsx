import { useEffect, useRef, useState } from 'react';
import { createChart, CandlestickSeries } from 'lightweight-charts';

// Candlestick panel with a semi-transparent consolidation band overlay.
// The band is a positioned div kept in sync with the chart's price scale.
export default function Chart({ ticker }) {
  const containerRef = useRef(null);
  const bandRef = useRef(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!ticker || !containerRef.current) return;
    let disposed = false;
    setError(null);
    setLoading(true);

    const chart = createChart(containerRef.current, {
      autoSize: true,
      layout: {
        background: { color: 'transparent' },
        textColor: '#94a3b8',
      },
      grid: {
        vertLines: { color: '#33415555' },
        horzLines: { color: '#33415555' },
      },
      timeScale: { timeVisible: true, borderColor: '#334155' },
      rightPriceScale: { borderColor: '#334155' },
      crosshair: { mode: 0 },
    });

    const series = chart.addSeries(CandlestickSeries, {
      upColor: '#0ea5a3',
      downColor: '#64748b',
      borderVisible: false,
      wickUpColor: '#0ea5a3',
      wickDownColor: '#64748b',
    });

    let band = { high: null, low: null };

    const positionBand = () => {
      const el = bandRef.current;
      if (!el || band.high == null) return;
      const yTop = series.priceToCoordinate(band.high);
      const yBot = series.priceToCoordinate(band.low);
      if (yTop == null || yBot == null) {
        el.style.display = 'none';
        return;
      }
      el.style.display = 'block';
      el.style.top = `${Math.min(yTop, yBot)}px`;
      el.style.height = `${Math.abs(yBot - yTop)}px`;
    };

    fetch('/api/chart', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticker }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (disposed) return;
        setLoading(false);
        if (data.error) {
          setError(data.error);
          return;
        }
        const breakoutTime = data.breakoutTime;
        series.setData(
          data.candles.map((c) =>
            c.time === breakoutTime
              ? { ...c, color: '#10b981', wickColor: '#10b981', borderColor: '#10b981' }
              : c,
          ),
        );
        band = { high: data.consolidationHigh, low: data.consolidationLow };
        chart.timeScale().fitContent();
        requestAnimationFrame(positionBand);
      })
      .catch((e) => {
        if (!disposed) {
          setLoading(false);
          setError(e.message);
        }
      });

    chart.timeScale().subscribeVisibleLogicalRangeChange(positionBand);
    const ro = new ResizeObserver(() => requestAnimationFrame(positionBand));
    ro.observe(containerRef.current);
    const interval = setInterval(positionBand, 250); // catch price-scale autoscale changes

    return () => {
      disposed = true;
      clearInterval(interval);
      ro.disconnect();
      chart.remove();
    };
  }, [ticker]);

  return (
    <div className="relative h-96">
      <div ref={containerRef} className="absolute inset-0" />
      {/* consolidation range band — rose-500 @ 15% */}
      <div
        ref={bandRef}
        className="pointer-events-none absolute right-0 left-0 z-10 hidden"
        style={{ backgroundColor: 'rgba(244, 63, 94, 0.15)' }}
      />
      {loading && (
        <div className="absolute inset-0 z-20 flex items-center justify-center text-slate-400">
          Loading {ticker}…
        </div>
      )}
      {error && (
        <div className="absolute inset-0 z-20 flex items-center justify-center text-rose-400">
          {error}
        </div>
      )}
    </div>
  );
}
