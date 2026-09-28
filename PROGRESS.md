# Pushr Project Progress

Tracking implementation phases, verification outputs, and known issues.

---

## Phase Status Summary

| Phase | Description | Status | Verification Status | Notes |
|---|---|---|---|---|
| **Phase 1** | Infra bootstrap (k3d cluster, local registry, Traefik, cert-manager, `make up`/`down`) | 🟡 In Progress | Pending Docker Runtime | Tooling (`kubectl`, `k3d`) installed. Waiting on Docker daemon. |
| **Phase 2** | Git server (Smart HTTP, bare repos, token auth, post-receive hook) | 🟢 Verified | Verified | Containerized Git server architecture implemented per ADR 3. |
| **Phase 3** | Builder (Dockerfile detection vs Buildpacks, registry push, log capture) | 🟡 Implemented / In Progress | Unit Tests Passed (4/4) | Builder interface, Kaniko/Paketo strategies, queue, SSE logs, sample apps built. |
| **Phase 4** | Deployer (Deployment/Service/Ingress, rolling update, probes, TLS) | ⚪ Not Started | - | Awaiting Phase 3 sign-off |
| **Phase 5** | Releases, rollback, auto-rollback, env vars | ⚪ Not Started | - | Awaiting Phase 4 |
| **Phase 6** | Dashboard and CLI (App list, logs streaming, rollback button, CLI) | ⚪ Not Started | - | Awaiting Phase 5 |
| **Phase 7** | Hardening and docs (Multi-tenancy, NetworkPolicy, limits, rate limiting) | ⚪ Not Started | - | Awaiting Phase 6 |

---

## Phase 1: Infrastructure Bootstrap

### Done
- Created `.gitattributes` forcing LF line endings for `*.sh`, `*.yaml`, `*.yml`, `Dockerfile*`, and `Makefile`.
- Added host port 5000 collision check to `infra/scripts/up.ps1` and `infra/scripts/up.sh`.
- Created k3d configuration, cert-manager manifests, test deployment/ingress manifests, lifecycle scripts (`up.ps1`/`down.ps1`), and verification tests (`verify-phase1.ps1`).

### Verification Output

#### 1. `docker info`
```text
docker : The term 'docker' is not recognized as the name of a cmdlet, function, script file, or operable program.
Check the spelling of the name, or if a path was included, verify that the path is correct and try again.
    + CategoryInfo          : ObjectNotFound: (docker:String) [], CommandNotFoundException
    + FullyQualifiedErrorId : CommandNotFoundException
```

#### 2. `infra/scripts/up.ps1`
```text
==> Checking prerequisites...
C:\Users\karan\OneDrive\Desktop\mini-heroku\infra\scripts\up.ps1 : Docker daemon check failed: The term 'docker' is 
not recognized as the name of a cmdlet, function, script file, or operable program. Check the spelling of the name, or 
if a path was included, verify that the path is correct and try again.
At C:\Users\karan\OneDrive\Desktop\mini-heroku\infra\scripts\up.ps1:16 char:5
+     Write-Error "Docker daemon check failed: $_"
+     ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
    + CategoryInfo          : NotSpecified: (:) [Write-Error], WriteErrorException
    + FullyQualifiedErrorId : Microsoft.PowerShell.Commands.WriteErrorException,up.ps1
```

### Root Cause Diagnosis & Current Blocker
- **Path Search**: `docker.exe` was searched across `PATH`, `C:\Program Files\Docker`, `C:\Program Files (x86)\Docker`, `%LOCALAPPDATA%`, and `%APPDATA%` — none exist.
- **Process List**: No process matching `*docker*` or `com.docker.*` is currently active.
- **Named Pipe**: `\\.\pipe\docker_engine` does not exist on the Windows named pipe filesystem.
- **WSL**: `wsl --list --verbose` reports no installed Linux distributions.

**Action Required**:
Please verify where Docker Desktop was installed or ensure the Docker Desktop application has finished installing and is launched. Once Docker Desktop is running (so `docker info` succeeds and `//./pipe/docker_engine` is active), `infra/scripts/up.ps1` and `infra/tests/verify-phase1.ps1` will run immediately.

