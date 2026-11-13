import React, { useEffect, useMemo, useRef, useState } from 'react';
import { PanelProps, dateTimeFormat, formattedValueToString, getValueFormat } from '@grafana/data';
import { css } from '@emotion/css';
import { SpectrogramOptions } from 'types';
import { generateSyntheticPsd, buildPsdFrame } from '../synth';
import { cellAt, framesToMatrix, niceStep, niceTimeStep, pixelRanges, robustRange } from '../matrix';

// ---------------------------------------------------------------------------
// Colormaps (stops sampled from matplotlib; value 0..1 → [r,g,b] 0..255)
// ---------------------------------------------------------------------------
type Stops = Array<[number, number, number]>;

function buildLut(stops: Stops): Uint8ClampedArray {
  const n = 256;
  const lut = new Uint8ClampedArray(n * 3);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * (stops.length - 1);
    const j = Math.min(stops.length - 2, Math.floor(x));
    const t = x - j;
    for (let ch = 0; ch < 3; ch++) {
      lut[i * 3 + ch] = stops[j][ch] + (stops[j + 1][ch] - stops[j][ch]) * t;
    }
  }
  return lut;
}

const COLORMAPS: Record<string, Uint8ClampedArray> = {
  inferno: buildLut([
    [0, 0, 4],
    [22, 11, 57],
    [66, 10, 104],
    [106, 23, 110],
    [147, 38, 103],
    [188, 55, 84],
    [221, 81, 58],
    [243, 118, 27],
    [252, 165, 10],
    [252, 225, 115],
    [252, 255, 164],
  ]),
  viridis: buildLut([
    [68, 1, 84],
    [72, 40, 120],
    [62, 74, 137],
    [49, 104, 142],
    [38, 130, 142],
    [31, 158, 137],
    [53, 183, 121],
    [109, 205, 89],
    [180, 222, 44],
    [253, 231, 37],
  ]),
  magma: buildLut([
    [0, 0, 4],
    [28, 16, 68],
    [79, 18, 123],
    [129, 37, 129],
    [181, 54, 122],
    [229, 80, 100],
    [251, 135, 97],
    [254, 194, 135],
    [252, 253, 191],
  ]),
  turbo: buildLut([
    [48, 18, 59],
    [70, 107, 227],
    [40, 201, 220],
    [72, 249, 157],
    [192, 252, 60],
    [254, 189, 43],
    [226, 87, 25],
    [122, 4, 3],
  ]),
  gray: buildLut([
    [0, 0, 0],
    [255, 255, 255],
  ]),
};

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------
/** Hz with a unit chosen by magnitude and decimals enough to resolve `step`. */
function fmtHz(hz: number, step: number): string {
  const mag = Math.max(Math.abs(hz), Math.abs(step));
  const [div, unit] = mag >= 1e9 ? [1e9, 'GHz'] : mag >= 1e6 ? [1e6, 'MHz'] : mag >= 1e3 ? [1e3, 'kHz'] : [1, 'Hz'];
  const s = Math.abs(step) / div;
  let decimals = Math.max(0, Math.ceil(-Math.log10(s) - 1e-9));
  while (decimals < 6 && Math.abs(Math.round(s * 10 ** decimals) - s * 10 ** decimals) > 1e-6) {
    decimals++;
  }
  return `${(hz / div).toFixed(decimals)} ${unit}`;
}

function timeFormatFor(stepMs: number, rangeMs: number): string {
  if (stepMs < 1000) {
    return 'HH:mm:ss.SSS';
  }
  if (stepMs < 60_000) {
    return 'HH:mm:ss';
  }
  if (rangeMs > 864e5) {
    return 'MM-DD HH:mm';
  }
  return 'HH:mm';
}

interface Layout {
  ml: number;
  mt: number;
  pw: number;
  ph: number;
}

