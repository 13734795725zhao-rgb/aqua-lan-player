# 生成应用图标（.ico）+ 512 PNG 预览
#   powershell -ExecutionPolicy Bypass -File tools\make-icon.ps1
Add-Type -AssemblyName System.Drawing
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$outIco = Join-Path $root 'build\icon.ico'
$outPng = Join-Path $root 'build\icon.png'
New-Item -ItemType Directory -Force -Path (Split-Path $outIco) | Out-Null

function New-RoundRectPath([double]$x, [double]$y, [double]$w, [double]$h, [double]$r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $p.AddArc($x, $y, $d, $d, 180, 90)
  $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $p.CloseFigure()
  return $p
}

function New-PlayPath([double]$cx, [double]$cy, [double]$size) {
  # 简洁的等腰三角形（QuickTime 风格），顶点略偏右
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $hw = $size * 0.44
  $hh = $size * 0.52
  $a = [System.Drawing.Point]::new([int]($cx - $hw * 0.55), [int]($cy - $hh))
  $b = [System.Drawing.Point]::new([int]($cx + $hw), [int]$cy)
  $c = [System.Drawing.Point]::new([int]($cx - $hw * 0.55), [int]($cy + $hh))
  $p.AddPolygon([System.Drawing.Point[]]@($a, $b, $c))
  $p.CloseFigure()
  return $p
}
function New-IconBitmap([int]$size) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.Clear([System.Drawing.Color]::Transparent)

  $pad = $size * 0.055
  $w = $size - $pad * 2
  $r = $w * 0.225
  $rect = New-RoundRectPath $pad $pad $w $w $r

  # 主体渐变：海蓝 → 深天蓝
  $p1 = [System.Drawing.PointF]::new([single]$pad, [single]$pad)
  $p2 = [System.Drawing.PointF]::new([single]$pad, [single]($pad + $w))
  $c1 = [System.Drawing.Color]::FromArgb(255, 96, 208, 250)
  $c2 = [System.Drawing.Color]::FromArgb(255, 22, 92, 224)
  $brush = [System.Drawing.Drawing2D.LinearGradientBrush]::new($p1, $p2, $c1, $c2)
  $g.FillPath($brush, $rect)

  # 内描边（玻璃高光边）
  $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(60, 255, 255, 255)), ([Math]::Max(1, $size * 0.012))
  $g.DrawPath($pen, $rect)

  # 播放三角
  $play = New-PlayPath ($size * 0.54) ($size * 0.50) ($size * 0.46)
  $white = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(242, 255, 255, 255))
  $g.FillPath($white, $play)

  $g.Dispose()
  return $bmp
}

# ------------------------------------------------------- 打包成 .ico ---
$sizes = @(16, 24, 32, 48, 64, 128, 256)
$frames = @()
foreach ($s in $sizes) {
  $bmp = New-IconBitmap $s
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $frames += ,@{ size = $s; data = $ms.ToArray() }
  $ms.Dispose(); $bmp.Dispose()
}

$head = [System.IO.BinaryWriter]::new([System.IO.MemoryStream]::new())
$out = [System.IO.MemoryStream]::new()
$bw = [System.IO.BinaryWriter]::new($out)
$bw.Write([UInt16]0)          # reserved
$bw.Write([UInt16]1)          # type = icon
$bw.Write([UInt16]$frames.Count)
$offset = 6 + 16 * $frames.Count
foreach ($f in $frames) {
  $bw.Write([byte]($(if ($f.size -ge 256) { 0 } else { $f.size })))
  $bw.Write([byte]($(if ($f.size -ge 256) { 0 } else { $f.size })))
  $bw.Write([byte]0)          # 调色板
  $bw.Write([byte]0)          # reserved
  $bw.Write([UInt16]1)        # color planes
  $bw.Write([UInt16]32)       # bits per pixel
  $bw.Write([UInt32]$f.data.Length)
  $bw.Write([UInt32]$offset)
  $offset += $f.data.Length
}
foreach ($f in $frames) { $bw.Write($f.data) }
$bw.Flush()
[System.IO.File]::WriteAllBytes($outIco, $out.ToArray())
$bw.Dispose(); $out.Dispose()

# 512 PNG 预览
$big = New-IconBitmap 512
$big.Save($outPng, [System.Drawing.Imaging.ImageFormat]::Png)
$big.Dispose()

"已生成: $outIco"
"已生成: $outPng"
