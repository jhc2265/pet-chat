// 펫 채팅 서버
// 역할: 같은 "코드"를 입력한 두 사람을 한 방(room)에 묶고, 서로의 메시지를 전달한다.
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

      // 한 방에는 두 명까지만
      if (room.size >= 2) {
        ws.send(JSON.stringify({ type: 'error', reason: 'full' }));
        return;
      }

      ws.roomCode = code;
      room.add(ws);
      ws.send(JSON.stringify({ type: 'joined', code }));

      // 방에 두 명이 모이면 양쪽 모두에게 "연결됨" 알림
      if (room.size === 2) {
        room.forEach((peer) =>
          peer.send(JSON.stringify({ type: 'peer-joined' }))
        );
      }
      return;
    }

    // 채팅 메시지: 같은 방의 상대에게만 전달
    if (msg.type === 'chat') {
      const room = rooms.get(ws.roomCode);
      if (!room) return;
      room.forEach((peer) => {
        if (peer !== ws && peer.readyState === WebSocket.OPEN) {
          peer.send(JSON.stringify({ type: 'chat', text: String(msg.text || '') }));
        }
      });
    }
  });

  ws.on('close', () => {
    const room = rooms.get(ws.roomCode);
    if (!room) return;
    room.delete(ws);
    room.forEach((peer) => peer.send(JSON.stringify({ type: 'peer-left' })));
    if (room.size === 0) rooms.delete(ws.roomCode);
  });
});

server.listen(PORT, () => {
  console.log(`펫 채팅 서버 실행 중 → 포트 ${PORT}`);
});
