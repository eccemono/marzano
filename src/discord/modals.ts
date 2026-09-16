import { ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } from "discord.js";

import type { Split } from "../domain/split";

/**
 * Modal builders.
 *
 * A modal is used instead of "reply with your split in chat": it validates
 * inline, needs no Message Content intent, and gives the user the accepted
 * formats up front.
 */

export const SPLIT_MODAL_ID = "marzano:setup:split";
export const SPLIT_INPUT_ID = "split";

export const SPLIT_PLACEHOLDER = "25 5 15  -  or just 25";

export function formatSplit(split: Split): string {
  return `${split.focusMinutes} ${split.shortBreakMinutes} ${split.longBreakMinutes}`;
}

export interface SplitModalOptions {
  title: string;
  initialSplit?: string | null;
}

export function buildSplitModal(options: SplitModalOptions): ModalBuilder {
  const input = new TextInputBuilder()
    .setCustomId(SPLIT_INPUT_ID)
    .setLabel("Focus, short break, long break (minutes)")
    .setStyle(TextInputStyle.Short)
    .setPlaceholder(SPLIT_PLACEHOLDER)
    .setMinLength(1)
    .setMaxLength(32)
    .setRequired(true);

  const initial = (options.initialSplit ?? "").trim();
  if (initial.length > 0) {
    input.setValue(initial);
  }

  return new ModalBuilder()
    .setCustomId(SPLIT_MODAL_ID)
    .setTitle(options.title.slice(0, 45))
    .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
}
