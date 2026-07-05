// 펫 채팅 서버
// 역할: 같은 "코드"를 입력한 사람들을 한 방(room)에 묶고, 서로의 메시지를 전달한다.
//       (여러 명 = 단체 채팅 지원, 각자 닉네임)
// 실행: node server.js  (기본 포트 8080)

const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;

// 클라우드(Render 등)가 "서버 살아있나?" 확인할 때 응답할 간단한 웹 페이지.
// 브라우저로 서버 주소를 열면 이 메시지가 보이면 정상.
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('펫 채팅 서버 작동 중 🐥');
});

const wss = new WebSocket.Server({ server });

// code -> Set<socket>  : 코드별로 접속한 사람들
const rooms = new Map();
const MAX_PER_ROOM = 30; // 한 방 최대 인원 (안전장치)

// 방의 현재 접속자(이름+상태) 목록을 모두에게 알림 (입장/퇴장 정보 포함)
function broadcastRoster(room, extra) {
  const members = [...room].map((s) => ({
    name: s.nickname || '익명',
    status: s.userStatus || ''
  }));
  const payload = JSON.stringify({ type: 'roster', members, ...extra });
  room.forEach((s) => {
    if (s.readyState === WebSocket.OPEN) s.send(payload);
  });
}

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // 방에 입장
    if (msg.type === 'join') {
      const code = String(msg.code || '').toUpperCase().trim();
      if (!code) return;

      if (!rooms.has(code)) rooms.set(code, new Set());
      const room = rooms.get(code);

      if (room.size >= MAX_PER_ROOM) {
        ws.send(JSON.stringify({ type: 'error', reason: 'full' }));
        return;
      }

      ws.roomCode = code;
      ws.nickname = String(msg.nickname || '익명').slice(0, 20);
      ws.userStatus = String(msg.status || '').slice(0, 20);
      room.add(ws);

      // 입장한 사람에게는 코드도 알려줌
      ws.send(JSON.stringify({ type: 'joined', code }));
      // 방 전체에 "누가 들어왔다 + 현재 명단" 알림
      broadcastRoster(room, { joined: ws.nickname });
      return;
    }

    // 상태 변경 (자리 비움 등) → 방 전체 명단 새로고침 + 누가 바꿨는지 알림
    if (msg.type === 'status') {
      ws.userStatus = String(msg.status || '').slice(0, 20);
      const room = rooms.get(ws.roomCode);
      if (room) broadcastRoster(room, {
        statusChanged: { name: ws.nickname || '익명', status: ws.userStatus }
      });
      return;
    }

    // 채팅 메시지: 같은 방의 "나 빼고 전원"에게 전달 (보낸 사람 이름 포함)
    if (msg.type === 'chat') {
      const room = rooms.get(ws.roomCode);
      if (!room) return;
      const out = JSON.stringify({
        type: 'chat',
        from: ws.nickname || '익명',
        text: String(msg.text || '')
      });
      room.forEach((peer) => {
        if (peer !== ws && peer.readyState === WebSocket.OPEN) peer.send(out);
      });
    }
  });

  ws.on('close', () => {
    const room = rooms.get(ws.roomCode);
    if (!room) return;
    room.delete(ws);
    if (room.size === 0) {
      rooms.delete(ws.roomCode);
    } else {
      broadcastRoster(room, { left: ws.nickname || '익명' });
    }
  });
});

server.listen(PORT, () => {
  console.log(`펫 채팅 서버 실행 중 → 포트 ${PORT}`);
});
