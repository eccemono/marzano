import { ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } from "discord.js";

import type { PartialConfig } from "../domain/config";
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

export const CONFIGURE_MODAL_ID = "marzano:setup:configure";
export const DEFAULT_MODAL_ID = "marzano:setup:default";

/** The input ids shared by both config modals. */
export const CONFIG_INPUT_IDS = {
  split: "split",
  cycles: "cycles",
  sound: "sound",
  volume: "volume",
  auto: "auto",
} as const;

const YES = ["on", "yes", "true", "1"];

/** Whether the text means "on". Empty text means "not supplied". */
export function parseOnOff(value: string): boolean | null {
  const trimmed = value.trim().toLowerCase();
  if (trimmed.length === 0) return null;
  return YES.includes(trimmed);
}

/**
 * A full configuration modal, shown when a command is run with no options.
 *
 * Every field is optional, so the user fills in only what they want to change;
 * an untouched field leaves the existing setting alone.
 */
export function buildConfigModal(options: {
  customId: string;
  title: string;
  initial?: PartialConfig | null;
}): ModalBuilder {
  const initial = options.initial ?? {};

  const add = (
    id: string,
    label: string,
    placeholder: string,
    value: string | number | undefined,
  ): void => {
    const input = new TextInputBuilder()
      .setCustomId(id)
      .setLabel(label)
      .setStyle(TextInputStyle.Short)
      .setPlaceholder(placeholder)
      .setRequired(false);
    if (value !== undefined && value !== null && String(value).length > 0) {
      input.setValue(String(value));
    }
    rows.push(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
  };

  const rows: ActionRowBuilder<TextInputBuilder>[] = [];

  const splitValue =
    initial.focusMinutes !== undefined
      ? [initial.focusMinutes, initial.shortBreakMinutes, initial.longBreakMinutes]
          .filter((value) => value !== undefined && value !== null)
          .join(" ")
      : undefined;

  add(CONFIG_INPUT_IDS.split, "Split (focus short long, minutes)", "25 5 15", splitValue);
  add(
    CONFIG_INPUT_IDS.cycles,
    "Focus periods before a long break",
    "4",
    initial.cyclesBeforeLongBreak,
  );
  add(
    CONFIG_INPUT_IDS.sound,
    "Sound (on or off)",
    "on",
    initial.soundEnabled === undefined ? undefined : initial.soundEnabled ? "on" : "off",
  );
  add(CONFIG_INPUT_IDS.volume, "Volume (0 to 100)", "80", initial.soundVolume);
  add(
    CONFIG_INPUT_IDS.auto,
    "Auto-advance (on or off)",
    "off",
    initial.autoAdvance === undefined ? undefined : initial.autoAdvance ? "on" : "off",
  );

  return new ModalBuilder()
    .setCustomId(options.customId)
    .setTitle(options.title.slice(0, 45))
    .addComponents(rows);
}
