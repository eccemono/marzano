/**
 * The ports the session supervisor depends on.
 *
 * All three are injected so the lifecycle rules - scheduling, recovery, grace
 * periods - can be driven by tests with a fake clock and fake timers instead of
 * waiting on real time and a real Discord connection.
 */

/** A cancellable scheduled callback. */
export interface TimerHandle {
  cancel(): void;
}

/** Schedules a one-shot callback and returns a handle to cancel it. */
export type ScheduleFn = (delayMs: number, callback: () => void) => TimerHandle;

export interface VoiceAudience {
  /** Whether the voice channel still exists and is still reachable. */
  channelExists(guildId: string, channelId: string): Promise<boolean>;
  /**
   * Ids of the human members currently in a voice channel, bots excluded.
   *
   * Returns `null` when the answer could not be determined - for example the
   * guild fetch failed. That distinction matters: "nobody is here" ends a
   * session, whereas "I could not tell" must not.
   */
  humanMembers(guildId: string, channelId: string): Promise<string[] | null>;
}

/** Real timers, used in production. */
export const systemSchedule: ScheduleFn = (delayMs, callback) => {
  const handle = setTimeout(callback, delayMs);
  // A pending session wake must not be the reason the process stays alive.
  if (typeof handle.unref === "function") handle.unref();
  return { cancel: () => clearTimeout(handle) };
};
