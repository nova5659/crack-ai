import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, shell } from 'electron';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, '..');

// Support optional portable-data folder next to CrackAI.exe
try {
  const exeDir = path.dirname(app.getPath('exe'));
  const portableDir = path.join(exeDir, 'portable-data');
  if (fs.existsSync(portableDir) && !process.env.CRACK_DATA_DIR) {
    process.env.CRACK_DATA_DIR = portableDir;
  }
} catch {
  // Ignore if exe path is unavailable
}

// Import CRACK AI backend after optional CRACK_DATA_DIR setup
const { getPort, readConfig } = await import('../src/config.mjs');
const { startServer } = await import('../src/server.mjs');

let mainWindow = null;
let serverHandle = null;
let serverPort = getPort();

if (process.platform === 'win32') {
  app.setAppUserModelId('com.crackai.desktop');
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

function applyNativeTheme(theme) {
  const isLight = theme === 'light';
  nativeTheme.themeSource = isLight ? 'light' : 'dark';
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setBackgroundColor(isLight ? '#f5f5f7' : '#000000');
  }
}

async function bootEmbeddedServer() {
  const preferredPort = getPort();
  const attempts = [
    { port: preferredPort, host: '0.0.0.0' },
    { port: 0, host: '0.0.0.0' },
    { port: 0, host: '127.0.0.1' },
  ];
  let lastErr = null;
  for (const opts of attempts) {
    try {
      const started = await startServer(opts);
      serverHandle = started.server;
      serverPort = started.port;
      return started;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('로컬 CRACK AI 서버를 시작하지 못했습니다.');
}

function setupAppMenu() {
  const template = [
    {
      label: '파일',
      submenu: [
        {
          label: '새로고침',
          accelerator: 'CmdOrCtrl+R',
          click: () => mainWindow?.webContents.reload(),
        },
        {
          label: '브라우저에서 열기',
          click: () => shell.openExternal(`http://127.0.0.1:${serverPort}`),
        },
        { type: 'separator' },
        {
          label: '개발자 도구',
          accelerator: 'F12',
          click: () => mainWindow?.webContents.toggleDevTools(),
        },
        { type: 'separator' },
        { label: '종료', role: 'quit' },
      ],
    },
    {
      label: '편집',
      submenu: [
        { label: '실행 취소', role: 'undo' },
        { label: '다시 실행', role: 'redo' },
        { type: 'separator' },
        { label: '잘라내기', role: 'cut' },
        { label: '복사', role: 'copy' },
        { label: '붙여넣기', role: 'paste' },
        { label: '전체 선택', role: 'selectAll' },
      ],
    },
    {
      label: '보기',
      submenu: [
        { label: '실제 크기', role: 'resetZoom' },
        { label: '확대', role: 'zoomIn' },
        { label: '축소', role: 'zoomOut' },
        { type: 'separator' },
        { label: '전체 화면', role: 'togglefullscreen' },
      ],
    },
    {
      label: '도움말',
      submenu: [
        {
          label: 'Google AI Studio 무료 API 키 발급 ↗',
          click: () => shell.openExternal('https://aistudio.google.com/apikey'),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createMainWindow() {
  const cfg = readConfig();
  const initialTheme = cfg.theme === 'light' ? 'light' : 'dark';
  nativeTheme.themeSource = initialTheme;

  const iconPath = path.join(APP_ROOT, 'windows', 'icon.ico');
  mainWindow = new BrowserWindow({
    width: 1340,
    height: 860,
    minWidth: 440,
    minHeight: 640,
    center: true,
    show: false,
    title: 'CRACK · AI 캐릭터 챗 & 인터랙티브 스토리',
    backgroundColor: initialTheme === 'light' ? '#f5f5f7' : '#000000',
    autoHideMenuBar: true,
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  // Open external links (Google AI Studio, etc.) in default Windows browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    try {
      const parsed = new URL(url);
      const isLocal = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
      if (!isLocal) {
        event.preventDefault();
        shell.openExternal(url);
      }
    } catch {
      // Ignore malformed URLs
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.loadURL(`http://127.0.0.1:${serverPort}/`);
}

ipcMain.on('crack:set-theme', (_event, theme) => {
  applyNativeTheme(theme);
});

app.whenReady().then(async () => {
  try {
    setupAppMenu();
    await bootEmbeddedServer();
    createMainWindow();
  } catch (err) {
    dialog.showErrorBox(
      'CRACK AI 시작 오류',
      `로컬 서버를 시작하는 중 오류가 발생했습니다.\n\n${err?.message || err}`
    );
    app.quit();
  }
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', () => {
  if (serverHandle) {
    try {
      serverHandle.close();
    } catch {
      // Ignore shutdown errors
    }
    serverHandle = null;
  }
});
