---
kind: patterns
title: Bad patterns
revision: 1
scopes: [diff, full]
agent: review
categories: [anti-idiom, unsafe-api, race, resource-leak, error-handling, n-plus-one]
defaults: { enabled: true, delivery: pr, auto_submit: false, armed: false, cadence_days: 14, admission: arbiter, lean: admit }
---
Find known bad patterns for the languages in this repository: anti-idioms, unsafe or deprecated
APIs, races and missing awaits, leaked resources, error handling that loses information,
N+1 queries.

Every finding must point at the exact construct and say what goes wrong at runtime, not only
that it is unidiomatic. Security-relevant patterns belong to the security check — skip them here.
