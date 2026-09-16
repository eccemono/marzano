import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";

import { isPaused, isStopped, type TimerSession } from "../domain/timer";

import {
  SESSION_BUTTON_IDS,
  type SessionAction,
  cancelIdFor,
  confirmIdFor,
} from "./session-controls";

/**
 * Component builders for the session message.
 *
 * Only legacy components are used, never Components V2: V2 cannot be combined
 * with a classic embed, and the status message is an embed.
 *
 * Custom IDs are fixed constants rather than per-session values, which is what
 * lets the same view be re-registered after a restart and still resolve.
 */

export function buildSessionComponents(session: TimerSession): ActionRowBuilder<ButtonBuilder>[] {
  const paused = isPaused(session);
  const awaiting = session.awaitingContinue === true;
  const stopped = isStopped(session);
  const disabled = stopped;

  const primary = awaiting ? "Continue" : paused ? "Resume" : "Pause";

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(SESSION_BUTTON_IDS.pauseResume)
      .setLabel(primary)
      .setStyle(awaiting || paused ? ButtonStyle.Success : ButtonStyle.Secondary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(SESSION_BUTTON_IDS.skip)
      .setLabel("Skip")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(SESSION_BUTTON_IDS.modify)
      .setLabel("Modify")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(SESSION_BUTTON_IDS.stop)
      .setLabel("Stop")
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabled),
  );

  return [row];
}

export function buildModifyComponents(): ActionRowBuilder<ButtonBuilder>[] {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(SESSION_BUTTON_IDS.extend2)
      .setLabel("+2 minutes")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(SESSION_BUTTON_IDS.extend5)
      .setLabel("+5 minutes")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(SESSION_BUTTON_IDS.changeSplit)
      .setLabel("Change split")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(SESSION_BUTTON_IDS.toggleSound)
      .setLabel("Sound on/off")
      .setStyle(ButtonStyle.Secondary),
  );

  return [row];
}

export function buildConfirmationComponents(
  action: SessionAction,
): ActionRowBuilder<ButtonBuilder>[] {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(confirmIdFor(action))
      .setLabel("Confirm")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(cancelIdFor(action))
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Secondary),
  );

  return [row];
}

/** How much time the extend buttons add. */
export const EXTEND_BUTTON_MS: Record<string, number> = {
  [SESSION_BUTTON_IDS.extend2]: 2 * 60_000,
  [SESSION_BUTTON_IDS.extend5]: 5 * 60_000,
};
