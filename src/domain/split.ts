/**
 * Parsing of user-supplied Pomodoro splits.
 *
 * Accepted forms mirror how people actually type a split:
 *
 *   25           focus only; breaks are derived from the default ratio
 *   25 5         focus and short break; long break is twice the short break
 *   25 5 15      explicit focus, short break and long break
 *
 * Spaces, commas, slashes and dashes are all treated as separators, so
 * `25-5-15` and `25, 5, 15` mean the same thing. Input is validated rather
 * than repaired: anything nonsensical is rejected with a message safe to show
 * to the user.
 */

export interface Split {
  focusMinutes: number;
  shortBreakMinutes: number;
  longBreakMinutes: number;
}

export const SPLIT_LIMITS = {
  minMinutes: 1,
  maxFocusMinutes: 180,
  maxBreakMinutes: 180,
} as const;

export class SplitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SplitError";
  }
}

const SEPARATOR = /[\s,;/\\|\-–—]+/;

/** A minus sign at the start, or straight after a separator, means a negative. */
const NEGATIVE_NUMBER = /(?:^|[\s,;/\\|–—])-\d/;

const ALLOWED_CHARACTERS = /^[\d\s,;/\\|\-–—]+$/;

function toPositiveInteger(token: string): number {
  const value = Number.parseInt(token, 10);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new SplitError(`"${token}" is not a positive whole number of minutes.`);
  }
  return value;
}

function assertWithin(name: string, value: number, max: number): void {
  if (value < SPLIT_LIMITS.minMinutes || value > max) {
    throw new SplitError(
      `The ${name} must be between ${SPLIT_LIMITS.minMinutes} and ${max} minutes; received ${value}.`,
    );
  }
}

function normalise(focus: number, shortBreak: number, longBreak: number): Split {
  assertWithin("focus period", focus, SPLIT_LIMITS.maxFocusMinutes);
  assertWithin("short break", shortBreak, SPLIT_LIMITS.maxBreakMinutes);
  assertWithin("long break", longBreak, SPLIT_LIMITS.maxBreakMinutes);

  // A break longer than the work period, or a "long" break shorter than the
  // short one, means the numbers were almost certainly given out of order.
  if (shortBreak > focus) {
    throw new SplitError(
      `The short break (${shortBreak}m) cannot be longer than the focus period (${focus}m). Check the order: focus, short break, long break.`,
    );
  }
  if (longBreak < shortBreak) {
    throw new SplitError(
      `The long break (${longBreak}m) cannot be shorter than the short break (${shortBreak}m).`,
    );
  }

  return {
    focusMinutes: focus,
    shortBreakMinutes: shortBreak,
    longBreakMinutes: longBreak,
  };
}

/**
 * Parse a split string.
 *
 * @throws {SplitError} when the input is empty, malformed or out of range.
 */
export function parseSplit(input: string): Split {
  const cleaned = (input ?? "").trim();

  if (cleaned.length === 0) {
    throw new SplitError("Enter a split such as `25 5 15`, or a single focus length such as `25`.");
  }

  if (/\./.test(cleaned)) {
    throw new SplitError("Use whole minutes, for example `25 5 15`.");
  }

  if (!ALLOWED_CHARACTERS.test(cleaned)) {
    throw new SplitError(
      "A split may only contain numbers separated by spaces, commas or dashes, for example `25 5 15`.",
    );
  }

  if (NEGATIVE_NUMBER.test(cleaned)) {
    throw new SplitError("Durations must be positive; negative values are not allowed.");
  }

  const tokens = cleaned.split(SEPARATOR).filter((token) => token.length > 0);

  if (tokens.length > 3) {
    throw new SplitError(
      `A split takes at most three numbers (focus, short break, long break); received ${tokens.length}.`,
    );
  }

  const numbers = tokens.map(toPositiveInteger);
  const [focus, shortBreak, longBreak] = numbers;

  if (focus === undefined) {
    throw new SplitError("Enter a split such as `25 5 15`.");
  }

  // Three values: use them as given.
  if (longBreak !== undefined && shortBreak !== undefined) {
    return normalise(focus, shortBreak, longBreak);
  }

  // Two values: the long break is twice the short break.
  if (shortBreak !== undefined) {
    return normalise(focus, shortBreak, shortBreak * 2);
  }

  // One value: derive the default 5:1:3 ratio (25 -> 5 and 15).
  const derivedShort = Math.max(SPLIT_LIMITS.minMinutes, Math.round(focus / 5));
  return normalise(focus, derivedShort, derivedShort * 3);
}
