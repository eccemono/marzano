import type { ActionRowBuilder, ButtonBuilder } from "discord.js";

import { type TimerSession, isStopped } from "../domain/timer";
import type { Logger } from "../logger";

import { buildSessionComponents } from "./session-components";
import { type SessionEmbed, buildSessionEmbed } from "./session-view";

/**
 * Rendering the status message.
 *
 * Two failure modes matter here and both used to be easy to get wrong:
 *
 *   1. The status message is deleted by a user. The next edit fails with
 *      "unknown message" and the session must keep running with a fresh
 *      message rather than dying.
 *   2. Discord is briefly unavailable or rate limiting us. Failures back off
 *      exponentially instead of hammering the API, and recover on the first
 *      success.
 *
 * The gateway is injected so both can be exercised in tests without a
 * connection.
 */

export class SessionMessageMissingError extends Error {
  constructor(message = "the status message no longer exists") {
    super(message);
    this.name = "SessionMessageMissingError";
  }
}

export interface SessionPayload {
  embeds: [SessionEmbed];
  components: ActionRowBuilder<ButtonBuilder>[];
}

export interface SessionMessageGateway {
  /** Create the status message and return its id. */
  post(channelId: string, payload: SessionPayload): Promise<string>;
  /**
   * Edit an existing status message.
   *
   * Must reject with {@link SessionMessageMissingError} when the message is
   * gone, and with any other error for a transient failure.
   */
  edit(channelId: string, messageId: string, payload: SessionPayload): Promise<void>;
}

export interface RenderResult {
  messageId: string;
  /** True when a new message had to be posted because the old one was gone. */
  replaced: boolean;
}

export interface SessionPresenterOptions {
  gateway: SessionMessageGateway;
  logger: Logger;
  now?: () => number;
  baseIntervalMs?: number;
  maxIntervalMs?: number;
}

export const DEFAULT_REFRESH_MS = 15_000;
/**
 * Ceiling on the refresh backoff.
 *
 * This message is how the session is read, so a long backoff leaves the channel
 * looking at a stage that has already ended. The old 120s ceiling meant a single
 * transient failure could freeze the status for two minutes - most of a short
 * stage. Failures still back off; they just do not back off past usefulness.
 */
export const DEFAULT_MAX_REFRESH_MS = 30_000;

export class SessionPresenter {
  private readonly gateway: SessionMessageGateway;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly baseIntervalMs: number;
  private readonly maxIntervalMs: number;

  private consecutiveFailures = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  /** Serialises renders. See `enqueue`. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(options: SessionPresenterOptions) {
    this.gateway = options.gateway;
    this.logger = options.logger;
    this.now = options.now ?? (() => Date.now());
    this.baseIntervalMs = options.baseIntervalMs ?? DEFAULT_REFRESH_MS;
    this.maxIntervalMs = options.maxIntervalMs ?? DEFAULT_MAX_REFRESH_MS;
  }

  get failures(): number {
    return this.consecutiveFailures;
  }

  /** Refresh delay, doubled per consecutive failure and capped. */
  nextDelayMs(): number {
    if (this.consecutiveFailures === 0) return this.baseIntervalMs;

    const grown = this.baseIntervalMs * 2 ** Math.min(this.consecutiveFailures, 16);
    return Math.min(grown, this.maxIntervalMs);
  }

  buildPayload(session: TimerSession): SessionPayload {
    return {
      embeds: [buildSessionEmbed({ session, now: this.now() })],
      components: buildSessionComponents(session),
    };
  }

  /**
   * Renders are serialised, so the order they are requested in is the order they
   * are applied in.
   *
   * A refresh tick already in flight when a session ends would otherwise paint
   * the live view over the terminal summary: the loop has been stopped, but the
   * HTTP edit is still on its way and lands afterwards. Chaining makes the
   * terminal render - always requested last - the last word, so a stopped
   * session cannot leave its live view on screen.
   */
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.chain.then(work, work);
    // Keep the chain settled, so one failed render cannot poison later ones.
    this.chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Post or refresh the status message for `session`. */
  render(session: TimerSession): Promise<RenderResult> {
    return this.enqueue(() => this.renderNow(session));
  }

