import { type ButtonInteraction, MessageFlags } from "discord.js";

import { deleteActiveSession, getActiveSession, saveActiveSession } from "../db/session-repository";
import type { Db } from "../db/database";
import {
  type TimerSession,
  changeSessionSettings,
  extend,
  isPaused,
  isStopped,
  pause,
  resume,
  skip,
  terminate,
} from "../domain/timer";

import {
  EXTEND_BUTTON_MS,
  buildConfirmationComponents,
  buildModifyComponents,
} from "./session-components";
import {
  SESSION_BUTTON_IDS,
  SESSION_SPLIT_MODAL_ID,
  type SessionAction,
  actionForButtonId,
  actionLabel,
  authorizeControl,
  parseConfirmationId,
} from "./session-controls";
import type { SessionPresenter } from "./session-presenter";
import { buildSplitModal, formatSplit } from "./modals";
import type { SessionVoice } from "../voice/manager";

/**
 * The session control buttons.
 *
 * Authorization is re-evaluated on every click against the caller's *current*
 * voice state - a visible button is never treated as permission. Destructive
 * actions route through an ephemeral confirmation first, and the confirmation
 * carries the action it confirms so no state has to be remembered between the
 * click that asks and the click that answers.
 */

export interface SessionButtonDeps {
  db: Db;
  presenter: SessionPresenter;
  voice: SessionVoice;
  voiceChannelIdOf(interaction: ButtonInteraction): string | null;
}

function ephemeral(content: string) {
  return { content, flags: MessageFlags.Ephemeral as number };
}

/** The pause button doubles as resume, so resolve it against live state. */
function resolveAction(action: SessionAction, session: TimerSession): SessionAction {
  if (action === "pause" && isPaused(session)) return "resume";
  return action;
}

function applyAction(
  action: SessionAction,
  session: TimerSession,
  customId: string,
  now: number,
): { session: TimerSession; note: string; remove: boolean } {
  switch (action) {
    case "pause":
      return { session: pause(session, now), note: "Paused.", remove: false };
    case "resume":
      return { session: resume(session, now), note: "Resumed.", remove: false };
    case "skip": {
      const result = skip(session, now);
      return { session: result.session, note: "Skipped to the next stage.", remove: false };
    }
    case "stop":
      return {
        session: terminate(session, `stopped by a participant`),
        note: "Session stopped.",
        remove: true,
      };
    case "extend": {
      const delta = EXTEND_BUTTON_MS[customId];
      if (delta === undefined) {
        return { session, note: "That button is not recognised.", remove: false };
      }
      return {
        session: extend(session, delta, now),
        note: `Added ${delta / 60_000} minutes.`,
        remove: false,
      };
    }
    case "toggle_sound": {
      const enabled = !session.config.soundEnabled;
      return {
        session: changeSessionSettings(session, { soundEnabled: enabled }),
        note: `Sound ${enabled ? "on" : "off"}.`,
        remove: false,
      };
    }
    case "modify":
      return { session, note: "", remove: false };
    case "change_split":
      // Handled by the caller, which opens a modal rather than mutating here.
      return { session, note: "", remove: false };
  }
}

export async function handleSessionButton(
  interaction: ButtonInteraction,
  deps: SessionButtonDeps,
): Promise<void> {
  const guildId = interaction.guildId;

  const confirmation = parseConfirmationId(interaction.customId);
  const action: SessionAction | null = confirmation
    ? confirmation.action
    : actionForButtonId(interaction.customId);

  if (!action) return;

  if (!guildId) {
    await interaction.reply(ephemeral("Marzano only works inside a server."));
    return;
  }

  const stored = getActiveSession(deps.db, guildId);
  if (!stored || isStopped(stored)) {
    await interaction.reply(ephemeral("No session is running in this server."));
    return;
  }

  const resolved = resolveAction(action, stored);
  const permissions = interaction.memberPermissions?.bitfield ?? 0n;

  const decision = authorizeControl({
    action: resolved,
    callerVoiceChannelId: deps.voiceChannelIdOf(interaction),
    sessionVoiceChannelId: stored.voiceChannelId,
    permissions,
    confirmed: confirmation?.confirmed === true,
  });

  if (!decision.allowed) {
    if (decision.requiresConfirmation) {
      await interaction.reply({
        ...ephemeral(`Are you sure you want to ${actionLabel(resolved).toLowerCase()}?`),
        components: buildConfirmationComponents(resolved),
      });
      return;
    }

    await interaction.reply(ephemeral(decision.reason ?? "You cannot do that."));
    return;
  }

  if (resolved === "modify") {
    await interaction.reply({
      ...ephemeral("Adjust the running session."),
      components: buildModifyComponents(),
    });
    return;
  }

  if (resolved === "change_split") {
    const modal = buildSplitModal({
      title: "Change the split",
      initialSplit: formatSplit({
        focusMinutes: stored.config.focusMinutes,
        shortBreakMinutes: stored.config.shortBreakMinutes,
        longBreakMinutes: stored.config.longBreakMinutes,
      }),
    }).setCustomId(SESSION_SPLIT_MODAL_ID);

    await interaction.showModal(modal);
    return;
  }

  const now = Date.now();
  const applied = applyAction(resolved, stored, interaction.customId, now);

  if (applied.remove) {
    deleteActiveSession(deps.db, guildId);
    // Leave the voice channel as part of stopping, otherwise the bot would sit
    // in the channel indefinitely after the session it was there for ended.
    void deps.voice.leave();
  } else {
    saveActiveSession(deps.db, applied.session);

    // A skip moves the session into a new stage, so it gets the bell. Not
    // awaited: audio must not delay the acknowledgement.
    if (resolved === "skip") {
      void deps.voice.announceTransition(applied.session);
    }
  }

  const rendered = await deps.presenter.render(applied.session);
  if (!applied.remove && rendered.messageId !== applied.session.statusMessageId) {
    saveActiveSession(deps.db, { ...applied.session, statusMessageId: rendered.messageId });
  }

  // The status message is the visible acknowledgement, so keep the reply
  // ephemeral and short to avoid two competing views of the same state.
  await interaction.reply(ephemeral(applied.note));
}

export { SESSION_BUTTON_IDS };
