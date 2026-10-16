# dsh-shot-analyzer - Windows full-desktop screen capture
#
# Writes one PNG of the whole virtual desktop (all monitors) to -Out.
# Optionally downscales so the longest side is at most -MaxLongSide.
# Then keeps only the newest -KeepLocalCopies files in that directory, so the
# convenience copies never grow without bound. The copy just written is never
# deleted, and a retention failure never fails the capture.
# Prints "<width>x<height>" of the written image on success.
param(
  [Parameter(Mandatory = $true)][string]$Out,
  [int]$MaxLongSide = 0,
  [int]$KeepLocalCopies = 10
)

$ErrorActionPreference = 'Stop'

# The parent (Electron) process is normally DPI-unaware, and a child PowerShell
# inherits that. Without this the reported virtual-screen bounds are the scaled
# logical ones while CopyFromScreen copies physical pixels, so the capture comes
# out cropped. Bind the call first, then make the process per-monitor aware.
try {
  Add-Type -Namespace DshShot -Name Dpi -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
'@ -ErrorAction Stop
  [void][DshShot.Dpi]::SetProcessDPIAware()
} catch { }

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
if ($bounds.Width -le 0 -or $bounds.Height -le 0) {
  throw "virtual screen has no area ($($bounds.Width)x$($bounds.Height)); no interactive desktop?"
}

$source = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
$graphics = [System.Drawing.Graphics]::FromImage($source)
try {
  $graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $source.Size,
    [System.Drawing.CopyPixelOperation]::SourceCopy)
} finally {
  $graphics.Dispose()
}

$image = $source
try {
  if ($MaxLongSide -gt 0) {
    $longest = [Math]::Max($source.Width, $source.Height)
    if ($longest -gt $MaxLongSide) {
      $scale = [double]$MaxLongSide / [double]$longest
      $width = [int][Math]::Round($source.Width * $scale)
      $height = [int][Math]::Round($source.Height * $scale)
      if ($width -lt 1) { $width = 1 }
      if ($height -lt 1) { $height = 1 }
      $scaled = New-Object System.Drawing.Bitmap($width, $height)
      $scaleGraphics = [System.Drawing.Graphics]::FromImage($scaled)
      try {
        $scaleGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $scaleGraphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $scaleGraphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
        $scaleGraphics.DrawImage($source, 0, 0, $width, $height)
      } finally {
        $scaleGraphics.Dispose()
      }
      $image = $scaled
    }
  }

  $directory = [System.IO.Path]::GetDirectoryName($Out)
  if ($directory -and -not (Test-Path -LiteralPath $directory)) {
    [void][System.IO.Directory]::CreateDirectory($directory)
  }
  $image.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
  Write-Output ("{0}x{1}" -f $image.Width, $image.Height)
} finally {
  $image.Dispose()
  if (-not [object]::ReferenceEquals($image, $source)) { $source.Dispose() }
}

# --- convenience-copy retention -------------------------------------------
# Trim only this plugin's own shot-*.png files. The file just written is never
# deleted, KeepLocalCopies <= 0 disables trimming, and any failure here is
# swallowed so it can never fail the capture itself.
# NOTE: this file is intentionally ASCII-only. Windows PowerShell 5.1 decodes
# BOM-less .ps1 files with the ANSI code page, so non-ASCII comments would be
# misread as code.
if ($KeepLocalCopies -gt 0 -and $directory) {
  try {
    $keep = [System.IO.Path]::GetFullPath($Out)
    $older = @(
      Get-ChildItem -LiteralPath $directory -Filter 'shot-*.png' -File -ErrorAction SilentlyContinue |
        Where-Object { [System.IO.Path]::GetFullPath($_.FullName) -ne $keep } |
        Sort-Object LastWriteTimeUtc -Descending
    )
    # The newest file is already excluded above, so keep (N-1) of the rest.
    $allowed = $KeepLocalCopies - 1
    if ($older.Count -gt $allowed) {
      $older | Select-Object -Skip $allowed | ForEach-Object {
        Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue
      }
    }
  } catch { }
}
