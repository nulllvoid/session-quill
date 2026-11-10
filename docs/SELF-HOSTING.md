# Self-hosting a team hub

A team hub is a small web service your team runs on its own machine. Each member's Quill worker pushes a read-only copy of their board to it, and anyone with a token opens one page that shows:

- every member's board, with ticket counts by status and when it was last pushed;
- the deployments that merged pull requests still owe, across the team, oldest first;
- all open work, most recent activity first, with next actions and blockers;
- each member's full read-only dashboard.

The hub is part of this repository and under the same MIT licence. It has no runtime dependencies and no database. Design and guarantees: [ADR 0044](decisions/0044-self-hosted-team-hub.md).

## What leaves a member's machine

The same fields as a shared snapshot or mirror: ticket keys, titles, statuses, priorities, next actions, blockers, PR and deployment states, and session and run metadata. Never: source code, prompts, command output, checkpoint or plan text, agent result summaries, memory, run notes, scope names, credentials, or local paths. PR and tracker links are sent only with `include_links = true`. Local-only tickets never leave.

The hub checks this again on arrival and refuses a push that is not sanitizer output.

## 1. Run the hub

### With Docker and automatic TLS

On a host with a public DNS name:

```bash
git clone https://github.com/nulllvoid/session-quill
cd session-quill/deploy/hub
QUILL_HUB_DOMAIN=quill.example.org QUILL_HUB_NAME="Payments team" docker compose up -d --build
```

Caddy obtains a certificate for `QUILL_HUB_DOMAIN` and proxies to the hub. Only Caddy is published; the hub's data lives in the `hub-data` volume.

### With Node directly

Node 22 or newer, no `npm install` needed:

```bash
node bin/quill.js hub serve --dir /var/lib/quill-hub --name "Payments team"
```

This listens on `127.0.0.1:47400`. Put your own TLS-terminating reverse proxy in front and add `--trust-proxy`, or pass `--host 0.0.0.0 --secure-cookies` if TLS ends elsewhere. Do not expose the hub over plain HTTP outside a network you trust: tokens travel in request headers.

| Option | Environment variable | Default | Meaning |
| --- | --- | --- | --- |
| `--dir <folder>` | `QUILL_HUB_DIR` | none (required) | Data folder |
| `--host <addr>` | `QUILL_HUB_HOST` | `127.0.0.1` | Address to bind |
| `--port <n>` | `QUILL_HUB_PORT` | `47400` | Port; `0` picks a free one |
| `--name "<text>"` | `QUILL_HUB_NAME` | `Team hub` | Shown on every page |
| `--secure-cookies` | `QUILL_HUB_SECURE_COOKIES=1` | off | Mark the session cookie `Secure` |
| `--trust-proxy` | `QUILL_HUB_TRUST_PROXY=1` | off | Read the client address and scheme from `X-Forwarded-*`. Use only when the hub is reachable through your proxy alone |
| `--max-body-mb <n>` | `QUILL_HUB_MAX_BODY_MB` | `8` | Largest push accepted, 1 to 64 |

## 2. Create tokens

On the hub's host. Each token is printed once; the hub stores only its hash.

```bash
# Docker
docker compose exec hub node bin/quill.js hub token add alice
docker compose exec hub node bin/quill.js hub token add vera --role viewer

# Node directly
node bin/quill.js hub token add alice --dir /var/lib/quill-hub
```

- A **member** token pushes that member's boards and can read the hub.
- A **viewer** token only reads. Use it for people who do not run Quill.

Any token reads every board on the hub. `hub token list` shows names and roles, never tokens. `hub token revoke <name>` ends that token and signs out browsers using it; add `--purge` to delete the member's boards too.

## 3. Join from each member's machine

```bash
export QUILL_HUB_TOKEN="qh_m_…"                      # where your worker starts; never in a config file
quill hub join https://quill.example.org             # prints what would be sent; changes nothing
quill hub join https://quill.example.org --confirm   # saves the hub and switches pushing on
quill hub push                                       # push now, without waiting for the worker
```

The worker then pushes after each change, at most once every five minutes, and once more when it stops. Restart the worker after setting the variable (`quill worker stop`, then `quill start`). If the worker starts at login (`quill worker install`), set the variable in your login environment.

`join` writes this to `~/.claude/quill/config.toml`. A repository's `.quill.toml` cannot set any of it.

```toml
[hub]
url = "https://quill.example.org"
enabled = true
confirmed_url = "https://quill.example.org"   # changing url stops pushing until you confirm again
# token_env = "QUILL_HUB_TOKEN"     # the variable's name, never the token
# interval_seconds = 300            # at most one push per interval (minimum 60)
# projects = ["payments"]           # default: all projects
# fields = ["key", "title", "status", "next_action", "blocker", "last_activity", "prs", "deployments"]
# include_links = false             # PR and tracker links stay out unless true
```

`quill hub status` shows whether pushing is on, the last accepted push and the last error. `quill hub leave` stops pushing; `quill hub leave --remove` also deletes your board from the hub.

## 4. Open the hub

Open the hub's address in a browser and paste a token. The browser stays signed in for 7 days. The overview is built when you load it; reload for newer pushes.

`GET /v1/team` returns the overview as JSON for scripts, with `Authorization: Bearer <token>`.

## Operating it

- **Backup.** Copy the data folder (`tokens.json`, `secret.key`, `boards/`). Restoring it restores tokens, sessions and boards.
- **Upgrade.** `git pull`, then `docker compose up -d --build` (or restart the Node process). The data folder format is versioned; this release is version 1.
- **Health.** `GET /healthz` answers `{"ok":true,"service":"quill-hub","api":1}` without a token and carries no data.
- **Sign everyone out.** Delete `secret.key` and restart; every browser signs in again.
- **Stale boards.** A board not pushed for over a day is marked on the overview. It is never removed on its own.
- **Lockout.** Ten failed attempts from one address refuse that address for five minutes. Behind a reverse proxy without `--trust-proxy`, every visitor shares the proxy's address, so one person's failures lock everyone out; the compose file sets it for you.
- **Board limit.** A member token holds at most 10 boards (one per store, such as a laptop and a desktop).

## Limits in this release

- Read-only. Nobody can edit a ticket or start a run from the hub.
- No per-board permissions: any token reads every board. Run separate hubs for groups that must not see each other's work.
- No accounts, SSO or snapshot history.
- The hub renders boards with its own copy of the dashboard, so keep the hub at least as new as the members' plugins.
