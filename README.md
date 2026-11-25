# Lamplighter

**A self-hosted maintainer for a fleet of repositories.** Lamplighter walks its rounds over every
repository it is given (on a schedule, or when someone pushes), looks for what has gone dim (stale
docs, vulnerable or outdated dependencies, dead code, bad patterns, architectural drift, security
holes) and either fixes it, proposes a fix, or writes up what it found. A person decides what lands.

> A lamplighter walked the same streets every evening, lit what had gone out and trimmed what was
> guttering. Nobody noticed the work, only when it stopped. That is the job: routine upkeep that
> only gets attention once it is missing.

> Status: **v1, first reviewable version (2026-11-19).** Runs as one container with its admin MCP.
> This README is what and why; [`docs/architecture.md`](docs/architecture.md) is the model;
> [`docs/implementation.md`](docs/implementation.md) is how it is built, what v1 covers, and how to run it.

---

## What it is

Lamplighter is the third tool in the same family as **Touchstone** (judges apps against a
standard, and its *workshop* repairs them) and **Newsdesk** (an LLM proposes, a person approves,
only then does anything publish). It takes Touchstone's loop and workshop, and Newsdesk's desk,
and points them at code:

```
   TRIGGERS                       LAMPLIGHTER                          FORGES
┌───────────────┐   ┌──────────────────────────────────────┐   ┌──────────────────┐
│ cron (rounds) │   │ scheduler · queue · budget           │   │ GitHub  (PR)     │
│ GitHub webhook│──▶│ bare clones in its own state folder  │──▶│ Gitea   (PR)     │
│ Gitea webhook │   │ detectors → findings → dedup/memory  │   │ bare git (branch)│
│ git poll      │   │ proposals → validation → delivery    │   └──────────────────┘
└───────────────┘   │ Activity · Chat · MCP · Settings     │
                    └──────▲────────────────────┬──────────┘
            workspace tools│(session token)     │ inference (Settings → Inference)
                           │                    ▼
                    ┌──────┴───────────────────────────────┐
                    │ any LLM backend, shared:             │
                    │  claude-code  — MCP query_claude     │
                    │  openai       — /chat/completions    │
                    │  text         — same, no functions   │
                    └──────────────────────────────────────┘
```

The model never gets a clone or a credential. Each session (a review, a fix, a validation) gets a
worktree inside Lamplighter and a token for a small toolset (list, read, grep, git log/diff,
record a finding, write a file, finish). An agentic backend such as claude-code calls those tools
over HTTP; a plain function-calling API gets them as functions and Lamplighter runs the loop. Git,
pushes, PRs and forge tokens stay in Lamplighter.

Expected scale: **around 200 repositories** (personal ones plus the Yundera and NSL.sh orgs),
public and private, across GitHub, Gitea and plain git remotes.

## The checks

Nine kinds of check, each a file on the data volume (prompt, detectors, defaults) rather than code,
so they can be tuned without a rebuild, the same way Touchstone's protocols are:

Every check takes every delivery mode. The column below is only the seeded default; the maintainer
picks `report`, `branch`, `pr` or `push` per check (globally, per group, per repo).

| Check | Found by | Default delivery |
|---|---|---|
| `docs`: README/CLAUDE.md/docs drift from the code | diff since last doc touch + LLM | **push** |
| `cve`: known vulnerabilities in dependencies | OSV over the lockfile | **report** (a fix bumps the manifest; `npm install` refreshes the lockfile) |
| `deps`: outdated dependencies | npm registry lookup | **report** (same) |
| `dead-code`: unused exports, files, deps | LLM, proving each one with grep | **pr** |
| `refactor`: duplication, oversized units | LLM | **pr** |
| `quality`: cleaning, consistency, lint debt | LLM | **pr** |
| `patterns`: known bad patterns, anti-idioms | LLM | **pr** |
| `architecture`: structure, boundaries, drift | LLM only | **report** (a fix is a small structural step) |
| `security`: design-level and code-level review | LLM | **branch**, private (see below) |

Where a deterministic tool can detect something, the tool detects it and the LLM judges and fixes.
Where only a model can see it, the model does both, and the result is held to the same validation.

## How it works, in one paragraph per step

1. **Rounds.** The scheduler keeps one queue. Pushes arrive by webhook (GitHub, Gitea) or by
   polling (bare git) and get the cheap, **diff-scoped** checks. Full-repo passes of the expensive
   checks (architecture, security, refactor, dead code) rotate across the fleet, stalest first, on
   a budget. With 200 repos the budget decides what runs, not the clock.
2. **Findings.** A round produces findings. Each has a stable fingerprint, and the next round
   recognises "the same thing as last week" semantically, not by line number. A finding that a
   person **dismissed with a reason** stays dismissed until what it was about changes.
3. **Proposals.** When a check's delivery is anything but `report`, a fixing session writes a
   change in a throwaway worktree and Lamplighter commits it. **The session that wrote a fix
   never judges it**: a fresh, independent session reviews the diff and must find the issues gone
   and nothing new. With the sandbox on, the fix is also judged by the repository's own tests, run on
   the base and on the proposal in fresh containers, and by the scanners run again on both.
