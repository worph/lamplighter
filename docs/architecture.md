# Lamplighter: architecture

**Status: v1 built, 2026-11-19.** Decisions are in §1. Where v1 implements less than this document
describes, the section says so in a **v1:** note; everything else is how the code works.

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
| **budget** | what the scheduler may spend: agent sessions per hour, and **attention**: open activity items and deliveries per hour (§8.3). |

---

## 3. Invariants

These are the rules the design is built around. Code that breaks one is a bug even if it works.

1. **The agent never touches a remote.** The model edits a worktree, through the workspace tools, and nothing else. Every
   fetch, push, branch creation, PR and deletion is done by the backend through one guarded forge
   client. A force-push cannot be written with it: there is no `update ref` call, only
   *create branch*, *delete own branch*, and (for `push` delivery) *fast-forward the line*.
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
└── web/           React SPA: Chat · Repos · Activity · Settings

lamplighter-mcp    (beaconify sidecar: announces the admin MCP to Beacon)
lamplighter        (AppShield sidecar: SSO in front of everything, /hooks included)

inference backend  (external, shared: claude-code via Beacon, or any OpenAI-compatible API)
```

The backend holds **forge credentials**, unlike Newsdesk, which holds none. It has to, because
pushing and opening PRs are the product. They are fine-grained, one per account or owner on a forge,
scoped to the repos in the registry, each repo using the one pinned on it or its group or else the
one that may push there, and never handed to the model (invariant 1).

---

## 5. Checks are files

`data/checks/<kind>.md`, frontmatter plus a prompt body, on the volume, not in the image (the
lesson from Touchstone's rubric: a copy in the image drifts from every box).

```markdown
---
kind: cve
revision: 3                 # bumping it re-eligibles every repo for a full round
scopes: [diff, full]        # which scopes make sense for this check
cadence: { full: 7d }       # how stale a full round may get before it is due
detectors:                  # deterministic tools run before the agent, output handed to it
  - run: osv-scanner --format json -r .
    when: [package-lock.json, yarn.lock, pnpm-lock.yaml, go.sum, requirements*.txt, poetry.lock]
agent: triage               # none | triage | review: how much of the round is the model
delivery:
  mode: pr                  # report | branch | pr | push
  auto_submit: false        # true: passing validation is the approval
  batch: per-finding        # per-finding | per-round | weekly
  sensitive: when-reachable # never | when-reachable | always (§9)
---
You are triaging vulnerability reports for one repository…
```

- **Detectors** run in Lamplighter itself, on the worktree, before any agent call. **v1:** two
  built-in detectors, `osv` (package-lock.json against api.osv.dev) and `npm-outdated` (direct
  dependencies against the npm registry); shell-command detectors need a runner and are later work. Their raw output is
  attached to the round. A check with `agent: none` produces findings from detectors alone.
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

**v1:** the model has file tools, not a shell, so step 1 does not exist yet and `cve`/`deps` are
report-only (a fix needs a lockfile regeneration). Validation is step 2: the confirming round.

1. **Mechanical.** The repo's declared commands (from `LAMPLIGHTER.md`, else detected: `npm test`,
   `go test ./...`, `pytest`, …) on base and on the proposal. Anything that passed on base must
   pass on the proposal.
2. **Confirming round.** A fresh session runs the same check at `diff` scope on the proposal.
   The addressed findings must be gone and no new finding may appear (invariant 3).
3. **Cheap cross-checks.** The `cve`/`deps` detectors and the `patterns` detectors run on the
   proposal regardless of its kind, because a refactor can pull in a dependency.

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

**Debounce:** pushes to one repo within `debounce_min` (default 10) coalesce into one diff round
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

**Untrusted code:** v1 runs nothing from the repository. The day a runner executes repo scripts
(tests, package managers) it belongs in a separate, credential-free container.

## 11. Activity, chat and MCP

### 11.1 Activity

Two halves on one page:

- **Inbox** (things awaiting a person), newest first, grouped by repo, filterable by check, group
  and `sensitive`. Kinds: `proposal-ready` (approve / reject / edit-and-approve),
  `pr-open` / `branch-open` (link, merge for bare git, close), `report` (read, mark read, turn into
  a proposal), `pushed` (revert), `alert`. Every item can be **dismissed with a reason** or
  **snoozed**.
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

1. **A runner for tests and scanners**: a credential-free sidecar that runs commands in a
   worktree copy (tests, `npm install` for lockfile fixes, semgrep, knip). It unlocks mechanical
   validation (§7.3 step 1) and lockfile regeneration for `cve`/`deps` fixes.
2. **Concurrency at 200 repos** is `schedule.slots` against one shared backend; the claude-code
   container advises a ceiling (`check_status.recommendedMaxConcurrent`) that v1 does not read yet.
3. **Monorepos with submodules** (yundera-root, meta-root-v2): proposed rule is that each submodule
   is its own repo in the registry and the meta-root's pointer bumps are ignored. To confirm.
4. **Policy precedence** when the repo's `LAMPLIGHTER.md` and the group policy disagree. Proposed:
   the repo file wins, because it is reviewed with the code.
5. **Advisory API reach**: whether the fine-grained token can create GHSAs on every org in scope.
6. **Gitea version** in use, for the webhook payload and PR label APIs.
7. **Naming**: *lamp* / *round* are proposals; rename before M2 if they read wrong.
