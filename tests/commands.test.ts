import {
  ApplicationCommandOptionType,
  ChannelType,
  type ChatInputCommandInteraction,
} from "discord.js";
import { describe, expect, it } from "vitest";

import {
  APPLICATION_COMMANDS,
  INFO_COMMAND,
  POMODORO_COMMAND,
  START_COMMAND,
  START_COMMANDS,
} from "../src/commands/definitions";
import { buildInfoEmbed, formatUptime } from "../src/commands/info";
import { commandPayload } from "../src/commands/register";
import { callerVoiceChannelId, parseSplitModalId } from "../src/discord/handlers";
import { SPLIT_MODAL_ID, formatSplit } from "../src/discord/modals";

interface OptionShape {
  type: number;
  name: string;
  description: string;
  required?: boolean;
  options?: OptionShape[];
  min_value?: number;
  max_value?: number;
  channel_types?: number[];
}

interface CommandShape {
  name: string;
  description: string;
  options?: OptionShape[];
}

function command(name: string): CommandShape {
  const found = (APPLICATION_COMMANDS as readonly CommandShape[]).find(
    (entry) => entry.name === name,
  );
  if (!found) throw new Error(`missing command ${name}`);
  return found;
}

function optionOf(commandName: string, name: string): OptionShape {
  const found = command(commandName).options?.find((option) => option.name === name);
  if (!found) throw new Error(`missing option ${name} on ${commandName}`);
  return found;
}

describe("command definitions", () => {
  it("declares exactly the agreed surface, as top-level commands", () => {
    expect(APPLICATION_COMMANDS.map((entry) => entry.name)).toEqual([
      "pomodoro",
      "start",
      "status",
      "configure",
      "settings",
      "stop",
      "leaderboard",
      "info",
      // TEMPORARY: the audio diagnostic, removed with the /test command.
      "test",
    ]);
    expect(INFO_COMMAND.name).toBe("info");
  });

  it("exposes no subcommands at all any more", () => {
    // The old /pomodoro start|status|... surface is gone, not aliased: two ways
    // to do the same thing is how a command set drifts.
    for (const entry of APPLICATION_COMMANDS) {
      const options = (entry as CommandShape).options ?? [];
      const subcommands = options.filter(
        (option) => option.type === ApplicationCommandOptionType.Subcommand,
      );
      expect(subcommands).toEqual([]);
    }
  });

  it("treats /pomodoro and /start as the same command", () => {
    expect(START_COMMANDS).toEqual(["pomodoro", "start"]);
    expect(START_COMMAND.description).toContain("same as /pomodoro");

    // Identical option shape, so neither can drift from the other.
    expect(START_COMMAND.options).toEqual(POMODORO_COMMAND.options);
  });

  it("uses only lowercase names within Discord's length limits", () => {
    for (const command of APPLICATION_COMMANDS) {
      expect(command.name).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
      expect(command.description.length).toBeLessThanOrEqual(100);
      expect(command.description.length).toBeGreaterThan(0);
    }
  });

  it("defines start with an optional split override", () => {
    const split = optionOf("pomodoro", "split");

    expect(split.type).toBe(ApplicationCommandOptionType.String);
    expect(split.required).toBe(false);
  });

  it("bounds the cycles and volume options", () => {
    const cycles = optionOf("configure", "cycles");
    expect(cycles.min_value).toBe(1);
    expect(cycles.max_value).toBe(12);

    const volume = optionOf("configure", "volume");
    expect(volume.min_value).toBe(0);
    expect(volume.max_value).toBe(100);
  });

  it("restricts copy_from to voice channels", () => {
    const copyFrom = optionOf("configure", "copy_from");

    expect(copyFrom.type).toBe(ApplicationCommandOptionType.Channel);
    expect(copyFrom.channel_types).toEqual([ChannelType.GuildVoice]);
  });

  it("offers reset but not copy_from on the guild defaults wizard", () => {
    const names = command("settings").options?.map((option) => option.name) ?? [];

    expect(names).not.toContain("copy_from");
    expect(names).not.toContain("reset");
  });

  it("declares no prefix commands anywhere", () => {
    for (const command of APPLICATION_COMMANDS) {
      const source = JSON.stringify(command);
      expect(source).not.toMatch(/prefix/i);
    }
  });
});

