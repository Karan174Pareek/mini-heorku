#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"

pass_count=0
total_count=4

assert_check() {
    local name="$1"
    shift
    echo -e "\n\033[36m[CHECK] ${name}...\033[0m"
    if "$@"; then
        echo -e "\033[32m[PASS] ${name}\033[0m"
        ((pass_count++))
    else
        echo -e "\033[31m[FAIL] ${name}\033[0m"
    fi
}

echo -e "\033[35m==========================================\033[0m"
echo -e "\033[35m   PUSHR PHASE 1 VERIFICATION TEST SUITE   \033[0m"
echo -e "\033[35m==========================================\033[0m"

# Check 1: Nodes Ready
check_nodes() {
    local nodes
    nodes=$(kubectl get nodes --no-headers)
    echo "${nodes}"
    echo "${nodes}" | grep -q "Ready"
}
assert_check "Cluster nodes are Ready" check_nodes

# Check 2: Cert-Manager & Issuer
check_issuer() {
    local status
    status=$(kubectl get clusterissuer pushr-selfsigned-issuer -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}')
    echo "ClusterIssuer status: ${status}"
    [ "${status}" = "True" ]
}
assert_check "cert-manager and pushr-selfsigned-issuer are Ready" check_issuer

# Check 3: Registry Push & Pull
check_registry() {
    echo "Pushing test image to localhost:5001..."
    docker pull alpine:latest >/dev/null
    docker tag alpine:latest localhost:5001/pushr-test-alpine:v1
    docker push localhost:5001/pushr-test-alpine:v1

    echo "Running test pod inside cluster..."
    kubectl delete pod test-registry-pull --ignore-not-found=true >/dev/null 2>&1
    kubectl run test-registry-pull \
        --image=k3d-pushr-registry:5000/pushr-test-alpine:v1 \
        --restart=Never \
        --command -- /bin/sh -c "echo REGISTRY_PULL_SUCCESS && sleep 10"

    kubectl wait --for=condition=Ready pod/test-registry-pull --timeout=45s >/dev/null 2>&1
    local logs
    logs=$(kubectl logs pod/test-registry-pull)
    echo "Pod logs: ${logs}"
    kubectl delete pod test-registry-pull --ignore-not-found=true >/dev/null 2>&1
    echo "${logs}" | grep -q "REGISTRY_PULL_SUCCESS"
}
assert_check "Registry push to localhost:5001 and pull from inside cluster" check_registry

# Check 4: Ingress HTTPS Reachable
check_ingress() {
    kubectl apply -f "${ROOT_DIR}/infra/manifests/test-verify/test-app.yaml"
    kubectl rollout status deployment/test-nginx -n pushr-test --timeout=60s

    echo "Waiting for TLS certificate secret..."
    local ready=false
    for _ in {1..30}; do
        if kubectl -n pushr-test get secret test-pushr-tls >/dev/null 2>&1; then
            ready=true
            break
        fi
        sleep 2
    done
    [ "${ready}" = "true" ] || { echo "TLS secret not created"; return 1; }

    echo "Querying https://test.pushr.localhost/..."
    local response
    response=$(curl -k -s -w "\nHTTP_STATUS:%{http_code}" --resolve "test.pushr.localhost:443:127.0.0.1" https://test.pushr.localhost/)
    echo "${response}"
    echo "${response}" | grep -q "HTTP_STATUS:200"
}
assert_check "Test workload reachable via HTTPS at https://test.pushr.localhost" check_ingress

echo -e "\n\033[35m==========================================\033[0m"
echo -e "\033[35mVerification Results: ${pass_count} / ${total_count} checks passed\033[0m"
echo -e "\033[35m==========================================\033[0m"

[ "${pass_count}" -eq "${total_count}" ]
