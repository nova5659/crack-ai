import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const WORKSPACE_ROOT = path.resolve(PROJECT_ROOT, '..');
const OUTPUT_DIR = process.env.CRACK_WIN_OUT
  ? path.resolve(process.env.CRACK_WIN_OUT)
  : path.join(WORKSPACE_ROOT, 'CrackAI-Windows');

const ELECTRON_VERSION = process.env.CRACK_ELECTRON_VERSION || 'v45.4.1';
const ELECTRON_ZIP_NAME = `electron-${ELECTRON_VERSION}-win32-x64.zip`;
const ELECTRON_URL = `https://github.com/electron/electron/releases/download/${ELECTRON_VERSION}/${ELECTRON_ZIP_NAME}`;

const CACHE_DIR = path.join(os.homedir(), '.cache', 'crack-ai-win');
const CACHED_ZIP = path.join(CACHE_DIR, ELECTRON_ZIP_NAME);
const TOOLS_DIR = path.join(CACHE_DIR, 'tools');
const ICON_PATH = path.join(__dirname, 'icon.ico');

const ICON_SIZES = [16, 32, 48, 64, 128, 256];

function packPngsToIco(pngBuffers) {
  const count = pngBuffers.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // Reserved
  header.writeUInt16LE(1, 2); // Type: 1 = ICO
  header.writeUInt16LE(count, 4);

  const dirEntries = [];
  let offset = 6 + count * 16;

  for (const { size, buf } of pngBuffers) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0); // Width (0 = 256)
    entry.writeUInt8(size >= 256 ? 0 : size, 1); // Height (0 = 256)
    entry.writeUInt8(0, 2); // Color palette
    entry.writeUInt8(0, 3); // Reserved
    entry.writeUInt16LE(1, 4); // Color planes
    entry.writeUInt16LE(32, 6); // Bits per pixel
    entry.writeUInt32LE(buf.length, 8); // Image data size
    entry.writeUInt32LE(offset, 12); // Offset to PNG bytes
    dirEntries.push(entry);
    offset += buf.length;
  }

  return Buffer.concat([header, ...dirEntries, ...pngBuffers.map((p) => p.buf)]);
}

