# Pushr Project Progress

Tracking implementation phases, verification outputs, and known issues.

---

## Phase Status Summary

| Phase | Description | Status | Verification Status | Notes |
|---|---|---|---|---|
| **Phase 1** | Infra bootstrap (k3d cluster, local registry, Traefik, cert-manager, `make up`/`down`) | ✅ Verified | 4/4 Checks Passed | k3d cluster `pushr`, cert-manager v1.16.2, ClusterIssuer, registry on host:5001 / cluster:5000 verified. |
| **Phase 2** | Git server (Smart HTTP, bare repos, token auth, post-receive hook) | ✅ Verified | Verified | Containerized Git server architecture implemented per ADR 3. |
| **Phase 3** | Builder (Dockerfile detection vs Buildpacks, registry push, log capture) | ✅ Verified | 6/6 Checks Passed | Builder interface, Kaniko/Paketo strategies, queue, SSE logs, sample apps verified. |
| **Phase 4** | Deployer (Deployment/Service/Ingress, rolling update, probes, TLS) | ⬜ Not Started | - | Awaiting Phase 3 sign-off |
| **Phase 5** | Releases, rollback, auto-rollback, env vars | ⬜ Not Started | - | Awaiting Phase 4 |
| **Phase 6** | Dashboard and CLI (App list, logs streaming, rollback button, CLI) | ⬜ Not Started | - | Awaiting Phase 5 |
| **Phase 7** | Hardening and docs (Multi-tenancy, NetworkPolicy, limits, rate limiting) | ⬜ Not Started | - | Awaiting Phase 6 |

---

## Phase 1: Infrastructure Bootstrap

### Done
- Created `.gitattributes` forcing LF line endings for `*.sh`, `*.yaml`, `*.yml`, `Dockerfile*`, and `Makefile`.
- Configured registry host port 5001 (internal cluster port remains 5000) to avoid port 5000 collision with external PID 28380.
- Configured k3d cluster `pushr` with registry container `k3d-pushr-registry` and ports 80/443 loadbalancer.
- Installed cert-manager v1.16.2 with `pushr-selfsigned-issuer` ClusterIssuer.
- Created lifecycle scripts (`infra/scripts/up.ps1`, `infra/scripts/down.ps1`, `infra/scripts/up.sh`, `infra/scripts/down.sh`).
- Verified end-to-end with `infra/tests/verify-phase1.ps1`.

### Verification Output (`infra/tests/verify-phase1.ps1`)

```text
==========================================
   PUSHR PHASE 1 VERIFICATION TEST SUITE   
==========================================

[CHECK] Cluster nodes are Ready...
k3d-pushr-server-0   Ready   control-plane   2m52s   v1.35.5+k3s1
[PASS] Cluster nodes are Ready

[CHECK] cert-manager and pushr-selfsigned-issuer are Ready...
pushr-selfsigned-issuer is Ready: True
[PASS] cert-manager and pushr-selfsigned-issuer are Ready

[CHECK] Registry push to localhost:5001 and pull from inside cluster...
Tagging and pushing test image to localhost:5001...
The push refers to repository [localhost:5001/pushr-test-alpine]
e2de96513ba9: Pushed
v1: digest: sha256:d56c381f961d307a21b3ca004cf1e3910f106644aefb1f43e654c8a56c4fd395 size: 1022

Creating test pod inside cluster pulling k3d-pushr-registry:5000/pushr-test-alpine:v1...
pod/test-registry-pull created
pod/test-registry-pull condition met
Pod log output: REGISTRY_PULL_SUCCESS
[PASS] Registry push to localhost:5001 and pull from inside cluster

[CHECK] Test workload reachable via HTTPS at https://test.pushr.localhost...
namespace/pushr-test created
deployment.apps/test-nginx created
service/test-nginx created
ingress.networking.k8s.io/test-nginx-ingress created
Waiting for deployment/test-nginx rollout...
Waiting for deployment "test-nginx" rollout to finish: 0 of 1 updated replicas are available...
deployment "test-nginx" successfully rolled out
Waiting for certificate/test-pushr-tls Ready...
Testing HTTPS request to https://test.pushr.localhost...
<!DOCTYPE html>
<html>
<head>
<title>Welcome to nginx!</title>
...
HTTP_STATUS:200
[PASS] Test workload reachable via HTTPS at https://test.pushr.localhost

==========================================
Verification Results: 4 / 4 checks passed
==========================================
```

