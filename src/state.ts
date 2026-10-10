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

const unfinished: string[] = [];

/**
 * Phases this run left undone: their task stepped aside rather than failing,
 * so the run carried on past them.
 */
export const unfinishedPhases = (): readonly string[] => unfinished;

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
 * Brings `phase` about. With a `check`, the machine decides whether that's
 * needed: the phase runs whenever the check fails, recorded or not, and must
 * leave the check passing. Without one, `task` runs once and the state file
 * remembers that it did.
 *
 * @param state Current bootstrap state
 * @param phase Phase identifier
 * @param description Human-readable description for logging
 * @param task Async work that brings the phase about
 * @param check Whether the phase's effect is already in place
 *
 * @returns Updated state
 */
export const runPhase = async (
  state: State,
  phase: Phase,
  description: string,
  task: () => Promise<boolean | void>,
  check?: () => Promise<boolean>,
): Promise<State> => {
  // Checked rather than trusted, so a re-run repairs a machine whose state has
  // moved since the phase was recorded (a key removed, a castle re-locked), or
  // that got there without the bootstrap (a switch run by hand).
  if (check) {
    if (await check()) {
      console.log(`✓ ${description}`);
      return recordPhase(state, phase);
    }

    if ((await task()) === false) {
      unfinished.push(description);
      return state;
    }

    if (!(await check())) {
      throw new Error(
        `${description}: finished without error, but its result isn't in ` +
          'place. Re-run to try again.',
      );
    }

    return recordPhase(state, phase);
  }

  if (hasPhase(state, phase)) {
    console.log(`✓ ${description} (cached)`);
    return state;
  }

  // A task that returns `false` declares itself *incomplete* rather than failed:
  // the phase isn't recorded, so the next run tries again. Without this, a task
  // that bails out gracefully — "the tool I need isn't installed yet, skipping" —
  // gets recorded as done and never runs again.
  const completed = await task();

  if (completed === false) {
    unfinished.push(description);
    return state;
  }

  return recordPhase(state, phase);
};
