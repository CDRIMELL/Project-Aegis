import { create } from 'zustand';
import type { PlanDraft } from '../fleet/plan-edit';

/*
 * The flight plan being drafted. One draft, edited from two places: the planning panel and the
 * map. Both change it through `editDraft`, and both render from it, so they cannot disagree.
 * A draft is UI state. It becomes simulation state only when it is launched.
 */

interface PlanState {
  /** The aircraft a flight is being planned for; `null` when the planner is closed. */
  readonly planningAircraftId: string | null;
  /** The mission whose route is being edited; `null` when planning a flight on its own. */
  readonly missionId: string | null;
  /** `null` until a destination has been chosen and a plan generated. */
  readonly draft: PlanDraft | null;
}

export const usePlanStore = create<PlanState>(() => ({
  planningAircraftId: null,
  missionId: null,
  draft: null,
}));

export function beginPlanning(aircraftId: string): void {
  usePlanStore.setState({ planningAircraftId: aircraftId, missionId: null, draft: null });
}

/**
 * Opens the planner on a mission's route. It is the same draft and the same editing as any other
 * flight plan; saving writes the route back to the mission instead of launching it.
 */
export function beginMissionPlanning(missionId: string, draft: PlanDraft): void {
  usePlanStore.setState({ planningAircraftId: draft.aircraftId, missionId, draft });
}

export function cancelPlanning(): void {
  usePlanStore.setState({ planningAircraftId: null, missionId: null, draft: null });
}

export function setDraft(draft: PlanDraft | null): void {
  usePlanStore.setState({ draft });
}

/** Applies an edit to the current draft, if there is one. */
export function editDraft(edit: (draft: PlanDraft) => PlanDraft): void {
  usePlanStore.setState((state) => (state.draft ? { draft: edit(state.draft) } : state));
}
