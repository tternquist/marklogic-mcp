---
name: marklogic-docker-setup
description: Configure MarkLogic Server itself to run reliably in Docker or docker-compose — bootstrap and cluster-join environment variables, the persistent /var/opt/MarkLogic volume, rootless vs privileged image tags, swap and HugePages memory tuning, and the init/restart race that makes a healthcheck report ready before MarkLogic actually is. Use when writing or debugging a docker-compose.yml or docker run command for MarkLogic Server, when a MarkLogic container fails to start, crash-loops, or serves 503 "Restarting to reload server config" to an early caller, or when choosing among this repo's docker-compose.yml / docker-compose.external.yml / docker-compose.mcp-only.yml templates. Not for connecting across separate Compose projects (see docs/docker-networking.md) or for what to deploy once MarkLogic is reachable (see marklogic-project-setup).
---

# MarkLogic Server in Docker

## Start from what already exists

This repo ships three ready-to-copy compose files at its root — start from whichever is
closest before writing one from scratch:

| File | Runs | Use when |
|---|---|---|
| `docker-compose.yml` | MarkLogic + flux-runner + this MCP server | full local dev stack, nothing pre-existing |
| `docker-compose.external.yml` | MCP + flux-runner only, joins a shared network | MarkLogic (and/or Semaphore) already running in another compose project |
| `docker-compose.mcp-only.yml` | MCP server only | pointing at an existing MarkLogic reachable by host/IP |

`templates/docker-compose.yml` in this skill is the piece those three build on: a plain,
standalone single-node MarkLogic service with no MCP server attached, for when the task
is "stand up MarkLogic" rather than "run this MCP server."

## The init/restart race — the most common false alarm

MarkLogic's own `/manage/v2` and `/admin/v1/timestamp` endpoints can return `200` while
the server is **mid-restart applying a bootstrap or config change**. A dependent service,
or a `healthcheck:` that fires once and moves on, can connect during that window and get
`503 Restarting to reload server config` moments later — or connect to a MarkLogic that
hasn't finished creating its default databases and app servers yet.

A longer `start_period` alone does not fix this — the problem isn't waiting long enough
before the *first* check, it's that any single successful probe can land inside the
restart window. Require **several consecutive successful probes** before trusting
"ready":

```bash
ok_streak=0
for i in $(seq 1 36); do
  if curl -sf -u admin:admin http://localhost:8002/manage/v2 >/dev/null 2>&1; then
    ok_streak=$((ok_streak + 1))
    [ "$ok_streak" -ge 3 ] && break
    sleep 3
  else
    ok_streak=0
    sleep 5
  fi
done
```

This exact pattern is what this repo's own CI uses before seeding test data — see
`.github/workflows/integration.yml`. Use the same "N consecutive OKs" shape for any
consumer waiting on MarkLogic, not just a Compose `healthcheck:` block — a
`depends_on: condition: service_healthy` only inherits whatever the healthcheck itself
verifies, and a single-probe healthcheck reports healthy too early.

## Bootstrap and cluster environment variables

Verified against the official `progressofficial/marklogic-db` image:

| Variable | Effect |
|---|---|
| `MARKLOGIC_INIT=true` | Runs first-time bootstrap on container start |
| `MARKLOGIC_ADMIN_USERNAME` / `MARKLOGIC_ADMIN_PASSWORD` | Required together when `MARKLOGIC_INIT=true`; creates the admin user during bootstrap |
| `MARKLOGIC_ADMIN_USERNAME_FILE` / `MARKLOGIC_ADMIN_PASSWORD_FILE` | Same, via Docker secrets — prefer these over the plain env vars outside local dev |
| `MARKLOGIC_WALLET_PASSWORD` | Defaults to the admin password if unset |
| `REALM` | Authentication realm; defaults to `public` |
| `LICENSE_KEY` / `LICENSEE` | Enterprise license; omit for the free developer license (functional, capacity-limited) |
| `MARKLOGIC_JOIN_CLUSTER=true` + `MARKLOGIC_BOOTSTRAP_HOST=<host-or-service-name>` | Joins this node to the cluster bootstrapped at that host, instead of bootstrapping a new one |
| `MARKLOGIC_GROUP` | Assigns the node to a MarkLogic group (e.g. `dnode`) on join |
| `MARKLOGIC_JOIN_TLS_ENABLED` + `MARKLOGIC_JOIN_CACERT_FILE` | Join a TLS-enabled cluster; ignored on the bootstrap host |
| `ML_HUGEPAGES_TOTAL` | Overrides HugePages allocation (see memory section) |

`MARKLOGIC_INIT=true` only bootstraps a database that doesn't already have one in
`/var/opt/MarkLogic` — see the volume note below for why a "successful" restart can
silently skip it, and why changing `MARKLOGIC_ADMIN_PASSWORD` in the compose file does
nothing once a volume already has an initialized Security database.

## Persistent volume — required, not optional

MarkLogic stores everything in `/var/opt/MarkLogic`. Use a **named volume**, not a bind
mount — the upstream image documentation recommends this explicitly:

