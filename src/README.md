# RF Spectrogram

Draws power spectral density (PSD) records as a time × frequency heatmap.
Each query row is one spectrum, and rows are laid out along the dashboard's
time axis.

- The time axis follows the dashboard range. Drag across the plot to zoom
  in; double-click to zoom out 2×.
- Records and bins that share a pixel are combined by max-hold (short bursts
  stay visible) or by the mean. Missing records show as gaps.
- The frequency axis is in Hz. The colour range is automatic or fixed, and
  the colour bar uses the field unit.
- Hover to see the time, frequency and value under the cursor.

## Data formats

### Record format (recommended)

One row per record:

| Column      | Type   | Description                                                   |
| ----------- | ------ | ------------------------------------------------------------- |
| `Time`      | time   | Record timestamp (start of the interval it covers)            |
| `psd`       | string | The bins: base64 of little-endian i16, lowest frequency first |
| `center_hz` | number | Band center frequency, Hz (optional)                          |
| `span_hz`   | number | Frequency span covered by the bins, Hz (optional)             |

Bin `k` of `n` is drawn at `center_hz + (k/n − 0.5) · span_hz`. Without
`center_hz` and `span_hz`, the y-axis shows bin indexes. Rows with different
centers are merged onto one frequency axis. Each record is drawn as wide as
the typical spacing between records (one minute for a per-minute feed).

Example query (PostgreSQL, `bytea` column of i16 bins):

```sql
SELECT r.timestamp AS "Time", b.center_hz, b.span_hz,
       translate(encode(r.psd_raw, 'base64'), E'\n', '') AS psd
FROM psd_records r JOIN bands b USING (band)
WHERE r.band = $band
  AND r.timestamp > $__timeFrom()::timestamptz - interval '1 minute'
  AND r.timestamp <= $__timeTo()::timestamptz
ORDER BY r.timestamp
```

The `- interval '1 minute'` includes the record whose interval overlaps the
left edge of the time range. Set it to your record spacing.

### Long format

One row per (time, bin): a time column, a frequency column (Hz) and a value
column. The default names are `freq_hz` and `psd_db`; change them with the
options below.

## Options

| Option                        | Default              | Description                                                                                      |
| ----------------------------- | -------------------- | ------------------------------------------------------------------------------------------------ |
| Record field                  | `psd`                | Column holding the base64 i16 bins (record format)                                               |
| Frequency field / Value field | `freq_hz` / `psd_db` | Column names (long format)                                                                       |
| Color min / Color max         | empty                | Fixed colour range. When empty, the range runs from the 1st to the 99.9th percentile of the data |
| Normalize                     | Absolute             | `Absolute`: one shared scale. `Per time column`: each column scaled to its own range             |
| Pixel aggregation             | Max                  | How cells sharing a pixel are combined: `Max` or `Mean`                                          |
| Time axis                     | Dashboard range      | `Dashboard range`, or `Fit data` to fit the axis to the data's own extent                        |
| Colormap                      | Inferno              | Inferno, Viridis, Magma, Turbo, Gray                                                             |
| Show axes / Show legend       | on                   | Axis labels; colour bar                                                                          |
| Demo data when empty          | off                  | Draws built-in synthetic data when the query returns nothing (for testing)                       |

The colour bar and hover readout use **Standard options → Unit**, for example
`suffix: counts` or `dB`.
