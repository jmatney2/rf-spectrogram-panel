import { PanelPlugin, type SelectFieldConfigSettings } from '@grafana/data';
import { AggregateMode, ColormapId, NormalizeMode, SpectrogramOptions, TimeAxisMode, defaultOptions } from './types';
import { SpectrogramPanel } from './components/SpectrogramPanel';

export const plugin = new PanelPlugin<SpectrogramOptions>(SpectrogramPanel)
  .setPanelOptions((builder) => {
    return builder
      .addTextInput({
        path: 'recordField',
        name: 'Record field',
        description: "Column with each record's PSD bins (base64 i16 LE). Needs center_hz/span_hz columns for Hz.",
        defaultValue: defaultOptions.recordField,
      })
      .addTextInput({
        path: 'freqField',
        name: 'Frequency field',
        description: 'Long format only: column with the bin frequency, in Hz',
        defaultValue: defaultOptions.freqField,
      })
      .addTextInput({
        path: 'valueField',
        name: 'Value field',
        description: 'Long format only: column with the PSD value',
        defaultValue: defaultOptions.valueField,
      })
      .addTextInput({
        path: 'dbMin',
        name: 'Color min',
        description: 'Color scale floor. Empty = auto',
        defaultValue: defaultOptions.dbMin,
      })
      .addTextInput({
        path: 'dbMax',
        name: 'Color max',
        description: 'Color scale ceiling. Empty = auto',
        defaultValue: defaultOptions.dbMax,
      })
      .addRadio<NormalizeMode, SelectFieldConfigSettings<NormalizeMode>>({
        path: 'normalize',
        name: 'Normalize',
        description: 'One shared scale, or each time column scaled to its own range',
        defaultValue: defaultOptions.normalize,
        settings: {
          options: [
            { value: 'absolute', label: 'Absolute' },
            { value: 'peak', label: 'Per time column' },
          ],
        },
      })
      .addRadio<AggregateMode, SelectFieldConfigSettings<AggregateMode>>({
        path: 'aggregate',
        name: 'Pixel aggregation',
        description: 'When several records/bins share a pixel: max-hold (shows short bursts) or mean',
        defaultValue: defaultOptions.aggregate,
        settings: {
          options: [
            { value: 'max', label: 'Max' },
            { value: 'mean', label: 'Mean' },
          ],
        },
      })
      .addRadio<TimeAxisMode, SelectFieldConfigSettings<TimeAxisMode>>({
        path: 'timeAxis',
        name: 'Time axis',
        defaultValue: defaultOptions.timeAxis,
        settings: {
          options: [
            { value: 'dashboard', label: 'Dashboard range' },
            { value: 'data', label: 'Fit data' },
          ],
        },
      })
      .addRadio<ColormapId, SelectFieldConfigSettings<ColormapId>>({
        path: 'colormap',
        name: 'Colormap',
        defaultValue: defaultOptions.colormap,
        settings: {
          options: [
            { value: 'inferno', label: 'Inferno' },
            { value: 'viridis', label: 'Viridis' },
            { value: 'magma', label: 'Magma' },
            { value: 'turbo', label: 'Turbo' },
            { value: 'gray', label: 'Gray' },
          ],
        },
      })
      .addBooleanSwitch({
        path: 'showAxes',
        name: 'Show axes',
        defaultValue: defaultOptions.showAxes,
      })
      .addBooleanSwitch({
        path: 'showLegend',
        name: 'Show legend',
        description: 'Color bar on the right (uses the Standard options unit)',
        defaultValue: defaultOptions.showLegend,
      })
      .addBooleanSwitch({
        path: 'demoWhenEmpty',
        name: 'Demo data when empty',
        description: 'Show built-in synthetic data if the query returns nothing',
        defaultValue: defaultOptions.demoWhenEmpty,
      });
  })
  .useFieldConfig();
