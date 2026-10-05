import type { ColorToken } from '../tokens';

/*
 * Charts (ADR 0009). A screen describes a chart in AEGIS terms: categories, series, a tone for
 * each series. It never writes an ECharts option or a colour. This module turns that description
 * into the option, from the design tokens, so every chart in the application looks the same.
 *
 * Pure: the palette is passed in already resolved, so the option can be built and tested without
 * a browser.
 */

export type ChartTone = 'accent' | 'info' | 'warn' | 'critical' | 'neutral';

export interface ChartSeries {
  readonly name: string;
  readonly tone: ChartTone;
  /** One value for each category. `null` where there is nothing to show. */
  readonly values: readonly (number | null)[];
}

export interface ChartSpec {
  readonly kind: 'bar' | 'line';
  readonly categories: readonly string[];
  readonly series: readonly ChartSeries[];
  /** Bars are stacked on one another instead of standing side by side. */
  readonly stacked?: boolean;
  /** Categories run down the side: for a few named things, such as aircraft. */
  readonly horizontal?: boolean;
  /** Shown after values, for example `kg`. */
  readonly unit?: string;
  /** The top of the value axis, where it is fixed, for example 100 for a percentage. */
  readonly max?: number;
  /** The values are counts: the axis is marked in whole numbers only. */
  readonly counts?: boolean;
  readonly formatValue?: (value: number) => string;
}

/** The tokens a chart is drawn with. */
export const CHART_TOKENS = {
  accent: '--color-accent',
  info: '--color-info',
  warn: '--color-warn',
  critical: '--color-critical',
  neutral: '--color-ink-disabled',
  text: '--color-ink-muted',
  emphasis: '--color-ink',
  axis: '--color-line-strong',
  grid: '--color-line-subtle',
  tooltip: '--color-surface-raised',
  tooltipBorder: '--color-line-strong',
} as const satisfies Record<string, ColorToken>;

export type ChartPalette = Readonly<Record<keyof typeof CHART_TOKENS, string>>;

export interface ChartFonts {
  readonly sans: string;
  readonly mono: string;
}

/** Whether there is anything to draw: at least one value that is present and not zero. */
export function chartHasData(spec: ChartSpec): boolean {
  return spec.series.some((series) => series.values.some((value) => value !== null && value !== 0));
}

const plain = (value: number) => String(Math.round(value * 10) / 10);

/** The ECharts option for a chart. */
export function chartOption(
  spec: ChartSpec,
  palette: ChartPalette,
  fonts: ChartFonts,
): Record<string, unknown> {
  const format = spec.formatValue ?? plain;
  const withUnit = (value: number) => (spec.unit ? `${format(value)} ${spec.unit}` : format(value));
  const label = { color: palette.text, fontFamily: fonts.mono, fontSize: 11 };

  const categoryAxis = {
    type: 'category',
    data: [...spec.categories],
    axisLine: { lineStyle: { color: palette.axis } },
    axisTick: { show: false },
    axisLabel: { ...label, hideOverlap: true },
    // Named things read top to bottom in the order given.
    inverse: spec.horizontal === true,
  };
  const valueAxis = {
    type: 'value',
    min: 0,
    ...(spec.max !== undefined && { max: spec.max }),
    ...(spec.counts && { minInterval: 1 }),
    axisLine: { show: false },
    axisTick: { show: false },
    axisLabel: { ...label, hideOverlap: true, formatter: (value: number) => format(value) },
    splitLine: { lineStyle: { color: palette.grid } },
    splitNumber: 4,
  };

  return {
    // Nothing moves: a chart is a reading, and a reading that animates is harder to trust.
    animation: false,
    textStyle: { fontFamily: fonts.sans, color: palette.text },
    color: spec.series.map((series) => palette[series.tone]),
    grid: {
      left: 4,
      right: spec.horizontal ? 24 : 8,
      top: spec.series.length > 1 ? 30 : 10,
      bottom: 2,
      containLabel: true,
    },
    legend: {
      show: spec.series.length > 1,
      top: 0,
      left: 0,
      itemWidth: 10,
      itemHeight: 10,
      icon: 'rect',
      selectedMode: false,
      textStyle: { color: palette.text, fontFamily: fonts.sans, fontSize: 11 },
    },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: spec.kind === 'line' ? 'line' : 'shadow' },
      backgroundColor: palette.tooltip,
      borderColor: palette.tooltipBorder,
      borderWidth: 1,
      padding: [6, 8],
      textStyle: { color: palette.emphasis, fontFamily: fonts.sans, fontSize: 12 },
      valueFormatter: (value: unknown) => (typeof value === 'number' ? withUnit(value) : '—'),
      // Keep the tooltip inside the chart, so it never spills over a neighbouring panel.
      confine: true,
    },
    xAxis: spec.horizontal ? valueAxis : categoryAxis,
    yAxis: spec.horizontal ? categoryAxis : valueAxis,
    series: spec.series.map((series) => ({
      name: series.name,
      type: spec.kind,
      data: series.values.map((value) => value),
      ...(spec.stacked && { stack: 'total' }),
      ...(spec.kind === 'bar'
        ? { barMaxWidth: 22, emphasis: { disabled: true } }
        : {
            showSymbol: spec.categories.length <= 31,
            symbolSize: 4,
            lineStyle: { width: 1.5 },
            // A gap in the data is a gap in the line, never a line drawn through nothing.
            connectNulls: false,
          }),
    })),
  };
}
