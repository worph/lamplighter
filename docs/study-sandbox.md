# Study: a sandbox per session (validation, tools, tests)

**Status: brainstorm, 2026-11-24; two spikes run 2026-11-25 (§9); decisions written into
[architecture.md](architecture.md) (D8, §7.3, §10.1, §13) and built in 0.7.0 the same day.** Continues the Trello card's
*Design Doc v2* comment (the runner design), and partly replaces it: the runner became a container
per session. [architecture.md](architecture.md) is the source of truth; this file keeps the reasoning,
the comparison and the measurements.

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
- **Lamplighter builds the copy-in tar itself, owned by the sandbox user.** `docker cp` keeps the
  source uid, and with all capabilities dropped even root lacks `CAP_DAC_OVERRIDE`, so it cannot
  write files it does not own (spike: `npm ci` and `osv-scanner fix` failed with `EACCES` until the
  tar was re-owned). The same applies to scanner images, which run as root.
- **Tool calls avoid login shells.** An `exec` through `bash -lc` cost 3.5 s on `codex-universal`
  (its profile initialises pyenv, nvm, mise…), plain `sh -c` 0.35 s. An agent making 50 calls would
  lose 3 minutes. File tools use the archive API; `run` uses `sh -c` with PATH set by the image.
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

`/dev/kvm` is absent on `watch.nsl.sh` and `holyhorse` (no vmx/svm flags). So microVM sandboxes are out on our VPS
boxes: Firecracker, Kata, microsandbox, CubeSandbox, Arrakis, Docker Sandboxes. gVisor would work
without KVM but needs a host install. Realistic setup: plain runc with a non-root user, all
capabilities dropped, `no-new-privileges`, resource caps (CPU, memory, pids, wall clock, log size),
and the container removed when the session ends. The spike ran with 2 CPU, 2 GB and 512 pids
without trouble.

The image must support a non-root user: that rules out images that install their toolchains
under `/root` (`codex-universal`: mode 700, `node: command not found` as uid 1000).

## 4. Choosing the image: how other tools do it

Researched 2026-11-25. Sizes are compressed amd64 pulls (Docker Hub / GHCR manifests).

| Tool | Default image (size) | How the toolchain arrives | Version from | Cache across jobs | Non-root |
|---|---|---|---|---|---|
| Gitea act_runner | `runner-images:ubuntu-*`: `-slim` 0.13 GB, default 0.59 GB, `-full` 19.9 GB | `setup-*` actions download into `/opt/hostedtoolcache` at job time | the workflow (`node-version-file`…) | `tool_cache_mode: none` by default, `shared` keeps it per slot; built-in actions/cache server | tool cache writable by `nobody` |
| Forgejo runner | `node:lts` (~0.41 GB) | same as act_runner | same | cache server | per image |
| nektos/act | `catthehacker/ubuntu:act-*` 0.58 GB; `full-*` 19.9 GB (~60 GB extracted) | `setup-*` actions | workflow | none | `runner-*` tags |
| GitHub hosted | a full VM, nothing to pull | preinstalled, plus `setup-node`/`setup-python`: tool cache, then actions/node-versions, then nodejs.org | `.nvmrc`, `.node-version`, `.tool-versions`, `package.json`; `.python-version` | package-manager caches via actions/cache | `runner` + sudo |
| Copilot coding agent | hosted runner | repo-authored `copilot-setup-steps.yml` (≤ 59 min); without it, "trial and error" | the repo's workflow | actions/cache | `runner` |
| OpenHands V1 | `agent-server:*-python` 1.56 GB, on `debian:trixie-slim` with Python and Node copied from official images | anything else baked into a custom `BASE_IMAGE`; the agent may `apt` at runtime | none | BuildKit cache | uid 10001 + sudo |
| Renovate / containerbase | `containerbase/base` 0.14 GB; `renovate` 0.45 GB vs `-full` 2.74 GB | `install-tool <tool> <ver>` at runtime | Renovate's own code reads `engines`, `.nvmrc`, `.node-version` | `containerbaseDir`, keyed by URL hash | uid 12021, read-only rootfs supported |
| mise | `jdxcode/mise` 0.06 GB | downloads at runtime | `.tool-versions`, `mise.toml`, and (opt-in) `.nvmrc`, `package.json`, `.python-version`, `go.mod`, `rust-toolchain.toml`… | data dir on a volume | yes |
| container-use (Dagger) | `ubuntu:24.04` | `setup_commands` / `install_commands`, editable by the agent | the agent | Dagger layer cache | per image |
| Devcontainer features | any base | each feature's `install.sh` at build time | `version` option | image layers, prebuilds | `_REMOTE_USER` |
| Jules | Ubuntu VM, Python/Node/Java/Go/Rust preinstalled | per-repo setup script, then a snapshot | the script | VM snapshot | not stated |
| E2B, Daytona, Modal | templates built ahead | baked in, snapshotted | the template | snapshot | not verified |
| SWE-bench | base, ~60 env images, per-instance images (≥ 120 GB, ~2 TB at instance level) | prebuilt per repo version | hand-curated | image cache | not verified |
| OpenAI Codex (cloud) | `codex-universal` 43.7 GB on disk (spike, §9) | everything preinstalled; `CODEX_ENV_*` picks the version | env variables | container kept after setup | root only |

