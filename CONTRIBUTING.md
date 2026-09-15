# Contributing

Thanks for taking a look at Marzano. This project is small and opinionated; the
notes below describe how changes get from an idea to `main`.

## Before you start

Open an issue first for anything larger than a typo fix. It is cheaper to agree
on an approach than to rewrite a pull request.

## Development setup

```bash
git clone https://github.com/eccemono/marzano.git
cd marzano
npm ci
cp .env.example .env   # then add DISCORD_TOKEN and CLIENT_ID
```

You need **Node.js 22** (see `.nvmrc`) and **FFmpeg** if you plan to touch audio.

## Quality gates

Every pull request must pass the same gate CI runs:

```bash
npm ci
npm run format:check
npm run lint
npm run typecheck
npm run build
npm test
```

`npm run format` fixes formatting locally. Commits that fail a gate are not
merged, and CI failures should be fixed with a new commit rather than an empty
"retrigger" commit.

## Branch and commit style

- Branch from `main`: `feat/<slug>`, `fix/<slug>`, `docs/<slug>`, `chore/<slug>`.
- Write [Conventional Commits](https://www.conventionalcommits.org/):
  `feat: add split parser`, `fix: handle deleted status message`.
- Keep pull requests focused. One concern per pull request is easier to review
  and easier to revert.

## What belongs in a pull request

- A description of the behaviour change and why it is needed.
- Tests for new logic. The timer engine in particular is expected to be fully
  covered, since correctness there is not observable until it is wrong.
- Documentation updates when behaviour or configuration changes.

## What must never be committed

- Bot tokens, API keys or any other credential.
- `.env` files (`.env.example` is the template and is committed).
- Runtime data: the SQLite database, WAL files, logs.
- Host-specific deployment details.

Secret redaction is enforced in code as well as in review: see
`src/logger.ts`. Do not weaken it.

## Merging

Merges to `main` are expected to deploy. Do not merge a pull request that is not
green, and do not merge your own changes to deployment plumbing without review.

## Reporting problems

Security issues should follow [SECURITY.md](SECURITY.md) rather than the public
issue tracker.