function generateWindowsIcon() {
  console.log('🎨 Generating multi-resolution Windows icon.ico...');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crack-win-icon-'));
  try {
    const swiftCode = `
import AppKit
import Foundation

let outDir = CommandLine.arguments[1]

func renderIcon(size: Int) {
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
    NSColor(calibratedRed: 0.04, green: 0.04, blue: 0.04, alpha: 1.0),
    NSColor(calibratedRed: 0.09, green: 0.06, blue: 0.14, alpha: 1.0),
    NSColor(calibratedRed: 0.0, green: 0.0, blue: 0.0, alpha: 1.0),
  ])!
  bgGrad.draw(in: bgPath, angle: -45)

  let ringRect = rect.insetBy(dx: s * 0.18, dy: s * 0.18)
  let ringPath = NSBezierPath(ovalIn: ringRect)
  ringPath.lineWidth = max(1.5, s * 0.036)
  NSColor(calibratedRed: 0.65, green: 0.35, blue: 0.98, alpha: 0.34).setStroke()
  ringPath.stroke()

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

  let dotRect = NSRect(x: s * 0.68, y: s * 0.69, width: s * 0.075, height: s * 0.075)
  NSColor(calibratedRed: 0.92, green: 0.52, blue: 0.98, alpha: 0.95).setFill()
  NSBezierPath(ovalIn: dotRect).fill()

  NSGraphicsContext.restoreGraphicsState()
  let png = rep.representation(using: .png, properties: [:])!
  try! png.write(to: URL(fileURLWithPath: "\\(outDir)/icon_\\(size).png"))
}

for sz in [16, 32, 48, 64, 128, 256] { renderIcon(size: sz) }
`;
    execFileSync('swift', ['-', tmpDir], { input: swiftCode, stdio: ['pipe', 'inherit', 'inherit'] });
    const pngs = ICON_SIZES.map((size) => ({
      size,
      buf: fs.readFileSync(path.join(tmpDir, `icon_${size}.png`)),
    }));
    const icoBuf = packPngsToIco(pngs);
    fs.writeFileSync(ICON_PATH, icoBuf);
    console.log(`✅ Created ${ICON_PATH} (${(icoBuf.length / 1024).toFixed(1)} KB)`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function ensureElectronZip() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  if (fs.existsSync(CACHED_ZIP) && fs.statSync(CACHED_ZIP).size > 50_000_000) {
    console.log(`📦 Using cached Electron Win64 runtime: ${CACHED_ZIP}`);
    return;
  }
  console.log(`⬇️ Downloading official Electron ${ELECTRON_VERSION} (win32-x64)...`);
  const tmpZip = `${CACHED_ZIP}.part`;
  execFileSync('curl', ['-fL', '--retry', '3', '-o', tmpZip, ELECTRON_URL], { stdio: 'inherit' });
  fs.renameSync(tmpZip, CACHED_ZIP);
  console.log(`✅ Downloaded ${CACHED_ZIP}`);
}

function ensureReseditTool() {
  fs.mkdirSync(TOOLS_DIR, { recursive: true });
  const reseditPkg = path.join(TOOLS_DIR, 'node_modules', 'resedit', 'package.json');
  if (fs.existsSync(reseditPkg)) return;
  console.log('🔧 Installing pure-JS PE resource patcher (resedit) in build cache...');
  const pkgJson = path.join(TOOLS_DIR, 'package.json');
  if (!fs.existsSync(pkgJson)) {
    fs.writeFileSync(pkgJson, JSON.stringify({ name: 'crack-win-tools', private: true }, null, 2));
  }
  execFileSync('npm', ['install', '--no-audit', '--no-fund', 'resedit'], {
    cwd: TOOLS_DIR,
    stdio: 'inherit',
  });
}

async function patchWindowsExe(exePath, iconPath) {
  console.log('🛠️ Embedding CRACK icon & Windows PE VersionInfo into CrackAI.exe...');
  const reseditUrl = pathToFileURL(
    path.join(TOOLS_DIR, 'node_modules', 'resedit', 'dist', 'index.js')
  ).href;
  const ResEdit = await import(reseditUrl);

  const exeData = fs.readFileSync(exePath);
  const exe = ResEdit.NtExecutable.from(exeData, { ignoreCert: true });
  const res = ResEdit.NtExecutableResource.from(exe);

  // Replace default Electron icon with CRACK icon.ico
  const iconFile = ResEdit.Data.IconFile.from(fs.readFileSync(iconPath));
  const iconGroups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
  const targetIconId = iconGroups.length > 0 ? iconGroups[0].id : 1;
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
    res.entries,
    targetIconId,
    1033,
    iconFile.icons.map((item) => item.data)
  );

  // Patch VersionInfo strings
  const viList = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
  if (viList.length > 0) {
    const vi = viList[0];
    vi.setFileVersion(1, 0, 0, 0, 1033);
    vi.setProductVersion(1, 0, 0, 0, 1033);
    vi.setStringValues(
      { lang: 1033, codepage: 1200 },
      {
        CompanyName: 'CRACK AI',
        FileDescription: 'CRACK AI - Interactive Character Chat & Webnovel Story',
        FileVersion: '1.0.0.0',
        InternalName: 'CrackAI',
        LegalCopyright: 'Copyright (C) CRACK AI',
        OriginalFilename: 'CrackAI.exe',
        ProductName: 'CRACK AI',
        ProductVersion: '1.0.0',
      }
    );
    vi.outputToResourceEntries(res.entries);
  }

  res.outputResource(exe);
  const patched = Buffer.from(exe.generate());
  fs.writeFileSync(exePath, patched);
  console.log(`✅ Patched ${exePath} (${(patched.length / 1024 / 1024).toFixed(1)} MB)`);
}

function writeWindowsReadme(outDir) {
  const readme = [
    '====================================================',
    '  CRACK AI · Windows PC 전용 실행 폴더 (64-bit)',
    '====================================================',
    '',
    '▶ 실행 방법',
    '  1. 이 폴더(CrackAI-Windows) 전체를 윈도우 PC의 원하는 위치(예: 바탕화면)에 복사하세요.',
    '     ※ 주의: CrackAI.exe 파일만 따로 빼면 실행되지 않습니다! 폴더 통째로 복사해 주세요.',
    '  2. 폴더 안의 [CrackAI.exe] 를 더블클릭하면 바로 실행됩니다.',
    '     (Node.js, Python 등 별도 프로그램 설치가 전혀 필요 없습니다!)',
    '',
    '▶ Windows 보안 경고(SmartScreen)가 뜰 경우',
    '  - 개인 제작 앱이라 최초 1회 "Windows의 PC 보호" 창이 뜰 수 있습니다.',
    '  - [추가 정보] → [실행] 버튼을 누르면 정상 실행됩니다.',
    '',
    '▶ 무료 Google Gemini API 키 연결 방법',
    '  - 앱 우측 상단 [무료 Gemini API] 또는 ⚙️ 설정 클릭',
    '  - Google AI Studio에서 발급한 무료 AIza... 키 붙여넣기 → [연결 테스트 & 저장]',
    '',
    '▶ 다크모드 / 라이트모드 전환',
    '  - 상단 헤더 및 채팅방 우측 상단의 ☀️ / 🌙 버튼으로 언제든 리얼 블랙(#000000) / 라이트 모드 전환 가능',
    '',
    '▶ 데이터 저장 위치',
    '  - 기본 저장 위치: C:\\Users\\(윈도우계정)\\.crack-ai',
    '  - USB 포터블로 쓰고 싶다면 CrackAI.exe 옆에 "portable-data" 폴더를 만들면 그 안에 저장됩니다.',
    '',
    '▶ 스마트폰(아이폰 Safari) 동시 접속',
    '  - 최초 실행 시 Windows 방화벽 허용을 누른 뒤, 앱 상단 📱(QR) 버튼을 스캔하면 같은 Wi-Fi 폰에서도 접속됩니다.',
    '',
  ].join('\r\n');

  fs.writeFileSync(path.join(outDir, '사용법_읽어주세요.txt'), `\uFEFF${readme}`, 'utf8');
}

async function main() {
  console.log(`🔨 Building CRACK AI Windows x64 App -> ${OUTPUT_DIR}`);
  generateWindowsIcon();
  ensureElectronZip();
  ensureReseditTool();

  // Clean output directory
  fs.rmSync(OUTPUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  // Extract official Electron win32-x64 runtime
  console.log('📂 Extracting Electron win32-x64 runtime...');
  execFileSync('unzip', ['-q', CACHED_ZIP, '-d', OUTPUT_DIR], { stdio: 'inherit' });

  // Rename electron.exe -> CrackAI.exe
  const oldExe = path.join(OUTPUT_DIR, 'electron.exe');
  const newExe = path.join(OUTPUT_DIR, 'CrackAI.exe');
  fs.renameSync(oldExe, newExe);

  // Remove Electron default sample app
  const defaultAsar = path.join(OUTPUT_DIR, 'resources', 'default_app.asar');
  if (fs.existsSync(defaultAsar)) fs.rmSync(defaultAsar, { force: true });

  // Patch CrackAI.exe icon & Windows metadata
  await patchWindowsExe(newExe, ICON_PATH);

  // Copy self-contained app payload into resources/app
  const appDir = path.join(OUTPUT_DIR, 'resources', 'app');
  fs.mkdirSync(appDir, { recursive: true });

  const rootPkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'));
  const electronPkg = {
    name: rootPkg.name,
    version: rootPkg.version,
    description: rootPkg.description,
    type: 'module',
    main: './windows/main.mjs',
  };
  fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify(electronPkg, null, 2), 'utf8');

  fs.cpSync(path.join(PROJECT_ROOT, 'bin'), path.join(appDir, 'bin'), { recursive: true });
  fs.cpSync(path.join(PROJECT_ROOT, 'src'), path.join(appDir, 'src'), { recursive: true });
  fs.cpSync(path.join(PROJECT_ROOT, 'web'), path.join(appDir, 'web'), { recursive: true });

  const winAppDir = path.join(appDir, 'windows');
  fs.mkdirSync(winAppDir, { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'main.mjs'), path.join(winAppDir, 'main.mjs'));
  fs.copyFileSync(path.join(__dirname, 'preload.cjs'), path.join(winAppDir, 'preload.cjs'));
  fs.copyFileSync(ICON_PATH, path.join(winAppDir, 'icon.ico'));

  writeWindowsReadme(OUTPUT_DIR);

  console.log('');
  console.log(`✅ Windows app ready: ${OUTPUT_DIR}`);
  console.log(`✅ Executable:        ${newExe}`);
}

main().catch((err) => {
  console.error('❌ Windows build failed:', err);
  process.exit(1);
});
