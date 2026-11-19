---
kind: security
title: Security review
revision: 1
scopes: [diff, full]
agent: review
categories: [injection, authn-authz, secret-in-code, unsafe-deserialization, path-traversal, ssrf, xss, crypto-misuse]
sensitive: always
defaults: { enabled: true, delivery: branch, auto_submit: false, armed: false, cadence_days: 14 }
---
Review the code for exploitable security problems: injection (SQL, command, template, eval),
missing or broken authentication and authorization, secrets committed to the repository,
unsafe deserialization, path traversal, SSRF, XSS, misuse of cryptography.

Only report what an attacker could actually reach, and say how (the input, the route, the
call). Severity: critical = remote and unauthenticated, major = needs some access, minor =
defence in depth. When fixing, change as little as possible and never weaken an existing check.
