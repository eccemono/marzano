import type { Db } from "../db/database";
import { getActiveSession, saveActiveSession } from "../db/session-repository";
import type { TimerSession } from "../domain/timer";
import type { Logger } from "../logger";

import {
  type RenderResult,
  type SessionMessageGateway,
  SessionPresenter,
} from "./session-presenter";

/**
 * Rendering ownership.
 *
 * A refresh loop belongs to a *guild*, not to the process. A single shared loop
 * can only ever watch one session, which is exactly why a session started after
 * boot used to sit frozen on screen until somebody pressed a button - the loop
 * had been created at startup, for the sessions that existed then, and nothing
 * ever created another one.
 *
 * So the renderer keeps one presenter per guild and hands out `watch`/`unwatch`.
 * The supervisor calls `watch` when a session begins and `unwatch` when it ends,
 * which is the only ordering that cannot leak a loop.
 */
export interface SessionRendererPort {
  /** Post or refresh the status message for a session. */
  render(session: TimerSession): Promise<RenderResult>;
  /** Begin refreshing a guild's status message. Idempotent. */
  watch(guildId: string): void;
  /** Stop refreshing a guild's status message. Idempotent. */
  unwatch(guildId: string): void;
  /** Stop every loop. Used on shutdown. */
  unwatchAll(): void;
}

export interface SessionRendererOptions {
  db: Db;
  gateway: SessionMessageGateway;
  logger: Logger;
  now?: () => number;
  baseIntervalMs?: number;
  maxIntervalMs?: number;
  /**
   * Called after each render, including the periodic ticks.
   *
   * The voice-channel status piggybacks on the existing refresh cadence rather
   * than running a timer of its own; it writes only when its text has actually
   * changed, so most ticks cost nothing.
   */
  onRendered?: (session: TimerSession) => void;
}

export class SessionRenderer implements SessionRendererPort {
  private readonly db: Db;
  private readonly gateway: SessionMessageGateway;
  private readonly logger: Logger;
  private readonly now: (() => number) | undefined;
  private readonly baseIntervalMs: number | undefined;
  private readonly maxIntervalMs: number | undefined;
  private readonly onRendered: ((session: TimerSession) => void) | undefined;

  private readonly presenters = new Map<string, SessionPresenter>();
  private readonly watching = new Set<string>();

  constructor(options: SessionRendererOptions) {
    this.db = options.db;
    this.gateway = options.gateway;
    this.logger = options.logger;
    this.now = options.now;
    this.baseIntervalMs = options.baseIntervalMs;
    this.maxIntervalMs = options.maxIntervalMs;
    this.onRendered = options.onRendered;
  }

  private for(guildId: string): SessionPresenter {
    const existing = this.presenters.get(guildId);
    if (existing) return existing;

    const created = new SessionPresenter({
      gateway: this.gateway,
      logger: this.logger.child({ guildId }),
      ...(this.now ? { now: this.now } : {}),
      ...(this.baseIntervalMs === undefined ? {} : { baseIntervalMs: this.baseIntervalMs }),
      ...(this.maxIntervalMs === undefined ? {} : { maxIntervalMs: this.maxIntervalMs }),
    });

    this.presenters.set(guildId, created);
    return created;
  }

  render(session: TimerSession): Promise<RenderResult> {
    return this.for(session.guildId).render(session);
  }

  watch(guildId: string): void {
    const presenter = this.for(guildId);
    if (this.watching.has(guildId)) return;

    presenter.startLoop(
      () => getActiveSession(this.db, guildId),
      (rendered, result) => {
        // The message was replaced after being deleted; remember the new id or
        // every later refresh would try the dead one again.
        if (result.messageId !== rendered.statusMessageId) {
          saveActiveSession(this.db, { ...rendered, statusMessageId: result.messageId });
        }

        try {
          this.onRendered?.(rendered);
        } catch {
          // An observer must never break the refresh loop.
        }
      },
    );

    this.watching.add(guildId);
  }

  unwatch(guildId: string): void {
    this.presenters.get(guildId)?.stopLoop();
    this.watching.delete(guildId);
  }

  unwatchAll(): void {
    for (const presenter of this.presenters.values()) presenter.stopLoop();
    this.watching.clear();
  }
}
