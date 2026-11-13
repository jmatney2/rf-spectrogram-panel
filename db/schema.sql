-- PSD capture schema for the spectrogram panel.
--
-- Capture record: band number, PSD bytes, timestamp.
--   * N bands, described in `bands` (center + span).
--   * Typically one record per band per minute.
--   * PSD = n i16 little-endian values = n FREQUENCY BINS spanning the band
--     (fftshifted: bin 0 = lowest frequency, bin n/2 = band center).
--
-- Bin k of a record sits at  center_hz + (k / n_bins - 0.5) * span_hz.
-- The i16 -> physical-unit scaling is capture-specific, so values are stored
-- and plotted as raw counts.

DROP VIEW  IF EXISTS psd_bins;
DROP TABLE IF EXISTS psd_records;
DROP TABLE IF EXISTS bands;

CREATE TABLE bands (
    band       int PRIMARY KEY,
    name       text NOT NULL,
    center_hz  double precision NOT NULL,  -- band center, Hz
    span_hz    double precision NOT NULL   -- frequency span covered by the n bins
);

-- One row per (band, timestamp): the record verbatim.
CREATE TABLE psd_records (
    band       int NOT NULL REFERENCES bands(band),
    timestamp  timestamptz NOT NULL,
    n_bins     int NOT NULL,
    psd_raw    bytea NOT NULL,             -- original little-endian i16 bytes
    psd_i16    smallint[] NOT NULL,        -- same values, decoded (for SQL)
    PRIMARY KEY (band, timestamp)
);
CREATE INDEX psd_records_ts_idx ON psd_records (timestamp);

-- Inspection view: one row per (record, bin) with its frequency.
--   SELECT * FROM psd_bins WHERE band = 2 AND timestamp = '...' ORDER BY bin;
CREATE VIEW psd_bins AS
SELECT r.band,
       r.timestamp,
       g.k - 1                                                       AS bin,
       b.center_hz + ((g.k - 1)::double precision / r.n_bins - 0.5) * b.span_hz AS freq_hz,
       g.v                                                           AS value
FROM psd_records r
JOIN bands b USING (band)
CROSS JOIN LATERAL unnest(r.psd_i16) WITH ORDINALITY AS g(v, k);