  /**
   * Replace the status message with a final embed and no controls.
   *
   * Used for the terminal summary: the session is over, so the buttons would be
   * dead, and the summary is what the channel should keep.
   */
  renderWithEmbed(
    session: TimerSession,
    embed: SessionEmbed,
    components: ActionRowBuilder<ButtonBuilder>[] = [],
  ): Promise<RenderResult> {
    return this.enqueue(() => this.renderWithEmbedNow(session, embed, components));
  }

  /**
   * Post or refresh the status message for `session`.
   *
   * Returns the message id currently in use, and whether it had to be
   * recreated.
   */
  private async renderNow(session: TimerSession): Promise<RenderResult> {
    const channelId = session.textChannelId ?? session.voiceChannelId;
    const payload = this.buildPayload(session);

    if (session.statusMessageId) {
      try {
        await this.gateway.edit(channelId, session.statusMessageId, payload);
        this.consecutiveFailures = 0;
        return { messageId: session.statusMessageId, replaced: false };
      } catch (error) {
        if (!(error instanceof SessionMessageMissingError)) {
          this.consecutiveFailures += 1;
          // The reason used to be dropped here, which made "the status does not
          // change" impossible to diagnose from the logs: the warning said a
          // refresh failed but never why.
          this.logger.warn("status message refresh failed", {
            guildId: session.guildId,
            failures: this.consecutiveFailures,
            nextDelayMs: this.nextDelayMs(),
            reason: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }

        // The message was deleted. Fall through and post a replacement rather
        // than leaving the session without a visible status.
        this.logger.warn("status message was deleted; posting a replacement", {
          guildId: session.guildId,
        });
      }
    }

    const messageId = await this.gateway.post(channelId, payload);
    this.consecutiveFailures = 0;

    return { messageId, replaced: Boolean(session.statusMessageId) };
  }

  private async renderWithEmbedNow(
    session: TimerSession,
    embed: SessionEmbed,
    components: ActionRowBuilder<ButtonBuilder>[] = [],
  ): Promise<RenderResult> {
    const channelId = session.textChannelId ?? session.voiceChannelId;
    const payload: SessionPayload = { embeds: [embed], components };

    if (session.statusMessageId) {
      try {
        await this.gateway.edit(channelId, session.statusMessageId, payload);
        this.consecutiveFailures = 0;
        return { messageId: session.statusMessageId, replaced: false };
      } catch (error) {
        if (!(error instanceof SessionMessageMissingError)) {
          this.consecutiveFailures += 1;
          throw error;
        }
        this.logger.warn("status message was deleted; posting the summary instead", {
          guildId: session.guildId,
        });
      }
    }

    const messageId = await this.gateway.post(channelId, payload);
    this.consecutiveFailures = 0;

    return { messageId, replaced: Boolean(session.statusMessageId) };
  }

  /**
   * Refresh the session on a repeating timer, backing off on failure.
   *
   * `getSession` is re-read every tick, so the loop always renders current
   * state and stops itself when the session ends.
   */
  startLoop(
    getSession: () => TimerSession | null,
    onRendered: (session: TimerSession, result: RenderResult) => void,
  ): void {
    this.stopped = false;
    this.schedule(getSession, onRendered);
  }

  private schedule(
    getSession: () => TimerSession | null,
    onRendered: (session: TimerSession, result: RenderResult) => void,
  ): void {
    if (this.stopped) return;

    this.timer = setTimeout(() => {
      void this.tick(getSession, onRendered);
    }, this.nextDelayMs());

    // Do not hold the process open purely for a refresh timer.
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  async tick(
    getSession: () => TimerSession | null,
    onRendered: (session: TimerSession, result: RenderResult) => void,
  ): Promise<void> {
    if (this.stopped) return;

    const session = getSession();
    if (!session || isStopped(session)) {
      this.stopLoop();
      return;
    }

    try {
      const result = await this.render(session);
      onRendered(session, result);
    } catch {
      // Already logged and counted inside render(); the backoff accounts for it.
    }

    this.schedule(getSession, onRendered);
  }

  stopLoop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
