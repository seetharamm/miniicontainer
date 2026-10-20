# minicontainer User Guide

`minicontainer` is a Docker-like container runtime written in Node.js. It supports image pulling and building, Linux namespace isolation, bridge networking, volumes, environment configuration, resource limits, privilege dropping, cached OverlayFS layers, multi-tenant state, standalone binaries, and a lightweight multi-host orchestrator.

## Contents

- [Installation](#installation)
- [Container lifecycle](#container-lifecycle)
- [Images](#images)
- [Environment and runtime configuration](#environment-and-runtime-configuration)
- [Filesystem and volumes](#filesystem-and-volumes)
- [Networking](#networking)
- [Security and resource isolation](#security-and-resource-isolation)
- [Multi-tenancy](#multi-tenancy)
- [Compose](#compose)
- [Events and logs](#events-and-logs)
- [Multi-host orchestration](#multi-host-orchestration)
- [Standalone binaries](#standalone-binaries)
- [State layout](#state-layout)
- [Testing](#testing)
- [Platform requirements and limitations](#platform-requirements-and-limitations)

## Installation

### From source

```bash
cd minicontainer
npm install
npm link
minicontainer --version
```

The `mydocker` entry point exposes the same command registry under a Docker-compatible name:

```bash
mydocker ps
mydocker run alpine /bin/sh
```

## Container lifecycle

### Pull and run

```bash
minicontainer pull alpine:3.19
minicontainer run alpine:3.19 /bin/sh
```

Run detached with a name:

```bash
minicontainer run --detach --name web nginx:latest
```

The `run` command accepts environment variables, mounts, ports, resource limits, and a user:

```bash
minicontainer run \
  --detach \
  --name api \
  --env APP_ENV=production \
  --env DATABASE_URL='postgres://db/app' \
  --volume ./config:/etc/api:ro \
  --port 8080:8080 \
  --memory 512m \
  --cpus 1.5 \
  --pids-limit 128 \
  --user nobody \
  my-api:latest
```

### List, inspect, and manage containers

```bash
minicontainer ps
minicontainer ps --all
minicontainer inspect api
minicontainer logs api
minicontainer logs --follow api
minicontainer logs --tail 50 api
minicontainer exec api /bin/sh
minicontainer top api
minicontainer stats --no-stream api
minicontainer diff api
minicontainer port api
```

Lifecycle commands:

```bash
minicontainer start api
minicontainer stop --time 10 api
minicontainer restart api
minicontainer pause api
minicontainer unpause api
minicontainer kill api
minicontainer wait api
minicontainer rename api api-v2
minicontainer rm api
minicontainer rm --force api
```

Copy files between the host and a container with Docker-style paths:

```bash
minicontainer cp ./app.conf api:/etc/app.conf
minicontainer cp api:/var/log/app.log ./app.log
```

## Images

Pull images from Docker Hub or another OCI-compatible registry supported by the registry client:

```bash
minicontainer pull alpine
minicontainer pull ubuntu:22.04
minicontainer pull ghcr.io/example/app:v1
minicontainer images
minicontainer history alpine
```

Build an image from a `Containerfile` or Dockerfile:

```bash
minicontainer build . --tag example-api:latest
minicontainer build ./service --file Containerfile --tag example-api:v2
```

Supported build instructions include:

```Dockerfile
FROM node:20
WORKDIR /app
ENV NODE_ENV=production
COPY . .
RUN npm ci
EXPOSE 8080
USER node
CMD ["node", "server.js"]
```

Image lifecycle and export commands:

```bash
minicontainer tag example-api:latest registry.example.com/example-api:v1
minicontainer save example-api:latest --output example-api.tar
minicontainer load --input example-api.tar
minicontainer push example-api:latest
minicontainer rmi example-api:latest
```

## Environment and runtime configuration

Image environment values are merged with host values and runtime values. Runtime values override image values, and values containing `=` are preserved.

```bash
minicontainer run \
  --env APP_ENV=production \
  --env DSN='postgres://user:pass@db/app?ssl=true' \
  alpine env
```

The custom parser is available programmatically:

```js
const { parseEnv, buildRuntimeEnv } = require('./src/core/config');

const runtime = parseEnv(['APP_ENV=production', 'EMPTY=', 'DSN=a=b']);
const env = buildRuntimeEnv(runtime, ['APP_ENV=development', 'IMAGE_DEFAULT=yes']);

console.log(env.APP_ENV); // production
console.log(env.DSN);     // a=b
```

Environment variable names must match `[A-Za-z_][A-Za-z0-9_]*`.

## Filesystem and volumes

### Bind mounts

```bash
minicontainer run \
  --volume /host/data:/data \
  --volume /host/config:/etc/app:ro \
  alpine /bin/sh
```

### Named and anonymous volumes

```bash
minicontainer volume create app-data
minicontainer volume ls
minicontainer volume inspect app-data
minicontainer run --volume app-data:/var/lib/app alpine
minicontainer volume rm app-data
minicontainer volume prune
```

Supported volume options include `ro`, `rw`, and `nocopy`:

```bash
minicontainer run --volume app-data:/data:ro alpine /bin/sh
```

### OverlayFS

On Linux, image layers are unpacked into a cached lower directory and mounted with a per-container writable upper directory:

```text
~/.minicontainer/overlay/lower/<image-key>/
~/.minicontainer/tenants/<tenant>/containers/<id>/overlay/upper/
~/.minicontainer/tenants/<tenant>/containers/<id>/overlay/work/
```

If OverlayFS cannot be mounted, the runtime falls back to extracting image layers into the container rootfs.

## Networking

### Bridge networking

Linux containers receive isolated network namespaces and are connected to the `minicontainer0` bridge through veth pairs. Containers on the same bridge can communicate using their assigned `172.30.0.x` addresses.

```bash
minicontainer run --detach --name web nginx
minicontainer run --detach --name client alpine sleep 3600
minicontainer inspect web
minicontainer inspect client
```

Connect an existing running container:

```bash
minicontainer network connect bridge client
minicontainer network inspect bridge
minicontainer network disconnect bridge client
```

Network management:

```bash
minicontainer network ls
minicontainer network create backend --driver bridge --subnet 172.31.0.0/24 --gateway 172.31.0.1
minicontainer network inspect backend
minicontainer network rm backend
minicontainer network prune
```

The bridge configures forwarding and NAT on Linux. Network setup requires the privileges needed for bridge, veth, and iptables operations.

## Security and resource isolation

### Linux namespaces

Linux uses `unshare` and `chroot` for PID, network, mount, UTS, IPC, and filesystem isolation. Commands executed in a running container use `nsenter`.

### Dropping privileges

A container starts with the privileges needed for initialization and then runs its main process as the configured image user or `--user` value:

```bash
minicontainer run --user nobody alpine id
minicontainer run --user 1000:1000 app:latest
```

An image can declare its default user:

```Dockerfile
FROM alpine
USER nobody
CMD ["/bin/sh"]
```

The image must contain a usable `su` implementation for username-based privilege dropping.

### Resource controls

On Linux, cgroups are used when available:

```bash
minicontainer run \
  --memory 256m \
  --cpus 0.5 \
  --pids-limit 64 \
  --blkio 500 \
  alpine /bin/sh
```

Limits are validated before the container process starts.

## Multi-tenancy

Each tenant gets independent image and container databases and storage directories. Select a tenant with an environment variable:

```bash
MINICONTAINER_TENANT=team-a minicontainer pull alpine
MINICONTAINER_TENANT=team-a minicontainer run --name app alpine
MINICONTAINER_TENANT=team-a minicontainer ps

MINICONTAINER_TENANT=team-b minicontainer ps
```

Tenant data is stored under:

```text
~/.minicontainer/tenants/team-a/
  containers.json
  images.json
  containers/
  images/
```

Tenant names may contain letters, numbers, `_`, `.`, and `-`; path traversal is rejected.

## Compose

Compose supports service dependency ordering, builds, environment values, ports, volumes, resource limits, and lifecycle commands:

```yaml
services:
  db:
    image: postgres:16
    environment:
      POSTGRES_PASSWORD: example
  web:
    build: .
    depends_on:
      - db
    environment:
      APP_ENV: production
    ports:
      - "8080:8080"
```

```bash
minicontainer compose up --detach
minicontainer compose ps
minicontainer compose logs --follow web
minicontainer compose down
minicontainer compose down --volumes
```

## Events and logs

Stream or query the event log:

```bash
minicontainer events
minicontainer events --no-stream --format json
minicontainer events --filter type=container --filter action=start
minicontainer events --since 30m
minicontainer events --tail 20
```

Events cover container, image, volume, network, and system actions.

## Multi-host orchestration

The orchestrator has a control-plane process and lightweight worker agents. Workers expose a health endpoint and a container-run endpoint. The master schedules to the least-loaded ready node matching workload labels.

### Start a worker agent

Run this on every worker host:

```bash
MINICONTAINER_NODE_ID=worker-a \
minicontainer orchestrator agent \
  --host 0.0.0.0 \
  --port 8787 \
  --token replace-with-secret
```

Check health:

```bash
curl -H 'Authorization: Bearer replace-with-secret' \
  http://worker-a:8787/health
```

### Register workers

Run on the master:

```bash
minicontainer orchestrator node register worker-a \
  --endpoint http://worker-a:8787 \
  --capacity 4 \
  --label zone=east \
  --token replace-with-secret

minicontainer orchestrator node register worker-b \
  --endpoint http://worker-b:8787 \
  --capacity 8 \
  --label zone=west \
  --token replace-with-secret

minicontainer orchestrator node ls
```

### Deploy a workload

Create `workload.json`:

```json
{
  "id": "api-1",
  "image": "alpine:latest",
  "cmd": ["sleep", "3600"],
  "labels": {
    "zone": "east"
  },
  "env": ["APP_ENV=production"],
  "memory": "256m",
  "cpus": 0.5
}
```

Deploy it:

```bash
minicontainer orchestrator deploy workload.json
```

### Heartbeats and failover

Start the master heartbeat monitor:

```bash
minicontainer orchestrator monitor \
  --interval 5 \
  --threshold 2
```

The master polls each worker's `/health` endpoint. After two failed checks, it marks the worker offline and reschedules its recorded running workloads onto another ready node with matching labels.

Programmatic use:

```js
const orchestrator = require('./src/core/orchestrator');

const monitor = orchestrator.startHeartbeatMonitor({
  intervalMs: 5000,
  failureThreshold: 2,
});

// Shut down cleanly when the control-plane process exits.
process.on('SIGTERM', () => monitor.stop());
```

Failover can also be triggered directly:

```js
const moved = await orchestrator.failoverNode('worker-a');
console.log(moved);
// [{ id: 'api-1', from: 'worker-a', to: 'worker-b' }]
```

Failover is at-least-once. A worker may have started a workload before becoming unreachable, so applications should use durable workload IDs and idempotent startup behavior. The orchestrator does not yet provide consensus, replicated control-plane state, TLS/mTLS, cross-host networking, or replicated volumes.


### Service mesh routing

Workloads can register a service name and port. The master stores the route and exposes discovery, while worker agents proxy requests to the local container address. This allows callers to use a stable service name even when the target container is on another worker.

Deploy a service workload:

```json
{
  "id": "api-1",
  "image": "my-api:latest",
  "service": "api",
  "servicePort": 8080,
  "protocol": "http"
}
```

List routes on the master:

```bash
minicontainer orchestrator service ls
```

Programmatic discovery and proxying:

```js
const orchestrator = require('./src/core/orchestrator');

const route = orchestrator.discoverService('api');
console.log(route.nodeId, route.containerId, route.port);

const response = await orchestrator.proxyService('api', {
  method: 'GET',
  path: '/health',
});
console.log(response.status, response.data.toString());
```

Worker agents provide these mesh endpoints:

```text
GET /mesh/services
ANY /mesh/proxy/<service>/<path>
```

The proxy resolves the service route, selects the registered worker endpoint, and forwards the request into the target container over the worker's bridge network. Bearer tokens are applied to worker-to-worker proxy requests when configured. This is an HTTP service proxy, not a full L3 overlay network: arbitrary UDP, raw IP, and non-HTTP protocols require a separate tunnel or overlay network implementation.

## Standalone binaries

Build self-contained executables with `pkg`:

```bash
npm run build:linux
npm run build:windows
npm run build:binary
```

Outputs:

```text
dist/minicontainer-linux-x64
dist/mydocker-linux-x64
dist/minicontainer-win-x64.exe
dist/mydocker-win-x64.exe
```

The binaries include the Node.js runtime, but Linux still requires host kernel tools and privileges for namespaces, mounts, networking, cgroups, and OverlayFS.

## State layout

The runtime stores state beneath `~/.minicontainer`:

```text
~/.minicontainer/
  tenants/<tenant>/
    containers.json
    images.json
    containers/<id>/
      rootfs/
      container.log
      overlay/upper/
      overlay/work/
    images/<id>/layers/
  overlay/lower/<image-key>/
  cache/blobs/sha256/
  volumes/
  volumes.json
  networks.json
  network.json
  events.jsonl
  tenants/<tenant>/orchestrator.json
```

Use separate tenants rather than manually editing these files. State files are JSON and writes are atomic in the main stores.

## Testing

Run the built-in test suite:

```bash
npm test
```

Run syntax checks for a specific module:

```bash
node --check src/core/orchestrator.js
node --check src/core/runtime.js
```

The project also defines a lint command, but it requires an ESLint configuration to be present:

```bash
npm run lint
```

## Platform requirements and limitations

### Linux

Requires Node.js 18+ for source execution, plus commonly available tools:

- `unshare`
- `chroot`
- `nsenter`
- `mount` and `umount`
- `ip`
- `iptables`
- cgroups support for resource limits
- OverlayFS support for cached copy-on-write layers

Bridge networking, namespace setup, cgroups, and OverlayFS may require root or capabilities such as `CAP_NET_ADMIN` and `CAP_SYS_ADMIN`.

### Windows

Windows uses process and filesystem isolation, host networking, NTFS junctions, and `netsh interface portproxy`. Full Linux namespace behavior requires running inside WSL 2.

### Current limitations

- The orchestrator is a lightweight educational control plane, not a production Kubernetes replacement.
- Orchestrator agent transport supports bearer tokens but not TLS/mTLS.
- Failover is at-least-once and does not provide distributed consensus.
- Cross-host container networking and replicated persistent volumes are not implemented.
- The runtime uses direct Linux tools rather than the OCI `runc` specification.
