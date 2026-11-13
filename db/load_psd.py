#!/usr/bin/env python3
"""Turn PSD capture records into a psql load script (no psycopg2 needed).

Input: JSON array or ndjson of records, each
    {"band": <int>, "timestamp": <ms epoch | ISO-8601>, <psd>}
where <psd> is one of
    "psd":     [i16, ...]
    "psd_hex": "<little-endian i16 bytes, hex>"
    "psd_b64": "<little-endian i16 bytes, base64>"

Output (stdout): SQL that upserts the band table (the band plan given by
--centers/--span) and loads the records. Loading is idempotent: records whose
(band, timestamp) already exist are skipped. Pipe it into psql:

    python3 db/load_psd.py records.ndjson \
        | docker exec -i psd-db psql -q -v ON_ERROR_STOP=1 -U psd -d psd

Flags:
    --reset            truncate psd_records first
    --centers a,b,...  band center Hz, band 1 first (default -15e6,-5e6,5e6,15e6)
    --span HZ          span covered by a record's bins (default 10e6)
"""

import argparse
import base64
import json
import struct
import sys
from datetime import datetime, timezone

DEFAULT_CENTERS = '-15e6,-5e6,5e6,15e6'
DEFAULT_SPAN = 10e6


def iter_records(path):
    with open(path) as f:
        head = f.read(1)
        f.seek(0)
        if head == '[':
            yield from json.load(f)
        else:
            for line in f:
                if line.strip():
                    yield json.loads(line)


def record_bytes(r):
    if 'psd_b64' in r:
        return base64.b64decode(r['psd_b64'])
    if 'psd_hex' in r:
        return bytes.fromhex(r['psd_hex'])
    vals = [int(x) for x in r['psd']]
    return struct.pack('<%dh' % len(vals), *vals)


def to_ts(v):
    if isinstance(v, (int, float)):
        return datetime.fromtimestamp(v / 1000.0, tz=timezone.utc)
    return datetime.fromisoformat(str(v).replace('Z', '+00:00'))


def write_sql(out, records, centers=DEFAULT_CENTERS, span=DEFAULT_SPAN, reset=False):
    """Write the load script for `records` to `out`; returns the record count."""
    out.write('BEGIN;\n')
    for i, c in enumerate(float(x) for x in centers.split(',')):
        out.write(
            f"INSERT INTO bands(band, name, center_hz, span_hz) VALUES "
            f"({i + 1}, 'Band {i + 1} ({c / 1e6:+g} MHz)', {c!r}, {span!r}) "
            f"ON CONFLICT (band) DO UPDATE SET name = EXCLUDED.name, "
            f"center_hz = EXCLUDED.center_hz, span_hz = EXCLUDED.span_hz;\n")
    if reset:
        out.write('TRUNCATE psd_records;\n')
    out.write('CREATE TEMP TABLE psd_load (LIKE psd_records) ON COMMIT DROP;\n')
    out.write('COPY psd_load(band, timestamp, n_bins, psd_raw, psd_i16) FROM STDIN;\n')
    n = 0
    for r in records:
        raw = record_bytes(r)
        vals = struct.unpack('<%dh' % (len(raw) // 2), raw)
        out.write('%d\t%s\t%d\t\\\\x%s\t{%s}\n' % (
            int(r['band']), to_ts(r['timestamp']).isoformat(), len(vals),
            raw.hex(), ','.join(map(str, vals))))
        n += 1
    out.write('\\.\n')
    out.write('INSERT INTO psd_records SELECT * FROM psd_load ON CONFLICT (band, timestamp) DO NOTHING;\n')
    out.write('COMMIT;\n')
    return n


def main():
    p = argparse.ArgumentParser()
    p.add_argument('records')
    p.add_argument('--reset', action='store_true')
    p.add_argument('--centers', default=DEFAULT_CENTERS)
    p.add_argument('--span', type=float, default=DEFAULT_SPAN)
    a = p.parse_args()
    n = write_sql(sys.stdout, iter_records(a.records), a.centers, a.span, a.reset)
    print(f'prepared {n} records', file=sys.stderr)


if __name__ == '__main__':
    main()