```yaml
services:
  marklogic:
    volumes:
      - ml-data:/var/opt/MarkLogic
volumes:
  ml-data:
```

Without it, every `docker compose down` (or container recreate) destroys all forests,
security config, and the admin user — and the next `up` re-runs `MARKLOGIC_INIT` from
scratch, which looks like a working setup right up until you need the data to survive a
restart.

## Image tags — rootless by default, privileged mode is the exception

Tags follow `{ML release version}-{platform}` (e.g. `11.2.0-ubi9`), plus rolling
`latest-xx.x` / `latest-xx` / `latest` tags. **`latest` defaults to the `ubi-rootless`
platform** — do not pin to a bare `-ubi`/`-ubi9` (non-rootless) tag unless you have a
specific reason to, because the non-rootless image must run with `privileged: true` (it
uses `sudo` internally to create its runtime user), which most Compose setups don't need
and shouldn't grant by default.

On Apple Silicon, expect a platform-mismatch warning for `linux/amd64` images; add
`platform: linux/amd64` in the compose service (or `--platform linux/amd64` to
`docker run`) to silence it — this is cosmetic, not a functional problem.

## Memory: swap and HugePages

- **Swap.** MarkLogic recommends configuring swap for anything beyond local dev, using
  Docker's `--memory` / `--memory-swap` (or Compose's `mem_limit` / `memswap_limit`).
  Setting only `mem_limit` without swap headroom makes the container OOM-kill MarkLogic
  under memory pressure rather than MarkLogic degrading gracefully.
- **HugePages.** If the host has HugePages configured, MarkLogic in a container
  allocates up to 3/8 of the container's memory limit as HugePages by default — that
  fraction is per-container, so two MarkLogic containers each get their own 3/8, not a
  shared pool. Override with `ML_HUGEPAGES_TOTAL` (`0` disables it) if the host wasn't
  set up for HugePages or the default allocation is wrong for the workload.

## Multi-node clustering — compose does not do this for you

Multiple `marklogic:` service blocks (or `docker compose scale`) do **not** form a
cluster by themselves. Each node bootstraps as its own single-node cluster unless it
carries `MARKLOGIC_JOIN_CLUSTER=true` and `MARKLOGIC_BOOTSTRAP_HOST=<bootstrap-service>`
pointing at the node that ran `MARKLOGIC_INIT` first; `depends_on` on the bootstrap
service is required so joining nodes don't start the join before the bootstrap host is
actually up.

Two known rough edges worth planning around rather than debugging blind:

- **Removing a node via the Admin UI "leave" button may not succeed**, depending on
  network configuration — use the Management API instead
  (`DELETE /admin/v1/host-config`).
- **Rejoining a node that previously left a cluster may not succeed.** Recreate the
  node (fresh volume, fresh join) rather than retrying the same one.

For anything beyond a demo or a dev environment, prefer a single MarkLogic node; only
reach for multi-node compose when the task specifically requires testing cluster
behavior.

## Networking across separate compose projects

If MarkLogic runs in one `docker compose` project and a consumer (this MCP server,
another app) runs in a different one, they're on different Docker networks by default
and cannot resolve each other by container name. That problem, and the three ways to
solve it (shared external network, host networking, host-IP), is already covered in full
in `docs/docker-networking.md` at the repo root — read that rather than re-deriving a
networking fix here.

## Debugging a container that won't come up

- `docker exec -it <container> tail -f /var/opt/MarkLogic/Logs/ErrorLog.txt` — the
  authoritative source, before assuming a compose-level misconfiguration.
- `docker exec -it <container> service MarkLogic status` — confirms the process itself
  is running inside a container that Docker reports as up.
- A container that exits within the first few seconds with no MarkLogic log output past
  the startup banner is a container-runtime problem (permissions, missing volume,
  incompatible image variant for the host architecture), not a MarkLogic configuration
  problem — check `docker logs` for the container runtime's own errors first.

## Verifying the instance is actually ready

Don't trust `docker compose up` exiting 0 or a `healthy` status alone — confirm against
the instance itself once reachable:

```
ml_cluster_status      # cluster is up and stable
ml_databases_list      # default databases exist (Documents, Security, ...)
ml_servers_list        # expected app servers are listening on the expected ports
```

An empty or error result from any of these while the container reports `healthy` means
the healthcheck verified less than it should — widen it rather than assuming the MCP
connection config is wrong.

## Further reading

- [marklogic/marklogic-docker](https://github.com/marklogic/marklogic-docker) — the
  image's own README: full environment-variable reference, single/multi-node clustering
  examples (including Docker secrets and Swarm), TLS cluster join, backup/restore, and
  the known-issues list this skill's clustering caveats are drawn from
- [progressofficial/marklogic-db on Docker Hub](https://hub.docker.com/r/progressofficial/marklogic-db)
  — the published image and its tags
- `docs/docker-networking.md` (this repo) — cross-project container networking, in depth
- **marklogic-project-setup** — what to deploy once the container is up and reachable
  (indexes, TDE templates, REST extensions, ml-gradle)
