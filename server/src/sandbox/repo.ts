import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import matter from 'gray-matter'
import { z } from 'zod'

/**
 * How one repository wants to be run, read from its files on the host worktree (reading, never
 * executing). Resolution order of architecture §10.1, first match wins for the image:
 * `LAMPLIGHTER.md` → `.container-use/environment.json` → `.devcontainer/devcontainer.json` →
 * the configured default. Install and test commands are declared or detected.
 */

export interface RepoEnv {
  /** null: the configured default image. */
  image: string | null
  imageFrom: 'LAMPLIGHTER.md' | '.container-use' | '.devcontainer' | 'default'
  setup: string[]
  install: string[]
  test: string[]
  testsFrom: 'LAMPLIGHTER.md' | 'detected' | 'none'
}

const commands = z.union([z.string(), z.array(z.string())]).transform((v) => (Array.isArray(v) ? v : [v]).map((c) => c.trim()).filter(Boolean))

const lamplighterSchema = z.object({
  sandbox: z
    .object({
      image: z.string().optional(),
      setup: commands.optional(),
      install: commands.optional(),
      test: commands.optional(),
    })
    .optional(),
})

const containerUseSchema = z.object({
  base_image: z.string().optional(),
  setup_commands: z.array(z.string()).optional(),
  install_commands: z.array(z.string()).optional(),
})

function read(root: string, rel: string): string | null {
  const p = join(root, rel)
  if (!existsSync(p)) return null
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return null
  }
}

/** devcontainer.json is JSONC: drop comments and trailing commas before parsing. */
function parseJsonc(text: string): unknown {
  const stripped = text
    .replace(/("(?:\\.|[^"\\])*")|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (_, str) => str ?? '')
    .replace(/,(\s*[}\]])/g, '$1')
  return JSON.parse(stripped)
}

function json(root: string, rel: string, jsonc = false): unknown {
  const text = read(root, rel)
  if (text === null) return undefined
  try {
    return jsonc ? parseJsonc(text) : JSON.parse(text)
  } catch {
    return undefined
  }
}

export function detectInstall(root: string): string[] {
  const has = (f: string) => existsSync(join(root, f))
  const out: string[] = []
  if (has('package.json')) {
    if (has('pnpm-lock.yaml')) out.push('corepack enable --install-directory /tmp/corepack && PATH=/tmp/corepack:$PATH pnpm install --frozen-lockfile')
    else if (has('yarn.lock')) out.push('corepack enable --install-directory /tmp/corepack && PATH=/tmp/corepack:$PATH yarn install --frozen-lockfile')
    else if (has('package-lock.json') || has('npm-shrinkwrap.json')) out.push('npm ci --no-audit --no-fund')
    else out.push('npm install --no-audit --no-fund')
  }
  const reqs = existsSync(root) ? readdirSync(root).filter((f) => /^requirements.*\.txt$/.test(f)).sort() : []
  if (reqs.length || has('pyproject.toml')) {
    const pip = ['python -m venv .venv', ...(reqs.length ? [`.venv/bin/pip install -q ${reqs.map((r) => `-r ${r}`).join(' ')}`] : []), ...(has('pyproject.toml') && !reqs.length ? ['.venv/bin/pip install -q -e .'] : [])]
    out.push(pip.join(' && '))
  }
  if (has('go.mod')) out.push('go mod download')
  if (has('Cargo.toml')) out.push('cargo fetch')
  return out
}

const NPM_PLACEHOLDER = /no test specified/

export function detectTests(root: string): string[] {
  const out: string[] = []
  const pkg = json(root, 'package.json') as { scripts?: Record<string, string> } | undefined
  if (pkg?.scripts?.test && !NPM_PLACEHOLDER.test(pkg.scripts.test)) out.push('npm test')
  const python = [...(existsSync(root) ? readdirSync(root).filter((f) => /^requirements.*\.txt$/.test(f)) : []), 'pyproject.toml', 'setup.cfg', 'pytest.ini', 'tox.ini']
    .map((f) => read(root, f) ?? '')
    .join('\n')
  if (/\bpytest\b/i.test(python) || existsSync(join(root, 'pytest.ini')) || existsSync(join(root, 'conftest.py'))) out.push('.venv/bin/python -m pytest -q')
  if (existsSync(join(root, 'go.mod'))) out.push('go test ./...')
  if (existsSync(join(root, 'Cargo.toml'))) out.push('cargo test')
  return out
}

export function repoEnv(root: string): RepoEnv {
  const front = (() => {
    const text = read(root, 'LAMPLIGHTER.md')
    if (text === null) return undefined
    try {
      return lamplighterSchema.safeParse(matter(text).data).data?.sandbox
    } catch {
      return undefined
    }
  })()
  const cu = containerUseSchema.safeParse(json(root, '.container-use/environment.json') ?? {}).data
  const dc = json(root, '.devcontainer/devcontainer.json', true) as { image?: unknown } | undefined

  let image: string | null = null
  let imageFrom: RepoEnv['imageFrom'] = 'default'
  if (front?.image) [image, imageFrom] = [front.image, 'LAMPLIGHTER.md']
  else if (cu?.base_image) [image, imageFrom] = [cu.base_image, '.container-use']
  else if (typeof dc?.image === 'string') [image, imageFrom] = [dc.image, '.devcontainer']

  const declaredTests = front?.test
  const test = declaredTests ?? detectTests(root)
  return {
    image,
    imageFrom,
    setup: front?.setup ?? cu?.setup_commands ?? [],
    install: front?.install ?? cu?.install_commands ?? detectInstall(root),
    test,
    testsFrom: declaredTests ? 'LAMPLIGHTER.md' : test.length ? 'detected' : 'none',
  }
}
