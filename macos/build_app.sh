#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_NAME="CrackAI"
APP_BUNDLE="$PROJECT_ROOT/${APP_NAME}.app"
CONTENTS_DIR="$APP_BUNDLE/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"
RES_DIR="$CONTENTS_DIR/Resources"
APP_CODE_DIR="$RES_DIR/app"

echo "🔨 Building ${APP_NAME}.app..."
rm -rf "$APP_BUNDLE"
mkdir -p "$MACOS_DIR" "$RES_DIR" "$APP_CODE_DIR"

# 1. Generate high-res macOS AppIcon.icns via CoreGraphics
ICONSET_DIR="$(mktemp -d)/AppIcon.iconset"
mkdir -p "$ICONSET_DIR"

swift - "$ICONSET_DIR" << 'SWIFT'
import AppKit
import Foundation

let outDir = CommandLine.arguments[1]

func renderIcon(size: Int, filename: String) {
  let s = CGFloat(size)
  let rep = NSBitmapImageRep(
    bitmapDataPlanes: nil,
    pixelsWide: size,
    pixelsHigh: size,
    bitsPerSample: 8,
    samplesPerPixel: 4,
    hasAlpha: true,
    isPlanar: false,
    colorSpaceName: .deviceRGB,
    bytesPerRow: 0,
    bitsPerPixel: 0
  )!
  rep.size = NSSize(width: s, height: s)
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)

  let rect = NSRect(x: 0, y: 0, width: s, height: s)
  let corner = s * 0.22
  let bgPath = NSBezierPath(roundedRect: rect.insetBy(dx: s * 0.04, dy: s * 0.04), xRadius: corner, yRadius: corner)
  let bgGrad = NSGradient(colors: [
    NSColor(calibratedRed: 0.075, green: 0.063, blue: 0.145, alpha: 1.0),
    NSColor(calibratedRed: 0.125, green: 0.075, blue: 0.235, alpha: 1.0),
    NSColor(calibratedRed: 0.043, green: 0.043, blue: 0.078, alpha: 1.0),
  ])!
  bgGrad.draw(in: bgPath, angle: -45)

  // Subtle ambient violet ring
  let ringRect = rect.insetBy(dx: s * 0.18, dy: s * 0.18)
  let ringPath = NSBezierPath(ovalIn: ringRect)
  ringPath.lineWidth = max(2.0, s * 0.036)
  NSColor(calibratedRed: 0.65, green: 0.35, blue: 0.98, alpha: 0.30).setStroke()
  ringPath.stroke()

  // Signature Crack Bolt Emblem
  let bolt = NSBezierPath()
  bolt.move(to: NSPoint(x: s * 0.57, y: s * 0.84))
  bolt.line(to: NSPoint(x: s * 0.34, y: s * 0.49))
  bolt.line(to: NSPoint(x: s * 0.51, y: s * 0.49))
  bolt.line(to: NSPoint(x: s * 0.42, y: s * 0.16))
  bolt.line(to: NSPoint(x: s * 0.68, y: s * 0.53))
  bolt.line(to: NSPoint(x: s * 0.50, y: s * 0.53))
  bolt.close()

  let boltGrad = NSGradient(colors: [
    NSColor(calibratedRed: 0.78, green: 0.54, blue: 1.0, alpha: 1.0),
    NSColor(calibratedRed: 0.49, green: 0.36, blue: 1.0, alpha: 1.0),
    NSColor(calibratedRed: 0.96, green: 0.25, blue: 0.42, alpha: 1.0),
  ])!
  boltGrad.draw(in: bolt, angle: -55)

  // Sparkle accent
  let dotRect = NSRect(x: s * 0.68, y: s * 0.69, width: s * 0.075, height: s * 0.075)
  NSColor(calibratedRed: 0.92, green: 0.52, blue: 0.98, alpha: 0.95).setFill()
  NSBezierPath(ovalIn: dotRect).fill()

  NSGraphicsContext.restoreGraphicsState()
  let png = rep.representation(using: .png, properties: [:])!
  try! png.write(to: URL(fileURLWithPath: "\(outDir)/\(filename)"))
}

let specs: [(Int, String)] = [
  (16, "icon_16x16.png"),
  (32, "icon_16x16@2x.png"),
  (32, "icon_32x32.png"),
  (64, "icon_32x32@2x.png"),
  (128, "icon_128x128.png"),
  (256, "icon_128x128@2x.png"),
  (256, "icon_256x256.png"),
  (512, "icon_256x256@2x.png"),
  (512, "icon_512x512.png"),
  (1024, "icon_512x512@2x.png"),
]
for (sz, name) in specs { renderIcon(size: sz, filename: name) }
SWIFT

iconutil -c icns "$ICONSET_DIR" -o "$RES_DIR/AppIcon.icns"
rm -rf "$(dirname "$ICONSET_DIR")"

# 2. Compile native macOS Swift app
swiftc \
  -O \
  -target arm64-apple-macosx13.0 \
  -framework AppKit \
  -framework WebKit \
  "$SCRIPT_DIR/Sources/CrackAIApp.swift" \
  -o "$MACOS_DIR/$APP_NAME"

# 3. Bundle self-contained Node app & web assets
cp "$SCRIPT_DIR/Resources/Info.plist" "$CONTENTS_DIR/Info.plist"
cp "$PROJECT_ROOT/package.json" "$APP_CODE_DIR/package.json"
cp -R "$PROJECT_ROOT/bin" "$APP_CODE_DIR/bin"
cp -R "$PROJECT_ROOT/src" "$APP_CODE_DIR/src"
cp -R "$PROJECT_ROOT/web" "$APP_CODE_DIR/web"
chmod +x "$APP_CODE_DIR/bin/crack-ai.mjs"

# 4. Ad-hoc sign bundle
codesign --force --deep --sign - "$APP_BUNDLE"

echo "✅ Built $APP_BUNDLE"
