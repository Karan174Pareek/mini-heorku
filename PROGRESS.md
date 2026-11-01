# Pushr Project Progress

Tracking implementation phases, verification outputs, and known issues.

---

## Phase Status Summary

| Phase | Description | Status | Verification Status | Notes |
|---|---|---|---|---|
| **Phase 1** | Infra bootstrap (k3d cluster, local registry, Traefik, cert-manager, `make up`/`down`) | ✅ Verified | 4/4 Checks Passed | k3d cluster `pushr`, cert-manager v1.16.2, ClusterIssuer, registry on host:5001 / cluster:5000 verified. |
| **Phase 2** | Git server (Smart HTTP, bare repos, token auth, post-receive hook) | ✅ Verified | 10/10 Checks Passed | Linux container Smart HTTP git-server in `pushr-system`, token auth, async post-receive hook, auto-build, rolling update verified. |
| **Phase 3** | Builder (Dockerfile detection vs Buildpacks, registry push, log capture) | ✅ Verified | 6/6 Checks Passed | Builder interface, Kaniko/Paketo strategies, queue, SSE logs, sample apps verified. |
| **Phase 4** | Deployer (Deployment/Service/Ingress, rolling update, probes, TLS) | ✅ Verified | 6/6 Checks Passed | Per-app namespace isolation, rolling update zero-downtime, probe failure handling, idempotent apply verified. |
| **Phase 5** | Releases, rollback, auto-rollback, env vars | ⬜ Not Started | - | Awaiting Phase 4 completion |
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

## Phase 2: Git Server Subsystem

### Done
- Created containerized Linux Git server (`apps/git-server/Dockerfile`) with `git-daemon` (`git-http-backend`) and Express wrapper in `pushr-system` namespace.
- Implemented persistent repository storage on PVC `/repos` (`pushr-git-repos`).
- Implemented HTTP Basic authentication with constant-time token verification (`crypto.timingSafeEqual`) and SHA-256 token hashing (`gitTokenHash`).
- Configured public ingress `git.pushr.localhost` routing strictly Git Smart HTTP endpoints (`/*/info/refs`, `/*-upload-pack`, `/*-receive-pack`) while blocking internal management endpoints (returning 404).
- Implemented executable POSIX LF `post-receive` hook template dispatching asynchronous `POST /api/internal/releases/build` calls with `X-Pushr-Internal-Secret` protection, returning `git push` in < 5 seconds.
- Integrated branch filtering: non-main branch pushes are accepted by Git server but ignored by post-receive hook (0 builds triggered).
- Updated source checkout and tarball endpoints to pull commits directly from the real bare Git repos (`pushr-git` pod) via `git archive`.
- Isolated test-only synthetic fallbacks behind explicit `TEST_MODE=true` flag.
- Re-verified backward compatibility: Phase 3 (6/6) and Phase 4 (6/6) verification suites pass with internal secret.

### Verification Output (`infra/tests/verify-phase2.ps1`)

