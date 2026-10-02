#!/usr/bin/env bash
set -u

pass_count=0
total_count=6

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
echo -e "\033[35m   PUSHR PHASE 3 VERIFICATION TEST SUITE   \033[0m"
echo -e "\033[35m==========================================\033[0m"

# 1. Node App
check_node_app() {
    local res
    res=$(curl -s -X POST http://localhost:3000/api/internal/releases/build \
        -H "Content-Type: application/json" \
        -d '{"appSlug":"node-app","commitSha":"a1b2c3d4e5f600112233445566778899aabbcc01","ref":"refs/heads/main"}')
    local id
    id=$(echo "$res" | grep -o '"releaseId":"[^"]*' | cut -d'"' -f4)
    [ -n "$id" ] || return 1

    for _ in {1..30}; do
        sleep 3
        local status
        status=$(curl -s "http://localhost:3000/api/releases/${id}" | grep -o '"status":"[^"]*' | cut -d'"' -f4)
        [ "$status" = "succeeded" ] && break
        [ "$status" = "failed" ] && return 1
    done

    curl -s http://localhost:5001/v2/node-app/tags/list | grep -q "a1b2c3d"
}
assert_check "1. Push node-app: BuildpackBuilder -> succeeded & in registry" check_node_app

# 2. Python App
check_python_app() {
    local res
    res=$(curl -s -X POST http://localhost:3000/api/internal/releases/build \
        -H "Content-Type: application/json" \
        -d '{"appSlug":"python-app","commitSha":"b2c3d4e5f6a1002233445566778899aabbcc02","ref":"refs/heads/main"}')
    local id
    id=$(echo "$res" | grep -o '"releaseId":"[^"]*' | cut -d'"' -f4)
    [ -n "$id" ] || return 1

    for _ in {1..30}; do
        sleep 3
        local status
        status=$(curl -s "http://localhost:3000/api/releases/${id}" | grep -o '"status":"[^"]*' | cut -d'"' -f4)
        [ "$status" = "succeeded" ] && break
        [ "$status" = "failed" ] && return 1
    done

    curl -s http://localhost:5001/v2/python-app/tags/list | grep -q "b2c3d4e"
}
assert_check "2. Push python-app: DockerfileBuilder -> succeeded & in registry" check_python_app

# 3. Pull & Health
check_health() {
    kubectl delete pod test-node-health --ignore-not-found=true >/dev/null 2>&1
    kubectl run test-node-health --image=k3d-pushr-registry:5000/node-app:a1b2c3d --restart=Never --env="PORT=3000"
    kubectl wait --for=condition=Ready pod/test-node-health --timeout=45s
    kubectl exec test-node-health -- /layers/paketo-buildpacks_node-engine/node/bin/node --input-type=module -e "const r = await fetch('http://127.0.0.1:3000/health'); console.log(await r.text());" | grep -q '"status":"ok"'
    kubectl delete pod test-node-health >/dev/null 2>&1

    kubectl delete pod test-python-health --ignore-not-found=true >/dev/null 2>&1
    kubectl run test-python-health --image=k3d-pushr-registry:5000/python-app:b2c3d4e --restart=Never --env="PORT=5000"
    kubectl wait --for=condition=Ready pod/test-python-health --timeout=45s
    kubectl exec test-python-health -- python -c "import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:5000/health').read().decode())" | grep -q '"status":"ok"'
    kubectl delete pod test-python-health >/dev/null 2>&1
}
assert_check "3. Pull and /health returns 200" check_health

# 4. Broken Dockerfile
check_broken() {
    local res
    res=$(curl -s -X POST http://localhost:3000/api/internal/releases/build \
        -H "Content-Type: application/json" \
        -d '{"appSlug":"broken-app","commitSha":"deadbeef12340033445566778899aabbcc03","ref":"refs/heads/main"}')
    local id
    id=$(echo "$res" | grep -o '"releaseId":"[^"]*' | cut -d'"' -f4)

    for _ in {1..30}; do
        sleep 3
        local status
        status=$(curl -s "http://localhost:3000/api/releases/${id}" | grep -o '"status":"[^"]*' | cut -d'"' -f4)
        [ "$status" = "failed" ] && return 0
    done
    return 1
}
assert_check "4. Broken Dockerfile ends as failed" check_broken

# 5. Idempotency
check_idempotency() {
    local res
    res=$(curl -s -X POST http://localhost:3000/api/internal/releases/build \
        -H "Content-Type: application/json" \
        -d '{"appSlug":"python-app","commitSha":"b2c3d4e5f6a1002233445566778899aabbcc02","ref":"refs/heads/main"}')
    local id
    id=$(echo "$res" | grep -o '"releaseId":"[^"]*' | cut -d'"' -f4)

    local status
    status=$(curl -s "http://localhost:3000/api/releases/${id}" | grep -o '"status":"[^"]*' | cut -d'"' -f4)
    [ "$status" = "succeeded" ]
}
assert_check "5. Idempotent push reuses image" check_idempotency

# 6. SSE Logs
check_sse() {
    curl -s -N -H "Accept: text/event-stream" "http://localhost:3000/api/releases/${id}/build-logs" | grep -q "event:"
}
assert_check "6. SSE build logs" check_sse

echo -e "\n\033[35m==========================================\033[0m"
echo -e "\033[35mVerification Results: ${pass_count} / ${total_count} checks passed\033[0m"
echo -e "\033[35m==========================================\033[0m"

[ "${pass_count}" -eq "${total_count}" ]
