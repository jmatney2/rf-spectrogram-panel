#!/usr/bin/env python3
"""Synthetic PSD capture records, for development and testing.

Each record = (band, PSD bytes, timestamp):
    {"band": 2, "timestamp": 1731500000000, "psd_b64": "<n x i16 LE, base64>"}
One record per band per minute (timestamp = start of the minute, UTC).
Bins are fftshifted: bin k sits at center + (k/n - 0.5) * span.

The band plan is a parameter (--centers, --span, --bins). The scene is a pure
function of (seed, band plan, minute), so a backfill and a live feed produce
identical records for the same minute. Which band hosts which signal is
chosen from the seed:
    * noise floor with slow diurnal drift; receiver-filter roll-off at band edges
    * a persistent wideband carrier whose level follows time of day, with a
      30-minute daily outage
    * intermittent wideband sessions (20-50 min) on random bands
    * a narrow periodic beacon, 1 minute in every 10
    * a fixed CW spur and a CW spur that drifts with the diurnal cycle
    * occasional 1-4 minute broadband interference
    * ~0.3% of records dropped (capture gaps)

Values are i16 counts (here counts = 100 * dB relative to an arbitrary
reference; real captures may scale differently, and nothing downstream
assumes this).

Usage:
    # write a file (ndjson) covering the last N days
    python3 tools/gen_records.py --days 3 OUT.ndjson
    # live: backfill the last N days into Postgres, then append each minute
    python3 tools/gen_records.py --follow --days 3 [--psql 'psql -h psd -U psd -d psd']
"""

import argparse
import base64
import io
import json
import shlex
import subprocess
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'db'))
from load_psd import DEFAULT_CENTERS, DEFAULT_SPAN, write_sql  # noqa: E402

MINUTE_MS = 60_000
BLOCK_MIN = 360  # sessions are scheduled per 6-hour block
INTERF_BLOCK_MIN = 720


def lin(db):
    return 10.0 ** (db / 10.0)


