# Security Policy

## Reporting a vulnerability

Open a GitHub issue **without** credentials, tokens, or private Discord content.

Do not paste:

- Discord bot tokens
- API keys
- `.env` files
- database contents or message archives
- real user IDs paired with private content

If the issue cannot be described without a secret, open a minimal issue asking
for a private contact channel and wait for a reply.

## Scope

Marzano is a small self-hosted bot. The most relevant risks are:

- **Credential exposure.** The bot token grants full control of the bot user.
  It lives only in a mode-600 environment file on the host and is never
  committed, logged, or transmitted.
- **Privilege misuse.** Session controls are restricted to members currently
  connected to the target voice channel; permanent configuration requires
  `Manage Channels` or `Manage Guild`.
- **Input handling.** Split input from users is parsed, never evaluated, and is
  bounded before it reaches the timer.

## Handling of secrets in this repository

- `.env` and variants are git-ignored; only `.env.example` is committed and it
  contains placeholders only.
- `src/logger.ts` redacts credential-shaped strings and sensitive keys before
  anything is written to a log sink. This is covered by tests.
- GitHub secret scanning and push protection are enabled on the repository.

## Supported versions

This project is pre-1.0 and moves on `main`. Fixes land on `main`; there are no
maintained release branches yet.
