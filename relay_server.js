// Street Runner 1v1 relay — pairs two players by room code and forwards
// their messages. Works worldwide because both phones connect OUT to this.
//
//   npm install && npm start
//
// Deploy free on Render / Railway / Fly.io (it just needs Node 18+ and the
// PORT env var). Use the wss:// URL it gives you as RELAY_URL in global.gd.

const http = require("http");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 8080;
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const FORWARD = new Set(["start", "ready", "prog"]); // messages relayed to the other player
const MAX_MSGS_PER_SEC = 60;

const server = http.createServer((req, res) => {
  // Health check + lets the game "wake" a sleeping free-tier host.
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("street-runner relay ok\nrooms: " + rooms.size + "\n");
});

const wss = new WebSocketServer({ server, maxPayload: 2048, perMessageDeflate: false });
const rooms = new Map(); // code -> { host, guest, seed }

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function newCode() {
  for (let tries = 0; tries < 200; tries++) {
    let c = "";
    for (let i = 0; i < 4; i++) c += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    if (!rooms.has(c)) return c;
  }
  return null;
}

function cleanName(n) {
  return String(n || "Player").replace(/[^\w ]/g, "").slice(0, 12) || "Player";
}

function leave(ws) {
  const room = ws.room;
  if (!room) return;
  ws.room = null;
  if (room.host === ws) {
    send(room.guest, { t: "peer_left" });
    if (room.guest) room.guest.room = null;
    rooms.delete(room.code);
  } else if (room.guest === ws) {
    room.guest = null;
    send(room.host, { t: "peer_left" });
  }
}

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.room = null;
  ws.msgCount = 0;
  ws.on("pong", () => (ws.isAlive = true));

  ws.on("message", (data) => {
    ws.isAlive = true;
    if (++ws.msgCount > MAX_MSGS_PER_SEC) return; // flood guard
    let m;
    try { m = JSON.parse(data.toString()); } catch { return; }
    if (!m || typeof m.t !== "string") return;

    if (m.t === "ping") return send(ws, { t: "pong" });

    if (m.t === "create") {
      if (ws.room) return;
      const code = newCode();
      if (!code) return send(ws, { t: "error", msg: "Server busy. Try again." });
      const room = { code, host: ws, guest: null, seed: Number(m.seed) || 1, hostName: cleanName(m.name) };
      rooms.set(code, room);
      ws.room = room;
      return send(ws, { t: "created", code });
    }

    if (m.t === "join") {
      if (ws.room) return;
      const room = rooms.get(String(m.code || "").toUpperCase());
      if (!room) return send(ws, { t: "error", msg: "Room not found.\nCheck the code." });
      if (room.guest) return send(ws, { t: "error", msg: "That room is full." });
      room.guest = ws;
      ws.room = room;
      send(ws, { t: "joined", host: room.hostName, seed: room.seed });
      return send(room.host, { t: "peer_joined", name: cleanName(m.name) });
    }

    if (FORWARD.has(m.t) && ws.room) {
      const other = ws.room.host === ws ? ws.room.guest : ws.room.host;
      send(other, m);
    }
  });

  ws.on("close", () => leave(ws));
  ws.on("error", () => leave(ws));
});

// Reset flood counters every second; drop dead connections (mobile users who
// lost signal) so rooms don't hang around forever.
setInterval(() => wss.clients.forEach((ws) => (ws.msgCount = 0)), 1000);
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 20000);

server.listen(PORT, () => console.log("relay listening on " + PORT));
