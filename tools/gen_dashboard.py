#!/usr/bin/env python3
"""Regenerate provisioning/dashboards/dashboard.json for the spectrogram panel.

Panels:
  3. "$band"  - repeated once per band ($band variable), Postgres record-format
                query (db/psd_query.py): 1 row per record, bins decoded in panel.
  Collapsed "Dev / test panels" row:
  1. synthetic fallback  - no data + demoWhenEmpty -> built-in demo data + badge
"""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent  # the plugin repo root
OUT = ROOT / 'provisioning' / 'dashboards' / 'dashboard.json'

TESTDATA_UID = 'trlxrdZVk'
PG_UID = 'psd-pg'
DS_TYPE_TESTDATA = 'grafana-testdata-datasource'
# The bundled Postgres datasource's type id (NOT the bare "postgres").
DS_TYPE_PG = 'grafana-postgresql-datasource'

sys.path.insert(0, str(ROOT / 'db'))
from psd_query import BAND_VARIABLE_SQL, build_query  # noqa: E402


def main() -> None:
    base_options = {
        'recordField': 'psd',
        'freqField': 'freq_hz',
        'valueField': 'psd_db',
        'dbMin': '',
        'dbMax': '',
        'normalize': 'absolute',
        'aggregate': 'max',
        'timeAxis': 'dashboard',
        'colormap': 'inferno',
        'showAxes': True,
        'showLegend': True,
        'demoWhenEmpty': False,
    }

    def panel(pid, title, grid, ds, target, options, unit, **extra):
        return {
            'datasource': ds,
            'gridPos': grid,
            'id': pid,
            'options': {**base_options, **options},
            'fieldConfig': {'defaults': {'unit': unit}, 'overrides': []},
            'targets': [target],
            'title': title,
            'type': 'rf-spectrogram-panel',
            **extra,
        }

    testdata = {'type': DS_TYPE_TESTDATA, 'uid': TESTDATA_UID}
    pg = {'type': DS_TYPE_PG, 'uid': PG_UID}

    panels = [
        # One spectrogram per band (repeated over the $band variable), fed by
        # the record-format query: 1 row per record, bins decoded in the panel.
        panel(
            3,
            '$band',
            {'h': 10, 'w': 24, 'x': 0, 'y': 0},
            pg,
            {'datasource': pg, 'refId': 'A', 'format': 'table',
             'rawQuery': True, 'editorMode': 'code', 'rawSql': build_query('$band')},
            {},
            'suffix: counts',
            repeat='band',
            repeatDirection='v',
            maxPerRow=1,
        ),
        {
            'collapsed': True,
            'gridPos': {'h': 1, 'w': 24, 'x': 0, 'y': 40},
            'id': 10,
            'title': 'Dev / test panels',
            'type': 'row',
            'panels': [
                panel(
                    1,
                    'PSD - synthetic fallback (no data)',
                    {'h': 10, 'w': 12, 'x': 0, 'y': 41},
                    testdata,
                    {'datasource': testdata, 'refId': 'A', 'scenarioId': 'no_data_points'},
                    {'demoWhenEmpty': True, 'timeAxis': 'data'},
                    'dB',
                ),
            ],
        },
    ]

    band_var = {
        'name': 'band',
        'label': 'Band',
        'type': 'query',
        'datasource': pg,
        'query': BAND_VARIABLE_SQL,
        'definition': BAND_VARIABLE_SQL,
        'refresh': 1,
        'multi': True,
        'includeAll': True,
        'current': {'selected': True, 'text': ['All'], 'value': ['$__all']},
        'options': [],
        'sort': 0,
    }

    dashboard = {
        'annotations': {
            'list': [
                {'builtIn': 1, 'datasource': {'type': 'grafana', 'uid': '-- Grafana --'},
                 'enable': True, 'hide': True, 'iconColor': 'rgba(211, 211, 211, 1)',
                 'name': 'Annotations & Alerts', 'type': 'dashboard'}
            ]
        },
        'editable': True,
        'fiscalYearStartMonth': 0,
        'graphTooltip': 0,
        'id': 1,
        'links': [],
        'liveNow': False,
        'panels': panels,
        'refresh': '1m',
        'schemaVersion': 39,
        'tags': ['spectrogram'],
        'templating': {'list': [band_var]},
        'time': {'from': 'now-24h', 'to': 'now'},
        'timepicker': {},
        'timezone': '',
        'title': 'Provisioned spectrogram dashboard',
        'uid': 'rf-spectrogram',
        'version': 3,
        'weekStart': '',
    }

    OUT.write_text(json.dumps(dashboard, indent=2) + '\n')
    print(f'wrote {OUT} ({OUT.stat().st_size / 1024:.0f} KB)')


if __name__ == '__main__':
    main()
