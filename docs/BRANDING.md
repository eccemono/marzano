# Branding

Marzano is named after the **San Marzano tomato** - the small, sweet plum
tomato that gives a good sauce its backbone. It is a deliberate fit: the bot is
about doing a small number of things carefully and letting them reduce down to
something worth having. Focus, break, repeat.

This document records what still has to be done by hand. Everything listed here
is a manual step in the Discord Developer Portal or on GitHub; none of it is
automatable from the repository.

---

## Profile picture

**Placeholder: a San Marzano tomato.**

The bot avatar is a tomato. The specific image is not yet chosen.

### Requirements

| Property | Value |
| --- | --- |
| Format | PNG (or JPEG) |
| Dimensions | 512 × 512 px or larger, square |
| Max file size | 10 MB (Discord's limit) |
| Background | Should read clearly at 32 px, the size it appears in a member list |
| Transparency | Supported, but a solid background survives Discord's circular crop better |

### Licencing

**Do not use an image found through a search engine.** Use one of:

- an original illustration or photograph you own the rights to;
- a stock image with a licence permitting commercial use;
- a public-domain or CC0 image, with the source recorded below.

Once chosen, record the source and licence in this file before uploading.

> **Asset provenance:** _not yet recorded - pending selection._

### Uploading

1. <https://discord.com/developers/applications> → your application.
2. **General Information** → **App Icon** → **Choose File**.
3. Crop to square, then **Save Changes**.

---

## Bot bio and description

The Developer Portal has two separate fields, and they show up in different
places:

| Field | Where it appears |
| --- | --- |
| **Description** | The application's public listing |
| **Bot → About Me / bio** | The bot's profile in the client |

Suggested description:

> A Pomodoro timer that lives in your voice channel. Shared focus and break
> cycles, configurable per channel, controlled with buttons. Named after the
> tomato.

### Steps

1. **General Information** → **Description** → paste the text → **Save Changes**.
2. **Bot** → **About Me** → paste the same text → **Save Changes**.

---

## GitHub link

The repository link appears in two places:

1. **Developer Portal** → **General Information** → **Terms of Service URL** /
   **Privacy Policy URL**. Point these at the repository, or at files inside it.
2. **The bot itself** → `/info` prints the repository URL. This reads from
   `REPOSITORY_URL` in `src/runtime.ts`, so changing it there changes it
   everywhere.

---

## Verification checklist

Before a public release:

- [ ] Avatar uploaded and legible at 32 px
- [ ] Asset source and licence recorded above
- [ ] Description set in both **General Information** and **Bot**
- [ ] Repository link set in the Developer Portal
- [ ] Tags set (e.g. `productivity`, `pomodoro`, `utility`)
- [ ] Privacy policy present, since the bot stores per-guild configuration
- [ ] `/info` shows the correct version and repository

---

## Voice and tone

Where the bot speaks to users, in embeds and command replies:

- **Direct, not chatty.** "Session started." Not "Yay, let's focus! 🍅".
- **No exclamation marks** in routine confirmations.
- **Explain refusals.** A rejection says which channel holds the session, or
  which permission is missing - never just "you can't do that".
- **No emoji** in the product surface, with the single exception of the stage
  icons in the status embed, which carry state at a glance.
