# minicontainer

A Docker-like container runtime built **from scratch in Node.js**.  
Runs on **Linux** (full kernel-namespace isolation) and **Windows** (process + filesystem isolation).

---

## Architecture

```
bin/
  minicontainer.js        ← CLI entry point (#!/usr/bin/env node)
src/
  cli.js                  ← Commander program, all sub-commands wired up
  commands/
    run.js                ← minicontainer run
    stop.js               ← minicontainer stop
    ps.js                 ← minicontainer ps
    rm.js                 ← minicontainer rm
    images.js             ← minicontainer images
    pull.js               ← minicontainer pull
    build.js              ← minicontainer build
    logs.js               ← minicontainer logs
    exec.js               ← minicontainer exec
    inspect.js            ← minicontainer inspect
  core/
    runtime.js            ← Container spawn, stop, exec (unshare/chroot on Linux; Job Object on Windows)
  image/
    puller.js             ← Pull OCI/Docker layers from registry (Docker Hub compatible)
    builder.js            ← Containerfile / Dockerfile parser & image builder
  network/
    bridge.js             ← Virtual bridge + veth pairs (Linux); portproxy (Windows)
  state/
    store.js              ← JSON-file persistence (~/.minicontainer/)
  utils/
    platform.js           ← IS_WINDOWS / IS_LINUX / requireLinux()
    exec.js               ← run() / runInteractive() wrappers over child_process.spawn
    ids.js                ← shortId() / fullId() (UUID-based)
    tail.js               ← fs.watch-based log tail (cross-platform)
examples/
  Containerfile           ← Example build descriptor
test/
  runner.js               ← Built-in test suite (no framework needed)
```

---

## How it works

### Linux (full isolation)

| Layer | Mechanism |
|---|---|
| Process isolation | `unshare --pid --fork --mount --uts --ipc` |
| Filesystem isolation | `chroot <rootfs>` after unpacking image layers |
| Network isolation | `--net` namespace + veth pair + bridge (`minicontainer0`) |
| Port forwarding | `iptables DNAT` rules |
| Execute in running container | `nsenter --target <pid>` |

### Windows (process isolation)

| Layer | Mechanism |
|---|---|
| Process isolation | Isolated child process with separate working directory |
| Filesystem isolation | Image layers unpacked to `%USERPROFILE%\.minicontainer\containers\<id>\rootfs\` |
| Volume mounts | NTFS junction points |
| Port forwarding | `netsh interface portproxy` rules |
| Network | Host networking (full namespace isolation requires WSL 2) |

> **Full Linux namespace isolation on Windows** requires WSL 2.  
> Run `minicontainer` inside the WSL shell for the complete experience.

---

## Installation

```bash
cd minicontainer
npm install
npm link          # makes `minicontainer` available globally
```

### Standalone native binaries

Build self-contained native executables with the bundled [`pkg`](https://github.com/vercel/pkg) scripts. The binaries embed the Node.js runtime and application code, so the target machine does not need Node.js installed.

```bash
npm install
npm run build:linux    # dist/minicontainer-linux-x64 and dist/mydocker-linux-x64
npm run build:windows  # dist/minicontainer-win-x64.exe and dist/mydocker-win-x64.exe
```

Build both platforms with `npm run build:binary`. Linux binaries still require the host kernel tools and privileges used by the runtime (`unshare`, `mount`, `ip`, `iptables`, and `nsenter`); compilation does not remove those operating-system requirements. Runtime state remains under `~/.minicontainer`.



### Multi-host micro-orchestrator

The [`orchestrator`](src/core/orchestrator.js) module provides a small control-plane/agent model:

- Register remote host agents with endpoint, capacity, labels, and optional bearer token.
- Schedule workloads using least-loaded eligible-node selection.
- Run a local HTTP agent that invokes the existing container runtime.
- Deploy workload JSON files to selected hosts.

Start an agent on each host:

```bash
minicontainer orchestrator agent --port 8787 --token secret
```

Register hosts and deploy from the control node:

```bash
minicontainer orchestrator node register host-a --endpoint http://host-a:8787 --capacity 4 --label zone=east --token secret
minicontainer orchestrator node ls
minicontainer orchestrator deploy workload.json
```

A workload file contains at least `id` and `image`, and may include `labels`, `env`, `cmd`, `ports`, `volumes`, and resource limits. This is a lightweight scheduler, not a production Kubernetes replacement: it does not yet provide consensus, replicated control-plane state, secure certificate-based transport, persistent reconciliation, or cross-host networking/volume replication.

---

## Full documentation

See the complete [User Guide](docs/USER_GUIDE.md) for all runtime, security, networking, storage, tenancy, orchestration, failover, and distribution features with code snippets.

## Usage

### Pull an image
```bash
minicontainer pull alpine
minicontainer pull ubuntu:22.04
minicontainer pull nginx:latest
```

### Run a container (foreground)
```bash
minicontainer run alpine /bin/sh
```

### Run a container (detached)
```bash
minicontainer run -d --name webserver -p 8080:80 nginx
```

### Run with volumes and env vars
```bash
minicontainer run -v ./data:/data -e DEBUG=true alpine /bin/sh
```

### List containers
```bash
minicontainer ps        # running only
minicontainer ps -a     # all
```

### Stop a container
```bash
minicontainer stop <id|name>
```

### Remove a container
```bash
minicontainer rm <id|name>
minicontainer rm -f <id|name>   # force-remove running container
```

### View logs
```bash
minicontainer logs <id|name>
minicontainer logs -f <id|name>         # follow
minicontainer logs --tail 50 <id|name>  # last 50 lines
```

### Execute command in a running container
```bash
minicontainer exec <id|name> /bin/sh
```

### Inspect container metadata
```bash
minicontainer inspect <id|name>
```

### Build an image from a Containerfile
```bash
minicontainer build . -t myapp:latest
```

Supported Containerfile instructions:
`FROM`, `RUN`, `COPY`, `ADD`, `WORKDIR`, `ENV`, `EXPOSE`, `CMD`, `ENTRYPOINT`, `LABEL`, `USER`

### List local images
```bash
minicontainer images
```

---

## State & data

All data is stored in `~/.minicontainer/`:

```
~/.minicontainer/
  containers.json          ← container registry
  images.json              ← image registry
  containers/
    <id>/
      rootfs/              ← unpacked filesystem
      container.log        ← stdout/stderr (detached mode)
  images/
    <id>/
      layers/              ← downloaded .tar layer files
      rootfs/              ← (built images only)
```

---

## Running tests

```bash
node test/runner.js
```

---

## Requirements

| Requirement | Notes |
|---|---|
| Node.js ≥ 18 | Any platform |
| `unshare`, `chroot`, `ip`, `iptables`, `nsenter` | Linux only — usually pre-installed |
| WSL 2 | Windows — for full namespace isolation |
| Administrator / sudo | Required for network bridge and iptables rules |

---

## Limitations

- No built-in image registry server (push not implemented — pull only from Docker Hub)
- No OCI runtime spec (runc) integration — uses `unshare`/`chroot` directly
- OverlayFS is Linux-only and falls back to full extraction when unavailable
- Windows isolation is process-level, not hypervisor-level (unlike Docker Desktop)
- Multi-host orchestration is lightweight and does not provide consensus, TLS/mTLS, or replicated storage