Not verified: Daytona and Modal details, devbox/flox (Nix), the tool-cache mount path in GitHub
`container:` jobs.

Patterns:

1. **Nobody defaults to the 20 GB image.** act_runner, Forgejo, act and Renovate default to a
   0.1–0.6 GB base and keep "full" opt-in. A giant image only makes sense on a VM where it is
   already on disk (GitHub hosted, Codex cloud): exactly what `codex-universal` showed in the spike.
2. **Toolchains are installed at job time into a known cache directory** (`/opt/hostedtoolcache`,
   containerbase's dir, mise's data dir). Keeping it across jobs is a runner setting, not the image's.
3. **The version comes from repo files** (`.nvmrc`, `.python-version`, `.tool-versions`, `engines`,
   `go.mod`), read either by the installer (setup-*, mise) or by the orchestrator (Renovate).
4. **Agent products let the repo describe its own setup** (copilot-setup-steps, Jules' script,
   container-use, devcontainer), then cache or snapshot the result.
5. **Non-root with a fixed high uid** (10001, 12021) and a tool cache that user owns; most still
   allow sudo for apt.

The first draft of this study took the opposite lesson (one general-purpose image, plus a snapshot).
The spike and the table agree: **a slim base, toolchains on demand, caches on volumes.**

### Proposed resolution order

1. `LAMPLIGHTER.md` → `sandbox: { image, setup, install }` (same fields as container-use).
2. `.container-use/environment.json`, if present (free compatibility).
3. `.devcontainer/devcontainer.json` → its `image` field only. Building Dockerfiles and features
   through `@devcontainers/cli` comes later, if at all.
