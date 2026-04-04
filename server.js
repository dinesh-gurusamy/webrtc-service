const express = require('express');
const http = require('http');
const { Server } = require('ws');

const port = process.env.PORT || 9000;

const app = express();
const server = http.createServer(app);

// Match the path you're using in your client code: ws://localhost:9000/myapp
const wss = new Server({ server, path: '/myapp' });

// In-memory session store
// Format: sessionCode -> { hostWs, listeners, offer, iceCandidates }
const sessions = new Map();

function generateCode() {
  return Math.random().toString(36).substring(2, 6).toUpperCase(); // e.g. "A4F2"
}

wss.on('connection', (ws) => {
  let sessionCode = null;
  let role = null; // 'host' or 'listener'

  ws.on('message', (message) => {
    try {
      const msg = JSON.parse(message);
      
      if (msg.type === 'host:create') {
        role = 'host';
        sessionCode = generateCode();
        while (sessions.has(sessionCode)) {
           sessionCode = generateCode();
        }
        sessions.set(sessionCode, {
          hostWs: ws,
          listeners: new Set(),
          offer: null,
          iceCandidates: []
        });
        console.log(`[HOST] Created session: ${sessionCode}`);
        ws.send(JSON.stringify({ type: 'host:created', code: sessionCode }));
      }
      
      else if (msg.type === 'host:offer') {
        if (role !== 'host' || !sessionCode) return;
        const session = sessions.get(sessionCode);
        if (session) {
          session.offer = msg.offer;
          session.iceCandidates = msg.iceCandidates;
          console.log(`[HOST] Offer saved for session: ${sessionCode}`);
        }
      }
      
      else if (msg.type === 'listener:join') {
        role = 'listener';
        sessionCode = msg.code;
        const session = sessions.get(sessionCode);
        
        if (!session) {
          ws.send(JSON.stringify({ type: 'error', message: 'Session not found. Invalid code.' }));
          return;
        }
        
        session.listeners.add(ws);
        console.log(`[LISTENER] Joined session: ${sessionCode}`);
        ws.send(JSON.stringify({ type: 'listener:joined' }));
        
        // Immediately send the host's offer if available
        if (session.offer) {
          ws.send(JSON.stringify({ 
            type: 'listener:offer', 
            offer: session.offer, 
            iceCandidates: session.iceCandidates 
          }));
        }
      }
      
      else if (msg.type === 'listener:answer') {
        if (role !== 'listener' || !sessionCode) return;
        const session = sessions.get(sessionCode);
        if (session && session.hostWs.readyState === 1 /* OPEN */) {
          console.log(`[LISTENER] Forwarding answer to host for session: ${sessionCode}`);
          session.hostWs.send(JSON.stringify({
            type: 'host:answer',
            answer: msg.answer,
            iceCandidates: msg.iceCandidates
          }));
        }
      }
      
      else if (msg.type === 'host:close') {
        if (role !== 'host' || !sessionCode) return;
        const session = sessions.get(sessionCode);
        if (session) {
          console.log(`[HOST] Closed session: ${sessionCode}`);
          broadcastToListeners(session, { type: 'session:closed', reason: 'Host closed the session' });
          sessions.delete(sessionCode);
        }
      }

    } catch (err) {
      console.error('Failed to parse message:', err);
    }
  });

  ws.on('close', () => {
    if (sessionCode) {
      const session = sessions.get(sessionCode);
      if (session) {
        if (role === 'host') {
          console.log(`[HOST] Disconnected, closing session: ${sessionCode}`);
          broadcastToListeners(session, { type: 'session:closed', reason: 'Host disconnected' });
          sessions.delete(sessionCode);
        } else if (role === 'listener') {
          console.log(`[LISTENER] Disconnected from session: ${sessionCode}`);
          session.listeners.delete(ws);
        }
      }
    }
  });
});

function broadcastToListeners(session, payload) {
  const msg = JSON.stringify(payload);
  for (const listenerWs of session.listeners) {
    if (listenerWs.readyState === 1 /* OPEN */) {
      listenerWs.send(msg);
    }
  }
}

server.listen(port, () => {
  console.log(`Custom WebRTC Signaling Server running on port ${port}`);
  console.log(`WebSocket URL will be: ws://localhost:${port}/myapp`);
});