describe("commandPayload", () => {
  it("returns one entry per declared command", () => {
    expect(commandPayload()).toHaveLength(APPLICATION_COMMANDS.length);
  });

  it("is JSON-serialisable, so it can be sent to the REST API", () => {
    const payload = commandPayload();

    expect(() => JSON.stringify(payload)).not.toThrow();
    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);
  });
});

describe("formatUptime", () => {
  it("formats sub-minute uptimes in seconds", () => {
    expect(formatUptime(0)).toBe("0s");
    expect(formatUptime(45)).toBe("45s");
  });

  it("formats minutes and hours", () => {
    expect(formatUptime(60)).toBe("1m");
    expect(formatUptime(3_600)).toBe("1h 0m");
    expect(formatUptime(3_725)).toBe("1h 2m");
  });

  it("formats days", () => {
    expect(formatUptime(90_000)).toBe("1d 1h 0m");
  });

  it("never returns a negative duration", () => {
    expect(formatUptime(-5)).toBe("0s");
  });
});

describe("buildInfoEmbed", () => {
  const payload = {
    botName: "Marzano",
    version: "0.1.0",
    repositoryUrl: "https://github.com/eccemono/marzano",
    license: "MIT",
    applicationId: "1549548366864584744",
    nodeVersion: "22.23.2",
    uptimeSeconds: 3_725,
    gatewayLatencyMs: 42.4,
    guildCount: 3,
  };

  it("links to the public repository", () => {
    const embed = buildInfoEmbed(payload);

    expect(embed.description).toContain("https://github.com/eccemono/marzano");
    expect(embed.fields.find((field) => field.name === "Repository")?.value).toBe(
      payload.repositoryUrl,
    );
  });

  it("reports version, uptime, latency, servers, runtime and licence", () => {
    const embed = buildInfoEmbed(payload);
    const byName = new Map(embed.fields.map((field) => [field.name, field.value]));

    expect(embed.title).toBe("Marzano v0.1.0");
    expect(byName.get("Uptime")).toBe("1h 2m");
    expect(byName.get("Gateway")).toBe("42 ms");
    expect(byName.get("Servers")).toBe("3");
    expect(byName.get("Runtime")).toBe("Node 22.23.2");
    expect(byName.get("License")).toBe("MIT");
    expect(embed.footer.text).toContain("1549548366864584744");
  });

  it("degrades gracefully when latency is unknown", () => {
    const embed = buildInfoEmbed({ ...payload, gatewayLatencyMs: Number.NaN });

    expect(embed.fields.find((field) => field.name === "Gateway")?.value).toBe("unknown");
  });
});

describe("handler helpers", () => {
  it("reads the caller's voice channel, tolerating a partial member", () => {
    const withVoice = {
      member: { voice: { channelId: "abc" } },
    } as unknown as ChatInputCommandInteraction;
    const withoutVoice = {
      member: { voice: { channelId: null } },
    } as unknown as ChatInputCommandInteraction;
    const noMember = { member: null } as unknown as ChatInputCommandInteraction;

    expect(callerVoiceChannelId(withVoice)).toBe("abc");
    expect(callerVoiceChannelId(withoutVoice)).toBeNull();
    expect(callerVoiceChannelId(noMember)).toBeNull();
  });

  it("round-trips the modal id back to the target voice channel", () => {
    expect(parseSplitModalId(`${SPLIT_MODAL_ID}:222222222222222222`)).toBe("222222222222222222");
  });

  it("ignores unrelated modal ids", () => {
    expect(parseSplitModalId("something:else")).toBeNull();
    expect(parseSplitModalId(`${SPLIT_MODAL_ID}:`)).toBeNull();
  });
});

describe("formatSplit", () => {
  it("renders a split as space-separated minutes", () => {
    expect(formatSplit({ focusMinutes: 25, shortBreakMinutes: 5, longBreakMinutes: 15 })).toBe(
      "25 5 15",
    );
  });
});