4. Group default, then the global default, **tested in spike 2 (§9):** the official
   `buildpack-deps:bookworm-scm` (515 MB on disk: Debian with git, curl, CA certificates; what
   act_runner's default image builds on) plus **mise** installing every toolchain on demand. Its
   "idiomatic" version files are enabled for node and python (more to add: go, java, ruby, rust),
   so `.nvmrc`, `engines`, `.python-version`… pick the version with no code of ours. Still no image
   of our own:
   - `jdxcode/mise` has no shell, but its binary is static (175 MB; it must be called `mise`, or it
     acts as a shim). It is copied once into the shared mise volume through the archive API, so a
     session needs no copy and no image layer.
   - Runs as a fixed non-root uid (10001 in the spike) with all capabilities dropped. Named volumes
     start owned by root: a one-off helper with only `CAP_CHOWN` and no network hands each new
     volume to that uid.
   - Cold, mise installed Node 22 in 36 s and Python 3.12 in 14 s (prebuilt); warm, `mise install`
     is a 1–2 s no-op. mise checks the OpenPGP signature of Node's checksums and GitHub artifact
     attestations of the Python builds.

   Alternatives, not retained:
   - **containerbase** (Renovate's): built for this exact job, hardened for non-root and read-only
     rootfs, but it only installs; the "repo file → version" logic is Renovate's TypeScript, which
     we would have to rewrite.
   - **Per-language official images** (`node:22-bookworm-slim`, 329 MB): simplest, but break on
     polyglot repos and force the choice before the repo is read.
   - `codex-universal` or a `-full` image stays something a repo or group may name, never a default.

   `install` detected (`npm ci`, `pnpm i`, `pip install -r …`, …).
5. **Cache the toolchains and the package manager, not the container:** a shared volume for mise's
   data dir, and one cache volume per ecosystem (or per repo) at `~/.npm`, `~/.cache/pip`… With a warm npm cache, `npm ci` took 11 s instead of 15 s,
   and the cache survives image updates. `docker commit` was dropped: it took **31 minutes** on
   `codex-universal` (16 s on a 329 MB image) under the containerd image store, and a commit does
   not capture named volumes, so `/work/node_modules` would be lost anyway. Needs a pruning rule
   (size cap, LRU). Concurrent sessions may share the mise volume: three sessions installing
   node@20 at the same moment all finished within 0.8 s of each other and ran it at once; mise
   keeps a `lockfiles/` directory (one run, not a proof). Pin mise's version: it is the
   supply-chain surface. After both spikes: mise data 88 MB cache + 203 MB Node (two versions) +
   110 MB Python + the 168 MB binary.

Installs are **lazy**: a session starts from the source and the base image; `install` runs only
when a tool needs dependencies. Measured on `codex-universal`, a session was ready in about 6 s,
4 s of it in the image's entrypoint script; a slim image without one should start in about 2 s.

The repo's CI workflows (`.github/workflows`, `.gitea/workflows`) are a good **hint** for the
install and test commands, but are not run (`act`/`act_runner` would run deploy steps, need
secrets, and pull third-party actions).

## 5. Scanners and tools: official images, not ours

Each **detector** runs as **its own official image** against the same session volume, as CI does
`uses: docker://…` (spike: `osv-scanner` in its image read the session's named volume, 9 s).
**Fix tools** run in the session container instead, because they call the package manager: in its
own image, `osv-scanner fix --strategy=relock` computed the right plan, then failed with
`cannot find npm executable`. The tool's static binary is copied in from its official image through
the archive API (4 s), so there is still no image of our own. Declared in the check files:

```yaml
# checks/cve.md frontmatter (sketch)
detectors:
  - image: ghcr.io/google/osv-scanner:v2      # pinned by digest in practice
    run: osv-scanner scan -r /work --format sarif
fix_tools:
  - binary_from: ghcr.io/google/osv-scanner:v2:/osv-scanner   # copied into the session container
    run: osv-scanner fix --non-interactive --strategy=relock -M package.json -L package-lock.json
```

- **CVE:** `osv-scanner fix` (guided remediation: in-place, relock or override strategies) does
  the lockfile fix that v1 could not; its docs warn it may run package scripts, which is one more
  reason it belongs in the sandbox. Spike: relock found 3 bumps fixing 23/23 vulnerabilities, then
  `npm ci` and the tests passed and the re-scan reported no issues: the full deterministic proof.
  `in-place` found nothing to patch, correctly, on exact pins. Trivy covers CVEs, secrets, IaC and
  licences in one binary.
- **Deps:** Renovate in lookup/dry-run mode knows every ecosystem; simpler: `npm-check-updates`.
- **Scope the scan to the repo's own manifests.** In spike 2, scanning after `pip install` also read
  pip's vendored SBOM inside `.venv` and reported setuptools CVEs the repo does not own. Scan
  before install, or skip `.venv` and `node_modules`.
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

1. ~~**Spike first**~~: done 2026-11-25 (§9), folded into §3–§5.
2. **Shared volume:** ~~named volume or copy in/out?~~ A named volume per session works (spike).
   Still to check: that docker-socket-proxy allows named volumes while refusing host binds.
3. **Shell or named tools per check:** a free shell for author sessions, named commands for
   validation? A per-check setting?
4. **How the shell reaches each driver:** claude-code calls our HTTP tools today; a `shell` tool
   is one more endpoint. For openai/text it is one more function. Output size caps and timeouts per
   call.
5. **Cache volume pruning:** size cap, LRU; one volume per ecosystem or per repo.
6. **Monorepos/submodules** (yundera-root, meta-root-v2): one sandbox per submodule repo, or skip.
7. **Which part of `LAMPLIGHTER.md` is the schema** (`sandbox:` and `validate:` blocks), and how it
   relates to `.container-use/environment.json`.
8. ~~Write the result back into architecture.md~~ done (D8, §7.3, §10.1, §13). Post the summary on
   the Trello card: not done.
9. ~~**Toolchains without one big image**~~: researched (§4) and spiked (§9, spike 2). Left:
   an ecosystem osv-scanner cannot fix (PyPI: not tried), and timings on an idle box.
10. **The acme-api fixture** has a stub lockfile (`npm ci` rejects it) and no `test` script. Give
   `seed-fixtures.sh` a real lockfile and a `node --test` suite before end-to-end tests rely on it,
   and add a Python fixture (spike 2 used one: `.python-version`, vulnerable `requests`/`PyYAML`
   pins, a pytest suite run with `python -m pytest`).

## 9. Spike results (2026-11-25, holyhorse)

### Spike 1: `codex-universal`

Box: 3 vCPU, 7.8 GiB (2.6 available), 298 GB free, Docker 29.8.2 with the **containerd image
store**, no `/dev/kvm`. Fixture: a copy of acme-api with a real lockfile (the seeded one is a stub
`npm ci` rejects), exact pins `express 4.17.1`, `lodash 4.17.15`, `minimist 1.2.0`, and a
`node --test` suite. Every container: `--cap-drop ALL`, `no-new-privileges`, 2 CPU, 2 GB,
512 pids, its own bridge network, the workspace in a named volume at `/work`.

| Step | Result |
|---|---|
| Pull `codex-universal` (amd64) | **64 min, 43.7 GB** on disk (10.9 GB compressed, 24 layers) |
| Pull `osv-scanner` 2.7.1 / `node:22-bookworm-slim` | 66 s, 481 MB / 43 s, 329 MB |
| Session start until the entrypoint is ready | ~6 s (start 2 s + `setup_universal.sh` 4 s) |
| Copy-in (archive API) | 0.4 s |
| `docker exec` via `bash -lc` / plain `sh -c` | **3.5 s** / 0.35 s per call |
| `npm ci` (52 packages) cold / with a shared npm cache volume | 15 s / 11 s |
| `npm test` | 4.6 s (mostly the login shell) |
| `osv-scanner scan` in its own image, same volume | 9 s: 23 vulns in 9 packages |
| `osv-scanner fix --strategy=in-place` | no patch possible (exact pins), correct |
| `osv-scanner fix --strategy=relock` in its own image | plan right (3 bumps fix 23/23), **write fails: no `npm`** |
| Same, binary copied into the session container | 99 s, then `npm ci` 25 s, tests green, re-scan **"No issues found"** |
| `docker commit` of the session container | **31 min** (diff a few MB); 16 s on a 329 MB image |
| Non-root (`--user 1000`) on `codex-universal` | **fails**: toolchains under `/root` (mode 700), `node: command not found` |
| Token-free sandbox | no remote, no credential in `.git/config`, no secret in env; `pcs` names unresolved |

### Spike 2: slim base + mise, non-root

`buildpack-deps:bookworm-scm`, uid 10001, all capabilities dropped, mise and package caches on
shared named volumes, nothing bound from the host. **holyhorse was loaded (load average 30–38 on
3 vCPU) during this run, so the timings are upper bounds**: a container start took 4–19 s
instead of 2 s earlier in the day.

| Step | Result |
|---|---|
| Pull `buildpack-deps:bookworm-scm` / `jdxcode/mise` | 225 s, 515 MB / 53 s, 234 MB (no shell; static binary 175 MB) |
| `mise install` Node 22 (from `.nvmrc`), cold / warm | 36 s / 2 s; Node 22.23.5, OpenPGP-checked |
| `npm ci` + `npm test` on acme-api | 10 s + 2.6 s, green |
| `mise install` Python 3.12 (from `.python-version`), cold / warm | 14 s / 1 s; 3.12.16 prebuilt, attestation verified |
| `venv` + `pip install` on py-svc, cold / warm pip cache | 61 s / 30 s; `python -m pytest` 2 passed |
| `osv-scanner scan` on py-svc | requests, PyYAML, pytest CVEs found; plus setuptools from pip's SBOM in `.venv` (noise) |
| `exec sh -c true` / a shim call (`node -e 0`) | 0.8 s / 0.5 s (no login shell) |
| 2 then 3 sessions installing the same Node at once, one volume | all succeeded, all ran `node` right after |

The conclusions of both spikes are folded into §3 (copy-in ownership, exec overhead, non-root),
§4 (default image, mise, cache volumes instead of `docker commit`) and §5 (fix tools in the session
container, scan scope).

Left on holyhorse: the images (`codex-universal`, `osv-scanner`, `node:22-bookworm-slim`,
`buildpack-deps:bookworm-scm`, `jdxcode/mise`) and `~/lamp-spike/` (fixtures, `run.sh`,
`run2.sh`, logs, the extracted mise binary).

## Sources

- Codex: [cloud environments](https://developers.openai.com/codex/cloud/environments) ·
  [setup scripts and caching (third-party guide)](https://codex.danielvaughan.com/2026/05/19/codex-cloud-environment-configuration-setup-scripts-caching-codex-universal/)
- container-use: [environment configuration](https://container-use.com/environment-configuration) ·
  [Dagger blog](https://dagger.io/blog/agent-container-use)
- OpenHands: [custom sandbox guide](https://docs.openhands.dev/openhands/usage/advanced/custom-sandbox-guide)
- Renovate: [containerbase/base](https://github.com/containerbase/base) ·
  [Docker build process](https://docs.renovatebot.com/docker-build-process/)
- OSV-Scanner: [guided remediation](https://google.github.io/osv-scanner/experimental/guided-remediation/)
- Runners: [act_runner config](https://gitea.com/gitea/act_runner/src/branch/main/internal/pkg/config/config.example.yaml) ·
  [gitea/runner-images tags](https://hub.docker.com/r/gitea/runner-images/tags) ·
  [Forgejo runner register.go](https://code.forgejo.org/forgejo/runner/src/branch/main/internal/app/cmd/register.go) ·
  [act runners](https://nektosact.com/usage/runners.html) · [catthehacker images](https://github.com/catthehacker/docker_images) ·
  [setup-node](https://github.com/actions/setup-node) · [setup-python](https://github.com/actions/setup-python)
- Agents: [Copilot setup steps](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent/customize-the-agent-environment) ·
  [OpenHands agent-server Dockerfile](https://github.com/OpenHands/software-agent-sdk/blob/main/openhands-agent-server/openhands/agent_server/docker/Dockerfile) ·
  [Jules environment](https://jules.google/docs/environment/) · [E2B templates](https://docs.e2b.dev/sandbox-template) ·
  [SWE-bench Docker setup](https://www.swebench.com/SWE-bench/guides/docker_setup/)
- Installers: [mise versions and idiomatic files](https://mise.jdx.dev/dev-tools/versions.html) ·
  [Renovate node-version.ts](https://github.com/renovatebot/renovate/blob/main/lib/modules/manager/npm/post-update/node-version.ts) ·
  [Renovate running](https://docs.renovatebot.com/getting-started/running/) ·
  [devcontainer features spec](https://containers.dev/implementors/features/)
- MicroVM sandboxes (ruled out without KVM):
  [Docker Sandboxes](https://www.docker.com/blog/why-microvms-the-architecture-behind-docker-sandboxes/) ·
  [microsandbox](https://github.com/superradcompany/microsandbox) ·
  [CubeSandbox review](https://dev.to/andrew-ooo/cubesandbox-review-tencents-sub-60ms-ai-agent-sandbox-5ch2)
