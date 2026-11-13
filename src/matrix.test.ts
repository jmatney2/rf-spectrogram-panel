import { FieldType, toDataFrame } from '@grafana/data';
import { cellAt, decodeI16Base64, framesToMatrix, pixelRanges } from './matrix';

const OPTS = { recordField: 'psd', freqField: 'freq_hz', valueField: 'psd_db' };

function b64(vals: number[]): string {
  const bytes = new Uint8Array(new Int16Array(vals).buffer); // little-endian on test hosts
  return btoa(String.fromCharCode(...bytes));
}

describe('decodeI16Base64', () => {
  it('decodes little-endian signed i16', () => {
    expect(Array.from(decodeI16Base64(b64([0, 1, -1, 32767, -32768, -9000])))).toEqual([
      0, 1, -1, 32767, -32768, -9000,
    ]);
  });
});

describe('framesToMatrix (record format)', () => {
  const frame = toDataFrame({
    fields: [
      { name: 'Time', type: FieldType.time, values: [120_000, 0, 60_000] },
      { name: 'center_hz', type: FieldType.number, values: [1000, 1000, 1000] },
      { name: 'span_hz', type: FieldType.number, values: [400, 400, 400] },
      { name: 'psd', type: FieldType.string, values: [b64([9, 10, 11, 12]), b64([1, 2, 3, 4]), b64([5, 6, 7, 8])] },
    ],
  });

  it('puts bins on the frequency axis and records on the time axis', () => {
    const m = framesToMatrix([frame], OPTS)!;
    expect(m.rows).toBe(4);
    expect(m.cols).toBe(3);
    // bin k at center + (k/n - 0.5) * span
    expect(Array.from(m.freqs)).toEqual([800, 900, 1000, 1100]);
    expect(Array.from(m.times)).toEqual([0, 60_000, 120_000]);
    expect(m.colSpan).toBe(60_000);
    expect(m.rowSpan).toBe(100);
    // row 0 (lowest freq) across time, sorted by time
    expect(Array.from(m.values.slice(0, 3))).toEqual([1, 5, 9]);
    expect(Array.from(m.values.slice(9, 12))).toEqual([4, 8, 12]);
    expect(m.freqIsBin).toBe(false);
  });

  it('falls back to bin indexes without center/span', () => {
    const f = toDataFrame({
      fields: [
        { name: 'Time', type: FieldType.time, values: [0] },
        { name: 'psd', type: FieldType.string, values: [b64([1, 2, 3])] },
      ],
    });
    const m = framesToMatrix([f], OPTS)!;
    expect(m.freqIsBin).toBe(true);
    expect(Array.from(m.freqs)).toEqual([0, 1, 2]);
  });
});

describe('framesToMatrix (long format)', () => {
  it('pivots (time, freq, value) rows', () => {
    const f = toDataFrame({
      fields: [
        { name: 'Time', type: FieldType.time, values: [0, 0, 10, 10] },
        { name: 'freq_hz', type: FieldType.number, values: [5, 1, 1, 5] },
        { name: 'psd_db', type: FieldType.number, values: [-1, -2, -3, -4] },
      ],
    });
    const m = framesToMatrix([f], OPTS)!;
    expect(Array.from(m.values)).toEqual([-2, -3, -1, -4]);
  });
});

describe('pixelRanges / cellAt', () => {
  const times = Float64Array.from([0, 60, 120, 240]); // gap at 180
  it('maps pixels to covering cells and leaves gaps empty', () => {
    const r = pixelRanges(times, 60, 0, 0, 300, 5); // 60 per pixel
    const ranges = Array.from({ length: 5 }, (_, p) => [r[2 * p], r[2 * p + 1]]);
    expect(ranges).toEqual([
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 3], // 180..240: missing record -> empty
      [3, 4],
    ]);
  });
  it('aggregates several cells per pixel when zoomed out', () => {
    const r = pixelRanges(times, 60, 0, 0, 300, 1);
    expect([r[0], r[1]]).toEqual([0, 4]);
  });
  it('finds the cell under a coordinate', () => {
    expect(cellAt(times, 60, 0, 59)).toBe(0);
    expect(cellAt(times, 60, 0, 60)).toBe(1);
    expect(cellAt(times, 60, 0, 200)).toBe(-1);
    expect(cellAt(Float64Array.from([100, 200]), 100, 50, 149)).toBe(0);
  });
});
