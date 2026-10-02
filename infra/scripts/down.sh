#!/usr/bin/env bash
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"

echo "==> Tearing down test workloads..."
kubectl delete -f "${ROOT_DIR}/infra/manifests/test-verify/test-app.yaml" --ignore-not-found=true 2>/dev/null || true

echo "==> Deleting k3d cluster 'pushr'..."
k3d cluster delete pushr 2>/dev/null || true

echo "==> Deleting registry 'pushr-registry'..."
k3d registry delete k3d-pushr-registry pushr-registry 2>/dev/null || true

echo "==> Teardown complete."
