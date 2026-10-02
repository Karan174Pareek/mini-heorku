# Pushr 🚀

A lightweight, push-to-deploy PaaS built on Kubernetes (k3d), Node.js, and Cloud Native Buildpacks.

Push code via `git push pushr main` and have your app automatically built, containerized, deployed, and routed to `https://<app>.pushr.localhost` with automatic TLS.

---

## Architecture Overview

```mermaid
graph TD
    subgraph Developer Workflow
        Dev[Developer] -->|git push pushr main| GitServer[Pushr Git Server / Smart HTTP]
    end

    subgraph Control Plane
        GitServer -->|Post-Receive Hook| API[Pushr API Service]
        API --> DB[(MongoDB Mongoose)]
        API --> Builder[Builder Engine: Dockerfile / Buildpacks]
        Builder -->|Push image:tag| Registry[Local Registry :5001 (host) / :5000 (cluster)]
        API -->|K8s Deployment / Service / Ingress| Cluster[Kubernetes Cluster]
    end

    subgraph Edge & Ingress
        Traefik[Traefik Ingress] -->|https://slug.pushr.localhost| Cluster
        CertManager[cert-manager] -->|TLS Certificates| Traefik
    end

    subgraph User Interfaces
        Dashboard[React Dashboard] -->|REST / SSE Logs| API
        CLI[Pushr CLI] -->|API Calls| API
    end
```

---

## Quickstart

### Prerequisites
1. **Docker Desktop** (running with WSL2 backend or Hyper-V)
2. **Node.js** (>= 20)
3. **k3d** & **kubectl** (installed)

### Bootstrapping Infrastructure
```bash
# Using Make
make up

# Or via PowerShell on Windows
powershell -ExecutionPolicy Bypass -File infra/scripts/up.ps1
```

### Running Verification
```bash
# Automated verification for Phase 1
powershell -ExecutionPolicy Bypass -File infra/tests/verify-phase1.ps1
```

### Teardown
```bash
# Using Make
make down

# Or via PowerShell on Windows
powershell -ExecutionPolicy Bypass -File infra/scripts/down.ps1
```
