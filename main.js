// Electron 본체 (main 프로세스)
// - 펫 창과 채팅 창을 만든다
// - 서버(WebSocket)와의 연결을 여기서 관리하고, 두 창에 결과를 전달한다

const { app, BrowserWindow, ipcMain, screen, dialog, globalShortcut } = require('electron');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

// 지금은 내 컴퓨터(localhost) 서버에 연결.
// 나중에 친구랑 진짜로 쓰려면 여기 주소만 실제 서버 주소로 바꾸면 됨.
const SERVER_URL = process.env.SERVER_URL || 'ws://localhost:8080';

let petWindow = null;
let chatWindow = null;
let ws = null;
let myCode = null;

// ── 펫 이미지 설정 저장/불러오기 ─────────────────────────
// 사용자가 고른 이미지 파일 경로를 settings.json에 저장해서 다음에 켜도 유지한다.
const settingsPath = path.join(app.getPath('userData'), 'settings.json');

function readSettings() {
  try { return JSON.parse(fs.readFileSync(settingsPath, 'utf8')); }
  catch { return {}; }
}
function writeSettings(obj) {
  try { fs.writeFileSync(settingsPath, JSON.stringify(obj, null, 2)); }
  catch {}
}

// 이미지 파일을 읽어 data URL로 만든다 (경로에 한글/공백이 있어도 안전)
function imageToDataUrl(filePath) {
  try {
    const ext = path.extname(filePath).toLowerCase();
    const mime = { '.png': 'image/png', '.gif': 'image/gif', '.jpg': 'image/jpeg',
                   '.jpeg': 'image/jpeg', '.webp': 'image/webp' }[ext];
    if (!mime) return null;
    const b64 = fs.readFileSync(filePath).toString('base64');
    return `data:${mime};base64,${b64}`;
  } catch { return null; }
}

function currentPetImage() {
  const s = readSettings();
  return s.petImagePath ? imageToDataUrl(s.petImagePath) : null;
}

// ── 전역 단축키 ─────────────────────────────────────────
let currentHotkey = null;

function hotkeyPressed() {
  if (!chatWindow) return;
  if (chatWindow.isVisible() && chatWindow.isFocused()) {
    chatWindow.hide();                 // 이미 보고 있으면 숨기기
  } else {
    chatWindow.show();
    chatWindow.focus();
    sendTo(chatWindow, 'focus-input'); // 바로 타이핑할 수 있게
  }
}

// 새 단축키 등록. 실패하면 이전 단축키를 되살린다. 성공하면 true.
function registerHotkey(accel) {
  try {
    if (currentHotkey) globalShortcut.unregister(currentHotkey);
    if (globalShortcut.register(accel, hotkeyPressed)) {
      currentHotkey = accel;
      return true;
    }
    if (currentHotkey) globalShortcut.register(currentHotkey, hotkeyPressed);
    return false;
  } catch { return false; }
}

function sendTo(win, channel, data) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, data);
}
function broadcast(channel, data) {
  sendTo(petWindow, channel, data);
  sendTo(chatWindow, channel, data);
}

function randomCode() {
  // 헷갈리는 글자(0,O,1,I 등)는 뺀 5자리 코드
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 5; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function connectServer(code) {
  if (ws) { try { ws.close(); } catch {} }
  ws = new WebSocket(SERVER_URL);

  ws.on('open', () => ws.send(JSON.stringify({ type: 'join', code })));

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'joined') {
      broadcast('status', { state: 'waiting', code });
    } else if (msg.type === 'peer-joined') {
      broadcast('status', { state: 'connected', code });
    } else if (msg.type === 'peer-left') {
      broadcast('status', { state: 'waiting', code });
    } else if (msg.type === 'chat') {
      broadcast('chat-in', { text: msg.text });
    } else if (msg.type === 'error') {
      broadcast('status', { state: 'error', reason: msg.reason });
    }
  });

  ws.on('error', () => broadcast('status', { state: 'error', reason: 'server' }));
  ws.on('close', () => broadcast('status', { state: 'disconnected' }));
}

