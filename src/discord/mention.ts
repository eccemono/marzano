/**
 * Starting a session by mentioning the bot.
 *
 * This is the only entry point that is not an interaction, so it carries the
 * strictest filtering of any path in the bot:
 *
 *   - only a *user* message, never a bot or a webhook, so a bot cannot summon a
 *     session and cannot cause a loop by answering itself;
 *   - only an **explicit** mention (`<@id>` or `<@!id>`), never a bare name, so
 *     talking *about* Marzano does not start a timer;
 *   - only from somebody actually sitting in a voice channel, because a session
 *     is something the guild does together in a call.
 *
 * It reuses the same start path as the slash commands, so precedence, the
 * one-session-per-guild rule and the voice-membership requirement cannot drift
 * between the two.
 */

import type { Message } from "discord.js";

import type { Db } from "../db/database";
import type { Logger } from "../logger";

import { type HandlerDeps, type StartOutcome, startFrom } from "./handlers";

export interface MentionDeps {
  db: Db;
  deps: HandlerDeps;
  /** The bot's own user id, so the mention can be recognised exactly. */
  botUserId(): string | null;
  logger: Logger;
}

/** Whether the message explicitly mentions the given user. */
export function mentionsUser(message: Pick<Message, "mentions">, userId: string): boolean {
  return message.mentions.users.has(userId);
}

/**
 * Handle a message that may be summoning the bot.
 *
 * Returns the outcome for testing, or null when the message is not for us.
 * Never throws: a failed mention must not take the gateway down.
 */
export async function handleMention(
  message: Message,
  deps: MentionDeps,
): Promise<StartOutcome | null> {
  if (message.author.bot || message.webhookId) return null;
  if (!message.inGuild()) return null;

  const botUserId = deps.botUserId();
  if (!botUserId) return null;
  if (!mentionsUser(message, botUserId)) return null;

  const voiceChannelId = message.member?.voice?.channelId ?? null;

  if (!voiceChannelId) {
    // Worth a reply rather than silence: the person has clearly asked for
    // something, and "join a call first" is the missing piece.
    await message.reply({
      content:
        "Join a voice channel first and mention me again - a Pomodoro session needs a call to run in.",
      allowedMentions: { repliedUser: false },
    });
    return null;
  }

  const outcome = await startFrom(deps.deps, {
    guildId: message.guildId,
    textChannelId: message.channelId,
    voiceChannelId,
    splitInput: null,
  });

  if (outcome.kind === "started") {
    await message.reply({
      content: `Starting a Pomodoro session in <#${voiceChannelId}>. Controls are in that channel.`,
      allowedMentions: { repliedUser: false },
    });
    return outcome;
  }

  if (outcome.kind === "reject") {
    await message.reply({
      content: outcome.message,
      allowedMentions: { repliedUser: false },
    });
    return outcome;
  }

  // Unconfigured channel: point at the command rather than opening a modal,
  // which a message handler cannot do.
  await message.reply({
    content: `This channel has no saved settings yet. Run \`/configure\` in <#${message.channelId}> first, or \`/pomodoro 25 5 15\` to start with a split of your own.`,
    allowedMentions: { repliedUser: false },
  });
  return outcome;
}
