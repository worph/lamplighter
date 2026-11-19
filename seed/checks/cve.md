---
kind: cve
title: Known vulnerabilities
revision: 1
scopes: [diff, full]
agent: none
detectors: [osv]
categories: [vulnerable-dependency]
fixable: false
defaults: { enabled: true, delivery: report, auto_submit: false, armed: false, cadence_days: 1 }
---
Detector-only in v1: every package in the lockfile is queried against OSV (api.osv.dev).
A finding per vulnerable package version. Fixes need a lockfile regeneration, which needs a
package manager run — not available to v1's file-only sessions, so this check reports.
