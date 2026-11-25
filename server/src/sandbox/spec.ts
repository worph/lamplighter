import type Docker from 'dockerode'
import type { SandboxConfig } from '../config/index.js'

/**
 * Every container Lamplighter creates is built here, so the rules of architecture §10.1 live in one
 * place and one test: no host bind of any kind (Mounts of named volumes only, never `Binds`), no
 * Docker socket, no environment from Lamplighter, every capability dropped, no new privileges,
 * resource caps, the sandboxes' own network.
 */

export const LABEL = 'lamplighter.sandbox'
export const MISE_VOLUME = 'lamplighter-mise'
export const CACHE_VOLUME = 'lamplighter-cache'
export const REPO_DIR = '/work/repo'
export const TOOLS_DIR = '/opt/tools'
const LOG_MAX = '10m'

export function workVolume(sessionId: string): string {
  return `lamplighter-s-${sessionId.toLowerCase().replace(/[^a-z0-9_.-]/g, '-')}`
}

/** What a sandbox sees of its environment: tool locations and caches, nothing of Lamplighter's. */
export function sandboxEnv(): string[] {
  return [
    'HOME=/tmp',
    'CI=true',
    'MISE_DATA_DIR=/mise',
    'MISE_CACHE_DIR=/mise/cache',
    'MISE_GLOBAL_CONFIG_FILE=/mise/config.toml',
    'MISE_YES=1',
    `MISE_TRUSTED_CONFIG_PATHS=${REPO_DIR}`,
    // The repo's own version files pick the toolchain (.nvmrc, engines, .python-version, go.mod…).
    'MISE_IDIOMATIC_VERSION_FILE_ENABLE_TOOLS=node,python,go,ruby,java,rust',
    `PATH=/mise/shims:/mise/bin:${TOOLS_DIR}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
    'npm_config_cache=/cache/npm',
    'npm_config_update_notifier=false',
    'PIP_CACHE_DIR=/cache/pip',
    'GOMODCACHE=/cache/go/mod',
    'GOCACHE=/cache/go/build',
    'GIT_TERMINAL_PROMPT=0',
  ]
}

function hardened(cfg: SandboxConfig, network: string) {
  return {
    CapDrop: ['ALL'],
    SecurityOpt: ['no-new-privileges'],
    NanoCpus: Math.round(cfg.cpus * 1e9),
    Memory: cfg.memory_mb * 1024 * 1024,
    PidsLimit: cfg.pids,
    NetworkMode: network,
    LogConfig: { Type: 'json-file', Config: { 'max-size': LOG_MAX, 'max-file': '1' } },
  }
}

function volume(source: string, target: string, readOnly = false): Docker.MountSettings {
  return { Type: 'volume', Source: source, Target: target, ReadOnly: readOnly }
}

/** One session's container: kept alive for the session, driven by exec. */
export function sessionSpec(cfg: SandboxConfig, o: { sessionId: string; image: string }): Docker.ContainerCreateOptions {
  return {
    Image: o.image,
    name: `lamplighter-s-${o.sessionId.toLowerCase()}`,
    User: `${cfg.uid}:${cfg.uid}`,
    Entrypoint: ['sh', '-c'],
    Cmd: ['trap "exit 0" TERM; while :; do sleep 3600 & wait $!; done'],
    Env: sandboxEnv(),
    WorkingDir: '/work',
    Labels: { [LABEL]: o.sessionId },
    HostConfig: {
      ...hardened(cfg, cfg.network),
      Mounts: [volume(workVolume(o.sessionId), '/work'), volume(MISE_VOLUME, '/mise'), volume(CACHE_VOLUME, '/cache')],
    },
  }
}

/** A scanner in its own official image, reading the session's clone read-only (§10.1). */
export function detectorSpec(cfg: SandboxConfig, o: { sessionId: string; image: string; argv: string[] }): Docker.ContainerCreateOptions {
  return {
    Image: o.image,
    User: `${cfg.uid}:${cfg.uid}`,
    Cmd: o.argv,
    Env: ['HOME=/tmp'],
    WorkingDir: REPO_DIR,
    Labels: { [LABEL]: o.sessionId },
    HostConfig: { ...hardened(cfg, cfg.network), Mounts: [volume(workVolume(o.sessionId), '/work', true)] },
  }
}

/**
 * New named volumes belong to root. This one-off helper hands one to the sandbox uid: root, but
 * with CAP_CHOWN alone, no network, nothing else mounted.
 */
export function chownSpec(cfg: SandboxConfig, o: { volume: string; image: string }): Docker.ContainerCreateOptions {
  return {
    Image: o.image,
    User: '0:0',
    Entrypoint: ['chown'],
    Cmd: [`${cfg.uid}:${cfg.uid}`, '/v'],
    Labels: { [LABEL]: 'infra' },
    HostConfig: { ...hardened(cfg, 'none'), CapAdd: ['CHOWN'], Mounts: [volume(o.volume, '/v')] },
  }
}

/** A shell on the shared volumes as the sandbox user, to seed and measure them. No network. */
export function volumesSpec(cfg: SandboxConfig, o: { image: string }): Docker.ContainerCreateOptions {
  return {
    Image: o.image,
    User: `${cfg.uid}:${cfg.uid}`,
    Entrypoint: ['sh', '-c'],
    Cmd: ['sleep 300'],
    Env: ['HOME=/tmp'],
    Labels: { [LABEL]: 'infra' },
    HostConfig: { ...hardened(cfg, 'none'), Mounts: [volume(MISE_VOLUME, '/mise'), volume(CACHE_VOLUME, '/cache')] },
  }
}

/** An image, created and never started, to copy a static binary out of (mise, osv-scanner). */
export function sourceSpec(cfg: SandboxConfig, o: { image: string }): Docker.ContainerCreateOptions {
  return {
    Image: o.image,
    User: `${cfg.uid}:${cfg.uid}`,
    Labels: { [LABEL]: 'infra' },
    HostConfig: { ...hardened(cfg, 'none') },
  }
}
