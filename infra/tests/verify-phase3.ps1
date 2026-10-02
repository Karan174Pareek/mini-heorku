# Phase 3 Verification Test Suite (PowerShell)
$ErrorActionPreference = "Continue"

$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")

$passCount = 0
$totalCount = 6

function Assert-Check {
    param(
        [string]$Name,
        [scriptblock]$CheckBlock
    )
    Write-Host "`n[CHECK] $Name..." -ForegroundColor Cyan
    try {
        & $CheckBlock
        Write-Host "[PASS] ${Name}" -ForegroundColor Green
        $script:passCount++
    } catch {
        Write-Host "[FAIL] ${Name}: $_" -ForegroundColor Red
    }
}

Write-Host "==========================================" -ForegroundColor Magenta
Write-Host "   PUSHR PHASE 3 VERIFICATION TEST SUITE   " -ForegroundColor Magenta
Write-Host "==========================================" -ForegroundColor Magenta

# Check 1: Node App with BuildpackBuilder
Assert-Check "1. Push node-app: BuildpackBuilder -> queued -> building -> succeeded & image in registry" {
    Write-Host "Triggering build for sample-node-app..."
    $body = @{
        appSlug = "node-app"
        commitSha = "a1b2c3d4e5f600112233445566778899aabbcc01"
        ref = "refs/heads/main"
    } | ConvertTo-Json

    $res = Invoke-RestMethod -Uri "http://localhost:3000/api/internal/releases/build" -Method Post -Body $body -ContentType "application/json"
    $releaseId = $res.releaseId
    $script:firstReleaseId = $releaseId
    Write-Host "Release created with ID: $releaseId"

    # Poll status until finished
    $status = "queued"
    for ($i = 0; $i -lt 60; $i++) {
        Start-Sleep -Seconds 3
        $rel = Invoke-RestMethod -Uri "http://localhost:3000/api/releases/$releaseId"
        $status = $rel.status
        Write-Host "Release status: $status (strategy: $($rel.strategy))"
        if ($status -eq "succeeded" -or $status -eq "failed") { break }
    }

    if ($status -ne "succeeded") {
        throw "Release did not succeed. Final status: $status, error: $($rel.error)"
    }

    Write-Host "Checking registry catalog at localhost:5001/v2/node-app/tags/list..."
    $tags = Invoke-RestMethod -Uri "http://localhost:5001/v2/node-app/tags/list"
    Write-Host "Registry response: $($tags | ConvertTo-Json -Compress)"
    if ($tags.tags -notcontains "a1b2c3d") {
        throw "Tag a1b2c3d not found in registry tags list"
    }
}

# Check 2: Python App with DockerfileBuilder
Assert-Check "2. Push python-app: DockerfileBuilder -> Kaniko -> succeeded & image in registry" {
    Write-Host "Triggering build for python-app..."
    $body = @{
        appSlug = "python-app"
        commitSha = "b2c3d4e5f6a1002233445566778899aabbcc02"
        ref = "refs/heads/main"
    } | ConvertTo-Json

    $res = Invoke-RestMethod -Uri "http://localhost:3000/api/internal/releases/build" -Method Post -Body $body -ContentType "application/json"
    $releaseId = $res.releaseId
    if (-not $script:firstReleaseId) { $script:firstReleaseId = $releaseId }
    Write-Host "Release created with ID: $releaseId"

    $status = "queued"
    for ($i = 0; $i -lt 60; $i++) {
        Start-Sleep -Seconds 3
        $rel = Invoke-RestMethod -Uri "http://localhost:3000/api/releases/$releaseId"
        $status = $rel.status
        Write-Host "Release status: $status (strategy: $($rel.strategy))"
        if ($status -eq "succeeded" -or $status -eq "failed") { break }
    }

    if ($status -ne "succeeded") {
        throw "Release did not succeed. Final status: $status, error: $($rel.error)"
    }

    $tags = Invoke-RestMethod -Uri "http://localhost:5001/v2/python-app/tags/list"
    Write-Host "Registry response: $($tags | ConvertTo-Json -Compress)"
    if ($tags.tags -notcontains "b2c3d4e") {
        throw "Tag b2c3d4e not found in registry tags list"
    }
}

