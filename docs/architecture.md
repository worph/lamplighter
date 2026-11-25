# Lamplighter: architecture

**Status: v1 built, 2026-11-19.** Decisions are in §1. Where v1 implements less than this document
describes, the section says so in a **v1:** note; everything else is how the code works. The
session sandbox (D8, §10.1) is built since **0.7.0, 2026-11-25**; a **v1 mode:** note says what a
box without it does. The reasoning and the measurements behind it are in
[study-sandbox.md](study-sandbox.md).

---

## 1. Decisions taken

| # | Question | Answer |
|---|---|---|
| D1 | Forges | **GitHub, Gitea, and bare git.** Bare git is branch-or-push only: there is no PR. |
| D2 | Executor | **A shared inference endpoint, configured like the siblings** (Settings → Inference; seeded from env). On yunderalabs it is the same claude-code container Touchstone uses, through the box's Beacon. Lamplighter is standalone and talks to no other app. *Revised 2026-11-19:* an own worker sidecar on a shared clone volume was the first answer. |
| D2a | Code access | **Lamplighter clones and keeps every repo in its own state folder.** The model never gets a clone: it works through a **session-scoped workspace toolset** Lamplighter exposes (§10), Touchstone's workshop model. |
| D2b | Inference coupling | **Pluggable, nothing claude-code-specific above the driver.** Three drivers: `claude-code` (MCP `query_claude`, agentic, reaches the workspace over HTTP), `openai` (any OpenAI-compatible `/chat/completions` with function calling; Lamplighter runs the tool loop) and `text` (the same loop over an endpoint with no function calling, such as Claude Code's OpenAI API; the tools travel in the prompt). |
| D3 | Scale | Designed for **~200 repositories**: personal ones plus the Yundera and NSL.sh orgs. |
| D4 | Visibility | **Both public and private.** Visibility is a first-class repo property, read from the forge, and it changes what delivery is allowed (§9). |
| D5 | First tenants | Not decided. Onboarding is M8; nothing in the design depends on which repos come first. |
| D6 | Delivery modes | Per check type, like Touchstone's workshop switches: `report`, `branch`, `pr`, `push`, plus *auto-submit* and *armed*. |
| D7 | Review flow | Branches and PRs raise an item in **Activity** for a person to act on, the Newsdesk flow. |
| D8 | Running repo code | **A container per session** (the sandbox, §10.1), driven from outside through the Docker API. The agent stays outside; only its tools run inside. Credential-free: what it protects is the forge tokens, and only that. Shell and network allowed inside. No image of our own: an official base plus toolchains installed on demand. *Decided and built 2026-11-25 (0.7.0).* It replaced the "runner sidecar" first planned. |

---

## 2. Vocabulary

The family's habit is to be careful with words and rename before building, not after.

| Term | Meaning |
|---|---|
| **forge** | where a repo lives and how to talk to it: `github`, `gitea`, `git` (a bare remote URL, SSH or HTTPS). One configured forge = one host, holding one **credential** per account Lamplighter speaks as there (you, an org's token, a bot). |
| **repo** | one monitored repository on one forge, with a tracked **line** (the branch Lamplighter keeps well: usually the default branch). Identity: `<forge>~<owner>/<name>`, e.g. `github~worph/Touchstone`. `~` for the same reason as Touchstone: it survives `encodeURIComponent`. |
| **group** | a set of repos that share policy and defaults: typically an org (`yundera`, `nsl`, `worph`). A repo belongs to exactly one group. Settings inherit **default → group → repo**. |
| **check** | one kind of upkeep: `docs`, `cve`, `deps`, `dead-code`, `refactor`, `quality`, `patterns`, `architecture`, `security`. Each is a file, `data/checks/<kind>.md` (§5). |
| **lamp** | the state of one check on one repo: *lit* (clean as of a recent round), *dim* (open findings), *out* (failing/blocked), *unlit* (never run). The Repos page is a grid of lamps. |
| **round** | one run of one check against one repo **at one commit**, with a **scope**: `diff` (the commits since the last round) or `full`. A round writes a report and produces findings. It never changes code. |
| **finding** | one issue a round raised, with a **fingerprint** (§6) that survives line moves and re-wording. Lifecycle: `open → (dismissed | proposed | fixed | gone)`. |
| **dismissal** | a person saying *won't fix*, with a reason. It holds until the finding's **input** changes (the file(s) it is about, or the check's revision). Touchstone's task memory, applied to findings. |
| **proposal** | one candidate change to one repo, addressing one or more findings of one check. Lifecycle in §7. A proposal **never judges its own work**. |
| **validation** | what can make a proposal `ready`: the repo's build/test/lint, plus a **confirming round** (§7.3). |
| **delivery** | how a ready proposal lands: `report` (none), `branch`, `pr`, `push`. |
| **activity item** | something that needs a person: a proposal to approve, a PR/branch to review, a report to read, an alert. Activity is also the log of everything that happened. |
| **policy** | prose, per group and per repo, telling the checks what this codebase considers acceptable, the way Newsdesk's charter is prose. Plus the repo's own `LAMPLIGHTER.md` and `CLAUDE.md`, read as context. |
| **session** | one model run against one worktree (a review round, a fixing session or a validation session), with its own token and toolset (§10). A **slot** is one concurrent session. |
| **sandbox** | the credential-free container a session's tools run in, for the session's whole life (§10.1). |
| **budget** | what the scheduler may spend: agent sessions per hour, and **attention**: open activity items and deliveries per hour (§8.3). |

---

## 3. Invariants

These are the rules the design is built around. Code that breaks one is a bug even if it works.

1. **The agent never touches a remote.** The model edits a worktree, through the workspace tools, and nothing else. Every
   fetch, push, branch creation, PR and deletion is done by the backend through one guarded forge
   client. A force-push cannot be written with it: there is no `update ref` call, only
   *create branch*, *delete own branch*, and (for `push` delivery) *fast-forward the line*.
   A forge token never enters a sandbox (§10.1): its clone has no remote.
2. **The fixer never judges its own work.** A proposal becomes `ready` only through validation run
   separately from the authoring session: commands the repo declares, and a confirming round in
   a fresh agent session.
3. **No regression.** A proposal may not introduce a finding of any check that its base commit did
   not have, nor break a build or test that passed on the base (Touchstone's D7′).
4. **Lamplighter ignores itself.** Commits it authored (identified by a `Lamplighter-Round:`
   trailer and the bot author) and branches under its prefix (`lamplighter/…`) never trigger
   rounds. Without this, an auto-pushed docs fix triggers a docs round on its own commit, and so on
   indefinitely.
5. **Nothing security-sensitive reaches a public remote as readable text** (§9).
6. **Infra failure is not a finding.** A clone that fails, a dead or logged-out inference backend, a timeout is
   an *alert* and a `blocked` round. It never opens or closes a finding and never burns a repo's
   retry budget (Touchstone's 2026-08-05 lesson).
7. **A dismissal holds until its input changes.** Re-raising a dismissed finding against the same
   input is a bug, not a judgement call.
8. **Attention is a budget.** The scheduler may not open a PR, push a branch or raise an item past
   the attention caps, however much token budget is left.
9. **MCP cannot decide.** The admin MCP reads, configures, requests and dismisses, and may reject
   a proposal that has not left Lamplighter (saying no changes no repository). It cannot approve,
   merge, push or delete, and it never acts on a forge, so a delivered proposal is rejected only by
   a person in Activity, or the chat with a typed confirmation.
10. **Diagnosable with every port broken.** No forge, no inference, no network: the app still boots,
    serves its UI, and says what is wrong.

---

## 4. Components

```
lamplighter (backend, one Node process)
├── forges/        GitHub · Gitea · git adapters behind one ForgeClient interface
├── registry/      repos, groups, inherited settings; forge discovery (list an org)
├── mirror/        bare mirror clones on /DATA/repos, worktrees on /DATA/work
├── triggers/      webhook receivers (GitHub, Gitea), poller (ls-remote for bare git), cron
├── scheduler/     the queue, tiers, budget, slots, debounce
├── rounds/        detector runs + the agent call for a round; report writer
├── findings/      fingerprinting, dedup, lifecycle, dismissals
├── workshop/      proposals: authoring session, validation, delivery
├── activity/      items, actions, the event log, web push
├── chat/          administrator chat (the Touchstone/Newsdesk loop)
├── mcp/           admin MCP server + the session workspace (MCP and plain HTTP)
├── sandbox/       session containers through the Docker API: clone in, exec, patch out, scanners, caches
└── web/           React SPA: Chat · Repos · Activity · Settings

lamplighter-mcp    (beaconify sidecar: announces the admin MCP to Beacon)
lamplighter        (AppShield sidecar: SSO in front of everything, /hooks included)
lamplighter-docker (docker-socket-proxy sidecar: the only holder of the socket; §10.1)

inference backend  (external, shared: claude-code via Beacon, or any OpenAI-compatible API)
```

The backend holds **forge credentials**, unlike Newsdesk, which holds none. It has to, because
pushing and opening PRs are the product. They are fine-grained, one per account or owner on a forge,
scoped to the repos in the registry, each repo using the one pinned on it or its group or else the
one that may push there, and never handed to the model (invariant 1).

---

## 5. Checks are files

`data/checks/<kind>.md`, frontmatter plus a prompt body, on the volume, not in the image (the
lesson from Touchstone's rubric: a copy in the image drifts from every box). Seeded from the
image on first boot. At each boot, a file still byte-identical to a seed some release shipped
(`seed/checks/history.json`) is replaced by this release's seed; a file someone edited is theirs
and stays (since 0.7.1).

```markdown
---
kind: cve
revision: 3                 # bumping it re-eligibles every repo for a full round
scopes: [diff, full]        # which scopes make sense for this check
cadence: { full: 7d }       # how stale a full round may get before it is due
detectors:                  # deterministic tools run before the agent, output handed to it
  - name: osv-scanner         # an official image, run in the sandbox against the clone
    image: ghcr.io/google/osv-scanner:v2.7.1@sha256:…
    run: [scan, source, -r, /work/repo, --format, json]
    format: osv-json          # or sarif, which most scanners emit
    ok_exit: [1, 128]         # exit codes that mean "ran"
    fallback: osv             # the built-in that runs without the sandbox
fix_tools:                    # static binaries copied onto a fixing session's PATH
  - { image: "ghcr.io/google/osv-scanner:v2.7.1@sha256:…", path: /osv-scanner }
agent: triage               # none | triage | review: how much of the round is the model
delivery:
  mode: pr                  # report | branch | pr | push
  auto_submit: false        # true: passing validation is the approval
  batch: per-finding        # per-finding | per-round | weekly
  sensitive: when-reachable # never | when-reachable | always (§9)
---
You are triaging vulnerability reports for one repository…
```

- **Detectors** run before any agent call, and before anything is installed. Their output is
  attached to the round; a check with `agent: none` produces findings from detectors alone, and a
  review check gets them as hints to verify. Two kinds: a tool's **official image**, run in the
  sandbox against the session's clone read-only (seeded: osv-scanner for `cve`, Gitleaks for
  `security`), reading **SARIF** or osv-scanner's JSON, so a new scanner is a few lines in a check
  file, not code; and two **built-ins** run in Lamplighter itself, `osv` (package-lock.json against
  api.osv.dev) and `npm-outdated` (direct dependencies against the npm registry). **v1 mode:** an
  image detector runs its `fallback` built-in, or is reported as not run, never as clean.
- **`agent: triage`**: the model gets detector output and decides which items are real.
  **`agent: review`**: the model reads the code itself; detectors are hints.
- **Revision** works like Touchstone's *standard in force*: a finding raised under an older revision
  carries an `older check` chip, and the check moving makes its repos eligible for a full round.

Default shape of the nine:

| Check | `agent` | scopes | default delivery | batch |
|---|---|---|---|---|
| docs | review | diff, full | push, auto | per-round |
| cve | triage | diff, full | pr | per-finding |
| deps | none → review on major | full | pr | patch+minor weekly; major per-finding |
| dead-code | triage | full | pr | weekly |
| refactor | review | full | pr | weekly |
| quality | triage | diff, full | pr | weekly |
| patterns | triage | diff, full | pr | weekly |
| architecture | review | full | report | n/a |
| security | review | diff, full | branch, sensitive: always | per-finding |

The default delivery is only a seed: **every check accepts every mode** (`report`, `branch`, `pr`,
`push`), chosen by the maintainer per check, group or repo. No check is report-only by nature.

`deps` is a registry lookup and nothing else until a bump breaks the build: only then does an
agent session start, to fix the breakage. That is the part Renovate does not do.

---

## 6. Findings

### 6.1 Fingerprint

Line numbers move and wording varies, so a finding is identified by:

```
fingerprint = hash(check kind, rule/category, primary symbol or file path, normalised claim)
```

- **Detector findings** have a natural key (`CVE id + package`, `unused export X in file Y`).
- **Agent findings** are asked for a `category` from the check's closed list and an `anchor`
  (symbol, file, or module). Then, like Newsdesk's managing editor, **one dedup call** compares new
  agent findings against the open and dismissed findings for that repo and check, and links what
  matches. Same anchor + same category is the fast path. The model decides only the rest.

### 6.2 Lifecycle

```
          ┌──────── round no longer finds it ─────────► gone
open ─────┼──────── person dismisses (reason) ────────► dismissed ─(input changed)─► open
          └──────── proposal created ─► proposed ─► fixed (on the line) │ back to open (rejected)
```

- **gone** vs **fixed**: *fixed* means a Lamplighter proposal landed; *gone* means someone else
  fixed it, or the code was deleted. Both are recorded so the override rate is honest.
- A finding's **input** is the set of file blob hashes it anchors to, plus the check revision.
  A dismissal stores the input; it re-opens only if the input differs (invariant 7).

### 6.3 Reports

Each round also stores a markdown report on its round row (the `report` column) for a person
to read. The database stores findings as rows; the report is the narrative around them. When a
check's delivery is `report`, the report is what the maintainer gets: an Activity item for each
round that surfaced new or reopened findings, and for every full LLM review. A newer one
supersedes the unread one for the same repo and check.

---

## 7. Proposals (the workshop)

### 7.1 Lifecycle

```
drafting → validating → ready → (awaiting approval) → submitted → landed | rejected | abandoned
                      ↘ failed (with reason; remembered against its input)
```

### 7.2 Authoring

1. The backend creates a worktree from the mirror at the round's commit:
   `/DATA/work/<proposal-id>`, on a local branch `lamplighter/<kind>/<slug>-<yyyymmdd>-<id6>`.
2. One agent session (`query_claude`, `workdir` = the worktree, `sessionId` = the proposal id) gets
   the findings, the check's prompt, the policy, the repo's `CLAUDE.md`/`LAMPLIGHTER.md`, and the
   commands it may run. It edits files and may run the repo's build/tests to iterate. It
   **commits nothing**. The backend commits, so authorship and the trailer are not up to the model.
3. Bounded: a round count and a wall-clock cap. A session that ends without a diff is `failed`, not
   retried in a loop.

### 7.3 Validation

Run after the authoring session, as separate steps:

Cheapest first, stopping at the first failure; the confirming round comes last because it is the
only step that costs tokens. **v1 mode** (no sandbox): step 1 is skipped, step 2 runs the
built-in detectors only, and the model has file tools, so a `cve`/`deps` fix cannot refresh a
lockfile.

1. **Mechanical.** The repo's commands (`LAMPLIGHTER.md` → `sandbox.test`, else detected: `npm test`,
   `python -m pytest`, `go test ./...`, `cargo test`) on base and on the proposal, each side in a
   **fresh** sandbox (`mise install`, the install steps, then each command): the fixer's own green
   runs do not count (invariant 2). The commands and the image are read from the **base**, so a fix
   cannot change how it is judged. Anything that passed on base must pass on the proposal. Base
   results are cached per `(repo, sha, command, image)` (`command_runs`); red on base does not gate
   but is reported; a head failure is re-run once to rule out a flaky test.
2. **Cross-checks.** The proposal's own check's detectors and the `cve` detectors, whatever the
   kind (a refactor can pull in a dependency), on base and on the proposal. An addressed finding a
   scanner raised must be gone from the proposal — for a CVE, the deterministic proof — and the
   proposal may not raise anything the base did not. A registry hiccup in a built-in skips this
   step; it never fails a proposal (invariant 6).
3. **Confirming round.** A fresh session runs the same check at `diff` scope on the proposal.
   The addressed findings must be gone and no new finding may appear (invariant 3).

The results go on the proposal (`validation.mechanical`, `validation.scan`) and into the PR body
as evidence: commands, base against head, durations; for a CVE, the advisories come from OSV, not
from the model.

A repo whose tests cannot run (no command, toolchain missing) validates with the confirming round
alone, and its proposals are **never auto-submitted**, whatever the switch says.

### 7.4 Batching

Many small cleanup PRs waste review time, so `batch: weekly` checks accumulate validated changes
per repo and submit one *cleanup* proposal (one commit per finding, so a reviewer can drop
one). `per-finding` is for things that must not wait (CVE, major bump) or must not be mixed with
anything else (security).

---

## 8. Scheduling

### 8.1 Triggers

| Source | How | Produces |
|---|---|---|
| GitHub | org/repo webhook `push` on the line → `POST /hooks/github/<forge>` (HMAC verified) | `diff` rounds of every check with `diff` in its scopes |
| Gitea | org/repo webhook `push` → `POST /hooks/gitea/<forge>` | same |

**Behind AppShield (the store listing) webhooks cannot arrive:** the store opens no machine path
through the gate (`appshield-wiring`), so a Yundera box relies on polling. The receivers stay for
deployments that route `/hooks/*` to the backend themselves.
| bare git | `git ls-remote` poll per repo, interval from settings (default 15 min) | same |
| rotation | the scheduler tick | `full` rounds, stalest first (§8.2) |
| request | a person, the chat, or MCP `request_round` | goes to the front, like Touchstone's requests |
| forge events | PR/branch status poll | proposal state changes, cleanup |

**Debounce:** pushes to one repo within `debounce_min` (default 2) coalesce into one diff round
covering the whole range. Commits matching invariant 4 are dropped before they are queued.

### 8.2 One queue, tiers

Touchstone's model, copied. **Foreground** first (what a person asked for, FIFO), then
**background** by tier:

1. `cve` / `security` diff rounds (new code, possibly new holes)
2. other diff rounds
3. proposals: authoring and validation of what rounds already found
4. full rounds whose check revision moved
5. full rounds that are past their cadence, stalest first
6. full rounds that are merely the oldest (filler: idle capacity has nothing better to do)

### 8.3 Budget

At 200 repos × 9 checks, a weekly full pass alone is 1,800 rounds a week. The budget, not the
cadence, sets the pace:

- **agent sessions per hour** (rolling, `schedule.sessions_per_hour`, default 2): usage (tokens,
  cost, wall time) is recorded per session and per proposal (Touchstone's `onUsage`), and
  background work waits while the last hour's budget is spent. Hourly rather than daily, so a
  backlog drains steadily instead of in one burst that hits the backend's own rate limit.
- **slots**: concurrent sessions against the shared backend, a configured number bounded by its memory (each
  `claude -p` is ~400 MB). **v1:** `schedule.slots`, default 2; background work stops at the session budget, requests do not.
- **attention**: max open activity items per repo, max pushes/PRs/branches per rolling hour across
  the fleet (`schedule.deliveries_per_hour`, default 2). An auto-submit held back by the hourly cap
  waits ready, and the tick delivers it once the hour allows (a person may approve it sooner); no
  new proposal starts on a repo at its item cap.
- **detectors are cheap**: rounds with `agent: none` (deps) or detector-only fast paths do not
  draw on the token budget, so they can run fleet-wide daily.

---

## 9. Delivery per forge, and the sensitive path

| Mode | GitHub | Gitea | bare git |
|---|---|---|---|
| `report` | activity item only | same | same |
| `branch` | push `lamplighter/…` to origin | same | same |
| `pr` | branch + PR, label `lamplighter` | branch + PR, label `lamplighter` | **not available**, falls back to `branch` |
| `push` | fast-forward the line | same | same |

- **`push` is fast-forward only**, onto the tracked line, and every push has a **Revert** action in
  Activity (which is itself a proposal, so it is validated too).
- **Branches are Lamplighter's to clean**: deleted when the PR is merged or closed, or when a
  `branch` item is resolved in Activity. Only branches under `lamplighter/` can be deleted by the
  client at all.
- **Bare git approval**: for `branch` delivery on a bare remote, the Activity item carries a diff
  view and a **Merge** action (typed confirmation) that fast-forwards the line if it still can,
  and otherwise reports that the line moved and offers a rebase proposal.
- **Commits** are authored as `Lamplighter <bot address>` with trailers
  `Lamplighter-Round: <id>` and `Lamplighter-Check: <kind>`.

### 9.1 Sensitive findings

A finding is **sensitive** when its check says `sensitive: always` (security), or
`when-reachable` and triage rated it reachable (cve). On a repo the forge reports as **public**:

- No PR, issue, comment, branch name or commit message on the public remote describes it.
- **GitHub**: the proposal is delivered into a **private security advisory** (draft GHSA with its
  temporary private fork), if the token can. Otherwise, as on the others:
- **Gitea / bare git / no advisory permission**: the proposal is held in Lamplighter as a
  validated patch and a local branch. Activity offers *download patch* and, with typed confirmation,
  *push with a neutral message* (e.g. `chore: maintenance`), which is a person's decision to make.
- On **private** repos sensitive findings follow normal delivery, but are still flagged
  `sensitive` in Activity and the MCP.
- Visibility is re-read from the forge before every delivery. A repo that went public since the
  round was queued is treated as public.

---

## 10. Inference and the workspace

There is no worker of Lamplighter's own. Inference is a shared endpoint configured in Settings
(seeded from `LAMPLIGHTER_INFERENCE_*` on first boot, written back to `config.yaml`), and the
repository reaches the model only through the **workspace toolset** of one session.

**A session** (a review round, a fixing session, or a validation session) is:

1. a detached `git worktree` of Lamplighter's bare clone, at one commit, under `/DATA/work/<id>`;
2. a random token, alive for the session's timeout plus ten minutes, held in memory only;
3. one driver call; then the worktree is removed and the token forgotten.

**The toolset** (`tools/workspace.ts`), identical for every driver:

| Tool | In | What |
|---|---|---|
| `list_files(glob?)`, `read_file(path, start_line?, end_line?)`, `grep(pattern, glob?)` | all | read the worktree |
| `git_log(limit?, path?)`, `git_diff(path?, stat?)` | all | history; the session's diff range (diff review, validation) or the fixer's own edits |
| `record_finding(category, anchor, title, body, severity, existing_id?)` | review, validation | `existing_id` is how the model links a repeat (the semantic half of dedup) |
| `write_file(path, content)`, `delete_file(path)` | fixing only | the only way code changes |
| `finish(summary)` / `cannot(reason)` | all | end the session; a fix's summary becomes the commit and PR text |

Paths are resolved inside the worktree and `.git` is refused (Touchstone's `checkRel`).

**Three drivers** (`inference/`), one interface:

- **`claude-code`**: `query_claude` over MCP, `via: beacon` (wrapped in the aggregator's `call`
  tool, with `__beacon_timeout`) or `direct`. The backend is agentic and has a shell, so the prompt
  ends with an HTTP section: `POST <public_url>/api/v1/ws/<tool>` with `x-session-token`, plain
  text back. The same tools are also served as MCP at `/api/v1/mcp/workspace` (token in the
  arguments) for a backend that would rather speak MCP. `public_url` must be reachable *from the
  backend*: `http://lamplighter-backend:8080` on `pcs`, `http://localhost:8095` for the local
  host-networked claude-code.
- **`openai`**: any OpenAI-compatible `/chat/completions` with function calling. Lamplighter
  offers the tools as functions, executes each call in-process, and loops until `finish`, an
  answer with no tool call (one nudge), the round cap or the clock.
- **`text`**: the `openai` loop for an endpoint that is text in, text out — first of all
  claude-code-container's OpenAI API, used where its MCP endpoint is off. The tools are described
  in a system message; the model ends each answer with a fenced `tool` block (a JSON array of up
  to eight calls), and Lamplighter answers with `<result>` elements. The backend needs no route
  back to Lamplighter. Each request also narrows Claude Code through that API's own body fields
  (`permission_mode: default`, its own tools disallowed), so repository content cannot steer it
  into a shell or the box's other MCP servers. Every turn is a fresh `claude -p`: slower per turn
  than the agentic driver, and the transcript is resent each time.

**Failures are the backend's, not the repo's** (invariant 6): unreachable, refused credentials,
a dead login (claude-code answers "Failed to authenticate…" as ordinary text, which the driver
recognises), a timeout, or a session that ended **without a single workspace call** (the
callback URL is wrong) all make the round `blocked` and open one deduplicated alert. None of
them opens or closes a finding.

**Untrusted code:** v1 runs nothing from the repository. Running it is the sandbox's job (§10.1).

### 10.1 The session sandbox

Built in 0.7.0 (D8), `server/src/sandbox/`. Measured first in two spikes on holyhorse, 2026-11-25
([study-sandbox.md](study-sandbox.md) §9); its Docker tests (`LAMPLIGHTER_TEST_DOCKER`) run
against a real engine.

**Shape.** Every session, a docs round included, gets one container for its whole life. The agent
and its driver stay where they are (§10); the workspace tools run against the container instead
of a local worktree:

- Lamplighter drives it **from outside through the Docker API**: files in and out through the
  archive API, one `exec` per tool call. `read_file`, `grep` and `write_file` act on the
  container's filesystem, and `run(cmd)` (a shell) is one more tool. Nothing of Lamplighter's
  is in the image: it needs `/bin/sh` and nothing else.
- Lamplighter builds the copy-in tar itself, **owned by the sandbox user**: `docker cp` keeps the
  source uid, and with every capability dropped even root cannot write files it does not own.
- Tool calls use the archive API or `sh -c`, **never a login shell**: on an image whose profile sets
  up its toolchains, that costs 3.5 s per call against 0.35 s.
- The clone arrives as a `git bundle` of the host worktree's history, cloned inside, remote
  removed. At the end of a fixing session the change comes back as a binary patch
  (`git diff --cached --binary`, dependency folders excluded), is applied to the host worktree, and
  Lamplighter commits it there as before (invariant 1). The container and its volume are removed;
  any left by a crash are reaped at boot (label `lamplighter.sandbox`).
- Every sandbox session — review, fixing, confirming — has `run`; only a fixing session's changes
  are read back. One call is capped by `run_timeout_s` and the session's remaining time; its output
  is cut in the middle to what every driver returns whole.

**What keeps the token out** (the only thing it protects; repository code reaching the model is
not a threat it designs against, since the model already reads it):

- no environment from Lamplighter, no `/DATA`, no host bind of any kind, no Docker socket;
- a clone **with history** (`git log`, `git blame` are useful once there is a shell) and **no
  remote**; the token travels per command as `http.extraHeader` and is never stored in the
  mirror. A test asserts the sandbox's `.git/config` carries no credential;
- **its own Docker network, not `pcs`**, so a prompt-injected agent cannot call Beacon, claude-code
  or the admin MCP. Egress to the internet is allowed (installs, registries).

**Who holds the socket.** Not Lamplighter: the `lamplighter-docker` sidecar
(docker-socket-proxy), limited to the containers, exec, images, volumes and networks endpoints,
on a compose network with no route out, which Lamplighter calls with `dockerode`. Anyone who
takes over Lamplighter already has the tokens, so the proxy protects the host. It filters by
endpoint, not by request body: "named volumes only, never a host bind" is enforced by
`sandbox/spec.ts`, the one place every container is built, and its test.

**Isolation.** Plain runc: a fixed non-root uid, `--cap-drop ALL`, `no-new-privileges`, CPU,
memory, pids, wall-clock and log-size caps. Our VPS boxes have no `/dev/kvm`, so microVMs are out.

**Image and toolchains.** Resolved per repo, first match wins:

1. `LAMPLIGHTER.md` frontmatter → `sandbox: { image, setup, install, test }` (container-use's
   fields, plus the test commands; each a string or a list);
2. `.container-use/environment.json`;
3. `.devcontainer/devcontainer.json` → its `image` only;
4. group default, then the global default: the official **`buildpack-deps:bookworm-scm`** (Debian,
   git, curl, CA certificates) plus **mise**, which installs each toolchain on demand at the
   version the repo's own files name (`.nvmrc`, `engines`, `.python-version`, `go.mod`…). mise's
   static binary is copied once from its official image into the shared mise volume, so there is
   no image of our own. Cold, Node 22 took 36 s and Python 3.12 14 s; warm, 1–2 s. mise checks
   the signatures or attestations of what it downloads.

The install step (`npm ci`, `pip install -r …` into `.venv`, `go mod download`…) is detected and
runs **lazily**: the prompt names it and the model runs it when it needs to; validation always
does. `setup` runs as the sandbox user (no root). A repo's CI workflows are never run.
All-in-one images (`codex-universal`: 43.7 GB, an hour to pull, root only, no licence) are
something a repo may name, never a default.

**Caches are volumes, not snapshots.** One shared volume for mise's toolchains and one per
ecosystem for the package manager (`~/.npm`, pip…), each handed once to the sandbox uid by a
helper with only `CAP_CHOWN`. Concurrent sessions share them: mise keeps lock files, and three
sessions installing the same Node at once all worked (one run). Past `cache_max_gb` (checked
daily) the package cache is emptied, the toolchains kept. `docker commit` is not used: it took 31
minutes on a large image under the containerd store, and it does not capture volumes anyway.

**Scanners and fix tools.** Detectors run in their **official images**, as the sandbox user,
against the session's volume mounted read-only, before anything is installed (so `node_modules`
and `.venv` are never scanned as the repo's own); the report is read from the container's output.
A SARIF snippet is never copied into a finding (a secret scanner's snippet is the secret). Fix
tools that call the package manager run **in the session container**, their static binary
copied from the official image into `/opt/tools`: `osv-scanner fix --strategy=relock` needs
`npm`. Measured: 23 vulnerabilities in acme-api, three bumps, tests green, re-scan clean.

**Failures** follow invariant 6: Docker unreachable, an image that cannot be pulled, a registry
down or a timeout make the round `blocked` and raise one alert. Head red where base was green makes
the proposal `failed`.

**Fallback.** `sandbox.enabled: false` (an install without the proxy, or an upgrade from 0.6)
keeps v1's in-process mode: nothing of a repository runs, image detectors fall back to built-ins,
and fixes cannot refresh a lockfile (invariant 10). Enabled but unreachable is not a fallback: the
round is blocked with an alert, so a broken proxy is not mistaken for v1.

**Where this stands.** It matches self-hosted CI runners (act_runner, the Forgejo runner, GitLab's
Docker executor, Renovate): a container per job, a small base, toolchains on demand, caches on
volumes. It is stricter than they usually are on privileges (no sudo, no capabilities, no token
in the job). It is one step below hosted coding agents (Copilot, Codex, Jules), which add a
**microVM** and an **egress allowlist**. Both are later hardening (§13), not prerequisites.

## 11. Activity, chat and MCP

### 11.1 Activity

Two halves on one page:

- **Inbox** (things awaiting a person), newest first, grouped by repo, filterable by check, group
  and `sensitive`. Kinds: `proposal-ready` (approve / reject / edit-and-approve),
  `pr-open` / `branch-open` (link, merge for bare git, close), `report` (read, mark read, turn into
  a proposal), `pushed` (revert), `alert`. Every item can be **dismissed with a reason**.
- **Log**: every round, finding change, proposal step, delivery, decision and alert, as events.

Every decision is stored next to what the model proposed (Newsdesk's override log). The repo
and group policy pages show recent overrides beside the policy prose, so the operator can tighten
the wording and watch the override rate fall.

Web push (as Newsdesk and Touchstone do) for: sensitive findings, CVEs, PRs opened, alerts.

### 11.2 Chat

The administrator chat on the front page reuses the Touchstone/Newsdesk loop as it is: the
backend owns the loop and the tools, the model picks one tool per step, every step is a stored
row, bounded calls and clock. It has the MCP's tools plus the decisive ones (approve, merge,
push, revert, delete branch), each requiring a typed confirmation.

### 11.3 Admin MCP

`/mcp/admin`, bearer-protected, announced by the `beaconify` sidecar. Proposed tools:

| Tool | Kind |
|---|---|
| `list_repos`, `get_repo`, `list_findings`, `get_finding`, `get_round_report`, `list_activity`, `get_schedule`, `get_budget` | read |
| `request_round(repo, check, scope?)` | request: queued, never run inline |
| `dismiss_finding(id, reason)`, `reopen_finding(id)` | judgement on a finding, not on code |
| `get_policy`, `set_policy(group|repo, prose)`, `get_check`, `set_check_settings` | configure, with restore points (Newsdesk's config history) |
| `add_repo`, `discover_repos(forge, owner)`, `set_repo_group` | registry |

`reject_proposal(id, reason)` for an undelivered proposal. No approve, merge, push, delete or revert (invariant 9). A read-only mode drops everything
below the first row.

---

## 12. Storage and configuration

- **SQLite** (`better-sqlite3` with plain SQL migrations in `db/migrations.ts`; drizzle was not
  needed at this size) for repos, groups, rounds, findings,
  dismissals, proposals, activity items, events, usage. Touchstone dropped findings-as-rows. Here
  they are the product, and dedup, lifecycle and dismissals are relational. better-sqlite3 has
  glibc prebuilds for amd64 and arm64, so the image stays Debian-slim without node-gyp.
- **Files on the volume** for what a person edits or reads: `checks/*.md`, `policy/<group>.md`,
  round reports.
- **`config.yaml`**: read at boot. Live **controls** (armed, auto-submit, budget, caps) write back
  into it, as Touchstone does since 2026-10-27, so the file always says what is running.
- One data root `/DATA`: `lamplighter.db`, `config.yaml`, `checks/`, `repos/` (bare clones, a
  cache that can be re-fetched) and `work/` (live session worktrees). Round reports are rows.
  **v1:** group and repo policy are rows edited in the UI, not files.

---

## 13. Open questions

1. **Sandbox hardening, later** (§10.1): an egress allowlist (registries, GitHub, mise's sources);
   gVisor where a box can install it; a proxy that also filters request bodies, so "no host bind"
   does not rest on Lamplighter alone; an LRU for the caches instead of emptying them; fixes for
   ecosystems `osv-scanner fix` cannot relock (PyPI not tried); `setup` steps that need root.
2. **Concurrency at 200 repos** is `schedule.slots` against one shared backend; the claude-code
   container advises a ceiling (`check_status.recommendedMaxConcurrent`) that v1 does not read yet.
3. **Monorepos with submodules** (yundera-root, meta-root-v2): proposed rule is that each submodule
   is its own repo in the registry and the meta-root's pointer bumps are ignored. To confirm.
4. **Policy precedence** when the repo's `LAMPLIGHTER.md` and the group policy disagree. Proposed:
   the repo file wins, because it is reviewed with the code.
5. **Advisory API reach**: whether the fine-grained token can create GHSAs on every org in scope.
6. **Gitea version** in use, for the webhook payload and PR label APIs.
7. **Naming**: *lamp* / *round* are proposals; rename before M2 if they read wrong.
