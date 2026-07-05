// Electron 본체 (main 프로세스)
// - 펫 창과 채팅 창을 만든다
// - 서버(WebSocket)와의 연결을 여기서 관리하고, 두 창에 결과를 전달한다

const { app, BrowserWindow, ipcMain, screen, dialog, globalShortcut, Menu } = require('electron');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

// 인터넷(Render)에 올린 서버 주소. 이제 어디서든 이 서버를 통해 친구랑 연결됨.
// (내 컴퓨터에서 테스트하려면 ws://localhost:8080 으로 바꾸면 됨)
const SERVER_URL = process.env.SERVER_URL || 'wss://chatchat-gspa.onrender.com';

let petWindow = null;
let chatWindow = null;
let pickerWindow = null;
let quickWindow = null;
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

// 현재 펫이 무엇인지 결정: 사용자 이미지 > 기본 캐릭터(이모지) > 기본값 🐥
function currentPet() {
  const s = readSettings();
  if (s.petImagePath) {
    const dataUrl = imageToDataUrl(s.petImagePath);
    if (dataUrl) return { type: 'image', dataUrl };
  }
  return { type: 'char', char: s.petChar || '🐥' };
}

function sendPetToWindow() {
  const p = currentPet();
  if (p.type === 'image') sendTo(petWindow, 'set-pet-image', { dataUrl: p.dataUrl });
  else sendTo(petWindow, 'set-pet-char', { char: p.char });
}

// 펫 아래 이름표(+상태) 업데이트
function sendMyInfo() {
  const s = readSettings();
  sendTo(petWindow, 'my-info', { nickname: s.nickname || '', status: s.status || '' });
}

// ── 전역 단축키 ─────────────────────────────────────────
let currentHotkey = null;

// 단축키 → 피그마 커서챗처럼 "빠른 입력바"를 띄운다
function hotkeyPressed() {
  if (!quickWindow) return;
  if (quickWindow.isVisible()) {
    quickWindow.hide();
  } else {
    quickWindow.show();
    quickWindow.focus();
    sendTo(quickWindow, 'focus-quick');
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

function prettyAccel(a) {
  return a ? a.replace('Control', 'Ctrl').replace('Super', 'Win') : '(없음)';
}
function prettyKey(k) {
  return (!k || k === 'Escape') ? 'Esc' : k;
}

// 빠른 입력바 "닫기 키" 지정 시작 (창에서 다음 키 입력을 받음)
function startQuickCloseCapture() {
  if (!quickWindow) return;
  quickWindow.show();
  quickWindow.focus();
  sendTo(quickWindow, 'start-quickclose-capture');
}

// ── 상단 메뉴바 (꾸미기 / 설정) ──────────────────────────
function setPref(key, val) {
  const s = readSettings();
  s[key] = val;
  writeSettings(s);
  // 글꼴/테마 설정을 모든 창(채팅·펫·빠른바)에 전달
  broadcast('prefs', {
    theme: s.theme || 'pink', font: s.font || 'pretendard', size: s.size || 'medium'
  });
  buildMenu(); // 라디오 체크 표시 갱신
}

function startHotkeyCapture() {
  if (!chatWindow) return;
  chatWindow.show();
  chatWindow.focus();
  sendTo(chatWindow, 'start-hotkey-capture');
}

function buildMenu() {
  const s = readSettings();
  const theme = s.theme || 'pink', font = s.font || 'pretendard', size = s.size || 'medium';
  const radio = (cur, val, label, pref) => ({
    label, type: 'radio', checked: cur === val, click: () => setPref(pref, val)
  });

  const template = [
    { label: '꾸미기', submenu: [
      { label: '테마', submenu: [
        radio(theme, 'pink', '핑크', 'theme'),
        radio(theme, 'dark', '다크', 'theme'),
        radio(theme, 'blue', '블루', 'theme'),
        radio(theme, 'mint', '민트', 'theme'),
        radio(theme, 'yellow', '노랑', 'theme'),
      ]},
      { label: '글꼴', submenu: [
        radio(font, 'pretendard', '프리텐다드', 'font'),
        radio(font, 'paperlogy', '페이퍼로지', 'font'),
        radio(font, 'freesentation', '프리젠테이션', 'font'),
        radio(font, 'nanumsquare', '나눔스퀘어', 'font'),
        radio(font, 'a2z', '에이투지', 'font'),
        { type: 'separator' },
        radio(font, 'malgun', '맑은 고딕', 'font'),
        radio(font, 'gulim', '굴림', 'font'),
        radio(font, 'dotum', '돋움', 'font'),
        radio(font, 'batang', '바탕', 'font'),
        radio(font, 'gungsuh', '궁서', 'font'),
        radio(font, 'consolas', 'Consolas', 'font'),
      ]},
      { label: '글자 크기', submenu: [
        radio(size, 'small', '작게', 'size'),
        radio(size, 'medium', '보통', 'size'),
        radio(size, 'large', '크게', 'size'),
      ]},
    ]},
    { label: '설정', submenu: [
      { label: `빠른입력바 열기: ${prettyAccel(currentHotkey)}`, enabled: false },
      { label: '열기 단축키 변경…', click: startHotkeyCapture },
      { type: 'separator' },
      { label: `빠른입력바 닫기 키: ${prettyKey(s.quickCloseKey || 'Escape')}`, enabled: false },
      { label: '닫기 키 변경…', click: startQuickCloseCapture },
      { type: 'separator' },
      { label: '종료', click: () => { app.isQuitting = true; app.quit(); } },
    ]},
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function sendTo(win, channel, data) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, data);
}
function broadcast(channel, data) {
  sendTo(petWindow, channel, data);
  sendTo(chatWindow, channel, data);
  sendTo(quickWindow, channel, data);
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

  ws.on('open', () => ws.send(JSON.stringify({
    type: 'join', code,
    nickname: readSettings().nickname || '익명',
    status: readSettings().status || ''
  })));

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'joined') {
      broadcast('status', { state: 'joined', code });
    } else if (msg.type === 'roster') {
      // 현재 접속자 명단 + 방금 들어오거나 나간 사람
      broadcast('roster', { members: msg.members, joined: msg.joined, left: msg.left });
      // 다른 사람이 상태를 바꾸면 내 펫이 말풍선으로 알림 (내 것은 아래에서 따로 처리)
      const sc = msg.statusChanged;
      if (sc && sc.name !== (readSettings().nickname || '익명')) {
        sendTo(petWindow, 'pet-say', { text: sc.status ? `${sc.name}: ${sc.status}` : `${sc.name}: 💬 대화가능` });
      }
    } else if (msg.type === 'chat') {
      broadcast('chat-in', { from: msg.from, text: msg.text });
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
    width: 200, height: 240,
    x: width - 240, y: 120,
    frame: false, transparent: true, resizable: false,
    alwaysOnTop: true, skipTaskbar: true,
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });
  petWindow.loadFile('pet.html');

  // 드래그 영역을 오른쪽 클릭하면 뜨는 윈도우 시스템 메뉴를 가로채 우리 메뉴로 대체
  petWindow.on('system-context-menu', (e) => {
    e.preventDefault();
    popupPetMenu();
  });

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

  // 빠른 입력바(피그마 커서챗 스타일): 단축키로 화면 아래 중앙에 뜸
  quickWindow = new BrowserWindow({
    width: 440, height: 96,
    x: Math.round((width - 440) / 2), y: screen.getPrimaryDisplay().workAreaSize.height - 190,
    frame: false, transparent: true, resizable: false, alwaysOnTop: true,
    skipTaskbar: true, show: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });
  quickWindow.loadFile('quick.html');
  quickWindow.on('close', (e) => {
    if (!app.isQuitting) { e.preventDefault(); quickWindow.hide(); }
  });
}