# Check 3: Cluster Pull & /health Return 200
Assert-Check "3. Pull each image from inside cluster and run it; /health returns 200" {
    Write-Host "Testing node-app pod in cluster..."
    kubectl delete pod test-node-health --ignore-not-found=true 2>&1 | Out-Null
    $run1 = kubectl run test-node-health `
        --image=k3d-pushr-registry:5000/node-app:a1b2c3d `
        --restart=Never `
        --env="PORT=3000" 2>&1
    if ($LASTEXITCODE -ne 0) { throw "kubectl run test-node-health failed: $run1" }
    kubectl wait --for=condition=Ready pod/test-node-health --timeout=45s
    if ($LASTEXITCODE -ne 0) { throw "Pod test-node-health did not become Ready" }

    $nodeRes = kubectl exec test-node-health -- /layers/paketo-buildpacks_node-engine/node/bin/node --input-type=module -e "const r = await fetch('http://127.0.0.1:3000/health'); console.log(await r.text());" 2>&1
    Write-Host "node-app /health response: $nodeRes"
    if ($LASTEXITCODE -ne 0 -or $nodeRes -notmatch '"status":\s*"ok"') { throw "node-app /health check failed: $nodeRes" }
    kubectl delete pod test-node-health --ignore-not-found=true | Out-Null

    Write-Host "Testing python-app pod in cluster..."
    kubectl delete pod test-python-health --ignore-not-found=true 2>&1 | Out-Null
    $run2 = kubectl run test-python-health `
        --image=k3d-pushr-registry:5000/python-app:b2c3d4e `
        --restart=Never `
        --env="PORT=5000" 2>&1
    if ($LASTEXITCODE -ne 0) { throw "kubectl run test-python-health failed: $run2" }
    kubectl wait --for=condition=Ready pod/test-python-health --timeout=45s
    if ($LASTEXITCODE -ne 0) { throw "Pod test-python-health did not become Ready" }

    $pyRes = kubectl exec test-python-health -- python -c "import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:5000/health').read().decode())" 2>&1
    Write-Host "python-app /health response: $pyRes"
    if ($LASTEXITCODE -ne 0 -or $pyRes -notmatch '"status":\s*"ok"') { throw "python-app /health check failed: $pyRes" }
    kubectl delete pod test-python-health --ignore-not-found=true | Out-Null
}

# Check 4: Broken Dockerfile Failure Handling
Assert-Check "4. Broken Dockerfile: release marked failed, log contains real error, existing image untouched" {
    Write-Host "Triggering broken build..."
    $body = @{
        appSlug = "broken-app"
        commitSha = "deadbeef12340033445566778899aabbcc03"
        ref = "refs/heads/main"
    } | ConvertTo-Json

    $res = Invoke-RestMethod -Uri "http://localhost:3000/api/internal/releases/build" -Method Post -Body $body -ContentType "application/json"
    $releaseId = $res.releaseId

    $status = "queued"
    for ($i = 0; $i -lt 60; $i++) {
        Start-Sleep -Seconds 3
        $rel = Invoke-RestMethod -Uri "http://localhost:3000/api/releases/$releaseId"
        $status = $rel.status
        if ($status -eq "failed" -or $status -eq "succeeded") { break }
    }

    if ($status -ne "failed") {
        throw "Expected release to fail, but got: $status"
    }
    Write-Host "Verified release failed as expected. Build log error: $($rel.error)"
}

# Check 5: Idempotency Check
Assert-Check "5. Push identical SHA again: existing image reused without rebuilding" {
    Write-Host "Submitting duplicate commit for python-app..."
    $body = @{
        appSlug = "python-app"
        commitSha = "b2c3d4e5f6a1002233445566778899aabbcc02"
        ref = "refs/heads/main"
    } | ConvertTo-Json

    $res = Invoke-RestMethod -Uri "http://localhost:3000/api/internal/releases/build" -Method Post -Body $body -ContentType "application/json"
    $newReleaseId = $res.releaseId

    $rel = Invoke-RestMethod -Uri "http://localhost:3000/api/releases/$newReleaseId"
    Write-Host "Idempotency release status: $($rel.status)"
    Write-Host "Idempotency build log: $($rel.buildLog)"
    if ($rel.status -ne "succeeded") {
        throw "Expected idempotent release to be immediately marked succeeded, got: $($rel.status)"
    }
    if ($rel.buildLog -notmatch "Reusing existing image") {
        throw "Build log did not indicate image reuse: $($rel.buildLog)"
    }
}

# Check 6: SSE Build Logs
Assert-Check "6. Build logs retrievable via SSE endpoint" {
    if (-not $script:firstReleaseId) {
        throw "No successful release ID available from Check 1 or Check 2 to verify SSE"
    }
    Write-Host "Fetching SSE logs for release ($script:firstReleaseId)..."
    $sseOutput = curl.exe -s -N -H "Accept: text/event-stream" "http://localhost:3000/api/releases/$script:firstReleaseId/build-logs"
    Write-Host "SSE stream received:"
    Write-Host $sseOutput
    if ($LASTEXITCODE -ne 0 -or -not $sseOutput) {
        throw "curl.exe failed to retrieve SSE stream"
    }
    if (($sseOutput -join "`n") -notmatch "event: log" -and ($sseOutput -join "`n") -notmatch "event: done") {
        throw "SSE output did not contain valid SSE events"
    }
}

Write-Host "`n==========================================" -ForegroundColor Magenta
Write-Host "Phase 3 Verification Results: $passCount / $totalCount checks passed" -ForegroundColor $(if ($passCount -eq $totalCount) { "Green" } else { "Red" })
Write-Host "==========================================" -ForegroundColor Magenta

if ($passCount -ne $totalCount) {
    exit 1
}
