# Docker Networking — Connecting to Existing MarkLogic & Semaphore Containers

When MarkLogic and/or Semaphore are already running as Docker containers on the
same host, the MCP server needs to reach them over the Docker network. This guide
covers the three main approaches and when to use each.

---

## The Problem

Each `docker compose` project creates its own isolated bridge network. Containers
in different projects cannot see each other by default — even though they're on the
same machine.

```
┌─────────────────────────┐   ┌─────────────────────────┐
│  marklogic_default net  │   │  mcp_default net         │
│                         │   │                          │
│  ┌───────────┐          │   │  ┌──────────────┐        │
│  │ marklogic │          │   │  │ marklogic-mcp│        │
│  └───────────┘          │   │  └──────────────┘        │
│                         │   │        ✗ can't reach     │
│  ┌───────────┐          │   │        marklogic         │
│  │ semaphore │          │   │                          │
│  └───────────┘          │   └──────────────────────────┘
└─────────────────────────┘
```

---

## Approach 1: Shared External Network (Recommended)

Create one Docker network and attach all containers to it. They can then reach
each other by container name.

### Step 1 — Create the network (one-time)

```bash
docker network create shared
```

### Step 2 — Add the network to your MarkLogic compose file

```yaml
# marklogic/docker-compose.yml
networks:
  shared:
    external: true

services:
  marklogic:
    image: progressofficial/marklogic-db:latest
    container_name: marklogic
    networks:
      - shared
      - default        # keep the project-internal network too
    ports:
      - "8000:8000"
      - "8001:8001"
      - "8002:8002"
    # ... rest of config
```

Do the same for Semaphore if applicable:

```yaml
# semaphore/docker-compose.yml
networks:
  shared:
    external: true

services:
  semaphore:
    container_name: semaphore
    networks:
      - shared
      - default
    # ... rest of config
```

### Step 3 — Start the MCP server

```bash
ML_HOST=marklogic ML_PASSWORD=admin SEMAPHORE_HOST=semaphore \
  docker compose -f docker-compose.external.yml up -d
```

The `docker-compose.external.yml` file in the repo root already references the
`shared` external network.

### Attaching already-running containers without restarting

If you don't want to modify another project's compose file, attach on the fly:

```bash
docker network connect shared marklogic
docker network connect shared semaphore
```

This takes effect immediately — no restart needed. The container keeps its
existing network(s) and gains an additional interface on the `shared` network.

**Caveat**: `docker network connect` does not persist across container restarts.
Add `networks: [shared]` to the compose file for a permanent solution.

```
┌──────────────────────────────────────────────────────────┐
│  "shared" network                                        │
│                                                          │
│  ┌───────────┐  ┌───────────┐  ┌──────────────────────┐  │
│  │ marklogic │  │ semaphore │  │ marklogic-mcp        │  │
│  │ :8000     │  │ :5058     │  │ ML_HOST=marklogic    │  │
│  │ :8002     │  │ :5080     │  │ SEM_HOST=semaphore   │  │
│  └───────────┘  └───────────┘  └──────────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

---

## Approach 2: Host Network Mode

Use the host's network stack directly. Every container sees `localhost` as the
host machine — so if MarkLogic publishes port 8000 on the host, the MCP server
reaches it at `localhost:8000`.

```yaml
services:
  marklogic-mcp:
    image: ghcr.io/tternquist/marklogic-mcp:master
    network_mode: host
    environment:
      - ML_HOST=localhost
      - ML_PORT=8000
      - SEMAPHORE_HOST=localhost
      # ...
```

**Pros**: Simplest setup — no network plumbing needed.

**Cons**:
- No port isolation — if anything else uses port 3000, there's a conflict.
- `ports:` mappings are ignored in host mode.
- Not available on Docker Desktop for macOS/Windows (only Linux).
- Loses Docker's DNS-based service discovery.

**When to use**: Quick local testing on Linux when you don't care about isolation.

---

## Approach 3: Connect via Host IP

Use the host's IP address from inside the container. This works when MarkLogic
and Semaphore publish ports on the host (e.g. `-p 8000:8000`).

| Platform | Host address |
|---|---|
| Docker Desktop (macOS / Windows) | `host.docker.internal` |
| Linux (Docker 20.10+) | `host.docker.internal` (with `--add-host=host.docker.internal:host-gateway`) |
| Linux (older Docker) | The Docker bridge gateway IP, usually `172.17.0.1` |

```yaml
services:
  marklogic-mcp:
    image: ghcr.io/tternquist/marklogic-mcp:master
    extra_hosts:
      - "host.docker.internal:host-gateway"   # Linux only; macOS/Win have it built in
    environment:
      - ML_HOST=host.docker.internal
      - ML_PORT=8000
      - SEMAPHORE_HOST=host.docker.internal
      - SEMAPHORE_SCS_PORT=5058
      - SEMAPHORE_KMM_PORT=5080
