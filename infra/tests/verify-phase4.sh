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
echo -e "\033[35m   PUSHR PHASE 4 VERIFICATION TEST SUITE   \033[0m"
echo -e "\033[35m==========================================\033[0m"

# 1. Node App auto-deploy & TLS
check_node_app() {
    local res
    res=$(curl -s -X POST http://localhost:3000/api/internal/releases/build \
        -H "Content-Type: application/json" \
        -d '{"appSlug":"node-app","commitSha":"c1d2e3f4a5b600112233445566778899aabb0101","ref":"refs/heads/main"}')
    local id
    id=$(echo "$res" | grep -o '"releaseId":"[^"]*' | cut -d'"' -f4)
    [ -n "$id" ] || return 1
    export RELEASE_NODE_1="$id"

    for _ in {1..80}; do
        sleep 3
        local rel
        rel=$(curl -s "http://localhost:3000/api/releases/${id}")
        local b_status
        b_status=$(echo "$rel" | grep -o '"status":"[^"]*' | cut -d'"' -f4)
        local d_status
        d_status=$(echo "$rel" | grep -o '"deployStatus":"[^"]*' | cut -d'"' -f4)
        [ "$b_status" = "succeeded" ] && [ "$d_status" = "deployed" ] && break
        [ "$b_status" = "failed" ] && return 1
        [ "$d_status" = "failed" ] && return 1
    done

    # Wait for cert
    for _ in {1..30}; do
        kubectl -n apps-node-app get secret node-app-tls >/dev/null 2>&1 && break
        sleep 2
    done

    curl -k -s --resolve "node-app.pushr.localhost:443:127.0.0.1" https://node-app.pushr.localhost/health | grep -q '"status":"ok"'
}
assert_check "1. Push node-app: auto-deploy -> https://node-app.pushr.localhost returns 200 with TLS" check_node_app

