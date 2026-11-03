# Runs tests/index.html in headless Edge and prints the results.
# Usage: powershell -ExecutionPolicy Bypass -File tests\run.ps1   (exit code 1 if any test fails)
$edge = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
$page = "file:///" + ((Resolve-Path "$PSScriptRoot\index.html").Path -replace '\\', '/')
$profileDir = Join-Path $env:TEMP "sar-weather-test-profile"
$dom = & $edge --headless=new --disable-gpu --no-first-run "--user-data-dir=$profileDir" --dump-dom $page 2>$null | Out-String
$summary = [regex]::Match($dom, '<h1 id="summary"[^>]*>([^<]*)</h1>').Groups[1].Value
[regex]::Matches($dom, '<li class="(ok|bad)">([^<]*)</li>') | ForEach-Object {
  [System.Net.WebUtility]::HtmlDecode($_.Groups[2].Value)
}
""
if (-not $summary) { "No results: the test page did not run."; exit 1 }
$summary
if ($summary -notlike "ALL PASSED*") { exit 1 }