function layoutFor(width: number, height: number, showAxes: boolean, showLegend: boolean): Layout {
  const ml = showAxes ? 78 : 4;
  const mb = showAxes ? 34 : 4;
  const mr = showLegend ? 104 : 4;
  const mt = 6;
  return { ml, mt, pw: Math.max(1, Math.floor(width - ml - mr)), ph: Math.max(1, Math.floor(height - mt - mb)) };
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------
interface Props extends PanelProps<SpectrogramOptions> {}

const styles = {
  wrapper: css`
    position: relative;
    overflow: hidden;
  `,
  canvas: css`
    position: absolute;
    top: 0;
    left: 0;
  `,
  badge: css`
    position: absolute;
    top: 8px;
    right: 8px;
    padding: 2px 8px;
    font-size: 10px;
    color: #ffd;
    background: rgba(255, 170, 0, 0.25);
    border: 1px solid rgba(255, 170, 0, 0.6);
    border-radius: 3px;
    pointer-events: none;
  `,
  empty: css`
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    opacity: 0.7;
  `,
};

export const SpectrogramPanel: React.FC<Props> = ({
  options,
  data,
  width,
  height,
  fieldConfig,
  timeRange,
  timeZone,
  onChangeTimeRange,
}) => {
  const baseRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
  // Drag-to-zoom selection, in CSS px within the panel.
  const [drag, setDrag] = useState<{ x0: number; x1: number } | null>(null);

  const { recordField, freqField, valueField, demoWhenEmpty } = options;
  const { matrix, synthetic } = useMemo(() => {
    const fields = { recordField, freqField, valueField };
    const m = framesToMatrix(data.series, fields);
    if (m || !demoWhenEmpty) {
      return { matrix: m, synthetic: false };
    }
    const df = buildPsdFrame(generateSyntheticPsd().rows);
    return {
      matrix: framesToMatrix([df], { ...fields, freqField: 'freq_hz', valueField: 'psd_db' }),
      synthetic: true,
    };
  }, [data.series, recordField, freqField, valueField, demoWhenEmpty]);

  const unit = fieldConfig.defaults.unit;
  const fmtValue = useMemo(() => {
    const f = getValueFormat(unit || 'none');
    return (v: number, decimals?: number) => formattedValueToString(f(v, decimals));
  }, [unit]);

  const layout = useMemo(
    () => layoutFor(width, height, options.showAxes, options.showLegend),
    [width, height, options.showAxes, options.showLegend]
  );

  // Visible domain.
  const domain = useMemo(() => {
    if (!matrix) {
      return null;
    }
    const { times, freqs, colSpan, rowSpan } = matrix;
    const dataT0 = times[0];
    const dataT1 = times[times.length - 1] + colSpan;
    const useDash = options.timeAxis === 'dashboard' && !synthetic;
    return {
      t0: useDash ? timeRange.from.valueOf() : dataT0,
      t1: useDash ? timeRange.to.valueOf() : dataT1,
      f0: freqs[0] - rowSpan / 2,
      f1: freqs[freqs.length - 1] + rowSpan / 2,
    };
  }, [matrix, options.timeAxis, synthetic, timeRange]);

  // Aggregate the matrix onto the plot's pixel grid. Cells: a column covers
  // [t, t + colSpan); a row covers [f - rowSpan/2, f + rowSpan/2).
  const raster = useMemo(() => {
    if (!matrix || !domain) {
      return null;
    }
    const { pw, ph } = layout;
    const { values, cols, times, freqs, colSpan, rowSpan } = matrix;
    const cr = pixelRanges(times, colSpan, 0, domain.t0, domain.t1, pw);
    const rr = pixelRanges(freqs, rowSpan, rowSpan / 2, domain.f0, domain.f1, ph);
    const useMax = options.aggregate === 'max';
    const out = new Float32Array(pw * ph).fill(NaN);
    for (let py = 0; py < ph; py++) {
      const p = ph - 1 - py; // py=0 is the top = highest frequency
      const r0 = rr[2 * p];
      const r1 = rr[2 * p + 1];
      if (r0 >= r1) {
        continue;
      }
      for (let px = 0; px < pw; px++) {
        const c0 = cr[2 * px];
        const c1 = cr[2 * px + 1];
        if (c0 >= c1) {
          continue;
        }
        let acc = useMax ? -Infinity : 0;
        let cnt = 0;
        for (let r = r0; r < r1; r++) {
          const base = r * cols;
          for (let c = c0; c < c1; c++) {
            const v = values[base + c];
            if (v === v) {
              acc = useMax ? (v > acc ? v : acc) : acc + v;
              cnt++;
            }
          }
        }
        if (cnt) {
          out[py * pw + px] = useMax ? acc : acc / cnt;
        }
      }
    }
    return out;
  }, [matrix, domain, layout, options.aggregate]);

  const scale = useMemo(() => {
    const fixedMin = options.dbMin !== '' ? parseFloat(options.dbMin) : NaN;
    const fixedMax = options.dbMax !== '' ? parseFloat(options.dbMax) : NaN;
    const [aMin, aMax] = matrix ? robustRange(matrix.values) : [NaN, NaN];
    const min = Number.isFinite(fixedMin) ? fixedMin : aMin;
    const max = Number.isFinite(fixedMax) ? fixedMax : aMax;
    return { min, max: max > min ? max : min + 1 };
  }, [matrix, options.dbMin, options.dbMax]);

  // Base layer: heatmap, axes, legend.
  useEffect(() => {
    const canvas = baseRef.current;
    if (!canvas) {
      return;
    }
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.floor(width * dpr));
    canvas.height = Math.max(1, Math.floor(height * dpr));
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    if (!matrix || !raster || !domain || !Number.isFinite(scale.min)) {
      return;
    }
    const { ml, mt, pw, ph } = layout;
    const lut = COLORMAPS[options.colormap] ?? COLORMAPS.inferno;

    // Per-column range for 'peak' normalization.
    let colMin: Float32Array | null = null;
    let colMax: Float32Array | null = null;
    if (options.normalize === 'peak') {
      colMin = new Float32Array(pw).fill(Infinity);
      colMax = new Float32Array(pw).fill(-Infinity);
      for (let i = 0; i < raster.length; i++) {
        const v = raster[i];
        if (v === v) {
          const px = i % pw;
          colMin[px] = Math.min(colMin[px], v);
          colMax[px] = Math.max(colMax[px], v);
        }
      }
    }

    const img = ctx.createImageData(pw, ph);
    const range = scale.max - scale.min;
    for (let i = 0; i < raster.length; i++) {
      const v = raster[i];
      const o = i * 4;
      if (v !== v) {
        img.data[o] = 40;
        img.data[o + 1] = 40;
        img.data[o + 2] = 48;
        img.data[o + 3] = 90; // faint: no data here
        continue;
      }
      let n: number;
      if (colMin && colMax) {
        const px = i % pw;
        n = (v - colMin[px]) / Math.max(1e-9, colMax[px] - colMin[px]);
      } else {
        n = (v - scale.min) / range;
      }
      const li = Math.max(0, Math.min(255, Math.floor(n * 255))) * 3;
      img.data[o] = lut[li];
      img.data[o + 1] = lut[li + 1];
      img.data[o + 2] = lut[li + 2];
      img.data[o + 3] = 255;
    }
    // putImageData ignores the transform, so position in device pixels via a
    // temp canvas + drawImage.
    const tmp = document.createElement('canvas');
    tmp.width = pw;
    tmp.height = ph;
    tmp.getContext('2d')!.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(tmp, ml, mt, pw, ph);

    const text = 'rgba(204,204,220,0.85)';
    const line = 'rgba(204,204,220,0.3)';
    ctx.font = '11px Inter, Helvetica, Arial, sans-serif';
    ctx.lineWidth = 1;

    if (options.showAxes) {
      ctx.strokeStyle = line;
      ctx.fillStyle = text;
      ctx.strokeRect(ml + 0.5, mt + 0.5, pw - 1, ph - 1);

      // Frequency ticks.
      const { f0, f1 } = domain;
      const fStep = matrix.freqIsBin ? Math.max(1, niceStep(f1 - f0, ph / 36)) : niceStep(f1 - f0, ph / 36);
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      for (let f = Math.ceil(f0 / fStep) * fStep; f <= f1; f += fStep) {
        const y = Math.round(mt + ph - ((f - f0) / (f1 - f0)) * ph) + 0.5;
        ctx.beginPath();
        ctx.moveTo(ml - 4, y);
        ctx.lineTo(ml, y);
        ctx.stroke();
        ctx.fillText(matrix.freqIsBin ? String(Math.round(f)) : fmtHz(f, fStep), ml - 6, y);
      }
      ctx.save();
      ctx.translate(12, mt + ph / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.textAlign = 'center';
      ctx.fillText(matrix.freqIsBin ? 'Bin' : 'Frequency', 0, 0);
      ctx.restore();

      // Time ticks (aligned to local/dashboard time-of-day boundaries).
      const { t0, t1 } = domain;
      const tStep = niceTimeStep(t1 - t0, pw / 110);
      const fmt = timeFormatFor(tStep, t1 - t0);
      const tzOff = timeZone === 'utc' ? 0 : -new Date(t0).getTimezoneOffset() * 60_000;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      for (let t = Math.ceil((t0 + tzOff) / tStep) * tStep - tzOff; t <= t1; t += tStep) {
        const x = Math.round(ml + ((t - t0) / (t1 - t0)) * pw) + 0.5;
        ctx.beginPath();
        ctx.moveTo(x, mt + ph);
        ctx.lineTo(x, mt + ph + 4);
        ctx.stroke();
        ctx.fillText(dateTimeFormat(t, { format: fmt, timeZone }), x, mt + ph + 6);
      }
      ctx.fillText('Time', ml + pw / 2, mt + ph + 20);
    }

    if (options.showLegend) {
      const bx = ml + pw + 10;
      const bw = 12;
      const grad = ctx.createLinearGradient(0, mt, 0, mt + ph);
      for (let i = 0; i <= 16; i++) {
        const li = Math.floor((1 - i / 16) * 255) * 3;
        grad.addColorStop(i / 16, `rgb(${lut[li]},${lut[li + 1]},${lut[li + 2]})`);
      }
      ctx.fillStyle = grad;
      ctx.fillRect(bx, mt, bw, ph);
      ctx.strokeStyle = line;
      ctx.strokeRect(bx + 0.5, mt + 0.5, bw, ph);
      ctx.fillStyle = text;
      ctx.font = '10px Inter, Helvetica, Arial, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      if (options.normalize === 'peak') {
        ctx.fillText('col max', bx + bw + 3, mt + 5);
        ctx.fillText('col min', bx + bw + 3, mt + ph - 5);
      } else {
        const step = niceStep(scale.max - scale.min, Math.max(2, ph / 40));
        for (let v = Math.ceil(scale.min / step) * step; v <= scale.max; v += step) {
          const y = mt + ((scale.max - v) / (scale.max - scale.min)) * ph;
          ctx.fillText(fmtValue(v), bx + bw + 4, y);
        }
      }
    }
  }, [matrix, raster, domain, scale, width, height, options, layout, timeZone, fmtValue]);

  // Overlay layer: hover crosshair + readout (cheap; doesn't redraw the heatmap).
  useEffect(() => {
    const canvas = overlayRef.current;
    if (!canvas) {
      return;
    }
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.floor(width * dpr));
    canvas.height = Math.max(1, Math.floor(height * dpr));
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const { ml, mt, pw, ph } = layout;
    if (drag) {
      const a = Math.max(ml, Math.min(drag.x0, drag.x1));
      const b = Math.min(ml + pw, Math.max(drag.x0, drag.x1));
      ctx.fillStyle = 'rgba(120,160,255,0.2)';
      ctx.fillRect(a, mt, b - a, ph);
      ctx.strokeStyle = 'rgba(160,190,255,0.8)';
      ctx.strokeRect(a + 0.5, mt + 0.5, b - a, ph - 1);
      return;
    }
    if (!hover || !matrix || !domain) {
      return;
    }
    const { x, y } = hover;
    if (x < ml || x > ml + pw || y < mt || y > mt + ph) {
      return;
    }
    const t = domain.t0 + ((x - ml) / pw) * (domain.t1 - domain.t0);
    const f = domain.f0 + (1 - (y - mt) / ph) * (domain.f1 - domain.f0);
    const c = cellAt(matrix.times, matrix.colSpan, 0, t);
    const r = cellAt(matrix.freqs, matrix.rowSpan, matrix.rowSpan / 2, f);

    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(x + 0.5, mt);
    ctx.lineTo(x + 0.5, mt + ph);
    ctx.moveTo(ml, y + 0.5);
    ctx.lineTo(ml + pw, y + 0.5);
    ctx.stroke();
    ctx.setLineDash([]);

    const v = c >= 0 && r >= 0 ? matrix.values[r * matrix.cols + c] : NaN;
    const lines = [
      dateTimeFormat(c >= 0 ? matrix.times[c] : t, { format: 'YYYY-MM-DD HH:mm:ss', timeZone }),
      matrix.freqIsBin
        ? `bin ${r >= 0 ? matrix.freqs[r] : Math.round(f)}`
        : fmtHz(r >= 0 ? matrix.freqs[r] : f, Math.pow(10, Math.floor(Math.log10(matrix.rowSpan)))),
      Number.isNaN(v) ? 'no data' : fmtValue(v),
    ];
    ctx.font = '11px Inter, Helvetica, Arial, sans-serif';
    const tw = Math.max(...lines.map((l) => ctx.measureText(l).width));
    const bh = lines.length * 15 + 6;
    let bx = x + 12;
    if (bx + tw + 12 > width) {
      bx = x - tw - 22;
    }
    let by = y - bh - 8;
    if (by < 0) {
      by = y + 12;
    }
    ctx.fillStyle = 'rgba(10,10,20,0.9)';
    ctx.fillRect(bx, by, tw + 10, bh);
    ctx.strokeStyle = 'rgba(255,255,255,0.4)';
    ctx.strokeRect(bx + 0.5, by + 0.5, tw + 10, bh);
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    lines.forEach((l, i) => ctx.fillText(l, bx + 5, by + 4 + i * 15));
  }, [hover, drag, matrix, domain, width, height, layout, timeZone, fmtValue]);

  // Time domain shown on the x axis (also valid when there is no data).
  const tDomain: [number, number] = domain
    ? [domain.t0, domain.t1]
    : [timeRange.from.valueOf(), timeRange.to.valueOf()];
  const xToTime = (x: number) => tDomain[0] + ((x - layout.ml) / layout.pw) * (tDomain[1] - tDomain[0]);
  const pos = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };
  const onMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const p = pos(e);
    setHover(p);
    if (drag) {
      setDrag({ ...drag, x1: p.x });
    }
  };
  const onDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const { x } = pos(e);
    if (e.button === 0 && x >= layout.ml && x <= layout.ml + layout.pw) {
      setDrag({ x0: x, x1: x });
    }
  };
  // Drag across the plot -> zoom the dashboard to that time span.
  const onUp = () => {
    if (drag && Math.abs(drag.x1 - drag.x0) > 4) {
      const clamp = (x: number) => Math.max(layout.ml, Math.min(layout.ml + layout.pw, x));
      const from = xToTime(clamp(Math.min(drag.x0, drag.x1)));
      const to = xToTime(clamp(Math.max(drag.x0, drag.x1)));
      onChangeTimeRange({ from: Math.round(from), to: Math.round(to) });
    }
    setDrag(null);
  };
  // Double-click -> zoom out 2x around the current center.
  const onDouble = () => {
    const [t0, t1] = [timeRange.from.valueOf(), timeRange.to.valueOf()];
    const half = t1 - t0;
    const mid = (t0 + t1) / 2;
    onChangeTimeRange({ from: Math.round(mid - half), to: Math.round(Math.min(Date.now(), mid + half)) });
  };

  return (
    <div className={styles.wrapper} style={{ width, height }}>
      <canvas data-testid="spectrogram-canvas" ref={baseRef} className={styles.canvas} />
      <canvas
        ref={overlayRef}
        className={styles.canvas}
        style={{ cursor: 'crosshair' }}
        onMouseMove={onMove}
        onMouseDown={onDown}
        onMouseUp={onUp}
        onDoubleClick={onDouble}
        onMouseLeave={() => {
          setHover(null);
          setDrag(null);
        }}
      />
      {!matrix && <div className={styles.empty}>No PSD data in this time range</div>}
      {synthetic && <div className={styles.badge}>synthetic data</div>}
    </div>
  );
};
