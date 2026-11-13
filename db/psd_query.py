#!/usr/bin/env python3
"""The SQL the spectrogram panel runs against the PSD database.

One row per record (NOT per bin), so a day of 1-minute records is 1440 rows:
    Time       record timestamp            -> x axis
    center_hz  band center                 -> with span_hz, gives each bin's Hz
    span_hz    span of the record's bins
    psd        the record's i16 LE bytes, base64 (the panel decodes it)

The panel decodes `psd` into n bins at  center_hz + (k/n - 0.5) * span_hz.
`$band` is the dashboard variable (one repeated panel per band);
The time bounds select every record whose minute overlaps the dashboard range.

    python3 db/psd_query.py            # print the panel SQL
"""


def build_query(band_expr: str = '$band') -> str:
    return f"""SELECT
  r.timestamp AS "Time",
  b.center_hz,
  b.span_hz,
  translate(encode(r.psd_raw, 'base64'), E'\\n', '') AS psd
FROM psd_records r
JOIN bands b USING (band)
WHERE r.band = {band_expr}
  -- a record covers [timestamp, timestamp + 1 min): include the one that
  -- straddles the left edge of the range
  AND r.timestamp > $__timeFrom()::timestamptz - interval '1 minute'
  AND r.timestamp <= $__timeTo()::timestamptz
ORDER BY r.timestamp"""


BAND_VARIABLE_SQL = 'SELECT band AS __value, name AS __text FROM bands ORDER BY band'


if __name__ == '__main__':
    print(build_query())
