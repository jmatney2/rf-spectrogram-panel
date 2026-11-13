# PSD records: PostgreSQL storage and queries

## Record shape

Each capture record has three properties: **band** (1..N), **PSD bytes**
(n × i16, little-endian) and **timestamp**. Typically there is one record per
band per minute.

The n values are **frequency bins** spanning the band (one spectrum per
record), in fftshifted order: bin 0 is the lowest frequency. Bin k sits at
`center_hz + (k/n − 0.5) · span_hz`.

The band plan lives in the `bands` table and is set by the `--centers` and
`--span` flags of `load_psd.py` and `gen_records.py`. The default is 4 bands
at −15, −5, +5 and +15 MHz, each 10 MHz wide. Set it to match your receiver.
Values are stored and shown as raw i16 **counts**; to show physical units,
set the panel's Standard options › Unit, or scale the values in the query.

## Schema (`schema.sql`)

| Object                                                                    | Purpose                             |
| ------------------------------------------------------------------------- | ----------------------------------- |
| `bands(band, name, center_hz, span_hz)`                                   | Band plan                           |
| `psd_records(band, timestamp, n_bins, psd_raw bytea, psd_i16 smallint[])` | One row per record, stored verbatim |
| view `psd_bins(band, timestamp, bin, freq_hz, value)`                     | One row per bin, for inspection     |

## Load data

The `psd` service (`docker-compose.psd.yaml`, included by both compose
files) creates the schema automatically the first time it starts with an
empty volume. Grafana reaches it as `psd:5432`; from the host, use
`localhost:3125` (user, password and database are all `psd`).

### Live synthetic feed (default dev setup)

The `psd-feed` service runs
`tools/gen_records.py --follow`. It backfills the last 3 days, then publishes
one record per band at the end of every minute, the way a real capture
feed would. The backfill runs newest-first, so recent hours are available
within seconds. Each minute's records depend only on
(seed, minute), and loads skip existing (band, timestamp) rows, so restarts
are safe.

```bash
docker logs -f psd-feed                                   # "... records published"
docker compose -f docker-compose.dev.yaml stop psd-feed   # before loading your own data
```

### Record files (your own data, or a static synthetic set)

```bash
docker exec -i psd-db psql -q -U psd -d psd < db/schema.sql      # (re)create tables (auto on first start)
python3 tools/gen_records.py --days 3 data/records.ndjson        # optional synthetic file
# add --centers/--span to set the band plan, --reset to replace existing records
python3 db/load_psd.py data/records.ndjson \
  | docker exec -i psd-db psql -q -v ON_ERROR_STOP=1 -U psd -d psd
```

`load_psd.py` accepts a JSON array or ndjson. Each record takes its PSD as
`psd` (a list of ints), `psd_hex` or `psd_b64`. The timestamp is either epoch
ms or ISO-8601. Duplicates are skipped; `--reset` truncates first.

## Inspect

```bash
docker exec -it psd-db psql -U psd -d psd     # or from the host: localhost:3125
```

```sql
SELECT band, count(*), min(timestamp), max(timestamp) FROM psd_records GROUP BY 1 ORDER BY 1;
SELECT * FROM bands;
-- one spectrum, with frequencies
SELECT bin, freq_hz, value FROM psd_bins
WHERE band = 3 AND timestamp = (SELECT max(timestamp) FROM psd_records WHERE band = 3)
ORDER BY bin;
-- strongest bins in the last hour
SELECT band, timestamp, freq_hz, value FROM psd_bins
WHERE timestamp > now() - interval '1 hour' ORDER BY value DESC LIMIT 20;
```

## Panel query (`psd_query.py`)

Each panel returns **one row per record** (1440 rows per band per day at one record per minute); the
panel decodes the bins itself:

```sql
SELECT r.timestamp AS "Time", b.center_hz, b.span_hz,
       translate(encode(r.psd_raw, 'base64'), E'\n', '') AS psd
FROM psd_records r JOIN bands b USING (band)
WHERE r.band = $band
  AND r.timestamp > $__timeFrom()::timestamptz - interval '1 minute'  -- record covers [ts, ts+1min)
  AND r.timestamp <= $__timeTo()::timestamptz
ORDER BY r.timestamp
```

The dashboard repeats the panel over the `$band` variable
(`SELECT band AS __value, name AS __text FROM bands`).

Grafana gotchas:

- In the datasource provisioning, the database name must be in
  `jsonData.database`.
- The panel's datasource type must be `grafana-postgresql-datasource`.
