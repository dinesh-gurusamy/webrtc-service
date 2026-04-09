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
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('AudioSheet Signaling Server — Multi-Listener Edition');
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws.sessionCode = null;
  ws.role = null;
  ws.listenerId = null;

  ws.on('message', (raw) => {
    let msg;
    try { 
      // Multi-environment safety: Ensure raw is a string
      msg = JSON.parse(raw.toString()); 
    } catch {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
      return;
    }

    switch (msg.type) {
      case 'ping':
        // Keep-alive: Server doesn't need to do anything, just received it
        break;

      // ── HOST creates a session ───────────────────────────────────────────
      case 'host:create': {
        const code = generateCode();
        sessions.set(code, { hostWs: ws, listeners: new Map() });
        ws.sessionCode = code;
        ws.role = 'host';
        ws.send(JSON.stringify({ type: 'host:created', code }));
        console.log(`[${code}] Host created session`);
        break;
      }

      // ── LISTENER joins with a code ───────────────────────────────────────
      case 'listener:join': {
        const { code } = msg;
        const session = sessions.get(code);
        if (!session) {
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid code. Session not found.' }));
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
      console.log(`[${ws.sessionCode}] Host disconnected — session removed`);
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
  console.log(`   WebSocket: ws://localhost:${PORT}`);
});