```text
==========================================================
 [PHASE 2 VERIFICATION] REAL GIT SERVER & PIPELINE
 Configuration: TEST_MODE=unset (Real repos & containers only)
==========================================================

[Check 1/10] Verifying sample fallback is unreachable when TEST_MODE is unset...
  [PASS] Fallback correctly blocked: Release failed with 'TEST_MODE is disabled and no bare repo exists for app 'nonexistent-synthetic-app' (commit deadbeef12345678)'

[Check 2/10] Verifying internal endpoints return 401 without shared secret...
  [PASS] All internal endpoints return 401 Unauthorized without X-Pushr-Internal-Secret (401, 401, 401, 401)

[Check 3/10] Verifying public git Ingress blocks /internal/* paths...
  [PASS] Public Ingress correctly blocks /internal/* paths with HTTP 404

[Check 4/10] Creating app 'node-app-phase2' via POST /api/apps...
  [PASS] App created with push token: pushr_tok_73cf6f2c... and gitUrl: http://git.pushr.localhost/node-app-phase2.git

[Check 5/10] Inspecting post-receive hook inside pushr-git pod...
-rwxr-xr-x    1 root     root           885 Nov  1 12:40 /repos/node-app-phase2.git/hooks/post-receive /repos/node-app-phase2.git/hooks/post-receive: POSIX shell script, ASCII text executable
  [PASS] Hook in pod is executable (-rwxr-xr-x) and POSIX LF format (no CRLF)

[Check 6/10] Verifying push with wrong token is rejected (401)...
  [PASS] Push with wrong token rejected immediately (no release created)

[Check 7/10] Verifying push to non-main branch (feature-test) triggers no build...
  [PASS] Push to feature-test accepted by git server but skipped by post-receive hook (0 releases created)

[Check 8/10] Verifying git push main returns under 5s, builds real commit, and auto-deploys...
  Push completed in: 0.36s
remote: [Pushr] Received push: refs/heads/main (0000000000000000000000000000000000000000 -> 683aecb39b3c02f257c46bd49699ec5853586683)
remote: [Pushr] Enqueuing build for app 'node-app-phase2' (commit 683aecb39b3c02f257c46bd49699ec5853586683)...
remote: [Pushr] Build queued asynchronously for commit 683aecb39b3c02f257c46bd49699ec5853586683.
  [PASS] git push returned asynchronously in under 5 seconds (0.36s)
  [PASS] Build succeeded for exact commit SHA 683aecb
  [PASS] Release auto-deployed successfully
  [PASS] Live app serving at https://node-app-phase2.pushr.localhost/health (status: ok, app: node-app)

[Check 9/10] Verifying second commit via git push -> zero-downtime rolling update...
  Push v2 output: remote: [Pushr] Received push: refs/heads/main
  Rollout requests: 77 / 77 returned 200 (100%)
  Live app root body: Hello from Pushr Node App v2!
  [PASS] Rolling update for second commit succeeded with 100% 200 OK during update (serving: 'Hello from Pushr Node App v2!')

[Check 10/10] Re-verifying Phase 3 and Phase 4 tests with internal secret...
--- Running verify-phase3.ps1 (TEST_MODE=true) ---
Phase 3 Verification Results: 6 / 6 checks passed
--- Running verify-phase4.ps1 (TEST_MODE=true) ---
Phase 4 Verification Results: 6 / 6 checks passed
  [PASS] Both Phase 3 and Phase 4 test suites pass 100% with internal secret protection

==========================================================
 ALL 10 / 10 PHASE 2 VERIFICATION CHECKS PASSED!
==========================================================
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

---

## Phase 4: Deployer Subsystem

### Done
- Implemented `Deployer` service (`apps/api/src/services/deployer/Deployer.js`) managing:
  - Per-app namespace creation and isolation (`apps-<slug>`).
  - Idempotent `Deployment`, `Service`, and `Ingress` application.
  - Rolling update strategy (`maxSurge: 1`, `maxUnavailable: 0`) and graceful termination (`preStop: sleep 2`, `terminationGracePeriodSeconds: 30`).
  - Readiness and liveness probes targeting `/health`.
  - Automatic TLS certificate generation via cert-manager annotation `cert-manager.io/cluster-issuer: pushr-selfsigned-issuer`.
  - Rollout tracking, deadline detection, and failure state management.
- Integrated automatic deployment trigger on build completion in `BuildQueue.js`.
- Implemented manual deploy/re-deploy endpoint `POST /api/releases/:id/deploy`.
- Implemented `App` model and apps API (`GET /api/apps`, `GET /api/apps/:slug`, `POST /api/apps`, `PUT /api/apps/:slug/env`).
- Implemented automated Phase 4 verification test suites in `infra/tests/verify-phase4.ps1` and `infra/tests/verify-phase4.sh`.

### Verification Output (`infra/tests/verify-phase4.ps1`)

```text
==========================================
   PUSHR PHASE 4 VERIFICATION TEST SUITE   
==========================================

[CHECK] 1. Push node-app: auto-deploy -> https://node-app.pushr.localhost returns 200 with TLS...
Triggering build for node-app (Phase 4)...
Release created with ID: 6ae59147c78d981fa763c375
Release build: succeeded, deploy: deploying
Release build: succeeded, deploy: deploying
Release build: succeeded, deploy: deploying
Release build: succeeded, deploy: deployed
Waiting for cert-manager to generate node-app-tls secret...
Testing HTTPS request to https://node-app.pushr.localhost/health...
Response: {"status":"ok","app":"node-app"}
HTTP_STATUS:200
[PASS] 1. Push node-app: auto-deploy -> https://node-app.pushr.localhost returns 200 with TLS

