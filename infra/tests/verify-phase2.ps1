# infra/tests/verify-phase2.ps1
# Phase 2 Verification: Real Linux Container Git Server (Smart HTTP, Token Auth, Async Hook, Auto-Deploy)

$ErrorActionPreference = "Stop"

# Ensure TEST_MODE is explicitly unset for Phase 2 verification
Remove-Item Env:TEST_MODE -ErrorAction SilentlyContinue

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host " [PHASE 2 VERIFICATION] REAL GIT SERVER & PIPELINE" -ForegroundColor Cyan
Write-Host " Configuration: TEST_MODE=unset (Real repos & containers only)" -ForegroundColor Yellow
Write-Host "==========================================================" -ForegroundColor Cyan

$API_BASE = "http://127.0.0.1:3000"
$INTERNAL_SECRET = "pushr_internal_shared_secret_2026"
$GIT_HOST = "git.pushr.localhost"
$PASSED_COUNT = 0
$TOTAL_COUNT = 10

function Assert-Step($condition, $successMsg, $failMsg) {
    if ($condition) {
        Write-Host "  [PASS] $successMsg" -ForegroundColor Green
        $global:PASSED_COUNT++
    } else {
        Write-Host "  [FAIL] $failMsg" -ForegroundColor Red
        throw $failMsg
    }
}

function Invoke-PushrPostJson($url, $jsonString, $extraHeaders = @{}) {
    $tmp = [System.IO.Path]::GetTempFileName()
    try {
        [System.IO.File]::WriteAllText($tmp, $jsonString, [System.Text.Encoding]::UTF8)
        $headerArgs = @()
        foreach ($k in $extraHeaders.Keys) {
            $headerArgs += "-H"
            $headerArgs += "$k`: $($extraHeaders[$k])"
        }
        $raw = curl.exe -s -X POST $url -H "Content-Type: application/json" @headerArgs -d "@$tmp"
        return $raw
    } finally {
        if (Test-Path $tmp) { Remove-Item -Force $tmp }
    }
}

# ---------------------------------------------------------
# Check 1: Fallback Unreachable When TEST_MODE is Unset
# ---------------------------------------------------------
Write-Host "`n[Check 1/10] Verifying sample fallback is unreachable when TEST_MODE is unset..." -ForegroundColor Cyan
$buildPayload = '{"appSlug":"nonexistent-synthetic-app","commitSha":"deadbeef12345678","ref":"refs/heads/main"}'
$rawQueued = Invoke-PushrPostJson "$API_BASE/api/internal/releases/build" $buildPayload @{ "X-Pushr-Internal-Secret" = $INTERNAL_SECRET }
$queuedRes = $rawQueued | ConvertFrom-Json

$relId = $queuedRes.releaseId
Start-Sleep -Seconds 2
$relRes = curl.exe -s "$API_BASE/api/releases/$relId" | ConvertFrom-Json

$sampleFallbackBlocked = ($relRes.status -eq "failed") -and ($relRes.error -like "*TEST_MODE is disabled*")
Assert-Step $sampleFallbackBlocked "Fallback correctly blocked: Release failed with '$($relRes.error)'" "Fallback should fail when TEST_MODE is unset"

# ---------------------------------------------------------
# Check 2: Internal Endpoints Protected with Shared Secret
# ---------------------------------------------------------
Write-Host "`n[Check 2/10] Verifying internal endpoints return 401 without shared secret..." -ForegroundColor Cyan

$res1 = curl.exe -s -o /dev/null -w "%{http_code}" -X POST "$API_BASE/api/internal/releases/build"
$res2 = curl.exe -s -o /dev/null -w "%{http_code}" -X POST "$API_BASE/api/releases/666666666666666666666666/deploy"
$res3 = curl.exe -s -o /dev/null -w "%{http_code}" -X POST "$API_BASE/api/internal/auth/verify"
$res4 = curl.exe -s -o /dev/null -w "%{http_code}" -X GET "$API_BASE/api/internal/releases/666666666666666666666666/tarball"