// 단일 실행 잠금: 이미 실행 중이면 새 창을 띄우지 않고 종료 (펫이 2개 뜨는 것 방지)
const gotSingleLock = app.requestSingleInstanceLock();
if (!gotSingleLock) {
  app.quit();
} else {
  // 이미 켜져 있는데 또 실행하면 → 새로 안 띄우고 기존 펫을 보여줌
  app.on('second-instance', () => {
    if (petWindow) { if (petWindow.isMinimized()) petWindow.restore(); petWindow.show(); }
  });

  app.whenReady().then(() => {
    createWindows();
    registerHotkey(readSettings().hotkey || 'Control+Shift+C');
    buildMenu();
  });
}

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

function toggleChat() {
  if (!chatWindow) return;
  if (chatWindow.isVisible()) chatWindow.hide();
  else { chatWindow.show(); chatWindow.focus(); sendTo(chatWindow, 'focus-input'); }
}
ipcMain.on('toggle-chat', toggleChat);

ipcMain.on('hide-chat', () => { if (chatWindow) chatWindow.hide(); });
ipcMain.on('hide-quick', () => { if (quickWindow) quickWindow.hide(); });

// 빠른 입력바 닫기 키 불러오기/저장
ipcMain.on('get-quick-close', (e) => {
  e.sender.send('quick-close-key', { key: readSettings().quickCloseKey || 'Escape' });
});
ipcMain.on('set-quick-close', (e, key) => {
  const s = readSettings();
  s.quickCloseKey = key;
  writeSettings(s);
  sendTo(quickWindow, 'quick-close-key', { key });
  buildMenu(); // 메뉴 라벨 갱신
});

// 닉네임 저장/불러오기
ipcMain.on('get-nickname', (e) => {
  e.sender.send('nickname', { nickname: readSettings().nickname || '' });
});
ipcMain.on('set-nickname', (e, nickname) => {
  const s = readSettings();
  s.nickname = String(nickname || '').slice(0, 20);
  writeSettings(s);
  sendMyInfo(); // 펫 이름표 갱신
});

