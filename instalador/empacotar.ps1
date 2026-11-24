# Gera um pacote .tar.gz do projeto para levar ao servidor Linux (WinSCP, pendrive...).
# Não inclui arquivos com senhas (*.env), backups nem dados locais.
# Uso (PowerShell, na pasta do projeto):   .\instalador\empacotar.ps1
$ErrorActionPreference = "Stop"
$raiz  = Split-Path -Parent $PSScriptRoot          # ...\globaltech-acs
$pai   = Split-Path -Parent $raiz
$nome  = Split-Path -Leaf $raiz
$data  = Get-Date -Format "yyyyMMdd-HHmm"
$saida = Join-Path $pai "globaltech-acs-instalador-$data.tar.gz"

tar -czf "$saida" -C "$pai" `
  --exclude="*.env" --exclude="$nome/acs/backups" --exclude="$nome/portal/data" `
  --exclude="node_modules" --exclude=".git" --exclude="$nome/.claude" `
  "$nome"
if ($LASTEXITCODE -ne 0) { throw "tar falhou" }

$mb = "{0:N1}" -f ((Get-Item $saida).Length / 1MB)
Write-Host "Pacote criado: $saida ($mb MB)"
Write-Host ""
Write-Host "No servidor Linux, como root:"
Write-Host "  tar xzf $(Split-Path -Leaf $saida)"
Write-Host "  cd $nome && bash instalador/instalar.sh"
