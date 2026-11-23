# Lamplighter: implementation

**Status: v1, 2026-11-19.** What [architecture.md](architecture.md) became in code, how to run and
test it, and what is left.

---

## 1. Stack

The same as the siblings, so code and habits move between them.

| Concern | Choice | From |
|---|---|---|
| Language | TypeScript, Node 22, ESM | both |
| Layout | npm workspaces `server/`, `web/` | Newsdesk |
| HTTP | Fastify 5; `@fastify/static` serves the built SPA on the same port | both |
| UI | React 19, Vite, react-router, react-query, Tailwind v4 | Newsdesk |
| DB | SQLite via `better-sqlite3`, plain SQL migrations (`server/src/db/migrations.ts`, append-only) | Newsdesk, minus drizzle |
| Validation | zod; `zod-to-json-schema` for tool schemas | Newsdesk |
| MCP | `@modelcontextprotocol/sdk`, stateless Streamable HTTP server (admin + workspace) | Newsdesk |
| Inference HTTP | `undici` dispatcher with no header/body timeout (agent sessions outlive Node's 300 s default) | — |
| Config | `config.yaml` on the volume, written back with comments kept (`yaml` Document API) | Touchstone |
| Checks | markdown + frontmatter on the volume (`gray-matter`), seeded from `seed/checks/` | Touchstone protocols |
| Git | the `git` CLI, wrapped (`forges/gitcli.ts`): never prompts, redacts credentials | — |
| Tests | vitest (`server/src/**/*.test.ts`) | both |

No login screen, following Aube's rule that AppShield owns access in deployment. The admin MCP
uses a bearer token, and the workspace endpoints use per-session tokens.

## 2. Layout

```
server/src/
  index.ts            composition root: db, config, checks, mirrors, sessions, scheduler, routes
  env.ts settings.ts events.ts context.ts
  config/             ConfigStore — config.yaml read, validated, written back
  db/                 openDb + migrations
  checks/             check files, settings resolution (default → config → group → repo)
  checks/detectors/   osv (package-lock.json → api.osv.dev), npm-outdated (registry latest)
  forges/             gitcli, refs (OwnBranch brand, trailers), github, gitea, git, http
  repos/              registry, mirror (bare clone, fetch, worktrees, loop guard), push (the only ref writes)
  inference/          types, claude-code (MCP query_claude), openai (tool loop), text (tool loop without function calling), driverFor, extractJson
  tools/              workspace (the session toolset), admin (the MCP + chat registry)
  sessions/           session registry, prompts, engine (round, author, validate)
  findings/           fingerprint, input hash, reconcile, dismiss/reopen
  delivery/           afterReady, deliver, merge, reject, revert, PR polling
  scheduler/          queue, tiers, poll, rotation, budget, slots, view
  activity/           inbox items, overrides
  hooks/              GitHub/Gitea push webhooks (HMAC) → repo due now
  chat/               administrator chat loop + prompt.md
  mcp/                /mcp/admin, /api/v1/mcp/workspace, /api/v1/ws/:tool
  api/                REST for the SPA
web/src/pages/        Chat, Repos, Repo, Round, Proposal, Activity, Settings
seed/checks/          the nine checks;  seed/policy/default.md
deploy/Dockerfile     backend image (Debian slim + git, curl, openssh-client)
deploy/dev/           docker-compose.yml (lamplighter, +gitea, +mcp profiles), seed-fixtures.sh
Apps/Lamplighter/     store listing for a Yundera box: backend + beaconify + AppShield
```

## 3. How a round, a fix and a delivery run

1. **Trigger.** The tick (`schedule.tick_s`) fetches every repo that is due (`poll_min`, or
   immediately after a webhook). New commits on the line that are not Lamplighter's own (no
   `Lamplighter-Round:` trailer) queue a **diff** round for every enabled diff-scoped check.
   Rotation (off by default) queues **full** rounds by cadence or by a check-revision change. A
   person's request goes to the front.
2. **Dispatch.** Foreground first, then tier, then age. A job waits for: the debounce (pushes),
   the daily session budget (background agent work only), and the rule of one running job per
   (repo, check). At most `slots` run at once.
3. **Round.** A worktree at the head. Detector checks run their detectors. Review checks open a
   session: the prompt carries the check body, the policies, the repo's `LAMPLIGHTER.md` /
   `CLAUDE.md`, the scope, and the findings already known (with ids, so the model can link a
   repeat). The findings it records are reconciled (`findings/index.ts`): same fingerprint or
   `existing_id` means the same finding, a dismissal holds while the anchor's blob is unchanged,
   and a full round retires open findings it no longer sees. The round's report is stored; with
   delivery `report` it also becomes an Activity item (new or reopened findings, or a full LLM
   review), superseding the unread one for that repo and check.
4. **Proposal.** If the check's delivery is not `report` (any check, see below), and it is armed (or a
   person pressed Fix), and the repo is under its attention cap, and nothing is already in flight
   for that check, then an author job takes up to eight open findings. A fixing session edits
   the worktree; Lamplighter commits (identity from config, trailers) onto
   `lamplighter/<check>/<slug>-<date>-<id>` in the bare clone.