class Scene:
    def __init__(self, seed, n_bands, span, n_bins):
        self.seed = seed
        self.n_bands = n_bands
        self.n_bins = n_bins
        self.off = (np.arange(n_bins) / n_bins - 0.5) * span  # Hz from band center
        # Receiver filter: flat over the middle 62% of the span, raised-cosine
        # roll-off to -18 dB at the edges.
        pass_half = 0.31 * span
        edge = np.clip((np.abs(self.off) - pass_half) / (span / 2 - pass_half), 0, 1)
        self.filt_db = -18.0 * (1 - np.cos(np.pi * edge)) / 2

        rng = np.random.default_rng([seed, 99])
        bands = rng.permutation(n_bands)
        pick = lambda i: int(bands[i % n_bands])  # noqa: E731
        self.carrier_band = pick(0)
        self.beacon_band = pick(1)
        self.spur_band = pick(1)
        self.drift_band = pick(2)
        self.interf_band = pick(3)
        self.floor_db = list(-100.0 + rng.uniform(-1.5, 1.5, n_bands))
        self.beacon_off = float(rng.uniform(0.1, 0.2) * span * rng.choice([-1, 1]))
        self.spur_bin = n_bins // 2 + int(rng.integers(n_bins // 20, n_bins // 8))
        self.drift_bin = n_bins // 2 - int(rng.integers(n_bins // 10, n_bins // 6))

        self.carrier = self.occupied(0.0, 0.58 * span, 0.01 * span)
        self.session = {k: self.occupied(k * 0.1 * span, 0.58 * span, 0.02 * span) for k in (-1, 0, 1)}
        self.beacon = self.occupied(self.beacon_off, 0.13 * span, 0.01 * span)
        self.interf = self.occupied(0.0, 0.78 * span, 0.065 * span)

    def occupied(self, center, bw, rolloff):
        """Flat-top occupied spectrum with soft edges, linear 0..1."""
        d = np.abs(self.off - center) - bw / 2
        return np.where(d <= 0, 1.0, np.exp(-0.5 * (d / rolloff) ** 2))

    def block_sessions(self, block):
        rng = np.random.default_rng([self.seed, 1, block])
        return [(int(rng.integers(0, self.n_bands)), block * BLOCK_MIN + int(rng.integers(0, BLOCK_MIN)),
                 int(rng.integers(20, 51)), int(rng.integers(-1, 2)), float(rng.uniform(4, 10)))
                for _ in range(int(rng.integers(0, 3)))]

    def block_interference(self, block):
        rng = np.random.default_rng([self.seed, 2, block])
        return block * INTERF_BLOCK_MIN + int(rng.integers(0, INTERF_BLOCK_MIN)), int(rng.integers(1, 5))

    def minute_records(self, m):
        """Records for absolute minute m (= epoch_ms // 60000)."""
        n = self.n_bins
        hour = (m % 1440) / 60.0
        diurnal = np.cos((hour - 15.0) / 24.0 * 2 * np.pi)
        blk = m // BLOCK_MIN
        sessions = self.block_sessions(blk) + self.block_sessions(blk - 1)
        i0, idur = self.block_interference(m // INTERF_BLOCK_MIN)
        recs = []
        for b in range(self.n_bands):
            rng = np.random.default_rng([self.seed, 0, m, b])
            if rng.random() < 0.003:
                continue  # capture gap
            nf = self.floor_db[b] + 1.2 * diurnal
            p = np.full(n, lin(nf))
            if b == self.carrier_band and not (2.0 <= hour < 2.5):
                load = 0.5 + 0.5 * np.clip(np.sin((hour - 6) / 24 * 2 * np.pi) + 0.3, 0, 1)
                p += lin(nf + 8 + 12 * load + rng.normal(0, 0.7)) * self.carrier
            for (sb, s0, dur, k, lvl) in sessions:
                if sb == b and s0 <= m < s0 + dur:
                    p += lin(nf + lvl + rng.normal(0, 1.5)) * self.session[k]
            if b == self.beacon_band and m % 10 == 3:
                p += lin(nf + 9) * self.beacon
            if b == self.spur_band:
                p[self.spur_bin] += lin(nf + 25)
            if b == self.drift_band:
                k = self.drift_bin + int(round(0.02 * n * diurnal))
                p[k] += lin(nf + 20)
                p[k - 1:k + 2] += lin(nf + 8)
            if b == self.interf_band and i0 <= m < i0 + idur:
                p += lin(nf + 15 + rng.normal(0, 1)) * self.interf
            db = 10 * np.log10(p) + self.filt_db + rng.normal(0, 0.4, n)  # ~0.4 dB estimator noise
            i16 = np.clip(np.round(db * 100), -32768, 32767).astype('<i2')
            recs.append({'band': b + 1, 'timestamp': m * MINUTE_MS,
                         'psd_b64': base64.b64encode(i16.tobytes()).decode()})
        return recs


def main():
    p = argparse.ArgumentParser()
    p.add_argument('out', nargs='?', help='ndjson output file (file mode)')
    p.add_argument('--days', type=float, default=3)
    p.add_argument('--seed', type=int, default=1)
    p.add_argument('--centers', default=DEFAULT_CENTERS, help='band center Hz, comma-separated')
    p.add_argument('--span', type=float, default=DEFAULT_SPAN, help='Hz covered by each record')
    p.add_argument('--bins', type=int, default=1024)
    p.add_argument('--follow', action='store_true',
                   help='backfill --days into Postgres, then append each minute forever')
    p.add_argument('--psql', default='docker exec -i psd-db psql -U psd -d psd',
                   help='psql command used by --follow')
    a = p.parse_args()

    n_bands = len(a.centers.split(','))
    scene = Scene(a.seed, n_bands, a.span, a.bins)
    now_m = int(time.time() * 1000) // MINUTE_MS  # current (incomplete) minute
    first = now_m - int(a.days * 1440)

    if not a.follow:
        if not a.out:
            p.error('give an output file, or --follow')
        n = 0
        with open(a.out, 'w') as f:
            for m in range(first, now_m):
                for r in scene.minute_records(m):
                    f.write(json.dumps(r) + '\n')
                    n += 1
        print(f'wrote {n} records ({now_m - first} minutes x {n_bands} bands) to {a.out}')
        return

    def load(records):
        buf = io.StringIO()
        write_sql(buf, records, a.centers, a.span)
        subprocess.run(shlex.split(a.psql) + ['-q', '-v', 'ON_ERROR_STOP=1'],
                       input=buf.getvalue(), text=True, check=True)

    # Live mode. Backfill newest-first (recent data is usable within seconds),
    # then publish minute m once it has ended.
    for end in range(now_m, first, -720):
        load([r for m in range(max(first, end - 720), end) for r in scene.minute_records(m)])
    print(f'backfilled {now_m - first} minutes; following', flush=True)
    m = now_m
    while True:
        time.sleep(max(0.0, (m + 1) * MINUTE_MS / 1000 + 1 - time.time()))
        load(scene.minute_records(m))
        print(time.strftime('%H:%M:%S', time.gmtime(m * 60)), 'UTC records published', flush=True)
        m += 1


if __name__ == '__main__':
    main()