$allProtected = ($res1 -eq "401") -and ($res2 -eq "401") -and ($res3 -eq "401") -and ($res4 -eq "401")
Assert-Step $allProtected "All internal endpoints return 401 Unauthorized without X-Pushr-Internal-Secret ($res1, $res2, $res3, $res4)" "Internal endpoints must reject unauthenticated requests"

# ---------------------------------------------------------
# Check 3: Public Ingress Blocks Internal Paths
# ---------------------------------------------------------
Write-Host "`n[Check 3/10] Verifying public git Ingress blocks /internal/* paths..." -ForegroundColor Cyan
$ingressInternalCode = curl.exe -s -k -o /dev/null -w "%{http_code}" "https://$GIT_HOST/internal/repos/test"
$ingressBlocked = ($ingressInternalCode -eq "404") -or ($ingressInternalCode -eq "403")
Assert-Step $ingressBlocked "Public Ingress correctly blocks /internal/* paths with HTTP $ingressInternalCode" "Ingress should not route /internal/*"

# ---------------------------------------------------------
# Check 4: Create Real App Record & Bare Git Repo
# ---------------------------------------------------------
Write-Host "`n[Check 4/10] Creating app 'node-app-phase2' via POST /api/apps..." -ForegroundColor Cyan
$appSlug = "node-app-phase2"
$createPayload = '{"slug":"node-app-phase2"}'

# Delete existing app if present from prior runs
curl.exe -s -X DELETE "$API_BASE/api/apps/$appSlug" > $null 2>&1

$createRaw = Invoke-PushrPostJson "$API_BASE/api/apps" $createPayload
$createRes = $createRaw | ConvertFrom-Json

$pushToken = $createRes.pushToken
$gitUrl = $createRes.gitUrl

Assert-Step (($createRes.slug -eq $appSlug) -and ($pushToken -like "pushr_tok_*")) "App created with push token: $($pushToken.Substring(0,18))... and gitUrl: $gitUrl" "App creation failed"

# ---------------------------------------------------------
# Check 5: Hook in Pod is Executable and Has No CRLF
# ---------------------------------------------------------
Write-Host "`n[Check 5/10] Inspecting post-receive hook inside pushr-git pod..." -ForegroundColor Cyan
$hookCheck = kubectl exec -n pushr-system deployment/pushr-git -- sh -c "ls -l /repos/$appSlug.git/hooks/post-receive && file /repos/$appSlug.git/hooks/post-receive"
Write-Host "$hookCheck" -ForegroundColor Gray

$isExecutable = $hookCheck -match "-rwxr-xr-x"
$isPosixText = ($hookCheck -match "POSIX shell script") -or ($hookCheck -match "ASCII text")
$hasNoCRLF = -not ($hookCheck -match "CRLF")

Assert-Step ($isExecutable -and $isPosixText -and $hasNoCRLF) "Hook in pod is executable (-rwxr-xr-x) and POSIX LF format (no CRLF)" "Hook permissions or line endings invalid"

# ---------------------------------------------------------
# Setup Local Git Workspace for Real Push Tests
# ---------------------------------------------------------
$tempWorkspace = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), "pushr-git-verify-" + [System.Guid]::NewGuid().ToString().Substring(0,8))
New-Item -ItemType Directory -Path $tempWorkspace | Out-Null
Set-Location $tempWorkspace

git init -b main | Out-Null
git config user.email "verify@pushr.localhost"
git config user.name "Pushr Verifier"
Copy-Item -Path "c:\Users\karan\OneDrive\Desktop\mini-heroku\samples\node-app\*" -Destination $tempWorkspace -Recurse
git add .
git commit -m "feat: initial commit for phase 2 verification" | Out-Null
$v1Sha = (git rev-parse HEAD).Trim()

# ---------------------------------------------------------
# Check 6: Wrong Token Rejected with 401 & No Release Created
# ---------------------------------------------------------
Write-Host "`n[Check 6/10] Verifying push with wrong token is rejected (401)..." -ForegroundColor Cyan
$badAuthUrl = "http://git:wrongpassword@$GIT_HOST/$appSlug.git"
$pushBad = cmd.exe /c "git -c credential.helper= push $badAuthUrl main 2>&1"