5. **Validation.** A fresh session reviews `base..head` as a diff, with the claimed fixes
   listed. If it records anything, the proposal fails, and the findings return to open with
   `blocked_input` set, so the same input is not tried again.
6. **Ready.** If the change is sensitive and the repo is public (visibility re-read), it is
   **held**. Otherwise, with auto-submit and under the daily delivery cap, it is **delivered**;
   failing that, an Activity item asks for approval.
7. **Delivery.**
   - `push` fast-forwards the line: the remote rejects anything else, and `fastForwardLine`
     checks ancestry first.
   - `branch` pushes the own branch; Merge (typed confirmation) fast-forwards and deletes it.
   - `pr` pushes the branch and opens a labelled PR. A poll every five minutes follows it:
     merged → landed and branch deleted; closed → rejected, branch deleted, findings blocked
     on this input.

## 4. Configuration

`/DATA/config.yaml` is seeded on first boot from env and is what runs afterwards. Settings writes it back.

| Env (first boot only) | Key | Meaning |
|---|---|---|
| `LAMPLIGHTER_INFERENCE_DRIVER` | `inference.driver` | `claude-code`, `openai` or `text` |
| `LAMPLIGHTER_INFERENCE_URL` | `inference.url` | MCP endpoint (Beacon or the container) / OpenAI base URL |
| `LAMPLIGHTER_INFERENCE_TOOL` | `inference.tool` | `claude-code__query_claude` behind Beacon, `query_claude` direct |
| `LAMPLIGHTER_INFERENCE_VIA` | `inference.via` | `beacon` or `direct` |
| `LAMPLIGHTER_INFERENCE_MODEL` | `inference.model` | openai and text only |
| `LAMPLIGHTER_INFERENCE_BEARER` | (db, write-only) | bearer for the endpoint; Beacon needs none |
| `LAMPLIGHTER_PUBLIC_URL` | `public_url` | how the **backend** reaches Lamplighter's workspace endpoint |
| `LAMPLIGHTER_ADMIN_MCP_TOKEN` | (db) | admin MCP bearer, shared with the beaconify sidecar |
| `LAMPLIGHTER_DATA_DIR`, `_SEED_DIR`, `_PORT`, `_HOST`, `_LOG_LEVEL` | — | runtime (`_SEED_DIR` is where `seed/checks` and `seed/policy` are read from) |

A forge holds several **credentials** (table `credentials`): one per account Lamplighter speaks as
there — you, an organisation's token, a bot. A fine-grained GitHub token reaches one resource
owner, so personal and organisation repos on github.com are two credentials on one forge. Tokens
are set the way Touchstone sets its GitHub token: in Settings → Forges & credentials, with a guide
to what kind of token to make and how to scope it (fine-grained; Contents and Pull requests
read/write; only the monitored repositories). They are stored in the database and **write-only**:
no route returns them (`PUT|DELETE /api/v1/credentials/:id/token`), and no chat or admin-MCP tool
can set one. Each save is checked in the same response (`forges/auth.ts`): whose token it is, and
whether it may push to each monitored repo on its forge (account role, then the token's own
Contents grant). The checks rerun every 30 minutes.

Each repo uses one credential (`credentialFor`), first match wins:

1. pinned on the repo (`repos.credential_id`, the Repo page's "as" selector);
2. pinned on its group (`groups.credential_id`), when that credential is on the repo's forge;
3. **auto**: a credential whose last check says it may push there, the forge's default first;
4. the forge's default (its first credential, or the one marked default), which then cannot push.

With one credential per owner, step 3 assigns a whole fleet with no pins. Pins, like tokens, are
set only from Settings/the Repo page, never from the chat or admin MCP. A token a forge refuses,
or a repo no credential may push to, opens one alert per forge (`forge.<id>.auth`); a token that
merely cannot reach another owner's repos is not a fault. Fetches, pushes, PRs and the repo's
visibility all go through its credential; enrolling and discovery, before a repo has one, ask as
each credential in turn (`asAnyCredential`).

**No write access blocks fixing on that repo** (`writeAccess`): no proposal is drafted, validated or
delivered there, so nothing is authored only to fail at the push. Rounds and `report` delivery go
on; the Repo page says why and disables Fix, Armed, Auto-submit and the fixing delivery modes.
A forge with no credential (or no token) reads anonymously, so every repo on it is blocked this way.

Commits are authored by the repo's credential's `commit_name`/`commit_email` when set, else by
`identity.name` and `identity.email`; with no email anywhere (or the old default
`lamplighter@localhost`), a GitHub credential's account is used, by its noreply address.

## 5. Running it

### Locally (this workspace)

```bash
docker compose -f deploy/dev/docker-compose.yml --profile gitea --profile mcp up -d --build
docker exec lamplighter-dev seed-fixtures /DATA/fixtures
```

- UI at `http://localhost:8095`. Inference is preset to the local Beacon
  (`http://host.docker.internal:3000/mcp/`, via beacon). `public_url` is `http://localhost:8095`,
  because the local claude-code container is host-networked and reaches the published port
  that way.
- **Gitea** at `http://localhost:3300`. Create an admin and a token:

  ```bash
  docker exec -u git lamplighter-gitea gitea admin user create --admin --username lamp-admin --password … --email …
  docker exec -u git lamplighter-gitea gitea admin user generate-access-token --username lamp-admin --scopes all --raw
  ```

  Then seed `acme-web` there with `GITEA_URL=http://gitea:3000 GITEA_USER=… GITEA_TOKEN=… seed-fixtures /DATA/fixtures`.
  In Lamplighter, add a `gitea` forge with base URL `http://gitea:3000`, then a credential on it with that username and token.
- **Fixture forge**: add a `git` forge with base `/DATA/fixtures`, then repos `acme-api` and
  `tiny-cli`. They carry a stale README, an unused file, vulnerable lodash/minimist/express
  versions, an `eval()` on request input and a swallowed error.
- **MCP**: the `mcp` profile announces `lamplighter` on the local Beacon (`mcp-net`); the tools
  appear as `lamplighter__*`.

### On a Yundera box

Install `Apps/Lamplighter/` (this repo is its own one-app store, like Touchstone and Newsdesk).
The backend is on `pcs` with:
- `LAMPLIGHTER_INFERENCE_URL=http://beacon-backend:9300/mcp` (via beacon), which is the same
  shared claude-code the other apps use;
- `LAMPLIGHTER_PUBLIC_URL=http://lamplighter-backend:8080`, so the agent calls back by service
  name and never through the SSO gate.

The beaconify sidecar announces the admin MCP. AppShield 4.1 fronts everything, with platform SSO
and a generated fallback password. It opens no path: the store's `appshield-wiring` rule forbids
`ALLOWED_PATHS` for machine paths, so webhooks do not arrive there and polling (`poll_min`) is how
a box notices pushes. The official ClaudeCode listing ships with MCP **off**, so the preset
`query_claude` through Beacon works only on a box that enables it (yunderalabs does); elsewhere,
point Settings → Inference at an OpenAI-compatible API with function calling (driver `openai`), or,
for an endpoint without function calling such as the claude-code container's OpenAI API, use the
`text` driver.

Releases: tag, build and push `ghcr.io/worph/lamplighter:<v>`, then bump the image in
`Apps/Lamplighter/docker-compose.yml`.

## 6. Verification done for v1

- `npm run typecheck` is clean, and `npm test` passes all 25 tests. They cover:
  - fingerprint stability;
  - the `OwnBranch` brand, and a grep test that `repos/push.ts` cannot force;
  - workspace path escapes;
  - lockfile parsing and version drift;
  - claude-code SSE parsing, failure classes, the Beacon envelope, and dead-login → `auth`;
  - the openai tool loop;
  - `extractJson`;
  - settings precedence;
  - reconcile (repeat linking, a dismissal held, then reopened when the file changes, full-round
    retirement);
  - the Gitea and GitHub REST clients against a stubbed fetch.
- **In the dev stack, end to end** (detector checks live; LLM steps driven by a scripted
  OpenAI-compatible stub, because the local claude-code's headless login had expired that day):
  - `cve`/`deps` found the planted lodash, minimist and express problems on the bare and Gitea
    repos; tiny-cli stayed lit.
  - `docs`: review → fix → independent validation → auto-push fast-forwarded the bare repo's
    `main`. The next poll logged `OWN_COMMITS … no round (loop guard)`. A foreign commit then
    queued five debounced diff rounds.
  - `dead-code` on Gitea → approved in Activity (browser) → PR #1 with the `lamplighter` label
    and a minimal diff. Closing it on Gitea → the proposal was rejected, the branch deleted, and
    the finding blocked from re-proposal.
  - `dead-code` on bare git → approved → branch pushed → Merge with the typed id (browser)
    fast-forwarded `main`, deleted the branch and marked the finding fixed.
  - The admin MCP through the local Beacon: `lamplighter__list_findings` answered. No approve,
    merge or push tool is offered.
  - The claude-code driver against the real local backend: probe green through Beacon. A
    session against the expired login was classified as an auth failure: round `blocked`, alert
    raised, no finding touched.
- **Not yet exercised end to end:** a real claude-code session doing a review (blocked on that
  login), the sensitive *held* path, webhooks from a forge, rotation over a day, and the chat
  against a real model.

## 7. Next

| Item | Why |
|---|---|
| A credential-free **runner** sidecar (tests, package managers, scanners in a worktree copy) | mechanical validation (architecture §7.3 step 1); lockfile regeneration for `cve`/`deps` fixes; semgrep/knip as detector hints |
| GitHub **private advisory** delivery for sensitive fixes on public repos | replaces "held + typed confirmation" |
| **Batching** (`weekly` cleanup PRs, one commit per finding) | review attention at fleet scale |
| Read `check_status.recommendedMaxConcurrent` | slots that follow the shared backend's memory |
| Web push for sensitive findings, PRs and alerts | as Newsdesk and Touchstone |
| Override review beside the policy prose | tighten policy from real decisions |
| Fleet onboarding in waves with `armed: false` | judge each check's noise before anything is submitted |