4. **Delivery.** Per check, per repo group, per repo, for every check alike: `report` (the round's
   report lands in Activity, no code), `branch`, `pr` or `push`, each
   with an *auto-submit* switch saying whether a person approves first. Bare git has no PRs, so
   it is `branch` or `push` only. Each forge holds one credential per account (you, an org, a
   bot), set in Settings → Forges, Touchstone-style (write-only, checked on save). A repo uses
   the credential pinned on it or its group, else the one that may push there; a repo no
   credential can push to is **blocked from fixing** (rounds and reports only) and says so in the UI.
5. **Activity.** Everything that needs a person lands in Activity, Newsdesk-style: a PR to
   review, a branch to merge, a report to read, a proposal to approve, an alert. Each item has its
   actions inline (approve, reject, dismiss with reason), and every decision is recorded
   next to what the model proposed, so the policy can be tightened from real overrides.

## Security findings on public repositories

Half the fleet is public. A pull request titled *"fix SQL injection in /login"* on a public repo
discloses the hole before the fix ships, so for any repo the forge reports as public:

- `security`, and any `cve` the triage rates as reachable, **never reach the public remote as
  readable text**: no PR, no issue, no descriptive branch name, no commit message saying what was
  wrong.
- The finding lives in Lamplighter's Activity. The fix is prepared and validated, then **held**
  in Lamplighter with its patch for a person to review; delivering it is a typed-confirmation
  decision, and its commit message is neutral (`chore: maintenance`). Delivery into a GitHub
  private security advisory is planned.
- Private repos follow the normal delivery switches.

## The web UI

| Page | What it is for |
|---|---|
| **Chat** (front page) | the administrator chat: ask about any repo, request a round, edit policy; decisive actions (merge, push, delete a branch) need a typed confirmation, the same as Newsdesk's |
| **Repos** | the fleet: every repo with a light per check (lit, dim, out, never run), filters by group/forge/visibility; a repo page shows findings, rounds, proposals and its policy |
| **Activity** | the inbox of things awaiting a person, and below it the log of everything that happened |
| **Settings** | forges and credentials, groups and policy inheritance, check defaults and delivery switches, schedule, queue and budget, the inference endpoint (driver, URL, token, Test), the admin MCP token |

## MCP

Lamplighter is administrable over MCP (announced to Beacon through a `beaconify` sidecar, as
Touchstone and Newsdesk are): read the fleet, findings, rounds and the activity log; request a
round; edit policy and check settings; dismiss a finding with a reason; reject a proposal that has
not been delivered. **It cannot approve, merge, push or delete**, nor reject a delivered one (that
deletes its branch on the forge). Those belong to a person in Activity, or to the chat with a typed
confirmation.

## What it is not

- **Not Dependabot or Renovate.** Bumping a version is easy. What Lamplighter adds is fixing the
  code a major bump breaks, and judging whether a CVE matters to *this* code.
- **Not CI.** It does not gate merges or run on every PR. It keeps the main line well maintained.
- **Not a code host.** It keeps mirror clones for working in, and the forge remains the source
  of truth.
- **Not multi-tenant.** One operator, one fleet.

## Running it

Locally, against the local claude-code container through the local Beacon:

```bash
docker compose -f deploy/dev/docker-compose.yml up -d --build                  # http://localhost:8095
docker compose -f deploy/dev/docker-compose.yml --profile gitea up -d          # + a Gitea on :3300
docker compose -f deploy/dev/docker-compose.yml --profile mcp up -d            # + admin MCP on Beacon
docker exec lamplighter-dev seed-fixtures /DATA/fixtures                       # fixture repos with planted problems
```

Then **Settings → Forges** (a `git` forge with base `/DATA/fixtures`), **Repos → Add**, and run a
round. On a Yundera box, install `Apps/Lamplighter/` (this repo is its own one-app store); it
points at the box's Beacon and claude-code out of the box. Details in
[`docs/implementation.md`](docs/implementation.md).

## Status and roadmap

| | Contents |
|---|---|
| **v1** ✅ | GitHub / Gitea / bare git, bare clones, polling + webhooks + loop guard; nine check files; OSV and npm detectors; LLM review, fix and independent validation sessions through a workspace toolset; claude-code, OpenAI-compatible and text-only drivers; findings with dedup and dismissal memory; delivery report / branch / PR / push with approve, reject, merge, revert and PR follow-up; scheduler with tiers, debounce, slots, session budget and attention caps; Chat, Repos, Activity, Settings; admin MCP |
| **0.7** ✅ | the session sandbox: a credential-free container per session (docker-socket-proxy, buildpack-deps + mise, caches on volumes) with a `run` tool; mechanical validation on base and proposal; scanners in their official images (osv-scanner, Gitleaks) with SARIF; re-scan of every proposal; `osv-scanner fix` in fixing sessions, so `cve`/`deps` fixes refresh the lockfile |
| **next** | sandbox hardening (egress allowlist, gVisor); GitHub private advisories; batching of cleanup PRs; web push; policy-from-overrides review; onboarding the ~200-repo fleet in waves |
