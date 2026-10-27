$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Security
  $checkpointRequest = [Console]::In.ReadToEnd() | ConvertFrom-Json
  if ($checkpointRequest.action -eq 'protect-key' -or $checkpointRequest.action -eq 'unprotect-key') {
    $checkpointBytes = [Convert]::FromBase64String($checkpointRequest.data)
    $checkpointEntropy = [Text.Encoding]::UTF8.GetBytes('Skyline:xcpydisstlvtvcsqnjob:recovery:v1')
    if ($checkpointRequest.action -eq 'protect-key') {
      $checkpointResult = [Security.Cryptography.ProtectedData]::Protect($checkpointBytes,$checkpointEntropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
    } else {
      $checkpointResult = [Security.Cryptography.ProtectedData]::Unprotect($checkpointBytes,$checkpointEntropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
    }
    [Console]::Out.Write([Convert]::ToBase64String($checkpointResult))
    [Array]::Clear($checkpointBytes,0,$checkpointBytes.Length)
    [Array]::Clear($checkpointResult,0,$checkpointResult.Length)
  } elseif ($checkpointRequest.action -eq 'protect-directory' -or $checkpointRequest.action -eq 'verify-path') {
    $checkpointPath = [IO.Path]::GetFullPath($checkpointRequest.path)
    $checkpointIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
    if ($checkpointRequest.action -eq 'protect-directory') {
    if (-not (Test-Path -LiteralPath $checkpointPath)) { New-Item -ItemType Directory -Path $checkpointPath | Out-Null }
    if ((Get-Item -LiteralPath $checkpointPath).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse path forbidden' }
    $checkpointExisting = Get-Acl -LiteralPath $checkpointPath
    $checkpointExistingRules = @($checkpointExisting.Access)
    $checkpointAlreadyProtected = $checkpointExisting.AreAccessRulesProtected -and $checkpointExisting.GetOwner([Security.Principal.SecurityIdentifier]).Value -eq $checkpointIdentity.User.Value -and $checkpointExistingRules.Count -eq 2
    foreach ($checkpointRule in $checkpointExistingRules) {
      if ($checkpointRule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -notin @($checkpointIdentity.User.Value,'S-1-5-18') -or $checkpointRule.AccessControlType -ne 'Allow' -or $checkpointRule.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl) { $checkpointAlreadyProtected = $false }
    }
    if (-not $checkpointAlreadyProtected) {
    $checkpointAcl = Get-Acl -LiteralPath $checkpointPath
    $checkpointAcl.SetAccessRuleProtection($true,$false)
    foreach ($checkpointOldRule in @($checkpointAcl.Access)) { $checkpointAcl.RemoveAccessRuleSpecific($checkpointOldRule) }
    if ($checkpointAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $checkpointIdentity.User.Value) { $checkpointAcl.SetOwner($checkpointIdentity.User) }
    $checkpointInheritance = [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
    $checkpointPropagation = [Security.AccessControl.PropagationFlags]::None
    $checkpointAcl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($checkpointIdentity.User,'FullControl',$checkpointInheritance,$checkpointPropagation,'Allow')))
    $checkpointSystem = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
    $checkpointAcl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($checkpointSystem,'FullControl',$checkpointInheritance,$checkpointPropagation,'Allow')))
    Set-Acl -LiteralPath $checkpointPath -AclObject $checkpointAcl
    }
    }
    if ((Get-Item -LiteralPath $checkpointPath).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse path forbidden' }
    $checkpointVerified = Get-Acl -LiteralPath $checkpointPath
    $checkpointUnexpected = @($checkpointVerified.Access | Where-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -notin @($checkpointIdentity.User.Value,'S-1-5-18') })
    $checkpointAllowed = @($checkpointVerified.Access | Where-Object { $_.AccessControlType -eq 'Allow' -and $_.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl } | ForEach-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value } | Select-Object -Unique)
    if ($checkpointUnexpected.Count -ne 0 -or $checkpointIdentity.User.Value -notin $checkpointAllowed -or 'S-1-5-18' -notin $checkpointAllowed -or $checkpointVerified.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $checkpointIdentity.User.Value) { throw 'ACL validation failed' }
    if ($checkpointRequest.action -eq 'protect-directory' -and -not $checkpointVerified.AreAccessRulesProtected) { throw 'Inheritance validation failed' }
    [Console]::Out.Write('{"ownerAndSystemOnly":true,"inheritanceDisabled":true}')
  } else { throw 'Unsupported protected checkpoint operation' }
} catch {
  [Console]::Error.WriteLine('Protected checkpoint operation failed at helper line '+$_.InvocationInfo.ScriptLineNumber+' ('+$_.Exception.GetType().Name+'); no secret details emitted.')
  exit 1
}
