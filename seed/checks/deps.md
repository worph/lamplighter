---
kind: deps
title: Outdated dependencies
revision: 1
scopes: [full]
agent: none
detectors: [npm-outdated]
categories: [outdated-major, outdated-minor]
fixable: false
defaults: { enabled: true, delivery: report, auto_submit: false, armed: false, cadence_days: 7 }
---
Detector-only in v1: each direct dependency in package.json is compared with the registry's
`latest`. Patch-level drift is not reported. Bumps need a lockfile regeneration, so this check
reports until a runner exists.
