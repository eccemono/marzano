import { type ButtonInteraction, MessageFlags } from "discord.js";

import { getActiveSession, saveActiveSession } from "../db/session-repository";
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
import type { SessionRendererPort } from "./session-renderer";
import { buildSplitModal, formatSplit } from "./modals";
import type { SessionSupervisor } from "../session/supervisor";

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
  presenter: SessionRendererPort;
  supervisor: SessionSupervisor;
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

/**
 * Apply a button action to the session.
 *
 * `notice` is null for every action that shows its result in the status message
 * itself. The old behaviour posted an ephemeral "Paused." next to an embed that
 * already said paused, which is a second, more private, less clear copy of the
 * same fact. `notice` is only set when there is genuinely something the status
 * message cannot convey.
 */
function applyAction(
  action: SessionAction,
  session: TimerSession,
  customId: string,
  now: number,
): { session: TimerSession; notice: string | null; remove: boolean } {
  switch (action) {
    case "pause":
      return { session: pause(session, now), notice: null, remove: false };
    case "resume":
      return { session: resume(session, now), notice: null, remove: false };
    case "skip":
      return { session: skip(session, now).session, notice: null, remove: false };
    case "stop":
      return {
        session: terminate(session, `stopped by a participant`),
        notice: null,
        remove: true,
      };
    case "extend": {
      const delta = EXTEND_BUTTON_MS[customId];
      if (delta === undefined) {
        return { session, notice: "That button is not recognised.", remove: false };
      }
      return { session: extend(session, delta, now), notice: null, remove: false };
    }
    case "toggle_sound": {
      const enabled = !session.config.soundEnabled;
      return {
        session: changeSessionSettings(session, { soundEnabled: enabled }),
        notice: null,
        remove: false,
      };
    }
    case "modify":
      return { session, notice: null, remove: false };
    case "change_split":
      // Handled by the caller, which opens a modal rather than mutating here.
      return { session, notice: null, remove: false };
  }
}

export async function handleSessionButton(
  interaction: ButtonInteraction,
  deps: SessionButtonDeps,
): Promise<void> {
  // The Adjust panel's Cancel is not a session action - it dismisses the
  // ephemeral panel it lives on and nothing else. Handled before the action map
  // so it can never be confused with a control on the session itself.
  if (interaction.customId === SESSION_BUTTON_IDS.modifyCancel) {
    await interaction.deferUpdate();
    await interaction.deleteReply().catch(() => {
      // The panel is already gone; nothing to dismiss.
    });
    return;
  }

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

  // Only for something the status message cannot show for us.
  if (applied.notice) {
    await interaction.reply(ephemeral(applied.notice));
    return;
  }

  // Acknowledge *before* the slow work, not after it.
  //
  // Stopping leaves the voice channel, closes the history run and repaints the
  // message, and the render hits the Discord API. Answering the click only once
  // all of that finished is what made Discord give up and surface "Marzano
  // didn't respond in time" - the work was fine, it just exceeded the three
  // second budget for the acknowledgement.
  await interaction.deferUpdate();

  if (applied.remove) {
    // The supervisor owns stopping: it records the reason, cancels timers,
    // leaves the voice channel and frees the guild for a new session.
    await deps.supervisor.stop(guildId, "stopped by a participant");
  } else {
    saveActiveSession(deps.db, applied.session);

    // Skip, extend, pause and resume all move or clear the deadline, so the
    // supervisor has to re-arm rather than keep its stale timer.
    deps.supervisor.reschedule(guildId);

    // A skip moves the session into a new stage, so it gets the bell. Not
    // awaited: audio must not delay the acknowledgement.
    if (resolved === "skip") {
      // Recorded before the move so the skipped stage keeps its own window, and
      // recorded as skipped so it earns no focus credit.
      deps.supervisor.noteSkipped(guildId);
      deps.supervisor.announceTransition(guildId);
    }

    const rendered = await deps.presenter.render(applied.session);
    if (rendered.messageId !== applied.session.statusMessageId) {
      saveActiveSession(deps.db, { ...applied.session, statusMessageId: rendered.messageId });
    }
  }

  if (confirmation) {
    await interaction.deleteReply().catch(() => {
      // The prompt is already gone; nothing to clean up.
    });
  }
}

export { SESSION_BUTTON_IDS };