$releasesBefore = curl.exe -s "$API_BASE/api/apps/$appSlug/releases" | ConvertFrom-Json
$wrongRejected = ($pushBad -match "Authentication failed|401") -and ($releasesBefore.Count -eq 0)

Assert-Step $wrongRejected "Push with wrong token rejected immediately (no release created)" "Wrong token was not rejected properly"

# ---------------------------------------------------------
# Check 7: Push to Non-Main Branch Ignored (No Build)
# ---------------------------------------------------------
Write-Host "`n[Check 7/10] Verifying push to non-main branch (feature-test) triggers no build..." -ForegroundColor Cyan
$validAuthUrl = "http://git:$pushToken@$GIT_HOST/$appSlug.git"
git branch feature-test | Out-Null
$pushFeature = cmd.exe /c "git -c credential.helper= push $validAuthUrl feature-test 2>&1"

Start-Sleep -Seconds 2
$releasesAfterFeature = curl.exe -s "$API_BASE/api/apps/$appSlug/releases" | ConvertFrom-Json
$nonMainSkipped = ($releasesAfterFeature.Count -eq 0)

Assert-Step $nonMainSkipped "Push to feature-test accepted by git server but skipped by post-receive hook (0 releases created)" "Non-main branch should not trigger build"

# ---------------------------------------------------------
# Check 8: Fast Real git push on main -> Build -> Auto-Deploy -> 200 OK
# ---------------------------------------------------------
Write-Host "`n[Check 8/10] Verifying git push main returns under 5s, builds real commit, and auto-deploys..." -ForegroundColor Cyan
$pushSw = [System.Diagnostics.Stopwatch]::StartNew()
$pushOutput = cmd.exe /c "git -c credential.helper= push $validAuthUrl main 2>&1"
$pushSw.Stop()
$pushSeconds = $pushSw.Elapsed.TotalSeconds
Write-Host "  Push completed in: $([Math]::Round($pushSeconds, 2))s" -ForegroundColor Gray
Write-Host "$pushOutput" -ForegroundColor Gray

Assert-Step ($pushSeconds -lt 5.0) "git push returned asynchronously in under 5 seconds ($([Math]::Round($pushSeconds, 2))s)" "git push took too long to return (> 5s)"

# Wait for Build and Auto-Deploy
Write-Host "  Waiting for build & deploy of commit $v1Sha..." -ForegroundColor Gray
$v1Release = $null
$deadline = (Get-Date).AddSeconds(120)

while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 3
    $releases = curl.exe -s "$API_BASE/api/apps/$appSlug/releases" | ConvertFrom-Json
    if ($releases.Count -gt 0) {
        $v1Release = $releases[0]
        if ($v1Release.status -eq "succeeded" -and $v1Release.deployStatus -eq "deployed") {
            break
        }
        if ($v1Release.status -eq "failed" -or $v1Release.deployStatus -eq "failed") {
            break
        }
    }
}

Assert-Step (($v1Release.status -eq "succeeded") -and ($v1Release.commitSha -eq $v1Sha)) "Build succeeded for exact commit SHA $($v1Release.shortSha)" "Build did not succeed for commit"
Assert-Step ($v1Release.deployStatus -eq "deployed") "Release auto-deployed successfully" "Deploy did not complete"

# Verify 200 OK at subdomain
$appUrl = "https://$appSlug.pushr.localhost/health"
$healthRes = curl.exe -s -k $appUrl | ConvertFrom-Json
Assert-Step (($healthRes.status -eq "ok") -and ($healthRes.app -eq "node-app")) "Live app serving at $appUrl (status: $($healthRes.status), app: $($healthRes.app))" "App not reachable at subdomain"

# ---------------------------------------------------------
# Check 9: Second Commit via git push -> Rolling Update (100% 200 OK)
# ---------------------------------------------------------
Write-Host "`n[Check 9/10] Verifying second commit via git push -> zero-downtime rolling update..." -ForegroundColor Cyan
$serverJsPath = Join-Path $tempWorkspace "server.js"
$serverCode = Get-Content $serverJsPath -Raw
$serverCode = $serverCode.Replace('Hello from Pushr Node App!', 'Hello from Pushr Node App v2!')
Set-Content -Path $serverJsPath -Value $serverCode -NoNewline