// 상태(자리비움 등) 저장 + 접속 중이면 서버에 알림 + 내 펫이 말풍선으로 표시
function applyStatus(status) {
  const s = readSettings();
  s.status = String(status || '').slice(0, 20);
  writeSettings(s);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'status', status: s.status }));
  }
  sendTo(petWindow, 'pet-say', { text: s.status ? s.status : '💬 대화가능' });
  sendMyInfo();
}
ipcMain.on('set-status', (e, status) => {
  const s = readSettings();
  s.status = String(status || '').slice(0, 20);
  writeSettings(s);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'status', status: s.status }));
  }
  sendTo(petWindow, 'pet-say', { text: s.status ? s.status : '💬 대화가능' });
  sendMyInfo(); // 펫 아래 이름표(+상태) 갱신
});
ipcMain.on('get-status', (e) => {
  e.sender.send('status-now', { status: readSettings().status || '' });
});

// 테마/글꼴 설정 저장/불러오기 (내 화면에만 적용)
ipcMain.on('get-prefs', (e) => {
  const s = readSettings();
  e.sender.send('prefs', {
    theme: s.theme || 'pink',
    font: s.font || 'pretendard',
    size: s.size || 'medium'
  });
});
ipcMain.on('set-prefs', (e, p) => {
  const s = readSettings();
  if (p.theme) s.theme = p.theme;
  if (p.font) s.font = p.font;
  if (p.size) s.size = p.size;
  writeSettings(s);
});

// 채팅창이 현재 단축키를 물어봄
ipcMain.on('get-hotkey', (e) => {
  e.sender.send('hotkey-status', { accel: currentHotkey, ok: true });
});

// 사용자가 새 단축키를 지정함
ipcMain.on('set-hotkey', (e, accel) => {
  const ok = registerHotkey(accel);
  if (ok) { const s = readSettings(); s.hotkey = accel; writeSettings(s); }
  e.sender.send('hotkey-status', { accel: currentHotkey, ok, tried: accel });
  buildMenu(); // 메뉴의 단축키 표시 갱신
});

ipcMain.on('quit-app', () => {
  app.isQuitting = true;
  app.quit();
});

// 펫 창이 준비되면 저장돼 있던 펫(이미지/캐릭터)과 내 이름표를 보여준다
ipcMain.on('pet-ready', () => {
  sendPetToWindow();
  sendMyInfo();
});

// 펫 오른쪽 클릭 메뉴 (종료·채팅·캐릭터·상태를 여기서 바로)
function popupPetMenu() {
  if (!petWindow) return;
  const menu = Menu.buildFromTemplate([
    { label: '💬 채팅 열기 / 닫기', click: toggleChat },
    { label: '🖼️ 캐릭터 변경…', click: openPicker },
    { label: '상태 바꾸기', submenu: [
      { label: '💬 대화가능', click: () => applyStatus('') },
      { label: '💤 자리비움', click: () => applyStatus('💤 자리비움') },
      { label: '🍚 밥먹자', click: () => applyStatus('🍚 밥먹자') },
      { label: '🎮 게임중', click: () => applyStatus('🎮 게임중') },
    ]},
    { type: 'separator' },
    { label: '❌ 프로그램 종료', click: () => { app.isQuitting = true; app.quit(); } },
  ]);
  menu.popup({ window: petWindow });
}
ipcMain.on('show-pet-menu', popupPetMenu);

// 펫의 "캐릭터" 버튼 → 캐릭터 선택창 열기
function openPicker() {
  if (pickerWindow && !pickerWindow.isDestroyed()) { pickerWindow.show(); pickerWindow.focus(); return; }
  pickerWindow = new BrowserWindow({
    width: 340, height: 400, resizable: false, title: '캐릭터 선택',
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });
  pickerWindow.loadFile('picker.html');
  pickerWindow.on('closed', () => { pickerWindow = null; });
}
ipcMain.on('open-picker', openPicker);

// 기본 캐릭터(이모지) 선택 → 저장하고 펫에 적용
ipcMain.on('set-default-char', (e, char) => {
  const s = readSettings();
  s.petChar = char;
  delete s.petImagePath;       // 커스텀 이미지는 해제
  writeSettings(s);
  sendTo(petWindow, 'set-pet-char', { char });
  if (pickerWindow && !pickerWindow.isDestroyed()) pickerWindow.close();
});

// 내 컴퓨터 이미지 선택 → 파일 선택창 → 펫으로 적용
ipcMain.on('choose-pet-image', async () => {
  const res = await dialog.showOpenDialog(pickerWindow || undefined, {
    title: '펫으로 쓸 이미지 고르기',
    properties: ['openFile'],
    filters: [{ name: '이미지 (PNG, GIF, JPG, WEBP)', extensions: ['png', 'gif', 'jpg', 'jpeg', 'webp'] }]
  });
  if (res.canceled || !res.filePaths[0]) return;

  const dataUrl = imageToDataUrl(res.filePaths[0]);
  if (!dataUrl) return;

  const s = readSettings();
  s.petImagePath = res.filePaths[0];
  delete s.petChar;            // 기본 캐릭터 설정은 해제
  writeSettings(s);
  sendTo(petWindow, 'set-pet-image', { dataUrl });
  if (pickerWindow && !pickerWindow.isDestroyed()) pickerWindow.close();
});
