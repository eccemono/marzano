/**
 * The `/info` response.
 *
 * Built as a plain embed object rather than an EmbedBuilder so the exact
 * payload can be asserted in tests without constructing a Discord client.
 */

export interface InfoPayload {
  botName: string;
  version: string;
  repositoryUrl: string;
  license: string;
  applicationId: string;
  nodeVersion: string;
  /** Seconds since the process started. */
  uptimeSeconds: number;
  /** Gateway heartbeat latency in milliseconds. */
  gatewayLatencyMs: number;
  guildCount: number;
}

export interface InfoField {
  name: string;
  value: string;
  inline: boolean;
}

export interface InfoEmbed {
  title: string;
  description: string;
  fields: InfoField[];
  footer: { text: string };
}

/** Human-readable uptime such as `3d 4h 12m` or `45s`. */
export function formatUptime(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));

  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (days > 0 || hours > 0) parts.push(`${hours}h`);
  if (days > 0 || hours > 0 || minutes > 0) parts.push(`${minutes}m`);

  return parts.length > 0 ? parts.join(" ") : `${seconds}s`;
}

function describeLatency(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "unknown";
  return `${Math.round(milliseconds)} ms`;
}

export function buildInfoEmbed(payload: InfoPayload): InfoEmbed {
  return {
    title: `${payload.botName} v${payload.version}`,
    description: `A Pomodoro bot for voice channels. Source and issues: ${payload.repositoryUrl}`,
    fields: [
      { name: "Uptime", value: formatUptime(payload.uptimeSeconds), inline: true },
      { name: "Gateway", value: describeLatency(payload.gatewayLatencyMs), inline: true },
      { name: "Servers", value: String(payload.guildCount), inline: true },
      { name: "Repository", value: payload.repositoryUrl, inline: false },
      { name: "Runtime", value: `Node ${payload.nodeVersion}`, inline: true },
      { name: "License", value: payload.license, inline: true },
    ],
    footer: { text: `Application ID ${payload.applicationId}` },
  };
}
