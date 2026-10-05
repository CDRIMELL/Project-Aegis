import { describe, expect, it } from 'vitest';
import {
  CHART_TOKENS,
  chartHasData,
  chartOption,
  type ChartPalette,
  type ChartSpec,
} from './option';

/** A stand-in palette: each token resolves to a value that names it. */
const PALETTE = Object.fromEntries(
  Object.keys(CHART_TOKENS).map((key) => [key, `resolved(${key})`]),
) as ChartPalette;
const FONTS = { sans: 'Sans', mono: 'Mono' };

const SPEC: ChartSpec = {
  kind: 'bar',
  categories: ['04 Oct', '05 Oct', '06 Oct'],
  series: [
    { name: 'Completed', tone: 'accent', values: [2, 0, 1] },
    { name: 'Failed', tone: 'critical', values: [0, 1, null] },
  ],
  stacked: true,
  unit: 'missions',
};

interface Built {
  color: string[];
  legend: { show: boolean };
  animation: boolean;
  xAxis: { type: string; data?: string[]; max?: number; inverse?: boolean };
  yAxis: { type: string; data?: string[]; max?: number; inverse?: boolean };
  tooltip: { valueFormatter: (value: unknown) => string };
  series: { name: string; type: string; data: (number | null)[]; stack?: string }[];
}
const build = (spec: ChartSpec) => chartOption(spec, PALETTE, FONTS) as unknown as Built;

describe('chart options', () => {
  it('keeps categories and series in the order given', () => {
    const option = build(SPEC);
    expect(option.xAxis.data).toEqual(['04 Oct', '05 Oct', '06 Oct']);
    expect(option.series.map((series) => series.name)).toEqual(['Completed', 'Failed']);
    expect(option.series[1]?.data).toEqual([0, 1, null]);
    expect(option.series.every((series) => series.stack === 'total')).toBe(true);
  });

  it('colours each series by its tone, from the tokens and nothing else', () => {
    const option = build(SPEC);
    expect(option.color).toEqual(['resolved(accent)', 'resolved(critical)']);
    // Every colour anywhere in the option came from the palette: no literal slipped in.
    const colours = JSON.stringify(option).match(
      /#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|oklch\([^)]*\)/gi,
    );
    expect(colours).toBeNull();
    expect(JSON.stringify(option)).toContain('resolved(grid)');
  });

  it('draws the same option from the same description', () => {
    expect(JSON.stringify(build(SPEC))).toBe(JSON.stringify(build({ ...SPEC })));
  });

  it('does not animate, and shows a legend only when there is more than one series', () => {
    expect(build(SPEC).animation).toBe(false);
    expect(build(SPEC).legend.show).toBe(true);
    const single = build({ ...SPEC, series: SPEC.series.slice(0, 1) });
    expect(single.legend.show).toBe(false);
  });

  it('turns the axes for a horizontal chart and reads it top to bottom', () => {
    const option = build({ ...SPEC, horizontal: true, max: 100 });
    expect(option.yAxis).toMatchObject({ type: 'category', inverse: true });
    expect(option.xAxis).toMatchObject({ type: 'value', max: 100 });
    expect(build(SPEC).yAxis.max).toBeUndefined();
  });

  it('formats values with the unit, and says when there is none', () => {
    const { valueFormatter } = build(SPEC).tooltip;
    expect(valueFormatter(2)).toBe('2 missions');
    expect(valueFormatter(null)).toBe('—');
    const kg = build({ ...SPEC, unit: 'kg', formatValue: (value) => value.toFixed(1) });
    expect(kg.tooltip.valueFormatter(1234.56)).toBe('1234.6 kg');
  });

  it('leaves a gap in a line where there is no value', () => {
    const line = chartOption({ ...SPEC, kind: 'line', stacked: false }, PALETTE, FONTS) as {
      series: { connectNulls: boolean; type: string }[];
    };
    expect(line.series.every((series) => series.type === 'line' && !series.connectNulls)).toBe(
      true,
    );
  });

  it('knows when there is nothing to draw', () => {
    expect(chartHasData(SPEC)).toBe(true);
    expect(chartHasData({ ...SPEC, series: [] })).toBe(false);
    expect(
      chartHasData({
        ...SPEC,
        categories: [],
        series: [{ name: 'Completed', tone: 'accent', values: [] }],
      }),
    ).toBe(false);
    expect(
      chartHasData({ ...SPEC, series: [{ name: 'None', tone: 'neutral', values: [0, null, 0] }] }),
    ).toBe(false);
  });
});
