// Sample scan payload for UI previews/screenshots. Loaded only with ?demo=1 —
// the stats are illustrative, not live screening output.
export const DEMO_SCAN = {
  market: 'usa',
  scanned: 607,
  scannedAt: new Date().toISOString(),
  results: [
    { ticker: 'SMCI', price: 26.43, breakoutPct: 3.24, breakoutSizePct: 6.81, relVolume: 4.21, pctFrom20dHigh: 1.18, pctFrom50dHigh: 3.52 },
    { ticker: 'CIFR', price: 7.83, breakoutPct: 4.12, breakoutSizePct: 7.93, relVolume: 3.87, pctFrom20dHigh: 0.82, pctFrom50dHigh: 2.14 },
    { ticker: 'SOUN', price: 11.42, breakoutPct: 2.71, breakoutSizePct: 5.63, relVolume: 3.12, pctFrom20dHigh: 1.47, pctFrom50dHigh: 4.23 },
    { ticker: 'IREN', price: 14.95, breakoutPct: 2.24, breakoutSizePct: 5.12, relVolume: 2.64, pctFrom20dHigh: 2.03, pctFrom50dHigh: 5.48 },
    { ticker: 'HOOD', price: 98.3, breakoutPct: 2.91, breakoutSizePct: 6.17, relVolume: 2.35, pctFrom20dHigh: 0.54, pctFrom50dHigh: 1.92 },
  ],
};
