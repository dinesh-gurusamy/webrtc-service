/**
 * WebRTC Signaling Server — Multi-Listener Edition
 *
 * New protocol (per-listener offer model):
 *   host:create              → host:created { code }
 *   listener:join { code }   → listener:joined { code, listenerId }
 *                              + forwards to host: listener:request { listenerId }
 *   host:offer { listenerId, offer, iceCandidates }
 *                            → routed to that listener as listener:offer { offer, iceCandidates }
 *   listener:answer { listenerId, answer, iceCandidates }
 *                            → routed to host as host:answer { listenerId, answer, iceCandidates }
 *   host:close               → session:closed to all listeners
 *   WS close (listener)      → listener:disconnected { listenerId } to host
 *
 * Run: node signalingServer.js
 * Deploy to Railway / Render / Fly.io etc.
 */

const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;

// sessions: code -> { hostWs, listeners: Map<listenerId, ws> }
const sessions = new Map();
let nextListenerId = 0;

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return sessions.has(code) ? generateCode() : code;
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status: 'ok',
    server: 'AudioSheet Signaling Server — Multi-Listener Edition',
    sessions: sessions.size,
    uptime: process.uptime(),
  }));
});

// Accept connections on /myapp path (matches client URL) and also on any path
const wss = new WebSocketServer({ server, path: '/myapp' });

// ── Server-side heartbeat: detect dead connections ──────────────────────────
const HEARTBEAT_INTERVAL = 30000; // 30 seconds
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      console.log(`[HEARTBEAT] Terminating dead connection (role: ${ws.role}, session: ${ws.sessionCode})`);
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping(); // ws library sends a native ping frame
  });
}, HEARTBEAT_INTERVAL);

wss.on('close', () => clearInterval(heartbeat));

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.sessionCode = null;
  ws.role = null;
  ws.listenerId = null;

  // Native pong response marks connection as alive
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { 
      msg = JSON.parse(raw.toString()); 
    } catch {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
      return;
    }

    // Application-level ping from client also marks alive
    if (msg.type === 'ping') {
      ws.isAlive = true;
      return;
    }

    switch (msg.type) {

      // ── HOST creates a session ───────────────────────────────────────────
      case 'host:create': {
        const code = generateCode();
        sessions.set(code, { hostWs: ws, listeners: new Map() });
        ws.sessionCode = code;
        ws.role = 'host';
        ws.send(JSON.stringify({ type: 'host:created', code }));
        console.log(`[${code}] Host created session (${sessions.size} total sessions)`);
        break;
      }

      // ── LISTENER joins with a code ───────────────────────────────────────
      case 'listener:join': {
        const code = (msg.code || '').toUpperCase();
        const session = sessions.get(code);
        if (!session) {
          console.log(`[MISS] Listener tried code "${code}" — not found. Active sessions: [${[...sessions.keys()].join(', ')}]`);
          ws.send(JSON.stringify({ type: 'error', message: 'Session not found. Invalid code.' }));
          return;
        }
        const listenerId = String(nextListenerId++);
        ws.sessionCode = code;
        ws.role = 'listener';
        ws.listenerId = listenerId;
        session.listeners.set(listenerId, ws);

        // Tell listener it joined (with its ID)
        ws.send(JSON.stringify({ type: 'listener:joined', code, listenerId }));
        console.log(`[${code}] Listener ${listenerId} joined (${session.listeners.size} total)`);

        // Tell host to create a dedicated offer for this listener
        if (session.hostWs?.readyState === 1) {
          session.hostWs.send(JSON.stringify({ type: 'listener:request', listenerId }));
          console.log(`[${code}] Forwarded listener:request to host for listener ${listenerId}`);
        } else {
          console.log(`[${code}] WARNING: Host WS not open (state: ${session.hostWs?.readyState}), cannot forward listener:request`);
        }
        break;
      }

      // ── HOST sends offer for a specific listener ─────────────────────────
      case 'host:offer': {
        const session = sessions.get(ws.sessionCode);
        if (!session) return;
        const listenerWs = session.listeners.get(msg.listenerId);
        if (listenerWs?.readyState === 1) {
          listenerWs.send(JSON.stringify({
            type: 'listener:offer',
            offer: msg.offer,
            iceCandidates: msg.iceCandidates || [],
          }));
          console.log(`[${ws.sessionCode}] Offer forwarded to listener ${msg.listenerId}`);
        } else {
          console.log(`[${ws.sessionCode}] WARNING: Listener ${msg.listenerId} WS not open, offer dropped`);
        }
        break;
      }

      // ── LISTENER sends answer ────────────────────────────────────────────
      case 'listener:answer': {
        const session = sessions.get(ws.sessionCode);
        if (!session) return;
        if (session.hostWs?.readyState === 1) {
          session.hostWs.send(JSON.stringify({
            type: 'host:answer',
            listenerId: msg.listenerId,
            answer: msg.answer,
            iceCandidates: msg.iceCandidates || [],
          }));
          console.log(`[${ws.sessionCode}] Answer from listener ${msg.listenerId} forwarded to host`);
        }
        break;
      }

      // ── HOST sends a broadcast (command) to all listeners ────────────────
      case 'host:broadcast': {
        const session = sessions.get(ws.sessionCode);
        if (!session || ws.role !== 'host') return;
        
        session.listeners.forEach((lws, lid) => {
          if (lws.readyState === 1) {
            lws.send(JSON.stringify({ 
              type: 'listener:broadcast', 
              payload: msg.payload 
            }));
          }
        });
        console.log(`[${ws.sessionCode}] Broadcast forwarded to ${session.listeners.size} listeners`);
        break;
      }

      // ── HOST ends the session ────────────────────────────────────────────
      case 'host:close': {
        const session = sessions.get(ws.sessionCode);
        if (session) {
          session.listeners.forEach((lws) => {
            if (lws.readyState === 1) lws.send(JSON.stringify({ type: 'session:closed' }));
          });
          sessions.delete(ws.sessionCode);
          console.log(`[${ws.sessionCode}] Session closed by host`);
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    if (!ws.sessionCode) return;
    const session = sessions.get(ws.sessionCode);
    if (!session) return;

    if (ws.role === 'host') {
      session.listeners.forEach((lws) => {
        if (lws.readyState === 1)
          lws.send(JSON.stringify({ type: 'session:closed', reason: 'Host disconnected' }));
      });
      sessions.delete(ws.sessionCode);
      console.log(`[${ws.sessionCode}] Host disconnected — session removed (${sessions.size} remaining)`);
    } else if (ws.role === 'listener') {
      session.listeners.delete(ws.listenerId);
      console.log(`[${ws.sessionCode}] Listener ${ws.listenerId} left (${session.listeners.size} remaining)`);
      // Notify host so it can clean up the peer connection
      if (session.hostWs?.readyState === 1) {
        session.hostWs.send(JSON.stringify({ type: 'listener:disconnected', listenerId: ws.listenerId }));
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`🚀 Signaling server running on port ${PORT}`);
  console.log(`   WebSocket: ws://localhost:${PORT}/myapp`);
  console.log(`   Health:    http://localhost:${PORT}/`);
});