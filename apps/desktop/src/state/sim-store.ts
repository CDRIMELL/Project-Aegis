import type { SimView } from '@aegis/sim';
import { create } from 'zustand';

/*
 * UI-side mirror of the simulation. The worker owns the truth; this store only holds the latest
 * view it published, for React to render. Nothing here may be written back into the simulation.
 */

/**
 * - `starting`: the worker has not yet said what the database holds.
 * - `empty`: there is no saved world. One is created only when the player asks (ADR 0031).
 * - `ready`: a world is open.
 * - `failed`: the simulation cannot continue.
 */
export type SimPhase = 'starting' | 'empty' | 'ready' | 'failed';

interface SimState {
  readonly phase: SimPhase;
  /** Latest state published by the worker. Kept after a failure so the last known state shows. */
  readonly view: SimView | null;
  /** Why the simulation stopped, when `phase` is `failed`. */
  readonly failure: string | null;
  /** Why the most recent command was refused; cleared by the next state update. */
  readonly rejection: string | null;
}

export const useSimStore = create<SimState>(() => ({
  phase: 'starting',
  view: null,
  failure: null,
  rejection: null,
}));

export function simViewReceived(view: SimView): void {
  useSimStore.setState((state) =>
    state.phase === 'failed' ? { view } : { view, phase: 'ready', rejection: null },
  );
}

/** The worker found no saved world. */
export function simWorldAbsent(): void {
  useSimStore.setState((state) =>
    state.phase === 'failed' ? {} : { view: null, phase: 'empty', rejection: null },
  );
}

/** A new world has been asked for: what is shown of the old one is put away until it arrives. */
export function simWorldReplacing(): void {
  useSimStore.setState((state) =>
    state.phase === 'failed' ? {} : { view: null, phase: 'starting', rejection: null },
  );
}

export function simCommandRejected(message: string): void {
  useSimStore.setState({ rejection: message });
}

export function simFailed(message: string): void {
  useSimStore.setState({ phase: 'failed', failure: message });
}

/*
 * Stable empty values for selectors. A selector must return the same reference while the store is
 * unchanged: one that builds a new array each time (`?? []`, `.map(...)`) makes React re-render
 * without end. Select the stored value, or one of these, and derive anything else in `useMemo`.
 */
export const NO_AIRCRAFT: SimView['fleet']['aircraft'] = [];
export const NO_FLIGHTS: SimView['fleet']['recentFlights'] = [];
