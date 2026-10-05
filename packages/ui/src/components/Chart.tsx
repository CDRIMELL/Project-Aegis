import { BarChart, LineChart } from 'echarts/charts';
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components';
import { init, use as register, type EChartsType } from 'echarts/core';
import { SVGRenderer } from 'echarts/renderers';
import { useEffect, useRef } from 'react';
import {
  CHART_TOKENS,
  chartHasData,
  chartOption,
  type ChartFonts,
  type ChartPalette,
  type ChartSpec,
} from '../charts/option';
import { resolveColorTokens } from '../tokens';

// Only what the application's charts use is registered, so only that is bundled.
register([BarChart, LineChart, GridComponent, LegendComponent, TooltipComponent, SVGRenderer]);

let palette: ChartPalette | null = null;
let fonts: ChartFonts | null = null;

function theme(): { palette: ChartPalette; fonts: ChartFonts } {
  palette ??= resolveColorTokens(CHART_TOKENS);
  if (!fonts) {
    const style = getComputedStyle(document.documentElement);
    fonts = {
      sans: style.getPropertyValue('--font-sans').trim(),
      mono: style.getPropertyValue('--font-mono').trim(),
    };
  }
  return { palette, fonts };
}

export interface ChartProps extends ChartSpec {
  /** What the chart shows, for assistive technology. The figures are also in a table nearby. */
  readonly label: string;
  /** Height in pixels. */
  readonly height?: number;
  /** Shown instead of the chart when there is nothing to draw. */
  readonly empty?: string;
  /** Called with the index of the category that was clicked. */
  readonly onSelect?: (index: number) => void;
}

/**
 * A bar or line chart drawn from the design tokens. Give it stable `categories` and `series`
 * (memoised): it redraws when they change.
 */
export function Chart({
  label,
  height = 180,
  empty = 'Nothing to show for this period.',
  onSelect,
  ...spec
}: ChartProps) {
  const host = useRef<HTMLDivElement>(null);
  const chart = useRef<EChartsType | null>(null);
  const select = useRef(onSelect);
  select.current = onSelect;
  const drawn = chartHasData(spec);

  useEffect(() => {
    if (!drawn || !host.current) return;
    const instance = init(host.current, null, { renderer: 'svg' });
    chart.current = instance;
    instance.on('click', (event) => {
      if (typeof event.dataIndex === 'number') select.current?.(event.dataIndex);
    });
    const observer = new ResizeObserver(() => {
      instance.resize();
    });
    observer.observe(host.current);
    return () => {
      observer.disconnect();
      instance.dispose();
      chart.current = null;
    };
  }, [drawn]);

  const { kind, categories, series, stacked, horizontal, unit, max, counts, formatValue } = spec;
  useEffect(() => {
    if (!chart.current) return;
    const { palette: colours, fonts: faces } = theme();
    chart.current.setOption(
      chartOption(
        {
          kind,
          categories,
          series,
          ...(stacked !== undefined && { stacked }),
          ...(horizontal !== undefined && { horizontal }),
          ...(unit !== undefined && { unit }),
          ...(max !== undefined && { max }),
          ...(counts !== undefined && { counts }),
          ...(formatValue !== undefined && { formatValue }),
        },
        colours,
        faces,
      ),
      { notMerge: true },
    );
  }, [drawn, kind, categories, series, stacked, horizontal, unit, max, counts, formatValue]);

  if (!drawn) {
    return (
      <div
        className="flex items-center justify-center rounded-md border border-dashed border-line text-xs text-ink-muted"
        style={{ height }}
        role="img"
        aria-label={`${label}: ${empty}`}
      >
        {empty}
      </div>
    );
  }
  return (
    <div
      ref={host}
      role="img"
      aria-label={label}
      className={onSelect ? 'cursor-pointer' : undefined}
      style={{ height }}
    />
  );
}
