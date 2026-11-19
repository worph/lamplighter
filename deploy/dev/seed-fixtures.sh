#!/usr/bin/env bash
# Seed throwaway fixture repositories with planted problems, for the local end-to-end test.
#
#   seed-fixtures.sh <dir>                         bare repos <dir>/acme-api.git and <dir>/tiny-cli.git
#   GITEA_URL=… GITEA_USER=… GITEA_TOKEN=… seed-fixtures.sh <dir>   also creates <user>/acme-web on Gitea
#
# Planted: a stale README (wrong script, wrong env var, a missing endpoint), unused exports and an
# unused file, a vulnerable lodash in package-lock.json, an eval() on request input, a swallowed error.
set -euo pipefail
DIR=${1:?usage: seed-fixtures.sh <dir>}
mkdir -p "$DIR"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
export GIT_AUTHOR_NAME=Fixture GIT_AUTHOR_EMAIL=fixture@example.invalid GIT_COMMITTER_NAME=Fixture GIT_COMMITTER_EMAIL=fixture@example.invalid

acme() {
  local d=$1
  mkdir -p "$d/src"
  cat > "$d/README.md" <<'MD'
# acme-api

A tiny HTTP API.

## Running

```bash
npm install
npm run serve
```

The server listens on the port given by `PORT_NUMBER` (default 3000).

## Endpoints

- `GET /health` — liveness
- `GET /calc?expr=1+2` — evaluates an arithmetic expression
- `GET /users/:id` — one user
MD
  cat > "$d/package.json" <<'JSON'
{
  "name": "acme-api",
  "version": "1.0.0",
  "main": "src/index.js",
  "scripts": { "start": "node src/index.js" },
  "dependencies": { "express": "^4.17.1", "lodash": "4.17.15" }
}
JSON
  cat > "$d/package-lock.json" <<'JSON'
{
  "name": "acme-api",
  "version": "1.0.0",
  "lockfileVersion": 3,
  "requires": true,
  "packages": {
    "": { "name": "acme-api", "version": "1.0.0", "dependencies": { "express": "^4.17.1", "lodash": "4.17.15" } },
    "node_modules/express": { "version": "4.17.1" },
    "node_modules/lodash": { "version": "4.17.15" },
    "node_modules/minimist": { "version": "1.2.0" }
  }
}
JSON
  cat > "$d/src/index.js" <<'JS'
const express = require('express')
const { pick } = require('./utils')

const app = express()
const port = process.env.PORT || 3000

const users = { 1: { id: 1, name: 'Ada', email: 'ada@example.invalid', role: 'admin' } }

app.get('/calc', (req, res) => {
  // evaluate the expression the caller sent
  const result = eval(req.query.expr)
  res.json({ result })
})

app.get('/users/:id', (req, res) => {
  const user = users[req.params.id]
  if (!user) return res.status(404).end()
  res.json(pick(user, ['id', 'name']))
})

app.listen(port, () => {
  try {
    console.log(`listening on ${port}`)
  } catch (e) {}
})
JS
  cat > "$d/src/utils.js" <<'JS'
const _ = require('lodash')

function pick(obj, keys) {
  return _.pick(obj, keys)
}

// Formats a user's display name. Kept from the old admin page.
function displayName(user) {
  return `${user.name} <${user.email}>`
}

function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-')
}

module.exports = { pick, displayName, slugify }
JS
  cat > "$d/src/legacy-auth.js" <<'JS'
// Old token check, replaced by the reverse proxy's SSO.
module.exports = function checkToken(token) {
  return token === 'letmein'
}
JS
}

tiny() {
  local d=$1
  mkdir -p "$d"
  cat > "$d/README.md" <<'MD'
# tiny-cli

Prints a greeting.

```bash
./greet.sh --name World     # prints "Hello, World!"
./greet.sh --shout          # prints it in capitals
```

Requires bash 4.
MD
  cat > "$d/greet.sh" <<'SH'
#!/usr/bin/env bash
# Usage: greet.sh [name]
name=${1:-World}
echo "Hello, ${name}!"
SH
  chmod +x "$d/greet.sh"
}

make_bare() {
  local name=$1 fn=$2
  local bare="$DIR/$name.git"
  if [ -d "$bare" ]; then echo "exists: $bare"; return; fi
  local src="$WORK/$name"
  mkdir -p "$src" && $fn "$src"
  git -C "$src" init -q -b main && git -C "$src" add -A && git -C "$src" commit -q -m "Initial commit"
  git clone -q --bare "$src" "$bare"
  echo "created: $bare"
}

make_bare acme-api acme
make_bare tiny-cli tiny

if [ -n "${GITEA_URL:-}" ]; then
  : "${GITEA_USER:?}" "${GITEA_TOKEN:?}"
  code=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: token $GITEA_TOKEN" "$GITEA_URL/api/v1/repos/$GITEA_USER/acme-web")
  if [ "$code" = 200 ]; then
    echo "exists: gitea $GITEA_USER/acme-web"
  else
    curl -sf -X POST -H "Authorization: token $GITEA_TOKEN" -H 'content-type: application/json' \
      -d '{"name":"acme-web","private":false,"default_branch":"main"}' "$GITEA_URL/api/v1/user/repos" > /dev/null
    src="$WORK/acme-web"; mkdir -p "$src"; acme "$src"
    sed -i 's/acme-api/acme-web/g' "$src/README.md" "$src/package.json" "$src/package-lock.json"
    git -C "$src" init -q -b main && git -C "$src" add -A && git -C "$src" commit -q -m "Initial commit"
    auth=$(printf '%s:%s' "$GITEA_USER" "$GITEA_TOKEN" | base64 -w0)
    git -C "$src" -c "http.extraHeader=Authorization: Basic $auth" push -q "$GITEA_URL/$GITEA_USER/acme-web.git" main
    echo "created: gitea $GITEA_USER/acme-web"
  fi
fi
