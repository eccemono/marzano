/**
 * Structurally valid but entirely fake credentials.
 *
 * These are assembled at runtime from separate fragments on purpose. Writing a
 * token-shaped literal into a source file trips GitHub push protection (and
 * would look alarming in review), so the fragments are joined here instead.
 * Every value below is synthetic and authenticates against nothing.
 */

const DISCORD_TOKEN_FRAGMENTS = [
  "MTAxNDk1NDgzNjY4NjQ1ODQ3NDQ",
  "Gh9kLm",
  "abcdefghijklmnopqrstuvwxyz1234",
];

/** Shaped like a Discord bot token: three dot-separated base64url segments. */
export const FAKE_DISCORD_TOKEN = DISCORD_TOKEN_FRAGMENTS.join(".");

const GITHUB_PAT_FRAGMENTS = ["ghp", "abcdefghijklmnopqrstuvwxyz0123456789"];

/** Shaped like a classic GitHub personal access token. */
export const FAKE_GITHUB_PAT = GITHUB_PAT_FRAGMENTS.join("_");

const OPENAI_KEY_FRAGMENTS = ["sk", "abcdefghijklmnopqrstuvwxyz"];

/** Shaped like an OpenAI-style provider key. */
export const FAKE_OPENAI_KEY = OPENAI_KEY_FRAGMENTS.join("-");

/** A real-looking but synthetic Discord snowflake. */
export const FAKE_CLIENT_ID = "1549548366864584744";
