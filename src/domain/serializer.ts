/**
 * Serialises asynchronous work per guild.
 *
 * Session state transitions are read-modify-write cycles. Two interactions
 * arriving together - a pause and a skip, say - could otherwise both read the
 * same session and each write a different result, losing one of them or
 * producing two transitions where the user asked for one.
 *
 * Chaining per guild makes those operations strictly sequential while leaving
 * different guilds fully concurrent.
 */

type Task<T> = () => Promise<T> | T;

export class GuildSerializer {
  private readonly tails = new Map<string, Promise<unknown>>();

  /**
   * Queue `task` behind any work already queued for `guildId`.
   *
   * The returned promise settles with the task's own result or error; the
   * internal chain is kept settled so one failure cannot poison later work.
   */
  run<T>(guildId: string, task: Task<T>): Promise<T> {
    const previous = this.tails.get(guildId) ?? Promise.resolve();
    const result = previous.then(() => task());

    const tail = result.then(
      () => undefined,
      () => undefined,
    );

    this.tails.set(guildId, tail);
    void tail.then(() => {
      // Drop the entry once this chain is the last thing that ran, so the map
      // does not grow without bound across a long uptime.
      if (this.tails.get(guildId) === tail) {
        this.tails.delete(guildId);
      }
    });

    return result;
  }

  /** Guilds with queued or in-flight work. */
  get size(): number {
    return this.tails.size;
  }

  /** Resolve once every chain has settled. Intended for tests and shutdown. */
  async drain(): Promise<void> {
    await Promise.all([...this.tails.values()]);
  }
}
