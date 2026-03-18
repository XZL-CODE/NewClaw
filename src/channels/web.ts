/**
 * WebChannel — Browser-based chat GUI with WebSocket real-time communication.
 *
 * Built-in Express HTTP server serves a single-page chat interface.
 * WebSocket (ws) handles bidirectional streaming between browser and NewClaw.
 */

import express from 'express';
import { createServer, type Server } from 'http';
import { WebSocketServer, type WebSocket } from 'ws';
import { randomUUID } from 'crypto';
import type { ChannelAdapter, NewClawEvent } from '../types/index.js';
import { logger } from '../core/logger.js';

interface WSClient {
  ws: WebSocket;
  id: string;
}

export class WebChannel implements ChannelAdapter {
  readonly name = 'web';
  private app = express();
  private server: Server | null = null;
  private wss: WebSocketServer | null = null;
  private handler: ((event: NewClawEvent) => void) | null = null;
  private clients = new Map<string, WSClient>();
  private port: number;

  constructor(port: number = 3210) {
    this.port = port;
  }

  async connect(): Promise<void> {
    // Serve the chat HTML page
    this.app.get('/', (_req, res) => {
      res.type('html').send(CHAT_HTML);
    });

    this.server = createServer(this.app);
    this.wss = new WebSocketServer({ server: this.server });

    this.wss.on('connection', (ws) => {
      const clientId = randomUUID();
      this.clients.set(clientId, { ws, id: clientId });
      logger.info('WebChannel', `Client connected: ${clientId}`);

      ws.on('message', (raw) => {
        try {
          const data = JSON.parse(String(raw));
          if (data.type === 'message' && data.text && this.handler) {
            const event: NewClawEvent = {
              id: randomUUID(),
              source: 'user',
              channel: 'web',
              timestamp: Date.now(),
              data: {
                text: data.text,
                clientId,
              },
              priority: 'normal',
            };
            this.handler(event);
          }
        } catch {
          logger.warn('WebChannel', `Invalid message from ${clientId}`);
        }
      });

      ws.on('close', () => {
        this.clients.delete(clientId);
        logger.info('WebChannel', `Client disconnected: ${clientId}`);
      });
    });

    return new Promise((resolve) => {
      this.server!.listen(this.port, () => {
        logger.info('WebChannel', `Web GUI running at http://localhost:${this.port}`);
        resolve();
      });
    });
  }