```

**Pros**: Works without touching the other compose projects at all.

**Cons**:
- Traffic goes through the host's published ports — requires `-p` mappings.
- Slightly more latency than direct container-to-container networking.
- On Linux, `host.docker.internal` requires `extra_hosts` or Docker 20.10+.

---

## Approach Comparison

| | Shared Network | Host Mode | Host IP |
|---|---|---|---|
| Cross-platform | Yes | Linux only | Yes (with caveats) |
| Requires modifying other compose files | Recommended but optional | No | No |
| Containers resolve by name | Yes | N/A (all on host) | No (use host IP) |
| Port conflicts possible | No | Yes | No |
| Requires published ports on host | No | No | Yes |
| Persistent across restarts | Yes (if in compose) | Yes | Yes |

---

## Verifying Connectivity

After starting everything, verify the MCP server can reach MarkLogic and
Semaphore:

```bash
# MCP server health
curl http://localhost:3000/health

# Check MCP server logs for connection errors
docker logs marklogic-mcp 2>&1 | head -30

# Test connectivity from inside the MCP container
docker exec marklogic-mcp curl -sf http://marklogic:8002/manage/v2
docker exec marklogic-mcp curl -sf http://semaphore:5058/api
```

---

## Full Example: All Three Services on One Host

This example assumes MarkLogic and Semaphore each have their own compose file,
and the MCP server uses `docker-compose.external.yml`.

```bash
# 1. Create the shared network
docker network create shared

# 2. Start MarkLogic (its compose file includes networks: [shared])
cd ~/marklogic && docker compose up -d

# 3. Start Semaphore (its compose file includes networks: [shared])
cd ~/semaphore && docker compose up -d

# 4. Start the MCP server + Flux
cd ~/marklogic-mcp
ML_HOST=marklogic ML_PASSWORD=admin \
  SEMAPHORE_HOST=semaphore SEMAPHORE_USERNAME=admin SEMAPHORE_PASSWORD=admin \
  docker compose -f docker-compose.external.yml --profile flux up -d

# 5. Verify
curl http://localhost:3000/health
```

---

## Running MarkLogic Itself in Docker — Known Gotchas

Hard-won facts about the `progressofficial/marklogic-db` image that otherwise get
re-diagnosed by every project.

### First boot on a fresh volume can race and exit 1

With `MARKLOGIC_INIT=true`, the init script calls `/admin/v1/instance-admin` while the
server is still coming up. On a fresh data volume it can get a `503` and give up, and
the container exits with code 1. **This does not mean the image or your config is
broken** — run `docker compose up` again; the second boot almost always succeeds
immediately. Only start debugging if a *second* clean boot also fails.

### Admin/Manage endpoints require authentication — write healthchecks accordingly

`/admin/v1/timestamp` and the Manage API (`:8002/manage/v2`) require Digest/Basic auth
in current images. An unauthenticated healthcheck gets a `401`, which `curl -f` treats
as failure — so a container that is perfectly healthy reports `unhealthy`, or worse,
flaps depending on timing. The canonical known-good healthcheck:

```yaml
healthcheck:
  test: ["CMD", "curl", "-sf", "--anyauth", "-u", "admin:admin", "http://localhost:8002/manage/v2"]
  interval: 15s
  timeout: 10s
  retries: 10
  start_period: 60s
```

`--anyauth` lets curl answer whichever challenge (Digest or Basic) the server issues,
so the check keeps working across image versions with different auth defaults.

### The Docker daemon may be shared — never adopt containers you didn't create

On shared hosts (CI runners, cloud dev environments, team servers) `docker ps -a` can
show containers, images, and networks from **other sessions or other people's
projects**. A container name that sounds related to your task is not evidence it
belongs to your task — never reuse, inspect-and-adapt, or build on top of
infrastructure you did not create in the current session. Give every project a unique
identity so collisions can't happen:

```bash
# compose project name prefixes every container, network, and volume name
COMPOSE_PROJECT_NAME=myapp-$(whoami) docker compose up -d
# or pin it in the compose file:  name: myapp-demo
```

### Node app images next to MarkLogic: lock the install

When writing a Dockerfile for a UI or middle-tier next to MarkLogic, always
`COPY package.json package-lock.json ./` (plus any `.npmrc` the build needs) and use
`npm ci`, never `npm install`. A plain `npm install` with no lockfile re-resolves
versions inside the container — behind a private registry mirror or a
release-age-gated proxy this fails with `ECONNREFUSED` or `403` on packages that
resolved fine on the host, and neither error message points at the real cause. This
repo's own `Dockerfile` follows the pattern.