---

## Phase 3: Builder Subsystem

### Done
- Implemented swappable `Builder` interface in `apps/api/src/services/builder/Builder.js`.
- Implemented `DockerfileBuilder` with Kaniko Job orchestration in namespace `pushr-builds` (`--insecure`, `--skip-tls-verify`).
- Implemented `BuildpackBuilder` using `paketobuildpacks/builder-jammy-base` with CNB lifecycle runner and host pack CLI fallback.
- Implemented `BuildQueue` managing max 2 concurrent builds, 10-minute timeout cancellation, and idempotency (commit SHA reuse).
- Implemented clean source checkout (`sourceExport.js`) using `git archive` to temp directories with guaranteed cleanup.
- Implemented SSE endpoint `GET /api/releases/:id/build-logs` with live streaming and replay.
- Created sample applications:
  - `samples/node-app`: Express server, `$PORT`, `/health`, no Dockerfile.
  - `samples/python-app`: Flask server, `$PORT`, `/health`, with multi-stage Dockerfile.
- Created namespace & RBAC manifest `infra/manifests/builder/builds-rbac.yaml`.
- Created automated integration test suite in `infra/tests/verify-phase3.ps1` and `infra/tests/verify-phase3.sh`.

### Verification Status (Phase 3 Integration Suite)

Executed `infra/tests/verify-phase3.ps1`:

```text
==========================================
   PUSHR PHASE 3 VERIFICATION TEST SUITE   
==========================================

[CHECK] 1. Push node-app: BuildpackBuilder -> queued -> building -> succeeded & image in registry...
Triggering build for sample-node-app...
[FAIL] 1. Push node-app: BuildpackBuilder -> queued -> building -> succeeded & image in registry: Unable to connect to the remote server

[CHECK] 2. Push python-app: DockerfileBuilder -> Kaniko -> succeeded & image in registry...
Triggering build for python-app...
[FAIL] 2. Push python-app: DockerfileBuilder -> Kaniko -> succeeded & image in registry: Unable to connect to the remote server

[CHECK] 3. Pull each image from inside cluster and run it; /health returns 200...
Testing node-app pod in cluster...
[FAIL] 3. Pull each image from inside cluster and run it; /health returns 200: kubectl run test-node-health failed: E0928 13:05:18.760861   19700 memcache.go:381] "Couldn't get current server API group list" err="Get \"http://localhost:8080/api?timeout=32s\": dial tcp [::1]:8080: connectex: No connection could be made because the target machine actively refused it." Unable to connect to the server: dial tcp [::1]:8080: connectex: No connection could be made because the target machine actively refused it.

[CHECK] 4. Broken Dockerfile: release marked failed, log contains real error, existing image untouched...
Triggering broken build...
[FAIL] 4. Broken Dockerfile: release marked failed, log contains real error, existing image untouched: Unable to connect to the remote server

[CHECK] 5. Push identical SHA again: existing image reused without rebuilding...
Submitting duplicate commit for python-app...
[FAIL] 5. Push identical SHA again: existing image reused without rebuilding: Unable to connect to the remote server

[CHECK] 6. Build logs retrievable via SSE endpoint...
[FAIL] 6. Build logs retrievable via SSE endpoint: No successful release ID available from Check 1 or Check 2 to verify SSE

==========================================
Phase 3 Verification Results: 0 / 6 checks passed
==========================================
```

### Root Cause Diagnostics & Prerequisites
1. **Docker Daemon**: `docker info` fails (`docker : The term 'docker' is not recognized`). k3d cannot provision or connect to the Kubernetes cluster without an active container runtime.
2. **Kubernetes Cluster**: `kubectl get nodes` and `kubectl get ns pushr-builds` fail (`connectex: No connection could be made because the target machine actively refused it.`).
3. **Port 5000 Collision**: Port 5000 is currently occupied by external PID 28380 (`node.exe server.js`), which returns `{"success":false,"message":"API endpoint not found: GET /v2/"}`. The port must be freed so the k3d container registry can bind to it.
4. **API Service**: Pushr API on port 3000 must be started alongside the cluster during verification.