git add server.js
git commit -m "feat: upgrade to v2" | Out-Null
$v2Sha = (git rev-parse HEAD).Trim()

$pushV2 = cmd.exe /c "git -c credential.helper= push $validAuthUrl main 2>&1"
Write-Host "  Push v2 output: $pushV2" -ForegroundColor Gray

# Concurrently monitor requests while rollout happens
$rollout200Count = 0
$rolloutTotalCount = 0
$v2Completed = $false
$v2Deadline = (Get-Date).AddSeconds(180)

while ((Get-Date) -lt $v2Deadline) {
    # Check live app
    $code = curl.exe -s -k -o /dev/null -w "%{http_code}" $appUrl
    $rolloutTotalCount++
    if ($code -eq "200") {
        $rollout200Count++
    }

    $rel2List = curl.exe -s "$API_BASE/api/apps/$appSlug/releases" | ConvertFrom-Json
    if ($rel2List.Count -ge 2) {
        $latest = $rel2List[0]
        if ($latest.commitSha -eq $v2Sha -and $latest.deployStatus -eq "deployed") {
            $v2Completed = $true
            break
        }
    }
    Start-Sleep -Milliseconds 800
}

# Run 20 rapid sequential requests after update to ensure stability
for ($i = 0; $i -lt 20; $i++) {
    $code = curl.exe -s -k -o /dev/null -w "%{http_code}" $appUrl
    $rolloutTotalCount++
    if ($code -eq "200") {
        $rollout200Count++
    }
    Start-Sleep -Milliseconds 50
}

$successPct = [Math]::Round(($rollout200Count / $rolloutTotalCount) * 100, 1)
Write-Host "  Rollout requests: $rollout200Count / $rolloutTotalCount returned 200 ($successPct%)" -ForegroundColor Gray

$bodyV2 = ""
$v2PropagateDeadline = (Get-Date).AddSeconds(20)
while ((Get-Date) -lt $v2PropagateDeadline) {
    $bodyV2 = curl.exe -s -k "https://$appSlug.pushr.localhost/"
    if ($bodyV2 -like "*v2*") { break }
    Start-Sleep -Seconds 1
}
Write-Host "  Live app root body: $bodyV2" -ForegroundColor Gray

Assert-Step ($v2Completed -and ($successPct -eq 100) -and ($bodyV2 -like "*v2*")) "Rolling update for second commit succeeded with 100% 200 OK during update (serving: '$bodyV2')" "Rolling update experienced errors"

# Clean up temporary test workspace
Set-Location "c:\Users\karan\OneDrive\Desktop\mini-heroku"
Remove-Item -Recurse -Force $tempWorkspace

# ---------------------------------------------------------
# Check 10: Re-verify Phase 3 and Phase 4 with Internal Secret
# ---------------------------------------------------------
Write-Host "`n[Check 10/10] Re-verifying Phase 3 and Phase 4 tests with internal secret..." -ForegroundColor Cyan

Write-Host "--- Running verify-phase3.ps1 (TEST_MODE=true) ---" -ForegroundColor Yellow
$p3Output = & powershell -File infra/tests/verify-phase3.ps1 | Out-String
Write-Host "$p3Output"
$p3Passed = ($p3Output -match "6 / 6 checks passed")

Write-Host "--- Running verify-phase4.ps1 (TEST_MODE=true) ---" -ForegroundColor Yellow
$p4Output = & powershell -File infra/tests/verify-phase4.ps1 | Out-String
Write-Host "$p4Output"
$p4Passed = ($p4Output -match "6 / 6 checks passed")

Assert-Step ($p3Passed -and $p4Passed) "Both Phase 3 and Phase 4 test suites pass 100% with internal secret protection" "Regression in Phase 3 or Phase 4"

Write-Host "`n==========================================================" -ForegroundColor Green
Write-Host " ALL $PASSED_COUNT / $TOTAL_COUNT PHASE 2 VERIFICATION CHECKS PASSED!" -ForegroundColor Green
Write-Host "==========================================================" -ForegroundColor Green
