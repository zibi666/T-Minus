Add-Type -AssemblyName System.Drawing

$src = "E:\T-Minus\apps\windows\assets\icon.png"
$fg  = "E:\T-Minus\apps\harmony\AppScope\resources\base\media\foreground.png"
$bg  = "E:\T-Minus\apps\harmony\AppScope\resources\base\media\background.png"
$fg2 = "E:\T-Minus\apps\harmony\entry\src\main\resources\base\media\foreground.png"
$bg2 = "E:\T-Minus\apps\harmony\entry\src\main\resources\base\media\background.png"
$start = "E:\T-Minus\apps\harmony\entry\src\main\resources\base\media\startIcon.png"
$preview = "E:\T-Minus\tools\icon-preview.png"

# Adaptive-icon foreground: the brand tile scaled into the safe zone, NOT keyed.
# The background layer is the same tile full-bleed, so the foreground's square edge never
# shows — and colour keying (which hollowed the white hands and left a halo) is avoided.
function New-Foreground([int]$canvas, [double]$scale, [string]$out) {
  $bmp = New-Object System.Drawing.Bitmap $canvas, $canvas
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.Clear([System.Drawing.Color]::Transparent)
  $srcImg = New-Object System.Drawing.Bitmap $src
  $size = [int]($canvas * $scale)
  $off = [int](($canvas - $size) / 2)
  $g.DrawImage($srcImg, (New-Object System.Drawing.Rectangle $off, $off, $size, $size), `
    (New-Object System.Drawing.Rectangle 0, 0, $srcImg.Width, $srcImg.Height), `
    [System.Drawing.GraphicsUnit]::Pixel)
  $g.Dispose()
  $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
  $srcImg.Dispose(); $bmp.Dispose()
}

function New-Background([int]$canvas, [string]$out) {
  # Flat opaque fill, edge-to-edge (a transparent or light edge is the white-edge bug).
  # Deliberately NOT the brand tile: a full-bleed tile background ghosts the ring behind
  # the 66% foreground, and colour keying the tile hollows its white hands.
  $bmp = New-Object System.Drawing.Bitmap $canvas, $canvas
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $b = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 5, 6, 15))
  $g.FillRectangle($b, 0, 0, $canvas, $canvas)
  $g.Dispose(); $b.Dispose()
  $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}

New-Foreground 1024 0.66 $fg
Copy-Item $fg $fg2 -Force
New-Background 1024 $bg
Copy-Item $bg $bg2 -Force

# startIcon: full-bleed brand tile (no adaptive layering)
$bmp = New-Object System.Drawing.Bitmap 144, 144
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$srcImg = New-Object System.Drawing.Bitmap $src
$g.DrawImage($srcImg, 0, 0, 144, 144)
$g.Dispose(); $srcImg.Dispose()
$bmp.Save($start, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()

# Preview composite: what the launcher will actually show
$f = New-Object System.Drawing.Bitmap $fg
$b = New-Object System.Drawing.Bitmap $bg
$p = New-Object System.Drawing.Bitmap 1024, 1024
$pg = [System.Drawing.Graphics]::FromImage($p)
$pg.DrawImage($b, 0, 0, 1024, 1024)
$pg.DrawImage($f, 0, 0, 1024, 1024)
$pg.Dispose(); $b.Dispose(); $f.Dispose()
$p.Save($preview, [System.Drawing.Imaging.ImageFormat]::Png)
$p.Dispose()
Write-Output "ok"
