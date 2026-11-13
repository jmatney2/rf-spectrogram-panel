# Changelog

## 1.0.0 (Unreleased)

Initial release.

- Canvas spectrogram panel for PSD records. The time axis follows the
  dashboard range; records and bins are aggregated per pixel (max or mean),
  and missing records show as gaps.
- Record format (one row per spectrum: base64 i16 bins plus band center and
  span) and long format (one row per time × bin).
- Colormaps, absolute or per-time-column normalization, automatic colour range
  that ignores outliers, colour bar using the field unit, hover readout,
  drag to zoom and double-click to zoom out.
- PostgreSQL schema, loader, panel query, and a synthetic live record feed for
  development (`db/`, `tools/gen_records.py`).
