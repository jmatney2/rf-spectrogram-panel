export type ColormapId = 'inferno' | 'viridis' | 'magma' | 'turbo' | 'gray';
/** 'absolute' = one shared color scale; 'peak' = each time column scaled to its own min..max. */
export type NormalizeMode = 'peak' | 'absolute';
/** How several data cells that land on one screen pixel are combined. */
export type AggregateMode = 'max' | 'mean';
/** 'dashboard' = x axis follows the dashboard time range; 'data' = fit to the data's extent. */
export type TimeAxisMode = 'dashboard' | 'data';

export interface SpectrogramOptions {
  /**
   * Record format: string column holding each record's PSD as base64 of
   * little-endian i16 (one spectrum per row). Bin k sits at
   * center_hz + (k/n - 0.5) * span_hz (columns `center_hz`, `span_hz`).
   */
  recordField: string;
  /** Long format: column holding frequency (Hz), one row per (time, bin). */
  freqField: string;
  /** Long format: column holding the PSD value. */
  valueField: string;
  /** Fixed color-scale min. Empty = auto (robust data min). */
  dbMin: string;
  /** Fixed color-scale max. Empty = auto (robust data max). */
  dbMax: string;
  normalize: NormalizeMode;
  aggregate: AggregateMode;
  timeAxis: TimeAxisMode;
  colormap: ColormapId;
  showAxes: boolean;
  showLegend: boolean;
  /** Render built-in demo data when the query returns nothing (dev only). */
  demoWhenEmpty: boolean;
}

export const defaultOptions: SpectrogramOptions = {
  recordField: 'psd',
  freqField: 'freq_hz',
  valueField: 'psd_db',
  dbMin: '',
  dbMax: '',
  normalize: 'absolute',
  aggregate: 'max',
  timeAxis: 'dashboard',
  colormap: 'inferno',
  showAxes: true,
  showLegend: true,
  demoWhenEmpty: false,
};
