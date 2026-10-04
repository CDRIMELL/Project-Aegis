import { hazardsFrom, type PlanContext } from '@aegis/domain';
import { useMemo } from 'react';
import { useSimStore } from '../../state/sim-store';
import { useStable } from './useStable';

/** Estimates are refreshed for a new departure time this often, in ticks. */
const REFRESH_TICKS = 300;

/**
 * The world a plan would be flown in if it departed about now: the weather and the open events
 * (ADR 0021, ADR 0022). It is the same context the simulation checks a launch against.
 *
 * The departure time moves in five-minute steps rather than every second, because every change
 * re-flies the plan. A launch is always re-evaluated by the simulation at the exact tick.
 */
export function usePlanContext(): PlanContext | null {
  const weather = useStable(useSimStore((state) => state.view?.weather ?? null));
  const events = useStable(useSimStore((state) => state.view?.events.events ?? null));
  const tick = useSimStore((state) => {
    const now = state.view?.clock.tick ?? 0;
    return now - (now % REFRESH_TICKS);
  });
  return useMemo(
    () =>
      weather && events ? { weather, departureTick: tick, hazards: hazardsFrom(events) } : null,
    [weather, events, tick],
  );
}
