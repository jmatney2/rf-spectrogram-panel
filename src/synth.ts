import { toDataFrame } from '@grafana/data';

/**
 * Built-in demo data (shown only when "Demo data when empty" is on and the
 * query returns nothing): a short wideband capture with a few bursts, a CW
 * interferer and a sweep, in long format. Returns rows as [t_ms, freq_hz, psd_db].
 */
export interface SyntheticFrame {
  rows: Array<[number, number, number]>;
  freqs: number[];
}

const FS = 40e6;
const BINS = 512;
const N_WINDOWS = 512;
const HOP = 512; // samples
const T0 = Date.UTC(2026, 10, 13, 12, 0, 0); // 2026-11-13T12:00:00Z

// mulberry32 — deterministic PRNG so the frame is stable across reloads
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Burst {
  startWindow: number;
  endWindow: number;
  centerHz: number;
  bwHz: number;
  peakDb: number;
  name: string;
}

const BURSTS: Burst[] = [
  { startWindow: 60, endWindow: 95, centerHz: -15e6, bwHz: 6e6, peakDb: -22, name: 'burst A' },
  { startWindow: 140, endWindow: 190, centerHz: -5e6, bwHz: 6e6, peakDb: -18, name: 'burst B' },
  { startWindow: 240, endWindow: 300, centerHz: 5e6, bwHz: 6e6, peakDb: -20, name: 'burst C' },
  { startWindow: 360, endWindow: 410, centerHz: 15e6, bwHz: 6e6, peakDb: -24, name: 'burst D' },
  { startWindow: 150, endWindow: 210, centerHz: -5e6, bwHz: 6e6, peakDb: -21, name: 'burst E' },
];

export function generateSyntheticPsd(): SyntheticFrame {
  const rand = prng(1337);
  const freqs: number[] = [];
  for (let b = 0; b < BINS; b++) {
    freqs.push((b / BINS - 0.5) * FS);
  }

  const rows: Array<[number, number, number]> = [];
  const windowDurMs = (HOP / FS) * 1000; // ms per window

  // Precompute per-window noise floor with slow drift
  const noiseBase = new Float32Array(N_WINDOWS);
  for (let w = 0; w < N_WINDOWS; w++) {
    noiseBase[w] = -36 + 1.5 * Math.sin(w / 40) + (rand() - 0.5) * 1.2;
  }

  // CW interferer: fixed freq, on for windows 100..350
  const cwHz = 9.2e6;
  const cwBin = Math.round((cwHz / FS + 0.5) * BINS);
  // Sweep: freq ramps −10..+10 MHz over windows 380..470
  const sweepStart = 380;
  const sweepEnd = 470;

  for (let w = 0; w < N_WINDOWS; w++) {
    const t = T0 + w * windowDurMs;
    for (let b = 0; b < BINS; b++) {
      const f = freqs[b];
      // noise floor with slight spectral tilt (lower at band edges)
      let db = noiseBase[w] + 0.8 * Math.cos((f / FS) * Math.PI) * 0; // flat-ish
      db += (rand() - 0.5) * 0.9;

      // bursts
      for (const br of BURSTS) {
        if (w >= br.startWindow && w <= br.endWindow) {
          const u = (w - br.startWindow) / (br.endWindow - br.startWindow);
          const env = Math.sin(Math.PI * Math.min(1, Math.max(0, u * 1.08))); // rise/fall
          const d = f - br.centerHz;
          const x = d / (br.bwHz * 0.28);
          db = Math.max(db, br.peakDb * env - 12 * x * x - (rand() - 0.5) * 0.6);
        }
      }

      // CW interferer
      if (w >= 100 && w <= 350 && b === cwBin) {
        db = Math.max(db, -26);
      }
      // CW leakage into neighbors
      if (w >= 100 && w <= 350) {
        const dl = Math.abs(b - cwBin);
        if (dl > 0 && dl < 4) {
          db = Math.max(db, -26 - 6 * dl);
        }
      }

      // Sweep
      if (w >= sweepStart && w <= sweepEnd) {
        const su = (w - sweepStart) / (sweepEnd - sweepStart);
        const sf = -15e6 + 30e6 * su;
        const d = Math.abs(f - sf);
        if (d < 2.5e6) {
          db = Math.max(db, -25 - 10 * (d / 2.5e6) * (d / 2.5e6));
        }
      }

      rows.push([t, f, db]);
    }
  }

  return { rows, freqs };
}

/**
 * Build Grafana data frames from rows: one frame per burst annotation plus
 * the main PSD frame. The panel expects a single frame with columns
 * [Time, freq_hz, psd_db].
 */
export function buildPsdFrame(rows: Array<[number, number, number]>): import('@grafana/data').DataFrame {
  return toDataFrame({
    name: 'psd',
    fields: [
      {
        name: 'Time',
        type: 'time',
        values: rows.map((r) => r[0]),
      },
      {
        name: 'freq_hz',
        type: 'number',
        values: rows.map((r) => r[1]),
      },
      {
        name: 'psd_db',
        type: 'number',
        values: rows.map((r) => r[2]),
      },
    ],
  });
}

export const SYNTHETIC_BURSTS = BURSTS;