# 2. Zero downtime rolling update
check_zero_downtime() {
    local res
    res=$(curl -s -X POST http://localhost:3000/api/internal/releases/build \
        -H "Content-Type: application/json" \
        -d '{"appSlug":"node-app","commitSha":"c1d2e3f4a5b600112233445566778899aabb0102","ref":"refs/heads/main"}')
    local id
    id=$(echo "$res" | grep -o '"releaseId":"[^"]*' | cut -d'"' -f4)
    [ -n "$id" ] || return 1
    export RELEASE_NODE_2="$id"

    local req_count=0
    local non200_count=0

    for _ in {1..40}; do
        for _ in {1..3}; do
            local code
            code=$(curl -k -s -o /dev/null -w "%{http_code}" --resolve "node-app.pushr.localhost:443:127.0.0.1" https://node-app.pushr.localhost/health)
            ((req_count++))
            [ "$code" != "200" ] && ((non200_count++))
        done
        local d_status
        d_status=$(curl -s "http://localhost:3000/api/releases/${id}" | grep -o '"deployStatus":"[^"]*' | cut -d'"' -f4)
        [ "$d_status" = "deployed" ] && break
        [ "$d_status" = "failed" ] && return 1
        sleep 1
    done

    [ "$req_count" -ge 20 ] || return 1
    [ "$non200_count" -eq 0 ] || return 1
}
assert_check "2. Push new commit: concurrent curl loop during rollout confirms zero downtime (100% 200s)" check_zero_downtime

# 3. Python App
check_python_app() {
    local res
    res=$(curl -s -X POST http://localhost:3000/api/internal/releases/build \
        -H "Content-Type: application/json" \
        -d '{"appSlug":"python-app","commitSha":"c1d2e3f4a5b600112233445566778899aabb0103","ref":"refs/heads/main"}')
    local id
    id=$(echo "$res" | grep -o '"releaseId":"[^"]*' | cut -d'"' -f4)
    [ -n "$id" ] || return 1

    for _ in {1..80}; do
        sleep 3
        local d_status
        d_status=$(curl -s "http://localhost:3000/api/releases/${id}" | grep -o '"deployStatus":"[^"]*' | cut -d'"' -f4)
        [ "$d_status" = "deployed" ] && break
        [ "$d_status" = "failed" ] && return 1
    done

    for _ in {1..30}; do
        kubectl -n apps-python-app get secret python-app-tls >/dev/null 2>&1 && break
        sleep 2
    done

    curl -k -s --resolve "node-app.pushr.localhost:443:127.0.0.1" https://node-app.pushr.localhost/health | grep -q '"app":"node-app"' || return 1
    curl -k -s --resolve "python-app.pushr.localhost:443:127.0.0.1" https://python-app.pushr.localhost/health | grep -q '"app":"python-app"' || return 1
}
assert_check "3. Deploy python-app: both apps reachable simultaneously at distinct subdomains" check_python_app

# 4. Broken readiness probe
check_broken_probe() {
    local res
    res=$(curl -s -X POST http://localhost:3000/api/internal/releases/build \
        -H "Content-Type: application/json" \
        -d '{"appSlug":"node-app","commitSha":"failhealth00112233445566778899aabbcc04","ref":"refs/heads/main"}')
    local id
    id=$(echo "$res" | grep -o '"releaseId":"[^"]*' | cut -d'"' -f4)
    [ -n "$id" ] || return 1

    for _ in {1..50}; do
        sleep 3
        local d_status
        d_status=$(curl -s "http://localhost:3000/api/releases/${id}" | grep -o '"deployStatus":"[^"]*' | cut -d'"' -f4)
        [ "$d_status" = "failed" ] && break
    done

    [ "$d_status" = "failed" ] || return 1
    # Check old pods still serving 200
    curl -k -s --resolve "node-app.pushr.localhost:443:127.0.0.1" https://node-app.pushr.localhost/health | grep -q '"status":"ok"'
}
assert_check "4. Broken readiness probe: detected as failed, previous working pods still serve traffic" check_broken_probe

# 5. Idempotent apply: re-deploy release twice -> identical state, no duplicates, pods/restarts unchanged
check_idempotent() {
    local id="${RELEASE_NODE_2:-$RELEASE_NODE_1}"
    curl -s -X POST "http://localhost:3000/api/releases/${id}/deploy" >/dev/null 2>&1 || return 1
    sleep 5

    local pods_before
    pods_before=$(kubectl get pods -n apps-node-app -l app=node-app -o jsonpath='{range .items[*]}{.metadata.name}:{.status.containerStatuses[*].restartCount}{" "}{end}')

    curl -s -X POST "http://localhost:3000/api/releases/${id}/deploy" >/dev/null 2>&1 || return 1
    sleep 5

    local pods_after
    pods_after=$(kubectl get pods -n apps-node-app -l app=node-app -o jsonpath='{range .items[*]}{.metadata.name}:{.status.containerStatuses[*].restartCount}{" "}{end}')

    [ "$pods_before" = "$pods_after" ] || return 1

    local dep_cnt
    dep_cnt=$(kubectl get deployment -n apps-node-app -l app=node-app --no-headers | wc -l)
    local svc_cnt
    svc_cnt=$(kubectl get svc -n apps-node-app -l app=node-app --no-headers | wc -l)
    local ing_cnt
    ing_cnt=$(kubectl get ingress -n apps-node-app -l app=node-app --no-headers | wc -l)

    [ "$dep_cnt" -eq 1 ] && [ "$svc_cnt" -eq 1 ] && [ "$ing_cnt" -eq 1 ] || return 1
    curl -k -s --resolve "node-app.pushr.localhost:443:127.0.0.1" https://node-app.pushr.localhost/health | grep -q '"status":"ok"'
}
assert_check "5. Idempotent apply: re-deploy release twice -> identical state, no duplicates, pods/restarts unchanged" check_idempotent

# 6. Per-app namespace isolation
check_namespace_isolation() {
    for app in node-app python-app; do
        local ns="apps-${app}"
        kubectl get namespace "$ns" >/dev/null 2>&1 || return 1
        kubectl get deployment "$app" -n "$ns" >/dev/null 2>&1 || return 1
        kubectl get svc "$app" -n "$ns" >/dev/null 2>&1 || return 1
        kubectl get ingress "$app" -n "$ns" >/dev/null 2>&1 || return 1
        # No leak to default
        kubectl get deployment "$app" -n default >/dev/null 2>&1 && return 1
        kubectl get svc "$app" -n default >/dev/null 2>&1 && return 1
    done
    return 0
}
assert_check "6. Per-app namespace isolation: apps-<slug> contains its own Deployment/Service/Ingress" check_namespace_isolation

echo -e "\n\033[35m==========================================\033[0m"
echo -e "\033[35mPhase 4 Verification Results: ${pass_count} / ${total_count} checks passed\033[0m"
echo -e "\033[35m==========================================\033[0m"

[ "$pass_count" -eq "$total_count" ] || exit 1