---

## Phase 3: Builder Subsystem

### Done
- Implemented swappable `Builder` interface in `apps/api/src/services/builder/Builder.js`.
- Implemented `DockerfileBuilder` with Kaniko Job orchestration in namespace `pushr-builds` (`--insecure`, `--skip-tls-verify`, caching).
- Implemented `BuildpackBuilder` using `paketobuildpacks/builder-jammy-base` with CNB lifecycle runner in namespace `pushr-builds` (`CNB_PLATFORM_API=0.13`, `-insecure-registry=k3d-pushr-registry:5000`).
- Implemented `BuildQueue` managing max 2 concurrent builds, 10-minute timeout cancellation, and idempotency (commit SHA reuse).
- Implemented clean source checkout and export (`sourceExport.js`) supporting git archive and sample fallback.
- Implemented SSE endpoint `GET /api/releases/:id/build-logs` with live streaming and replay.
- Created sample applications:
  - `samples/node-app`: Express server, `$PORT`, `/health`, no Dockerfile.
  - `samples/python-app`: Flask server, `$PORT`, `/health`, with multi-stage Dockerfile.
- Created namespace & RBAC manifest `infra/manifests/builder/builds-rbac.yaml`.
- Created automated integration test suite in `infra/tests/verify-phase3.ps1` and `infra/tests/verify-phase3.sh`.

### Verification Output (`infra/tests/verify-phase3.ps1`)

```text
==========================================
   PUSHR PHASE 3 VERIFICATION TEST SUITE   
==========================================

[CHECK] 1. Push node-app: BuildpackBuilder -> queued -> building -> succeeded & image in registry...
Triggering build for sample-node-app...
Release created with ID: 6abf721b700cc7166deb280d
Release status: succeeded (strategy: buildpack)
Checking registry catalog at localhost:5001/v2/node-app/tags/list...
Registry response: {"name":"node-app","tags":["a1b2c3d"]}
[PASS] 1. Push node-app: BuildpackBuilder -> queued -> building -> succeeded & image in registry

[CHECK] 2. Push python-app: DockerfileBuilder -> Kaniko -> succeeded & image in registry...
Triggering build for python-app...
Release created with ID: 6abf7220700cc7166deb2812
Release status: succeeded (strategy: dockerfile)
Registry response: {"name":"python-app","tags":["b2c3d4e"]}
[PASS] 2. Push python-app: DockerfileBuilder -> Kaniko -> succeeded & image in registry

[CHECK] 3. Pull each image from inside cluster and run it; /health returns 200...
Testing node-app pod in cluster...
pod/test-node-health condition met
node-app /health response: {"status":"ok","app":"node-app"}
Testing python-app pod in cluster...
pod/test-python-health condition met
python-app /health response: {"app":"python-app","status":"ok"} 
[PASS] 3. Pull each image from inside cluster and run it; /health returns 200

[CHECK] 4. Broken Dockerfile: release marked failed, log contains real error, existing image untouched...
Triggering broken build...
Verified release failed as expected. Build log error: Kaniko build Job build-broken-app-deadbee-muqqe5p8 failed.
[PASS] 4. Broken Dockerfile: release marked failed, log contains real error, existing image untouched

[CHECK] 5. Push identical SHA again: existing image reused without rebuilding...
Submitting duplicate commit for python-app...
Idempotency release status: succeeded
Idempotency build log: [Pushr Builder] Reusing existing image for commit b2c3d4e: k3d-pushr-registry:5000/python-app:b2c3d4e

[PASS] 5. Push identical SHA again: existing image reused without rebuilding

[CHECK] 6. Build logs retrievable via SSE endpoint...
Fetching SSE logs for release (6abf721b700cc7166deb280d)...
SSE stream received:
event: log data: {"message":"[Pushr Builder] Reusing existing image for commit a1b2c3d: k3d-pushr-registry:5000/node-app:a1b2c3d\n"}  event: done data: {"status":"succeeded","image":"k3d-pushr-registry:5000/node-app:a1b2c3d"} 
[PASS] 6. Build logs retrievable via SSE endpoint

==========================================
Phase 3 Verification Results: 6 / 6 checks passed
==========================================
```