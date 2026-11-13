import { type DataFrame, FieldType } from '@grafana/data';

/**
 * Spectrogram grid. Rows = frequency (ascending), columns = time (ascending).
 * values[r * cols + c]; NaN = no data.
 */
export interface Matrix {
  values: Float32Array;
  times: Float64Array; // per column, ms epoch
  freqs: Float64Array; // per row, Hz (or bin index when freqIsBin)
  rows: number;
  cols: number;
  /** Duration one column covers (typical record spacing), ms. */
  colSpan: number;
  /** Frequency width one row covers (typical bin spacing). */
  rowSpan: number;
  /** True when no center/span columns were given: freqs are bin indexes. */
  freqIsBin: boolean;
}

export function decodeI16Base64(s: string): Int16Array {
  const bin = atob(s);
  const n = bin.length >> 1;
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8);
    out[i] = v >= 0x8000 ? v - 0x10000 : v;
  }
  return out;
}

/** Median spacing of sorted unique values; `fallback` when fewer than 2. */
function typicalStep(sorted: Float64Array, fallback: number): number {
  if (sorted.length < 2) {
    return fallback;
  }
  const d = new Float64Array(sorted.length - 1);
  for (let i = 1; i < sorted.length; i++) {
    d[i - 1] = sorted[i] - sorted[i - 1];
  }
  d.sort();
  return d[d.length >> 1] || fallback;
}

function sortedUnique(vals: ArrayLike<number>): Float64Array {
  const a = Float64Array.from(vals).sort();
  let n = 0;
  for (let i = 0; i < a.length; i++) {
    if (i === 0 || a[i] !== a[n - 1]) {
      a[n++] = a[i];
    }
  }
  return a.slice(0, n);
}

function indexOf(sorted: Float64Array): Map<number, number> {
  const m = new Map<number, number>();
  sorted.forEach((v, i) => m.set(v, i));
  return m;
}

/**
 * Record format: one row per record, `recordField` = base64 i16 LE bins.
 * Optional numeric `center_hz` / `span_hz` columns place bin k at
 * center + (k/n - 0.5) * span; without them rows are labeled by bin index.
 */
function recordFrameToMatrix(frame: DataFrame, recordField: string): Matrix | null {
  const tField = frame.fields.find((f) => f.type === FieldType.time);
  const pField = frame.fields.find((f) => f.name === recordField && f.type === FieldType.string);
  if (!tField || !pField || frame.length === 0) {
    return null;
  }
  const cField = frame.fields.find((f) => f.name === 'center_hz');
  const sField = frame.fields.find((f) => f.name === 'span_hz');
  const freqIsBin = !cField || !sField;

  const recs: Array<{ t: number; v: Int16Array; key: string }> = [];
  // Distinct (center, span, n) layouts -> their bin frequencies.
  const layouts = new Map<string, Float64Array>();
  for (let i = 0; i < frame.length; i++) {
    const s = pField.values[i];
    if (typeof s !== 'string' || !s) {
      continue;
    }
    const v = decodeI16Base64(s);
    const n = v.length;
    const center = freqIsBin ? 0 : Number(cField!.values[i]);
    const span = freqIsBin ? 0 : Number(sField!.values[i]);
    const key = `${center}|${span}|${n}`;
    if (!layouts.has(key)) {
      const f = new Float64Array(n);
      for (let k = 0; k < n; k++) {
        f[k] = freqIsBin ? k : center + (k / n - 0.5) * span;
      }
      layouts.set(key, f);
    }
    recs.push({ t: Number(tField.values[i]), v, key });
  }
  if (!recs.length) {
    return null;
  }

  const times = sortedUnique(recs.map((r) => r.t));
  const allFreqs: number[] = [];
  layouts.forEach((f) => f.forEach((x) => allFreqs.push(x)));
  const freqs = sortedUnique(allFreqs);
  const tIdx = indexOf(times);
  const fIdx = indexOf(freqs);
  const rowOf = new Map<string, Int32Array>();
  layouts.forEach((f, key) =>
    rowOf.set(
      key,
      Int32Array.from(f, (x) => fIdx.get(x)!)
    )
  );

  const rows = freqs.length;
  const cols = times.length;
  const values = new Float32Array(rows * cols).fill(NaN);
  for (const r of recs) {
    const c = tIdx.get(r.t)!;
    const ro = rowOf.get(r.key)!;
    for (let k = 0; k < r.v.length; k++) {
      values[ro[k] * cols + c] = r.v[k];
    }
  }
  return {
    values,
    times,
    freqs,
    rows,
    cols,
    colSpan: typicalStep(times, 60_000),
    rowSpan: typicalStep(freqs, 1),
    freqIsBin,
  };
}

