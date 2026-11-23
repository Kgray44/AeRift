#requires -Version 7.2
# Reuses the owner-local Landfall DPAPI identity. See docs/testflight.md for provenance.
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$ProfilePath,
  [string]$CertificatePath,
  [string]$ApiKeyPath,
  [string]$PrivateDirectory = 'D:\CodexTemp\ncl01-apple-signing',
  [switch]$InstallSecrets
)

$ErrorActionPreference = 'Stop'
$TeamId = 'X2JZ9N65V2'
$BundleId = 'com.kgamazing44.aerift'
$Repository = 'Kgray44/AeRift'
$EnvironmentName = 'aerift-testflight'
$LandfallRepository = 'Kgray44/treasurehuntSoT'
$LandfallEnvironment = 'ncl01-testflight'
$OwnerFile = Join-Path $PrivateDirectory 'owner.json'
$ProtectedKeyFile = Join-Path $PrivateDirectory 'distribution-rsa.dpapi'
$CsrFile = Join-Path $PrivateDirectory 'VoyageWright-Landfall-Distribution.certSigningRequest'
$Purpose = 'NCL01_APPLE_DISTRIBUTION_V1'
$Entropy = [Text.Encoding]::UTF8.GetBytes($Purpose)
if (-not $IsWindows) { throw 'Run this helper on the owner Windows laptop.' }

function Assert-PrivateDirectory {
  $item = Get-Item -LiteralPath $PrivateDirectory
  if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw 'Signing directory must be an ordinary owned directory.'
  }
  $acl = Get-Acl -LiteralPath $PrivateDirectory
  $current = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  if (-not $acl.AreAccessRulesProtected -or $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $current) {
    throw 'Signing directory ownership or inheritance is unexpected.'
  }
  foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin @($current, 'S-1-5-18')) {
      throw 'Signing directory grants access beyond this owner and SYSTEM.'
    }
  }
  $owner = Get-Content -Raw -LiteralPath $OwnerFile | ConvertFrom-Json
  if ($owner.purpose -ne $Purpose -or $owner.teamId -ne $TeamId -or $owner.bundleId -ne 'com.voyagewright.landfall') {
    throw 'Signing directory has different ownership metadata.'
  }
}

function Invoke-GhInput([string[]]$Arguments, [string]$InputText) {
  $processInfo = [Diagnostics.ProcessStartInfo]::new('gh')
  $processInfo.UseShellExecute = $false
  $processInfo.RedirectStandardInput = $true
  $processInfo.RedirectStandardOutput = $true
  $processInfo.RedirectStandardError = $true
  foreach ($argument in $Arguments) { $processInfo.ArgumentList.Add($argument) }
  $process = [Diagnostics.Process]::Start($processInfo)
  $outputTask = $process.StandardOutput.ReadToEndAsync()
  $errorTask = $process.StandardError.ReadToEndAsync()
  $process.StandardInput.Write($InputText)
  $process.StandardInput.Close()
  $process.WaitForExit()
  $null = $outputTask.GetAwaiter().GetResult()
  $null = $errorTask.GetAwaiter().GetResult()
  $code = $process.ExitCode
  $process.Dispose()
  if ($code -ne 0) { throw 'GitHub credential configuration failed; no credential output was printed. Check gh authentication and environment permissions.' }
}

