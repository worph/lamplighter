---
kind: cve
title: Known vulnerabilities
revision: 2
scopes: [diff, full]
agent: none
detectors: [osv]
categories: [vulnerable-dependency]
defaults: { enabled: true, delivery: report, auto_submit: false, armed: false, cadence_days: 1 }
---
Detector-only in v1: every package in the lockfile is queried against OSV (api.osv.dev).
A finding per vulnerable package version.

When fixing: raise the dependency's range in the manifest (package.json) to the first version
the advisory lists as fixed, for a direct dependency; for a transitive one, add an `overrides`
entry. Sessions edit files only and cannot run a package manager, so do not hand-edit the
lockfile's resolved/integrity fields: say in the summary that `npm install` must be run to
refresh the lockfile before this lands.
