import { create } from 'zustand';

/** Whether the reference data shipped with this build is in the database yet. */
export type ReferencePhase = 'checking' | 'installing' | 'ready' | 'failed';

interface ReferenceState {
  readonly phase: ReferencePhase;
  /** While installing: the dataset being loaded and how far through the pack it is. */
  readonly dataset: string | null;
  readonly step: number;
  readonly steps: number;
  /** Identity of the installed pack: the SHA-256 of its manifest. */
  readonly manifestSha256: string | null;
  /** True if this launch performed the install, false if the pack was already present. */
  readonly installedNow: boolean;
  readonly error: string | null;
}

export const useReferenceStore = create<ReferenceState>(() => ({
  phase: 'checking',
  dataset: null,
  step: 0,
  steps: 0,
  manifestSha256: null,
  installedNow: false,
  error: null,
}));