function Get-VerifiedRsa {
  $rsa = [Security.Cryptography.RSA]::Create()
  try {
    $bytes = [Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($ProtectedKeyFile), $Entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    try { $read = 0; $rsa.ImportPkcs8PrivateKey($bytes, [ref]$read) }
    finally { [Security.Cryptography.CryptographicOperations]::ZeroMemory($bytes) }
    $request = [Security.Cryptography.X509Certificates.CertificateRequest]::LoadSigningRequestPem(
      [IO.File]::ReadAllText($CsrFile), [Security.Cryptography.HashAlgorithmName]::SHA256,
      [Security.Cryptography.X509Certificates.CertificateRequestLoadOptions]::Default,
      [Security.Cryptography.RSASignaturePadding]::Pkcs1)
    if (-not [Security.Cryptography.CryptographicOperations]::FixedTimeEquals($rsa.ExportSubjectPublicKeyInfo(), $request.PublicKey.ExportSubjectPublicKeyInfo())) {
      throw 'Retained CSR and protected key do not match.'
    }
    return $rsa
  } catch { $rsa.Dispose(); throw 'Retained signing preparation failed its key and CSR integrity check; nothing was replaced.' }
}

function Get-PlistValue($Dictionary, [string]$Name) {
  $key = $Dictionary.SelectSingleNode("key[.='$Name']")
  if ($key) { return $key.NextSibling }
  return $null
}

function Assert-AppStoreProfile([byte[]]$ProfileBytes, $Certificate) {
  Add-Type -AssemblyName System.Security.Cryptography.Pkcs
  $cms = [Security.Cryptography.Pkcs.SignedCms]::new()
  $cms.Decode($ProfileBytes)
  $cms.CheckSignature($true)
  $settings = [Xml.XmlReaderSettings]::new()
  $settings.DtdProcessing = [Xml.DtdProcessing]::Ignore
  $settings.XmlResolver = $null
  $reader = [Xml.XmlReader]::Create([IO.StringReader]::new([Text.Encoding]::UTF8.GetString($cms.ContentInfo.Content)), $settings)
  $plist = [Xml.XmlDocument]::new()
  $plist.XmlResolver = $null
  try { $plist.Load($reader) } finally { $reader.Dispose() }
  $root = $plist.SelectSingleNode('/plist/dict')
  if (-not $root) { throw 'The profile has no plist dictionary.' }
  $entitlements = Get-PlistValue $root 'Entitlements'
  $team = Get-PlistValue $root 'TeamIdentifier'
  $expiry = Get-PlistValue $root 'ExpirationDate'
  $certificates = Get-PlistValue $root 'DeveloperCertificates'
  $certificateHash = [Security.Cryptography.SHA256]::HashData($Certificate.RawData)
  if (-not $entitlements -or -not $team -or $team.ChildNodes.Count -ne 1 -or $team.FirstChild.InnerText -ne $TeamId -or
      -not $expiry -or [DateTimeOffset]::Parse($expiry.InnerText).UtcDateTime -le [DateTime]::UtcNow -or
      (Get-PlistValue $entitlements 'application-identifier').InnerText -ne "$TeamId.$BundleId" -or
      (Get-PlistValue $entitlements 'com.apple.developer.team-identifier').InnerText -ne $TeamId -or
      (Get-PlistValue $entitlements 'get-task-allow').Name -ne 'false' -or
      (Get-PlistValue $entitlements 'beta-reports-active').Name -ne 'true' -or
      (Get-PlistValue $root 'ProvisionedDevices') -or (Get-PlistValue $root 'ProvisionsAllDevices') -or
      -not $certificates -or $certificates.ChildNodes.Count -ne 1 -or
      -not [Security.Cryptography.CryptographicOperations]::FixedTimeEquals($certificateHash, [Security.Cryptography.SHA256]::HashData([Convert]::FromBase64String($certificates.FirstChild.InnerText)))) {
    throw 'The profile is not a current matching App Store Connect distribution profile for this team, app and certificate.'
  }
}


function Read-EnvironmentVariable([string]$Repo, [string]$Environment, [string]$Name) {
  $value = gh api "repos/$Repo/environments/$Environment/variables/$Name" --jq .value
  if ($LASTEXITCODE -ne 0 -or -not $value) { throw "Deployment variable $Name is unavailable." }
  return $value
}

function ConvertTo-Base64Url([byte[]]$Bytes) {
  return [Convert]::ToBase64String($Bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function Assert-AppleApp($Key, [string]$KeyId, [string]$IssuerId, [string]$AppId) {
  $now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
  $header = @{ alg = 'ES256'; kid = $KeyId; typ = 'JWT' } | ConvertTo-Json -Compress
  $claims = @{ iss = $IssuerId; iat = $now; exp = $now + 300; aud = 'appstoreconnect-v1' } | ConvertTo-Json -Compress
  $payload = (ConvertTo-Base64Url ([Text.Encoding]::UTF8.GetBytes($header))) + '.' +
    (ConvertTo-Base64Url ([Text.Encoding]::UTF8.GetBytes($claims)))
  $signature = $Key.SignData(
    [Text.Encoding]::ASCII.GetBytes($payload),
    [Security.Cryptography.HashAlgorithmName]::SHA256,
    [Security.Cryptography.DSASignatureFormat]::IeeeP1363FixedFieldConcatenation)
  $token = $payload + '.' + (ConvertTo-Base64Url $signature)
  try {
    $lookup = Invoke-RestMethod -Uri "https://api.appstoreconnect.apple.com/v1/apps/$AppId" -Headers @{ Authorization = "Bearer $token" } -TimeoutSec 30
  } catch { throw 'The retained team key could not read the AeRift App Store Connect record.' }
  finally { $token = $null }
  if ($lookup.data.id -ne $AppId -or $lookup.data.attributes.bundleId -ne $BundleId) {
    throw 'App Store Connect returned a different app or bundle identifier.'
  }
}

Assert-PrivateDirectory
$login = gh api user --jq .login
if ($LASTEXITCODE -ne 0 -or $login -ne 'Kgray44') { throw 'The AeRift owner account must be active in gh.' }
$keyId = Read-EnvironmentVariable $LandfallRepository $LandfallEnvironment 'NCL01_ASC_KEY_ID'
$issuerId = Read-EnvironmentVariable $LandfallRepository $LandfallEnvironment 'NCL01_ASC_ISSUER_ID'
$appId = Read-EnvironmentVariable $Repository $EnvironmentName 'AERIFT_ASC_APP_ID'
if ($keyId -notmatch '^[A-Z0-9]{10}$' -or $issuerId -notmatch '^[0-9a-fA-F-]{36}$' -or $appId -notmatch '^[0-9]+$') {
  throw 'Deployment metadata is invalid.'
}

$downloads = Join-Path ([Environment]::GetFolderPath('UserProfile')) 'Downloads'
if (-not $ApiKeyPath) { $ApiKeyPath = Join-Path $downloads "AuthKey_$keyId.p8" }
if (-not $CertificatePath) {
  $certificates = @(Get-ChildItem -LiteralPath $downloads -File -Filter '*.cer')
  if ($certificates.Count -ne 1) { throw 'Provide the local path to the existing Apple Distribution certificate.' }
  $CertificatePath = $certificates[0].FullName
}
foreach ($path in @($CertificatePath, $ProfilePath, $ApiKeyPath)) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw 'A required local signing input was not found.' }
}

$certificate = [Security.Cryptography.X509Certificates.X509Certificate2]::new([IO.File]::ReadAllBytes((Resolve-Path -LiteralPath $CertificatePath)))
try {
  $now = [DateTime]::UtcNow
  if ($certificate.Subject -notmatch "(^|,\s*)OU=$TeamId(,|$)" -or
      $certificate.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false) -notlike 'Apple Distribution:*' -or
      $certificate.NotBefore.ToUniversalTime() -gt $now -or $certificate.NotAfter.ToUniversalTime() -le $now) {
    throw 'The existing certificate is not current Apple Distribution material for this team.'
  }
  $profileBytes = [IO.File]::ReadAllBytes((Resolve-Path -LiteralPath $ProfilePath))
  Assert-AppStoreProfile -ProfileBytes $profileBytes -Certificate $certificate
  $apiKey = [IO.File]::ReadAllText((Resolve-Path -LiteralPath $ApiKeyPath))
  if ($apiKey -notmatch '^-----BEGIN PRIVATE KEY-----' -or $apiKey -notmatch '-----END PRIVATE KEY-----\s*$') {
    throw 'The retained App Store Connect key is not an Apple .p8 private key.'
  }
  $apiIdentity = [Security.Cryptography.ECDsa]::Create()
  try {
    $apiIdentity.ImportFromPem($apiKey)
    if ($apiIdentity.ExportParameters($false).Curve.Oid.Value -ne '1.2.840.10045.3.1.7') {
      throw 'The App Store Connect key must use P-256.'
    }
    Assert-AppleApp $apiIdentity $keyId $issuerId $appId
  } finally { $apiIdentity.Dispose() }

  $rsa = Get-VerifiedRsa
  try {
    $signingCertificate = [Security.Cryptography.X509Certificates.RSACertificateExtensions]::CopyWithPrivateKey($certificate, $rsa)
    try {
      if ($InstallSecrets) {
        $password = [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
        $p12 = $signingCertificate.Export([Security.Cryptography.X509Certificates.X509ContentType]::Pkcs12, $password)
        foreach ($entry in @(
          @('AERIFT_DISTRIBUTION_P12_BASE64', [Convert]::ToBase64String($p12)),
          @('AERIFT_DISTRIBUTION_P12_PASSWORD', $password),
          @('AERIFT_APPSTORE_PROFILE_BASE64', [Convert]::ToBase64String($profileBytes)),
          @('AERIFT_ASC_PRIVATE_KEY_P8', $apiKey)
        )) {
          Invoke-GhInput -Arguments @('secret','set',$entry[0],'--repo',$Repository,'--env',$EnvironmentName) -InputText $entry[1]
          Write-Output "Configured AeRift environment secret: $($entry[0])"
        }
        foreach ($entry in @(@('AERIFT_ASC_KEY_ID',$keyId),@('AERIFT_ASC_ISSUER_ID',$issuerId))) {
          Invoke-GhInput -Arguments @('variable','set',$entry[0],'--repo',$Repository,'--env',$EnvironmentName) -InputText $entry[1]
        }
      }
    } finally { $signingCertificate.Dispose() }
  } finally { $rsa.Dispose() }
  Write-Output 'Verified the retained Distribution certificate, matching DPAPI key, AeRift App Store profile, and team API access to the AeRift app.'
} finally {
  if ($p12) { [Security.Cryptography.CryptographicOperations]::ZeroMemory($p12) }
  $password = $null
  $apiKey = $null
  $certificate.Dispose()
}