/** Long format: one row per (time, frequency) with a numeric value. */
function longFrameToMatrix(frame: DataFrame, freqField: string, valueField: string): Matrix | null {
  const tField = frame.fields.find((f) => f.type === FieldType.time);
  const fField = frame.fields.find((f) => f.name === freqField);
  const vField = frame.fields.find((f) => f.name === valueField);
  const n = frame.length;
  if (!tField || !fField || !vField || n === 0) {
    return null;
  }
  const times = sortedUnique(tField.values as number[]);
  const freqs = sortedUnique(fField.values as number[]);
  const tIdx = indexOf(times);
  const fIdx = indexOf(freqs);
  const rows = freqs.length;
  const cols = times.length;
  const values = new Float32Array(rows * cols).fill(NaN);
  for (let i = 0; i < n; i++) {
    const v = vField.values[i];
    if (v == null) {
      continue;
    }
    values[fIdx.get(fField.values[i])! * cols + tIdx.get(tField.values[i])!] = v;
  }
  return {
    values,
    times,
    freqs,
    rows,
    cols,
    colSpan: typicalStep(times, 1000),
    rowSpan: typicalStep(freqs, 1),
    freqIsBin: false,
  };
}

export function framesToMatrix(
  series: DataFrame[],
  opts: { recordField: string; freqField: string; valueField: string }
): Matrix | null {
  for (const frame of series) {
    const m = recordFrameToMatrix(frame, opts.recordField) ?? longFrameToMatrix(frame, opts.freqField, opts.valueField);
    if (m) {
      return m;
    }
  }
  return null;
}

/** First index i in sorted `a` with a[i] >= x. */
export function lowerBound(a: Float64Array, x: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid] < x) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

/**
 * For each of `npx` pixels spanning [lo, hi), the [start, end) range of
 * cells (sorted coords; cell i covers [coord - before, coord - before + span))
 * overlapping it. start >= end means no data under that pixel.
 */
export function pixelRanges(
  coords: Float64Array,
  span: number,
  before: number,
  lo: number,
  hi: number,
  npx: number
): Int32Array {
  const out = new Int32Array(npx * 2);
  const w = (hi - lo) / npx;
  for (let p = 0; p < npx; p++) {
    const a = lo + p * w;
    const b = a + w;
    // cell i overlaps [a,b) iff coord-before < b && coord-before+span > a
    out[2 * p] = lowerBound(coords, a + before - span + 1e-9 * Math.abs(span));
    out[2 * p + 1] = lowerBound(coords, b + before);
  }
  return out;
}

/** Nearest cell whose extent contains x, or -1. */
export function cellAt(coords: Float64Array, span: number, before: number, x: number): number {
  const i = lowerBound(coords, x + before);
  for (const j of [i - 1, i]) {
    if (j >= 0 && j < coords.length && x >= coords[j] - before && x < coords[j] - before + span) {
      return j;
    }
  }
  return -1;
}

/** Robust auto range: low/high percentiles of the finite values. */
export function robustRange(vals: Float32Array, pLo = 0.01, pHi = 0.999): [number, number] {
  const finite: number[] = [];
  const stride = Math.max(1, Math.floor(vals.length / 200_000));
  for (let i = 0; i < vals.length; i += stride) {
    if (!Number.isNaN(vals[i])) {
      finite.push(vals[i]);
    }
  }
  if (!finite.length) {
    return [NaN, NaN];
  }
  finite.sort((a, b) => a - b);
  const q = (p: number) => finite[Math.min(finite.length - 1, Math.floor(p * (finite.length - 1)))];
  return [q(pLo), q(pHi)];
}

const TIME_STEPS = [
  1, 2, 5, 10, 20, 50, 100, 200, 500, 1e3, 2e3, 5e3, 1e4, 15e3, 3e4, 6e4, 12e4, 3e5, 6e5, 9e5, 18e5, 36e5, 72e5, 108e5,
  216e5, 432e5, 864e5, 1728e5, 6048e5,
];

export function niceTimeStep(rangeMs: number, maxTicks: number): number {
  const raw = rangeMs / Math.max(1, maxTicks);
  return TIME_STEPS.find((s) => s >= raw) ?? Math.ceil(raw / 864e5) * 864e5;
}

export function niceStep(range: number, maxTicks: number): number {
  const raw = range / Math.max(1, maxTicks);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 2.5, 5, 10]) {
    if (m * mag >= raw) {
      return m * mag;
    }
  }
  return 10 * mag;
}