function createWindows() {
  const { width } = screen.getPrimaryDisplay().workAreaSize;

  // 펫 창: 테두리 없고 배경 투명하며 항상 위에 떠 있는 작은 창
  petWindow = new BrowserWindow({
    width: 180, height: 200,
    x: width - 220, y: 120,
    frame: false, transparent: true, resizable: false,
    alwaysOnTop: true, skipTaskbar: true,
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });
  petWindow.loadFile('pet.html');

  // 채팅 창: 평범한 창. 처음엔 숨겨두고 펫을 눌러야 나타남
  chatWindow = new BrowserWindow({
    width: 360, height: 500,
    frame: true, resizable: true, show: false,
    title: '펫 채팅',
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });
  chatWindow.loadFile('chat.html');

  // 채팅 창 X 버튼은 종료가 아니라 숨김
  chatWindow.on('close', (e) => {
    if (!app.isQuitting) { e.preventDefault(); chatWindow.hide(); }
  });
}

app.whenReady().then(() => {
  createWindows();
  registerHotkey(readSettings().hotkey || 'Control+Shift+C');
});

app.on('will-quit', () => globalShortcut.unregisterAll());

app.on('window-all-closed', () => app.quit());

// ── 채팅 창에서 오는 요청들 ─────────────────────────────
ipcMain.on('create-code', () => {
  myCode = randomCode();
  connectServer(myCode);
});

ipcMain.on('join-code', (e, code) => {
  myCode = String(code).toUpperCase().trim();
  connectServer(myCode);
});

ipcMain.on('send-chat', (e, text) => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'chat', text }));
  }
  broadcast('chat-out', { text }); // 내 화면에 내 메시지 표시
});

ipcMain.on('toggle-chat', () => {
  if (!chatWindow) return;
  if (chatWindow.isVisible()) chatWindow.hide();
  else { chatWindow.show(); chatWindow.focus(); sendTo(chatWindow, 'focus-input'); }
});

ipcMain.on('hide-chat', () => { if (chatWindow) chatWindow.hide(); });

// 채팅창이 현재 단축키를 물어봄
ipcMain.on('get-hotkey', (e) => {
  e.sender.send('hotkey-status', { accel: currentHotkey, ok: true });
});

// 사용자가 새 단축키를 지정함
ipcMain.on('set-hotkey', (e, accel) => {
  const ok = registerHotkey(accel);
  if (ok) { const s = readSettings(); s.hotkey = accel; writeSettings(s); }
  e.sender.send('hotkey-status', { accel: currentHotkey, ok, tried: accel });
});

ipcMain.on('quit-app', () => {
  app.isQuitting = true;
  app.quit();
});

// 펫 창이 준비되면 저장돼 있던 이미지를 불러와 보여준다
ipcMain.on('pet-ready', () => {
  sendTo(petWindow, 'set-pet-image', { dataUrl: currentPetImage() });
});

// "이미지 바꾸기" 버튼 → 파일 선택창을 열고, 고른 이미지를 펫으로 적용
ipcMain.on('choose-pet-image', async () => {
  const res = await dialog.showOpenDialog({
    title: '펫으로 쓸 이미지 고르기',
    properties: ['openFile'],
    filters: [{ name: '이미지 (PNG, GIF, JPG, WEBP)', extensions: ['png', 'gif', 'jpg', 'jpeg', 'webp'] }]
  });
  if (res.canceled || !res.filePaths[0]) return;

  const filePath = res.filePaths[0];
  const dataUrl = imageToDataUrl(filePath);
  if (!dataUrl) return;

  const s = readSettings();
  s.petImagePath = filePath;
  writeSettings(s);
  sendTo(petWindow, 'set-pet-image', { dataUrl });
});
