import { ensureFile } from 'https://deno.land/std@0.192.0/fs/mod.ts';

import { environment } from './configuration.ts';
import { type Phase, type State, stateSchema } from './schemas.ts';

const statePath = (): string => {
  const { HOME } = environment();
  return `${HOME}/.bootstrap/state.json`;
};

const emptyState = (): State => ({ phases: [] });

export const loadState = async (): Promise<State> => {
  const path = statePath();

  try {
    const raw = await Deno.readTextFile(path);
    return stateSchema.parse(JSON.parse(raw));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return emptyState();
    }

    console.warn(
      `Could not parse state file at ${path}; starting fresh:`,
      error,
    );
    return emptyState();
  }
};

const writeState = async (state: State): Promise<void> => {
  const path = statePath();
  await ensureFile(path);
  await Deno.writeTextFile(path, JSON.stringify(state, null, 2));
};

export const hasPhase = (state: State, phase: Phase): boolean =>
  state.phases.includes(phase);

export const recordPhase = async (
  state: State,
  phase: Phase,
): Promise<State> => {
  if (hasPhase(state, phase)) return state;

  const next: State = { ...state, phases: [...state.phases, phase] };
  await writeState(next);
  return next;
};

/**
 * Runs `task` once, recording `phase` in the state file on success. If `phase`
 * is already recorded, logs a skip message and returns the state unchanged.
 *
 * @param state Current bootstrap state
 * @param phase Phase identifier to gate on
 * @param description Human-readable description for skip logging
 * @param task Async work to perform when the phase has not yet completed
 *
 * @returns Updated state
 */
export const runPhase = async (
  state: State,
  phase: Phase,
  description: string,
  task: () => Promise<boolean | void>,
): Promise<State> => {
  if (hasPhase(state, phase)) {
    console.log(`✓ ${description} (cached)`);
    return state;
  }

  // A task that returns `false` declares itself *incomplete* rather than failed:
  // the phase isn't recorded, so the next run tries again. Without this, a task
  // that bails out gracefully — "the tool I need isn't installed yet, skipping" —
  // gets recorded as done and never runs again.
  const completed = await task();

  return completed === false ? state : recordPhase(state, phase);
};
