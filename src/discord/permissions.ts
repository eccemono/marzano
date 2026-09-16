import { PermissionFlagsBits } from "discord.js";

/**
 * Who may change what.
 *
 * Session controls (pause, skip, stop, extend) are open to anyone currently in
 * the voice channel - that is the whole point of a shared Pomodoro. Permanent
 * configuration is not: it outlives the session and affects everyone who uses
 * the channel later, so it needs an explicit moderator permission.
 *
 * These checks are pure functions over a permission bitfield so they can be
 * tested without a Discord connection, and so every call site goes through the
 * same rule rather than re-deriving it.
 */

/** Changing the saved configuration of one voice channel. */
export const CHANNEL_CONFIG_PERMISSIONS: readonly bigint[] = [
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.ManageGuild,
];

/** Changing the guild-wide defaults for newly configured channels. */
export const GUILD_CONFIG_PERMISSIONS: readonly bigint[] = [PermissionFlagsBits.ManageGuild];

/** Force-stopping a session the caller is not part of. */
export const FORCE_STOP_PERMISSIONS: readonly bigint[] = [
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.ManageGuild,
];

/** True when the bitfield grants at least one of `required`. */
export function hasAnyPermission(permissions: bigint, required: readonly bigint[]): boolean {
  if (required.length === 0) return false;
  return required.some((bit) => (permissions & bit) === bit);
}

export function canConfigureChannel(permissions: bigint): boolean {
  return hasAnyPermission(permissions, CHANNEL_CONFIG_PERMISSIONS);
}

export function canConfigureGuild(permissions: bigint): boolean {
  return hasAnyPermission(permissions, GUILD_CONFIG_PERMISSIONS);
}

export function canForceStop(permissions: bigint): boolean {
  return hasAnyPermission(permissions, FORCE_STOP_PERMISSIONS);
}
