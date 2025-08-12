// server.ts
import http from "http";
import { WebSocketServer, WebSocket } from "ws";

/**
 * Types
 */

type SignalType =
  | "join"
  | "offer"
  | "answer"
  | "ice-candidate"
  | "existing-peers"
  | "new-peer"
  | "peer-left";

interface SignalMessage {
  type: SignalType | string;
  roomId?: string;
  clientId?: string;
  to?: string;
  from?: string;
  sdp?: Record<string, unknown>;
  candidate?: Record<string, unknown>;
  peers?: string[];
  [key: string]: unknown;
}

interface ExtendedWebSocket extends WebSocket {
  clientId?: string;
  roomId?: string;
  lastMessageTimestamps?: number[];
  isAlive?: boolean;
}

/**
 * Config
 */
const PORT = Number(process.env.PORT);
const RATE_LIMIT_WINDOW_MS = 1000;
const RATE_LIMIT_MAX_MSGS = 30;
const PING_INTERVAL_MS = 30000;

/**
 * Rooms: roomId -> Map(clientId -> socket)
 */
const rooms = new Map<string, Map<string, ExtendedWebSocket>>();

/**
 * Safe JSON parse
 */
function safeParse(raw: unknown): SignalMessage | null {
  try {
    return JSON.parse(raw?.toString() || "") as SignalMessage;
  } catch {
    return null;
  }
}

/**
 * Basic rate limiter per socket
 */
function allowMessage(ws: ExtendedWebSocket): boolean {
  const now = Date.now();
  if (!ws.lastMessageTimestamps) ws.lastMessageTimestamps = [];
  ws.lastMessageTimestamps = ws.lastMessageTimestamps.filter(
    (t) => now - t < RATE_LIMIT_WINDOW_MS
  );
  if (ws.lastMessageTimestamps.length >= RATE_LIMIT_MAX_MSGS) return false;
  ws.lastMessageTimestamps.push(now);
  return true;
}

/**
 * HTTP server
 */
const server = http.createServer((req, res) => {
  if (req.url === "/" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", ts: Date.now() }));
  } else {
    res.writeHead(404);
    res.end();
  }
});

/**
 * WebSocket server
 */
const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (wsRaw) => {
  const ws = wsRaw as ExtendedWebSocket;
  ws.isAlive = true;

  ws.on("pong", () => {
    ws.isAlive = true;
  });

  ws.on("message", (raw) => {
    if (!allowMessage(ws)) {
      ws.send(JSON.stringify({ type: "error", message: "rate limit exceeded" }));
      ws.close(1008, "rate limit");
      return;
    }

    const msg = safeParse(raw);
    if (!msg) return;

    switch (msg.type) {
      case "join": {
        const { roomId, clientId } = msg;
        if (!roomId || !clientId) {
          ws.send(JSON.stringify({ type: "error", message: "join requires roomId and clientId" }));
          return;
        }

        ws.clientId = clientId;
        ws.roomId = roomId;

        if (!rooms.has(roomId)) rooms.set(roomId, new Map());
        const room = rooms.get(roomId)!;

        ws.send(JSON.stringify({ type: "existing-peers", peers: Array.from(room.keys()) }));

        room.forEach((peer) => {
          if (peer.readyState === WebSocket.OPEN) {
            peer.send(JSON.stringify({ type: "new-peer", clientId }));
          }
        });

        room.set(clientId, ws);
        console.log(`Client ${clientId} joined room ${roomId}`);
        break;
      }

      case "offer":
      case "answer":
      case "ice-candidate": {
        const { to } = msg;
        const roomId = ws.roomId;
        if (!roomId || !to) return;
        const room = rooms.get(roomId);
        const target = room?.get(to);
        if (target?.readyState === WebSocket.OPEN) {
          target.send(JSON.stringify({ ...msg, from: ws.clientId }));
        }
        break;
      }

      default:
        console.debug("Unknown message type:", msg.type);
    }
  });

  ws.on("close", () => {
    const { roomId, clientId } = ws;
    if (!roomId || !clientId) return;

    const room = rooms.get(roomId);
    room?.delete(clientId);

    room?.forEach((peer) => {
      if (peer.readyState === WebSocket.OPEN) {
        peer.send(JSON.stringify({ type: "peer-left", clientId }));
      }
    });

    if (room?.size === 0) rooms.delete(roomId);
    console.log(`Client ${clientId} left room ${roomId}`);
  });
});

/**
 * Upgrade to WebSocket
 */
server.on("upgrade", (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

/**
 * Keepalive ping/pong
 */
const pingInterval = setInterval(() => {
  wss.clients.forEach((client) => {
    const c = client as ExtendedWebSocket;
    if (!c.isAlive) return c.terminate();
    c.isAlive = false;
    c.ping();
  });
}, PING_INTERVAL_MS);

/**
 * Start server
 */
server.listen(PORT, () => {
  console.log(` after cahnging----HTTP+WebSocket signaling server running on port ${PORT}`);
});

/**
 * Graceful shutdown
 */
function shutdown() {
  clearInterval(pingInterval);
  wss.close(() => server.close(() => process.exit(0)));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