  async disconnect(): Promise<void> {
    for (const [, client] of this.clients) {
      client.ws.close();
    }
    this.clients.clear();

    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  async sendMessage(to: string, content: string): Promise<void> {
    const msg = JSON.stringify({ type: 'message', content });

    if (to === '*') {
      // Broadcast to all clients
      for (const [, client] of this.clients) {
        if (client.ws.readyState === 1) client.ws.send(msg);
      }
    } else {
      // Send to specific client
      const client = this.clients.get(to);
      if (client && client.ws.readyState === 1) {
        client.ws.send(msg);
      } else {
        // Fallback: broadcast if client not found
        for (const [, c] of this.clients) {
          if (c.ws.readyState === 1) c.ws.send(msg);
        }
      }
    }
  }

  /** Send a tool status update to all connected clients. */
  sendToolStatus(tool: string, status: 'running' | 'done' | 'error'): void {
    const msg = JSON.stringify({ type: 'tool_status', tool, status });
    for (const [, client] of this.clients) {
      if (client.ws.readyState === 1) client.ws.send(msg);
    }
  }

  /** Send a streaming text chunk to all connected clients. */
  sendStreamChunk(chunk: string): void {
    const msg = JSON.stringify({ type: 'stream', chunk });
    for (const [, client] of this.clients) {
      if (client.ws.readyState === 1) client.ws.send(msg);
    }
  }

  onMessage(handler: (event: NewClawEvent) => void): void {
    this.handler = handler;
  }
}

// ─── Inline Chat HTML ───────────────────────────────────────────

const CHAT_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>NewClaw</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #1a1a2e;
    color: #e0e0e0;
    height: 100vh;
    display: flex;
    flex-direction: column;
  }
  header {
    background: #16213e;
    padding: 12px 20px;
    border-bottom: 1px solid #2a2a4a;
    display: flex;
    align-items: center;
    gap: 10px;
  }
  header h1 {
    font-size: 18px;
    font-weight: 600;
    color: #64ffda;
  }
  header .status {
    font-size: 12px;
    color: #888;
  }
  header .status.connected { color: #4caf50; }
  #messages {
    flex: 1;
    overflow-y: auto;
    padding: 20px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .msg {
    max-width: 75%;
    padding: 10px 14px;
    border-radius: 16px;
    line-height: 1.5;
    font-size: 14px;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .msg.user {
    align-self: flex-end;
    background: #0f3460;
    color: #e0e0e0;
    border-bottom-right-radius: 4px;
  }
  .msg.assistant {
    align-self: flex-start;
    background: #2a2a4a;
    color: #e0e0e0;
    border-bottom-left-radius: 4px;
  }
  .msg.tool-status {
    align-self: flex-start;
    background: transparent;
    color: #888;
    font-size: 12px;
    padding: 4px 14px;
    font-style: italic;
  }
  .msg.tool-status.done { color: #4caf50; }
  .msg.tool-status.error { color: #ef5350; }
  #input-area {
    padding: 12px 20px;
    background: #16213e;
    border-top: 1px solid #2a2a4a;
    display: flex;
    gap: 10px;
  }
  #input-area textarea {
    flex: 1;
    background: #1a1a2e;
    border: 1px solid #2a2a4a;
    border-radius: 12px;
    color: #e0e0e0;
    padding: 10px 14px;
    font-size: 14px;
    font-family: inherit;
    resize: none;
    outline: none;
    min-height: 44px;
    max-height: 120px;
  }
  #input-area textarea:focus { border-color: #64ffda; }
  #input-area button {
    background: #64ffda;
    color: #1a1a2e;
    border: none;
    border-radius: 12px;
    padding: 0 20px;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    transition: opacity 0.2s;
  }
  #input-area button:hover { opacity: 0.85; }
  #input-area button:disabled { opacity: 0.4; cursor: default; }
  #messages::-webkit-scrollbar { width: 6px; }
  #messages::-webkit-scrollbar-track { background: transparent; }
  #messages::-webkit-scrollbar-thumb { background: #2a2a4a; border-radius: 3px; }
</style>
</head>
<body>
  <header>
    <h1>NewClaw</h1>
    <span id="status" class="status">Connecting...</span>
  </header>
  <div id="messages"></div>
  <div id="input-area">
    <textarea id="input" placeholder="Type a message..." rows="1"></textarea>
    <button id="send" disabled>Send</button>
  </div>
<script>
(function() {
  const msgs = document.getElementById('messages');
  const input = document.getElementById('input');
  const sendBtn = document.getElementById('send');
  const statusEl = document.getElementById('status');
  let ws, streamEl = null;

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(proto + '//' + location.host);

    ws.onopen = () => {
      statusEl.textContent = 'Connected';
      statusEl.className = 'status connected';
      sendBtn.disabled = false;
    };

    ws.onclose = () => {
      statusEl.textContent = 'Disconnected — reconnecting...';
      statusEl.className = 'status';
      sendBtn.disabled = true;
      setTimeout(connect, 2000);
    };

    ws.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type === 'message') {
          finishStream();
          addMsg('assistant', data.content);
        } else if (data.type === 'stream') {
          if (!streamEl) {
            streamEl = addMsg('assistant', '');
          }
          streamEl.textContent += data.chunk;
          scrollDown();
        } else if (data.type === 'tool_status') {
          finishStream();
          const cls = data.status === 'done' ? 'done' : data.status === 'error' ? 'error' : '';
          const icon = data.status === 'running' ? '⏳' : data.status === 'done' ? '✓' : '✗';
          addMsg('tool-status' + (cls ? ' ' + cls : ''), icon + ' ' + data.tool + '...');
        }
      } catch {}
    };
  }

  function finishStream() { streamEl = null; }

  function addMsg(cls, text) {
    const el = document.createElement('div');
    el.className = 'msg ' + cls;
    el.textContent = text;
    msgs.appendChild(el);
    scrollDown();
    return el;
  }

  function scrollDown() {
    msgs.scrollTop = msgs.scrollHeight;
  }

  function send() {
    const text = input.value.trim();
    if (!text || !ws || ws.readyState !== 1) return;
    addMsg('user', text);
    ws.send(JSON.stringify({ type: 'message', text }));
    input.value = '';
    input.style.height = 'auto';
  }

  sendBtn.addEventListener('click', send);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  });

  connect();
})();
</script>
</body>
</html>`;
