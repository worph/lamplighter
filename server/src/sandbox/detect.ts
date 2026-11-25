import type { CheckDef, DetectorDef, ImageDetector } from '../checks/index.js'
import { runDetectors, type DetectorResult } from '../checks/detectors/index.js'
import { fromOsvJson, fromSarif } from '../checks/detectors/formats.js'
import type { SandboxConfig } from '../config/index.js'
import type { Workspace } from '../sessions/workspace.js'
import { isSandbox } from './index.js'
import { SandboxError, type SandboxRuntime } from './runtime.js'
import { detectorSpec, REPO_DIR } from './spec.js'

/**
 * A check's detectors for one commit. Built-ins run in Lamplighter on the host worktree (they only
 * read files and query a registry). Image detectors run in their official image against the
 * session's clone, read-only — called before anything is installed, so dependency folders are not
 * scanned as if they were the repository's own. Without a sandbox an image detector runs its
 * `fallback`, or is reported as skipped: never as clean.
 */

const SCAN_TIMEOUT_MS = 15 * 60_000

async function runImage(rt: SandboxRuntime, cfg: SandboxConfig, sessionId: string, check: CheckDef, d: ImageDetector): Promise<DetectorResult> {
  await rt.ensureImage(d.image)
  const r = await rt.runCapture(detectorSpec(cfg, { sessionId, image: d.image, argv: d.run }), SCAN_TIMEOUT_MS)
  if (r.timedOut) throw new SandboxError(`${d.name} timed out after ${SCAN_TIMEOUT_MS / 60_000} min`, 'container')
  if (r.code !== 0 && !d.ok_exit.includes(r.code)) {
    // A scanner that crashed says nothing about the repository: report it, raise nothing, close nothing.
    throw new SandboxError(`${d.name} exited ${r.code}: ${r.stderr.trim().slice(-500)}`, 'container')
  }
  const category = d.category ?? check.categories[0]!
  return d.format === 'sarif' ? fromSarif(r.stdout, { category, root: REPO_DIR, tool: d.name }) : fromOsvJson(r.stdout, { category, tool: d.name })
}

export async function detect(
  check: CheckDef,
  worktree: string,
  ws: Workspace | undefined,
  sandbox: { rt: SandboxRuntime; cfg: SandboxConfig } | undefined,
): Promise<DetectorResult> {
  const all: DetectorResult = { findings: [], notes: [] }
  const add = (r: DetectorResult) => {
    all.findings.push(...r.findings)
    all.notes.push(...r.notes)
  }
  for (const d of check.detectors as DetectorDef[]) {
    if (typeof d === 'string') add(await runDetectors([d], worktree))
    else if (ws && isSandbox(ws) && sandbox) add(await runImage(sandbox.rt, sandbox.cfg, ws.sessionId, check, d))
    else if (d.fallback) add(await runDetectors([d.fallback], worktree))
    else all.notes.push(`${d.name} needs the sandbox, which is off: not run`)
  }
  return all
}

export function hasImageDetectors(check: CheckDef): boolean {
  return (check.detectors as DetectorDef[]).some((d) => typeof d !== 'string')
}
