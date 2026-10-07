import { create } from 'zustand';

/*
 * Where the player is in this run of the application (ADR 0031): at the front (the menu, the
 * introduction, a briefing or a summary) or in command of the world. It is state of the window,
 * not of the simulation: nothing here is saved, and the application always opens at the front.
 */

export type SessionStage = 'front' | 'command';

/** A new career being made: what is happening, and how far along the slow part is. */
export interface CreationProgress {
  readonly step: string;
  /** 0 to 1 for the step that has a measure; `null` for those that do not. */
  readonly share: number | null;
}

interface SessionState {
  readonly stage: SessionStage;
  readonly creating: CreationProgress | null;
  /** Why the last attempt to start or continue did not succeed. */
  readonly error: string | null;
  /** The file the previous world was copied to before a new career replaced it. */
  readonly backupFile: string | null;
}

export const useSessionStore = create<SessionState>(() => ({
  stage: 'front',
  creating: null,
  error: null,
  backupFile: null,
}));

export function setSession(change: Partial<SessionState>): void {
  useSessionStore.setState(change);
}

/*
 * The application's own settings. Kept by the window, because they are about how this
 * installation behaves and are no part of any simulated world.
 */

const SETTINGS_KEY = 'aegis.settings.v1';

export interface AppSettings {
  /** Show the operational brief when returning to a command day already under way. */
  readonly briefOnResume: boolean;
}

const DEFAULT_SETTINGS: AppSettings = { briefOnResume: true };

function readSettings(): AppSettings {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null');
    if (typeof stored === 'object' && stored !== null) {
      const { briefOnResume } = stored as Partial<AppSettings>;
      return {
        briefOnResume:
          typeof briefOnResume === 'boolean' ? briefOnResume : DEFAULT_SETTINGS.briefOnResume,
      };
    }
  } catch {
    // Unreadable settings, or nowhere to keep them, are the defaults.
  }
  return DEFAULT_SETTINGS;
}

export const useSettingsStore = create<AppSettings>(() => readSettings());

export function changeSettings(change: Partial<AppSettings>): void {
  useSettingsStore.setState(change);
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(useSettingsStore.getState()));
  } catch {
    // The setting holds for this run even if it cannot be kept.
  }
}
