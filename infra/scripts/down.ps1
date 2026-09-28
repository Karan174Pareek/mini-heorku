# Pushr Infra Down Script (PowerShell)
$ErrorActionPreference = "Continue"

$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")

Write-Host "==> Tearing down test workloads..." -ForegroundColor Cyan
kubectl delete -f (Join-Path $PSScriptRoot "..\manifests\test-verify\test-app.yaml") --ignore-not-found=true

Write-Host "==> Deleting k3d cluster 'pushr'..." -ForegroundColor Cyan
k3d cluster delete pushr

Write-Host "==> Deleting registry 'pushr-registry'..." -ForegroundColor Cyan
k3d registry delete pushr-registry

Write-Host "==> Teardown complete." -ForegroundColor Green
