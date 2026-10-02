#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"

echo "==> Checking prerequisites..."
command -v docker >/dev/null 2>&1 || { echo >&2 "Docker is required but not installed/running. Aborting."; exit 1; }
command -v k3d >/dev/null 2>&1 || { echo >&2 "k3d is required. Aborting."; exit 1; }
command -v kubectl >/dev/null 2>&1 || { echo >&2 "kubectl is required. Aborting."; exit 1; }

docker info >/dev/null 2>&1 || { echo >&2 "Docker daemon is not running. Aborting."; exit 1; }

echo "==> Checking if host port 5001 is free..."
if command -v lsof >/dev/null 2>&1 && lsof -i :5001 >/dev/null 2>&1; then
    echo >&2 "Host port 5001 is already in use. Please free port 5001 before proceeding."
    exit 1
elif command -v nc >/dev/null 2>&1 && nc -z 127.0.0.1 5001 2>/dev/null; then
    echo >&2 "Host port 5001 is already in use. Please free port 5001 before proceeding."
    exit 1
fi

echo "==> Checking k3d cluster 'pushr'..."
if ! k3d cluster list pushr >/dev/null 2>&1; then
    echo "==> Creating k3d cluster 'pushr'..."
    k3d cluster create --config "${ROOT_DIR}/infra/k3d-config.yaml"
else
    echo "==> Cluster 'pushr' already exists. Ensuring it is started..."
    k3d cluster start pushr || true
fi

echo "==> Setting kubectl context to k3d-pushr..."
kubectl config use-context k3d-pushr

echo "==> Waiting for cluster nodes to be ready..."
kubectl wait --for=condition=Ready node --all --timeout=120s

echo "==> Installing cert-manager v1.16.2..."
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.16.2/cert-manager.yaml

echo "==> Waiting for cert-manager deployments..."
kubectl rollout status deployment/cert-manager -n cert-manager --timeout=180s
kubectl rollout status deployment/cert-manager-webhook -n cert-manager --timeout=180s
kubectl rollout status deployment/cert-manager-cainjector -n cert-manager --timeout=180s

echo "==> Applying self-signed ClusterIssuer..."
sleep 3
kubectl apply -f "${ROOT_DIR}/infra/manifests/cert-manager/cluster-issuer.yaml"

echo "==> Infrastructure bootstrap complete!"
