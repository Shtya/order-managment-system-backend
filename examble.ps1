# Stop on errors
$ErrorActionPreference = "Stop"

# Load .env file
if (Test-Path ".env") {
  Get-Content ".env" | ForEach-Object {
    if ($_ -match "^\s*([^#].*?)=(.*)$") {
      [System.Environment]::SetEnvironmentVariable($matches[1], $matches[2])
    }
  }
}

# Validate required variables
if (-not $env:SHOPIFY_SHOP) { throw "Set SHOPIFY_SHOP in .env" }
if (-not $env:SHOPIFY_CLIENT_ID) { throw "Set SHOPIFY_CLIENT_ID in .env" }
if (-not $env:SHOPIFY_CLIENT_SECRET) { throw "Set SHOPIFY_CLIENT_SECRET in .env" }

# Request access token
$tokenUrl = "https://$($env:SHOPIFY_SHOP).myshopify.com/admin/oauth/access_token"

$body = @{
  grant_type    = "client_credentials"
  client_id     = $env:SHOPIFY_CLIENT_ID
  client_secret = $env:SHOPIFY_CLIENT_SECRET
}

# Make the request and capture raw response
$tokenResponseRaw = Invoke-WebRequest -Method Post -Uri $tokenUrl -ContentType "application/x-www-form-urlencoded" -Body $body
Write-Host "Raw token response:"
Write-Host $tokenResponseRaw.Content

# Parse token
try {
  $tokenResponse = $tokenResponseRaw.Content | ConvertFrom-Json
  $accessToken = $tokenResponse.access_token
  Write-Host "Access token parsed from response:"
  Write-Host $accessToken
}
catch {
  Write-Warning "Failed to parse token JSON"
  $accessToken = $null
}

if (-not $accessToken) {
  Write-Error "No valid access token obtained. Check the raw token response above."
  exit 1
}

$restUrl = "https://$($env:SHOPIFY_SHOP).myshopify.com/admin/api/2025-01/products.json?limit=10"

try {
  $response = Invoke-RestMethod -Method Get -Uri $restUrl -Headers @{
    "X-Shopify-Access-Token" = $accessToken
    "Content-Type"           = "application/json"
  }

  # Print full response
  $response | ConvertTo-Json -Depth 10

}
catch {
  Write-Error "Failed to fetch products via REST API: $_"
}
