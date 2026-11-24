# Study: a sandbox per session (validation, tools, tests)

**Status: brainstorm, 2026-11-24. Nothing here is built.** Continues the Trello card's
*Design Doc v2* comment (the runner design), and partly replaces it: the runner became a container
per session. [architecture.md](architecture.md) stays the source of truth until this study turns
into decisions there.

---

## 1. The problem

v1 runs nothing from a repository (architecture §10, "Untrusted code"). So:

- validation is only the confirming round (an LLM reading `base..head`): no tests, no build before
  a proposal lands (§7.3 step 1 does not exist);
- `cve` and `deps` are report-only, because a fix needs a lockfile refresh, which needs a package
  manager;
- detectors are TypeScript code (`osv`, `npm-outdated`); shell detectors (knip, Semgrep, Gitleaks,
  Trivy) have nowhere to run.

OpenHands / ACP would give the agent a sandbox with a shell. Its two real benefits are the **fix
loop** (the agent runs the tests, reads the failure, tries again) and **proof by execution**
(validation runs the code rather than another model reading it).

## 2. Decisions taken in this session

| # | Question | Answer |
|---|---|---|
| S1 | Store policy for something that spawns containers | **A root variant is fine.** Lamplighter is a dev tool; it may hold the Docker socket (as `ClaudeCodeRoot` does, unlike the sandboxed `ClaudeCode` listing). |
| S2 | What we protect | **The forge token(s), and only that.** They must never reach the sandbox or the model. Private code leaving through the agent or a test is *not* a threat we design against (the agent already reads it through Beacon's claude-code). |
| S3 | Shell for the agent | **Yes, inside the sandbox.** v1's "no shell" rule was a stand-in for "no credential, no remote". A credential-free container meets the real rule, so shell vs named commands becomes a matter of cost and predictability, not security. |
| S4 | Network in the sandbox | **Allowed**, where useful (installs, registries). |
| S5 | Languages | Whatever is useful; not limited to Node. |
| S6 | Images | **No image of our own** if it can be avoided. At most: configurable, with a ready-made default made for this use case. |
| — | OpenHands | Dropped (already proposed on Nov 19). ACP stays a possible *driver* only if we want Codex/Gemini as agents. |

## 3. The shape that came out of it

**A session is a container.** Every session (a review round, a fixing session, a validation session,
a docs round included) gets one container for its whole life, not one per command. The agent stays
outside (claude-code through Beacon, or the openai/text drivers). Only the tools run inside.

- Lamplighter drives the container **from outside through the Docker API**: copy files in and out
  (archive API), `exec` for each tool call. `read_file`, `grep`, `write_file` become operations on
  the container's filesystem, and `run(cmd)` / a shell is one more tool.
- So **nothing of Lamplighter's lives in the image**: the image only needs `/bin/sh`. That is the
  difference with OpenHands, which has to build a runtime image to put its agent server inside.
- At the end Lamplighter reads the change back and does the git work itself, as today
  (invariant 1 unchanged: commits, pushes, PRs stay in the backend).
- The backend no longer reads untrusted files itself, which is a small bonus.

Why even docs rounds: one execution path is simpler than two, and it is cheap if installs are lazy
and cached (§4). A docs round can also run `--help`, typedoc, or check code samples.

### What keeps the token out

- The sandbox gets no environment from Lamplighter, never mounts `/DATA`, never sees the socket.
- It gets a clone **with history** (useful once the agent has a shell: `git log`, `git blame`) but
  **no remote**. The token travels per command as `http.extraHeader` (`forges/gitcli.ts`) and is not
  stored in the mirror; still assert in a test that the sandbox's `.git/config` carries no
  credential and no remote URL with one.
- Sandboxes go on **their own Docker network, not `pcs`**, so a prompt-injected agent cannot call
  Beacon, claude-code or Lamplighter's admin MCP. This costs nothing and matters even with network on.

### Who holds the socket

First idea: a separate spawner service holding the socket with a fixed template. **Revised:** with
S2, anyone who compromises the Lamplighter process already has the tokens, so a separate spawner
mostly protects the host, and S1 accepts a root variant. Simpler: Lamplighter talks to Docker
through [docker-socket-proxy](https://github.com/Tecnativa/docker-socket-proxy), limited to the
containers / exec / images / volumes endpoints, from Node with `dockerode`.

`sandbox/light-docker-api` (our own filtered Docker API) does not fit as is: no `exec`, no archive
endpoints, and its bind-mount check is a blocklist (`/DATA/AppData/lamplighter` would pass).

### Isolation level

`/dev/kvm` is absent on `watch.nsl.sh` (no vmx/svm flags). So microVM sandboxes are out on our VPS
boxes: Firecracker, Kata, microsandbox, CubeSandbox, Arrakis, Docker Sandboxes. gVisor would work
without KVM but needs a host install. Realistic setup: plain runc with a non-root user, all
capabilities dropped, resource caps (CPU, memory, wall clock, log size), and the container removed
when the session ends.

## 4. Choosing the image: how other tools do it

| Tool | Default image | Configuration | Caching |
|---|---|---|---|
| OpenAI Codex (cloud) | `codex-universal` (ghcr; Python, Node, Go, Rust…) | `CODEX_ENV_NODE_VERSION`, `CODEX_ENV_PYTHON_VERSION`… pick versions at start; per-repo setup script | container kept after setup |
| container-use (Dagger) | `ubuntu:24.04` | `.container-use/environment.json` in the repo: `base_image`, `setup_commands` (before the code), `install_commands` (after, e.g. `npm ci`); the agent may change it, a person adopts with `config import` | Dagger layer cache |
| OpenHands | `nikolaik/python-nodejs:python3.12-nodejs22` (V0) | any base; it **builds** a runtime image on top for its agent server (V1: agent-server image `FROM BASE_IMAGE`) | image reused by hash |
| Renovate | containerbase | `install-tool node 20.11` at runtime, version read from the repo | tool cache; only inside a containerbase image |
| Devcontainers / Codespaces | `mcr.microsoft.com/devcontainers/universal` | `.devcontainer/devcontainer.json`: `image`, or Dockerfile + features | prebuilds |
| act / Gitea act_runner | `catthehacker/ubuntu:act-*`, `gitea/runner-images` | label → image | none |

Common pattern: **a ready-made general-purpose image, chosen per repo, plus a setup command per
repo, plus a cached snapshot after setup.** Only OpenHands needs its own image, for a reason we
do not have.

### Proposed resolution order

1. `LAMPLIGHTER.md` → `sandbox: { image, setup, install }` (same fields as container-use).
2. `.container-use/environment.json`, if present (free compatibility).
3. `.devcontainer/devcontainer.json` → its `image` field only. Building Dockerfiles and features
   through `@devcontainers/cli` comes later, if at all.
4. Group default, then the global default: **`codex-universal`**, pinned by digest. Versions mapped
   from `.nvmrc`, `.python-version`, `engines` to its `CODEX_ENV_*` variables. `install` detected
   (`npm ci`, `pnpm i`, `pip install -r …`, …).
5. **Cache:** after `install`, `docker commit` the container, tagged
   `(repo, image digest, lockfile hash)`. The next session on the same lockfile starts installed.
   Needs a pruning rule (LRU plus a size cap).

Installs are **lazy**: a session starts from the source and the base image; `install` runs (or the
cached snapshot is used) only when a tool needs dependencies. A docs or architecture round then
starts in about a second.

The repo's CI workflows (`.github/workflows`, `.gitea/workflows`) are a good **hint** for the
install and test commands, but are not run (`act`/`act_runner` would run deploy steps, need
secrets, and pull third-party actions).

## 5. Scanners and tools: official images, not ours

Each scanner runs as **its own official image** against the same session volume, as CI does
`uses: docker://…`. Declared in the check files:

```yaml
# checks/cve.md frontmatter (sketch)
detectors:
  - image: ghcr.io/google/osv-scanner:v2      # pinned by digest in practice
    run: osv-scanner scan -r /work --format sarif
fix_tools:
  - image: ghcr.io/google/osv-scanner:v2
    run: osv-scanner fix --non-interactive --strategy=relock -M /work/package.json -L /work/package-lock.json
```

- **CVE:** `osv-scanner fix` (guided remediation: in-place, relock or override strategies) does
  the lockfile fix that v1 could not; its docs warn it may run package scripts, which is one more
  reason it belongs in the sandbox. Trivy covers CVEs, secrets, IaC and licences in one binary.
- **Deps:** Renovate in lookup/dry-run mode knows every ecosystem; simpler: `npm-check-updates`.
- **Dead code / patterns / secrets / lint:** knip, opengrep (the LGPL fork of Semgrep CE),
  Gitleaks, MegaLinter (one image, 100+ linters).
- **SARIF as the common output:** most of these emit it. The detector layer becomes "run a tool,
  parse SARIF into findings", so a new scanner is a line in a check file, not code. This is the
  biggest "don't reinvent" win, more than the sandbox itself.

## 6. Validation pipeline (carried over from Design Doc v2)

A proposal becomes `ready` only after, cheapest first, stopping at the first failure:

1. **Mechanical:** the repo's commands on base and on head, each in a fresh sandbox. Whatever
   passed on base must pass on head (invariant 3). Base results cached per
   `(repo, base sha, command, image digest)`. Red on base does not gate, but is reported. One
   re-run on a head failure to rule out a flaky test.
2. **Detector cross-check:** the scanners on head, whatever the check kind. A CVE fix must make
   its fingerprint disappear: the deterministic proof.
3. **Confirming round:** the existing fresh LLM session on `base..head`, last because it is the
   only step that costs tokens.

The fixer's own green runs (inside its session, with the shell) do not count (invariant 2);
validation re-runs everything in new containers. Results go on the proposal and into the PR body
as evidence (commands, base vs head, durations; for CVEs the advisory and the patched version from
OSV, not from the model).

Failure handling stays as in invariant 6: Docker unreachable, an image that cannot be pulled, a
registry down, a timeout → round `blocked` plus one alert, findings released without being
blocked. Head red where base was green → proposal `failed`, findings blocked on this input.

**Fallback:** a box without the socket keeps today's in-process mode (no execution, `cve`/`deps`
report-only). Lamplighter must still work there (invariant 10).

## 7. What this unlocks

- `cve` and `deps` become fixable; their default delivery can move from `report` to `pr`.
- Breaking major bumps: bump, tests go red, the agent fixes the code until green. That is the part
  Renovate does not do.
- Auto-submit becomes defensible for low-risk checks on repos with tests.
- Shell detectors as round hints, the "scanners find, the LLM judges" split from the Oct 14 doc.
- A possible "the line builds and tests pass" lamp, towards the open "up to standard" verdict.

## 8. Open, for tomorrow

1. **Spike first:** start `codex-universal` on the acme-api fixture, install, run `npm test`, run
   `osv-scanner fix` in its official image against the same volume; time a cold start against a
   cached snapshot. Check `codex-universal`'s real size and licence, and the disk on a box.
2. **Shared volume between the env container and scanner containers:** a named volume per session,
   or copy in/out per container? (Named volumes are simplest; check that the socket proxy allows
   them without allowing host binds.)
3. **Shell or named tools per check:** a free shell for author sessions, named commands for
   validation? A per-check setting?
4. **How the shell reaches each driver:** claude-code calls our HTTP tools today; a `shell` tool
   is one more endpoint. For openai/text it is one more function. Output size caps and timeouts per
   call.
5. **Snapshot pruning:** size cap, LRU, per-repo limit; where the snapshots live.
6. **Monorepos/submodules** (yundera-root, meta-root-v2): one sandbox per submodule repo, or skip.
7. **Which part of `LAMPLIGHTER.md` is the schema** (`sandbox:` and `validate:` blocks), and how it
   relates to `.container-use/environment.json`.
8. Write the result back into architecture.md (§7.3, §10, §13) once decided, and post the summary
   on the Trello card.

## Sources

- Codex: [cloud environments](https://developers.openai.com/codex/cloud/environments) ·
  [setup scripts and caching (third-party guide)](https://codex.danielvaughan.com/2026/05/19/codex-cloud-environment-configuration-setup-scripts-caching-codex-universal/)
- container-use: [environment configuration](https://container-use.com/environment-configuration) ·
  [Dagger blog](https://dagger.io/blog/agent-container-use)
- OpenHands: [custom sandbox guide](https://docs.openhands.dev/openhands/usage/advanced/custom-sandbox-guide)
- Renovate: [containerbase/base](https://github.com/containerbase/base) ·
  [Docker build process](https://docs.renovatebot.com/docker-build-process/)
- OSV-Scanner: [guided remediation](https://google.github.io/osv-scanner/experimental/guided-remediation/)
- MicroVM sandboxes (ruled out without KVM):
  [Docker Sandboxes](https://www.docker.com/blog/why-microvms-the-architecture-behind-docker-sandboxes/) ·
  [microsandbox](https://github.com/superradcompany/microsandbox) ·
  [CubeSandbox review](https://dev.to/andrew-ooo/cubesandbox-review-tencents-sub-60ms-ai-agent-sandbox-5ch2)
