# Architecture Decision Records (ADRs)

## ADR 1: Local Kubernetes Cluster with k3d

### Context
Pushr requires a fast, reproducible local Kubernetes cluster for push-to-deploy workflows. Options considered:
- `minikube`
- `kind`
- `k3d` (k3s in Docker)

### Decision
We use **k3d**.

### Rationale
1. **Speed & Resource Efficiency**: k3s is stripped of legacy cloud providers and has a sub-30-second boot time.
2. **Built-in Traefik Ingress**: k3s ships with Traefik ingress controller enabled out of the box, reducing bootstrap complexity.
3. **Integrated Container Registry**: k3d provides native multi-cluster registry support (`k3d registry create`), automatically creating bridge networks and resolving internal DNS names (`k3d-pushr-registry:5000`) for seamless pod image pulling without complicated self-signed registry certificates.

---

## ADR 2: TLS Management & cert-manager Configuration

### Context
Pushr deploys user applications to `https://<app>.pushr.localhost`. Local development requires automatic TLS termination with minimal friction.

### Decision
We use **cert-manager** with a local **self-signed `ClusterIssuer`** (`pushr-selfsigned-issuer`).

### Rationale
1. **Automated Lifecycle**: Ingress resources annotated with `cert-manager.io/cluster-issuer: pushr-selfsigned-issuer` automatically have certificates issued and secrets mounted.
2. **Production Parity**: Switching to Let's Encrypt in production requires only swapping the `ClusterIssuer` to ACME HTTP-01 or DNS-01, leaving application Ingress definitions completely identical.

### Switching to Let's Encrypt (Production)
To switch to Let's Encrypt, replace the `ClusterIssuer` with:
```yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: pushr-letsencrypt-issuer
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: admin@yourdomain.com
    privateKeySecretRef:
      name: letsencrypt-account-key
    solvers:
    - http01:
        ingress:
          class: traefik
```
And change the ingress annotation in deployments to `cert-manager.io/cluster-issuer: pushr-letsencrypt-issuer`.

---

## ADR 3: Containerized Git Server & POSIX Hook Compatibility

### Context
Running a Git Smart HTTP server directly on Windows hosts introduces cross-platform filesystem issues:
- Git hooks (`post-receive`) require POSIX execution semantics (`chmod +x`), which are not natively supported on Windows NTFS/FAT without MSYS/Cygwin wrappers.
- Windows CRLF line endings cause `\r\n` syntax errors when `/bin/sh` or `/bin/bash` attempts to execute hook shebangs.
- Path separators (`\` vs `/`) and process spawning differ between Windows and Linux.

### Decision
The Pushr Git server **always runs inside a Linux container** (and as a Kubernetes Pod in cluster mode), never directly on the Windows host.
- **Bare Repos Storage**: Backed by a dedicated Docker named volume (`pushr-repos`) during local container execution, and a PersistentVolumeClaim (`repos-pvc`) when deployed to Kubernetes.
- **Hook Scripts**:
  - Authored strictly with LF line endings (`eol=lf` enforced in `.gitattributes`).
  - Permissions are set to `chmod 755` inside the Linux container filesystem upon hook instantiation.
  - Shebangs use `#!/bin/sh` or `#!/usr/bin/env bash` supported in standard Alpine/Debian base images.
- **Control Plane Notification**: The `post-receive` hook inside the container dispatches an HTTP POST to the control plane API (`http://pushr-api:3000/api/internal/releases/build`) passing the repository slug, old SHA, new SHA, and ref.

