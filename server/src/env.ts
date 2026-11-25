import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Everything read from the environment, once, at boot. Inference and the callback URL only
 * *seed* config.yaml on first boot — afterwards the file (and the Settings page that writes it)
 * is what is running.
 */
export interface Env {
  dataDir: string
  port: number
  host: string
  logLevel: string
  publicDir: string
  seedDir: string
  /** Seeds `admin_mcp.token` on first boot. Unset: one is generated and shown in Settings. */
  adminMcpToken?: string
  seed: {
    publicUrl?: string
    inferenceDriver?: string
    inferenceUrl?: string
    inferenceTool?: string
    inferenceVia?: string
    inferenceModel?: string
    inferenceBearer?: string
    /** Seeds `sandbox.docker_url`, and turns the sandbox on, on first boot. */
    dockerUrl?: string
  }
}

const here = fileURLToPath(new URL('.', import.meta.url))

export function loadEnv(): Env {
  const e = process.env
  return {
    dataDir: e.LAMPLIGHTER_DATA_DIR ?? '/DATA',
    port: Number(e.LAMPLIGHTER_PORT ?? 8080),
    host: e.LAMPLIGHTER_HOST ?? '0.0.0.0',
    logLevel: e.LAMPLIGHTER_LOG_LEVEL ?? 'info',
    // src/ (tsx) and dist/ (built) are both one level under server/.
    publicDir: join(here, '..', 'public'),
    seedDir: e.LAMPLIGHTER_SEED_DIR ?? join(here, '..', '..', 'seed'),
    adminMcpToken: e.LAMPLIGHTER_ADMIN_MCP_TOKEN || undefined,
    seed: {
      publicUrl: e.LAMPLIGHTER_PUBLIC_URL || undefined,
      inferenceDriver: e.LAMPLIGHTER_INFERENCE_DRIVER || undefined,
      inferenceUrl: e.LAMPLIGHTER_INFERENCE_URL || undefined,
      inferenceTool: e.LAMPLIGHTER_INFERENCE_TOOL || undefined,
      inferenceVia: e.LAMPLIGHTER_INFERENCE_VIA || undefined,
      inferenceModel: e.LAMPLIGHTER_INFERENCE_MODEL || undefined,
      inferenceBearer: e.LAMPLIGHTER_INFERENCE_BEARER || undefined,
      dockerUrl: e.LAMPLIGHTER_DOCKER_URL || undefined,
    },
  }
}
