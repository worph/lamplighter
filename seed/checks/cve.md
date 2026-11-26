---
kind: cve
title: Known vulnerabilities
revision: 3
scopes: [diff, full]
agent: none
detectors:
  - name: osv-scanner
    image: ghcr.io/google/osv-scanner:v2.7.1@sha256:a70ffffc2bfd33482953e5d6b64c6fcdb30239717a07b0f0d3ab2859ce3e4cde
    run: [scan, source, -r, /work/repo, --format, json]
    format: osv-json
    ok_exit: [1, 128]   # 1: vulnerabilities found; 128: no lockfile or manifest to scan
    fallback: osv       # without the sandbox: package-lock.json against api.osv.dev
fix_tools:
  - image: ghcr.io/google/osv-scanner:v2.7.1@sha256:a70ffffc2bfd33482953e5d6b64c6fcdb30239717a07b0f0d3ab2859ce3e4cde
    path: /osv-scanner
categories: [vulnerable-dependency]
defaults: { enabled: true, delivery: report, auto_submit: false, armed: false, cadence_days: 1, admission: always, lean: admit }
---
Detector-only: osv-scanner reads every lockfile and manifest it knows (npm, pnpm, yarn, PyPI,
Go, Cargo, Maven…) and checks each package version against OSV. A finding per vulnerable
package version. Without the sandbox, only package-lock.json is checked, against api.osv.dev.

When fixing in the sandbox: let osv-scanner compute the smallest upgrade that fixes the most
advisories, refresh the lockfile with the package manager, then prove nothing broke:

    osv-scanner fix --non-interactive --strategy=relock -M package.json -L package-lock.json
    npm ci && npm test

`--strategy=in-place` changes only the lockfile, within the ranges the manifest allows; try it
first when the manifest pins exact versions on purpose. For an ecosystem `osv-scanner fix` does
not support, raise the version in the manifest yourself and run the package manager. Validation
re-scans the proposal: every addressed vulnerability must be gone.

Without the sandbox (file tools only): raise the dependency's range in the manifest to the first
fixed version for a direct dependency, or add an `overrides` entry for a transitive one; do not
hand-edit the lockfile's resolved/integrity fields, and say in the summary that `npm install`
must be run before this lands.
