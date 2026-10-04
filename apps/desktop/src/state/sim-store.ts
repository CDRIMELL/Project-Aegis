import type { SimView } from '@aegis/sim';
import { create } from 'zustand';

/*
 * UI-side mirror of the simulation. The worker owns the truth; this store only holds the latest
 * view it published, for React to render. Nothing here may be written back into the simulation.
 */

export type SimPhase = 'starting' | 'ready' | 'failed';

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

export function simCommandRejected(message: string): void {
  useSimStore.setState({ rejection: message });
}

export function simFailed(message: string): void {
  useSimStore.setState({ phase: 'failed', failure: message });
}
