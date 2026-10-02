# Pushr Infra Up Script (PowerShell)
$ErrorActionPreference = "Stop"

# Refresh PATH from Registry in case tools were recently installed
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")

Write-Host "==> Checking prerequisites..." -ForegroundColor Cyan

# Check Docker
try {
    $dockerInfo = docker info 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "Docker is not running. Please start Docker Desktop and ensure the Docker daemon is accessible."
    }
} catch {
    Write-Error "Docker daemon check failed: $_"
    exit 1
}

# Check k3d
if (-not (Get-Command k3d -ErrorAction SilentlyContinue)) {
    Write-Error "k3d is not found in PATH. Please install k3d (winget install k3d.k3d) and retry."
    exit 1
}

# Check kubectl
if (-not (Get-Command kubectl -ErrorAction SilentlyContinue)) {
    Write-Error "kubectl is not found in PATH. Please install kubectl (winget install Kubernetes.kubectl) and retry."
    exit 1
}

Write-Host "==> Checking if host port 5001 is free for container registry..." -ForegroundColor Cyan
$port5001InUse = Get-NetTCPConnection -LocalPort 5001 -ErrorAction SilentlyContinue
if ($port5001InUse) {
    Write-Error "Host port 5001 is already in use by process ID $($port5001InUse[0].OwningProcess). Please free port 5001 before proceeding."
    exit 1
}
Write-Host "Port 5001 is free." -ForegroundColor Green

Write-Host "==> Checking k3d cluster 'pushr'..." -ForegroundColor Cyan
$existingClusters = k3d cluster list -o json | ConvertFrom-Json
$clusterExists = $false
foreach ($c in $existingClusters) {
    if ($c.name -eq "pushr") {
        $clusterExists = $true
        break
    }
}

if (-not $clusterExists) {
    Write-Host "==> Creating k3d cluster 'pushr' with registry and ports 80/443..." -ForegroundColor Cyan
    $configFile = Join-Path $PSScriptRoot "..\k3d-config.yaml"
    k3d cluster create --config $configFile
} else {
    Write-Host "==> Cluster 'pushr' already exists. Ensuring it is started..." -ForegroundColor Green
    k3d cluster start pushr
}

Write-Host "==> Setting kubectl context to k3d-pushr..." -ForegroundColor Cyan
kubectl config use-context k3d-pushr

Write-Host "==> Waiting for cluster nodes to be ready..." -ForegroundColor Cyan
kubectl wait --for=condition=Ready node --all --timeout=120s

Write-Host "==> Installing cert-manager v1.16.2..." -ForegroundColor Cyan
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.16.2/cert-manager.yaml

Write-Host "==> Waiting for cert-manager deployments to complete rollout..." -ForegroundColor Cyan
kubectl rollout status deployment/cert-manager -n cert-manager --timeout=180s
kubectl rollout status deployment/cert-manager-webhook -n cert-manager --timeout=180s
kubectl rollout status deployment/cert-manager-cainjector -n cert-manager --timeout=180s

Write-Host "==> Applying self-signed ClusterIssuer..." -ForegroundColor Cyan
$issuerFile = Join-Path $PSScriptRoot "..\manifests\cert-manager\cluster-issuer.yaml"
# Small sleep to let webhook service register endpoints
Start-Sleep -Seconds 3
kubectl apply -f $issuerFile

Write-Host "==> Infrastructure bootstrap complete! Traefik, registry:5001, and cert-manager are ready." -ForegroundColor Green