[CHECK] 2. Push new commit: concurrent curl loop during rollout confirms zero downtime (100% 200s)...
Triggering second release for node-app...
Second release created with ID: 6ae59154c78d981fa763c382
Hammering ingress with concurrent requests during rolling update...
Total requests sent during rollout window: 35
Zero-downtime verified! 100% of 35 requests returned HTTP 200.
[PASS] 2. Push new commit: concurrent curl loop during rollout confirms zero downtime (100% 200s)

[CHECK] 3. Deploy python-app: both apps reachable simultaneously at distinct subdomains...
Triggering build for python-app (Phase 4)...
Release created with ID: 6ae5915bc78d981fa763c393
Waiting for cert-manager to generate python-app-tls secret...
node-app response: {"status":"ok","app":"node-app"}
python-app response: {"app":"python-app","status":"ok"}
[PASS] 3. Deploy python-app: both apps reachable simultaneously at distinct subdomains

[CHECK] 4. Broken readiness probe: detected as failed, previous working pods still serve traffic...
Pushing commit with failing health probe for node-app...
Failing release created with ID: 6ae59165c78d981fa763c39f
Failing release build: succeeded, deploy: deploying
Failing release build: succeeded, deploy: deploying
Failing release build: succeeded, deploy: deploying
Failing release build: succeeded, deploy: deploying
Failing release build: succeeded, deploy: deploying
Failing release build: succeeded, deploy: deploying
Failing release build: succeeded, deploy: deploying
Failing release build: succeeded, deploy: deploying
Failing release build: succeeded, deploy: deploying
Failing release build: succeeded, deploy: deploying
Failing release build: succeeded, deploy: deploying
Failing release build: succeeded, deploy: deploying
Failing release build: succeeded, deploy: deploying
Failing release build: succeeded, deploy: deploying
Failing release build: succeeded, deploy: deploying
Failing release build: succeeded, deploy: failed
Verified rollout detected as failed: Rollout timed out after 45s. New pods failed readiness probe.
Verifying previous working pods are still serving traffic...
Host response: {"status":"ok","app":"node-app"}
HTTP_STATUS:200
Verified old ReplicaSet remained intact and serving traffic!
[PASS] 4. Broken readiness probe: detected as failed, previous working pods still serve traffic

[CHECK] 5. Idempotent apply: re-deploy release twice -> identical state, no duplicates, pods/restarts unchanged...
Re-deploying release 6ae59154c78d981fa763c382 via POST /api/releases/6ae59154c78d981fa763c382/deploy...
First deploy result: {"message":"Deployment complete","status":"deployed","appSlug":"node-app","releaseId":"6ae59154c78d981fa763c382","url":"https://node-app.pushr.localhost","deployedAt":"2026-10-31T06:58:32.066Z"}
Pods before second deploy: node-app-7f78649f85-c98qv, node-app-7f78649f85-dc865
Second deploy result: {"message":"Deployment complete","status":"deployed","appSlug":"node-app","releaseId":"6ae59154c78d981fa763c382","url":"https://node-app.pushr.localhost","deployedAt":"2026-10-31T06:58:39.891Z"}
Pods after second deploy: node-app-7f78649f85-c98qv, node-app-7f78649f85-dc865
Pod names and restart counts strictly unchanged!
Object counts: Deployments=1, Services=1, Ingresses=1
Idempotency confirmed: objects cleanly updated, pod identities and restart counts preserved, app fully healthy.
[PASS] 5. Idempotent apply: re-deploy release twice -> identical state, no duplicates, pods/restarts unchanged

[CHECK] 6. Per-app namespace isolation: apps-<slug> contains its own Deployment/Service/Ingress...
Checking resources in namespace apps-node-app...
Namespace apps-node-app verified with dedicated Deployment, Service, and Ingress.
Checking resources in namespace apps-python-app...
Namespace apps-python-app verified with dedicated Deployment, Service, and Ingress.
[PASS] 6. Per-app namespace isolation: apps-<slug> contains its own Deployment/Service/Ingress

==========================================
Phase 4 Verification Results: 6 / 6 checks passed
==========================================
```
