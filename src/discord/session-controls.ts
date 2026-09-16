import { canForceStop } from "./permissions";
import { isParticipant, participantRequirementMessage } from "./voice";

/**
 * Authorization for the session control buttons.
 *
 * The rule the plan settled on: anyone currently in the voice channel may
 * steer the session, because it is their session. Nobody else may - with one
 * exception, a moderator may force-stop a session they are not part of, since
 * otherwise a session whose participants have all left a channel could keep the
 * bot's single voice slot indefinitely.
 *
 * A moderator may *not* pause, skip or modify a session from outside: those
 * change what the people actually in the call are doing.
 *
 * Every interaction is checked again at click time. The buttons being visible is
 * never treated as authorization.
 */

export const SESSION_BUTTON_IDS = {
  pauseResume: "marzano:session:pause",
  skip: "marzano:session:skip",
  stop: "marzano:session:stop",
  modify: "marzano:session:modify",
  modifyCancel: "marzano:session:modify-cancel",
  extend2: "marzano:session:extend2",
  extend5: "marzano:session:extend5",
  changeSplit: "marzano:session:split",
  toggleSound: "marzano:session:sound",
  confirm: "marzano:session:confirm",
  cancel: "marzano:session:cancel",
} as const;

/** Modal shown when changing the split of a running session. */
export const SESSION_SPLIT_MODAL_ID = "marzano:session:split-modal";

export type SessionButtonId = (typeof SESSION_BUTTON_IDS)[keyof typeof SESSION_BUTTON_IDS];

export type SessionAction =
  | "pause"
  | "resume"
  | "skip"
  | "stop"
  | "modify"
  | "extend"
  | "change_split"
  | "toggle_sound";

/**
 * Actions that ask before acting.
 *
 * Empty on purpose: stopping now takes effect on the first click. The prompt was
 * an extra tap on the button people press when they have already decided, and
 * the status message makes the result of a stop obvious enough to undo by
 * starting again.
 */
export const DESTRUCTIVE_ACTIONS: readonly SessionAction[] = [];

const ACTION_LABELS: Record<SessionAction, string> = {
  pause: "Pause",
  resume: "Resume",
  skip: "Skip",
  stop: "Stop",
  modify: "Modify",
  extend: "Add time",
  change_split: "Change split",
  toggle_sound: "Change sound",
};

export function actionLabel(action: SessionAction): string {
  return ACTION_LABELS[action];
}

export function requiresConfirmation(action: SessionAction): boolean {
  return DESTRUCTIVE_ACTIONS.includes(action);
}

const BUTTON_ACTION: Record<string, SessionAction> = {
  [SESSION_BUTTON_IDS.pauseResume]: "pause",
  [SESSION_BUTTON_IDS.skip]: "skip",
  [SESSION_BUTTON_IDS.stop]: "stop",
  [SESSION_BUTTON_IDS.modify]: "modify",
  [SESSION_BUTTON_IDS.extend2]: "extend",
  [SESSION_BUTTON_IDS.extend5]: "extend",
  [SESSION_BUTTON_IDS.changeSplit]: "change_split",
  [SESSION_BUTTON_IDS.toggleSound]: "toggle_sound",
};

export function actionForButtonId(customId: string): SessionAction | null {
  return BUTTON_ACTION[customId] ?? null;
}

/**
 * Confirmation buttons carry the action they confirm, so the prompt itself is
 * the only state needed - nothing has to be remembered between the click that
 * asks and the click that answers.
 */
const CONFIRMABLE_ACTIONS: readonly SessionAction[] = [];

export function confirmIdFor(action: SessionAction): string {
  return `${SESSION_BUTTON_IDS.confirm}:${action}`;
}

export function cancelIdFor(action: SessionAction): string {
  return `${SESSION_BUTTON_IDS.cancel}:${action}`;
}

export function parseConfirmationId(
  customId: string,
): { action: SessionAction; confirmed: boolean } | null {
  const separator = customId.lastIndexOf(":");
  if (separator < 0) return null;

  const prefix = customId.slice(0, separator);
  const action = customId.slice(separator + 1) as SessionAction;

  if (!CONFIRMABLE_ACTIONS.includes(action)) return null;

  if (prefix === SESSION_BUTTON_IDS.confirm) return { action, confirmed: true };
  if (prefix === SESSION_BUTTON_IDS.cancel) return { action, confirmed: false };

  return null;
}

export interface ControlRequest {
  action: SessionAction;
  callerVoiceChannelId: string | null | undefined;
  sessionVoiceChannelId: string;
  permissions: bigint;
  /** Whether a confirmation step has already been satisfied. */
  confirmed?: boolean;
}

export interface ControlDecision {
  allowed: boolean;
  /** True when the caller should be shown a confirmation prompt instead. */
  requiresConfirmation: boolean;
  reason: string | null;
}

export function authorizeControl(request: ControlRequest): ControlDecision {
  const inChannel = isParticipant({
    callerVoiceChannelId: request.callerVoiceChannelId,
    commandVoiceChannelId: request.sessionVoiceChannelId,
  });

  if (!inChannel) {
    const mayForceStop = request.action === "stop" && canForceStop(request.permissions);

    if (!mayForceStop) {
      return {
        allowed: false,
        requiresConfirmation: false,
        reason: participantRequirementMessage(),
      };
    }
  }

  if (requiresConfirmation(request.action) && request.confirmed !== true) {
    return {
      allowed: false,
      requiresConfirmation: true,
      reason: `${actionLabel(request.action)} needs confirmation.`,
    };
  }

  return { allowed: true, requiresConfirmation: false, reason: null };
}
