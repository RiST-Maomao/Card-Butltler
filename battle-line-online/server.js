// Battle Line - local multiplayer server.
// Serves the client from ./public and relays moves through a WebSocket,
// with the authoritative game state kept only on this process (game-engine.js).
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");
const engine = require("./game-engine");

const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;
const PUBLIC_DIR = path.join(__dirname, "public");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
const TURN_LIMIT_MS = 2 * 60 * 1000;

const rooms = new Map(); // roomId -> room

function makeRoomId() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let id;
  do {
    id = Array.from({ length: 4 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
  } while (rooms.has(id));
  return id;
}

function makeToken() { return crypto.randomBytes(16).toString("hex"); }

function createRoom() {
  const id = makeRoomId();
  const room = {
    id,
    game: null,
    sockets: [null, null],
    tokens: [makeToken(), makeToken()],
    names: ["プレイヤー1", "プレイヤー2"],
    joined: [false, false],
    turnDeadline: null,
    turnTimerHandle: null,
    paused: false,
    pauseVotes: [false, false],
    pausedRemainingMs: null
  };
  rooms.set(id, room);
  return room;
}

function clearRoomTimer(room) {
  if (room.turnTimerHandle) { clearTimeout(room.turnTimerHandle); room.turnTimerHandle = null; }
}

function startRoomTimer(room, ms) {
  clearRoomTimer(room);
  room.turnDeadline = Date.now() + ms;
  room.turnTimerHandle = setTimeout(() => {
    if (!room.game || room.game.gameOver) return;
    engine.forceLoseByTimeout(room.game, room.game.current);
    clearRoomTimer(room);
    room.turnDeadline = null;
    broadcast(room);
  }, ms);
}

function restartTurnClock(room) {
  room.paused = false;
  room.pauseVotes = [false, false];
  room.pausedRemainingMs = null;
  startRoomTimer(room, TURN_LIMIT_MS);
}

function stopTurnClock(room) {
  clearRoomTimer(room);
  room.turnDeadline = null;
  room.paused = false;
  room.pauseVotes = [false, false];
  room.pausedRemainingMs = null;
}

function togglePause(room, playerIdx) {
  if (!room.game || room.game.gameOver) return;
  room.pauseVotes[playerIdx] = !room.pauseVotes[playerIdx];
  const bothNow = room.pauseVotes[0] && room.pauseVotes[1];
  if (bothNow && !room.paused) {
    room.pausedRemainingMs = room.turnDeadline ? Math.max(0, room.turnDeadline - Date.now()) : TURN_LIMIT_MS;
    clearRoomTimer(room);
    room.turnDeadline = null;
    room.paused = true;
  } else if (!bothNow && room.paused) {
    room.paused = false;
    startRoomTimer(room, room.pausedRemainingMs != null ? room.pausedRemainingMs : TURN_LIMIT_MS);
    room.pausedRemainingMs = null;
  }
}

function maybeStartGame(room) {
  if (room.joined[0] && room.joined[1] && !room.game) {
    room.game = engine.createGame();
    restartTurnClock(room);
  }
}

function sanitize(room, viewerIdx) {
  const game = room.game;
  const base = {
    you: viewerIdx,
    roomId: room.id,
    names: room.names,
    opponentConnected: !!room.sockets[1 - viewerIdx],
    waitingForOpponent: !room.joined[1 - viewerIdx],
    paused: room.paused,
    pauseVotes: room.pauseVotes,
    turnDeadline: room.paused ? null : room.turnDeadline,
    pausedRemainingMs: room.paused ? room.pausedRemainingMs : null
  };
  if (!game) return Object.assign(base, { started: false });
  const pendingDraw = game.pendingDraw
    ? { mine: game.pendingDraw.player === viewerIdx }
    : null;
  const pendingScout = game.pendingScout
    ? (game.pendingScout.player === viewerIdx
        ? { mine: true, drawn: game.pendingScout.drawn }
        : { mine: false })
    : null;
  const pendingVassal = game.pendingVassal
    ? (game.pendingVassal.player === viewerIdx
        ? { mine: true, card: game.pendingVassal.card }
        : { mine: false })
    : null;
  return Object.assign(base, {
    started: true,
    current: game.current,
    turnPhase: game.turnPhase,
    gameOver: game.gameOver,
    winner: game.winner,
    reason: game.reason,
    flags: game.flags,
    hand: game.hands[viewerIdx],
    oppHandCount: game.hands[1 - viewerIdx].length,
    troopDeckCount: game.troopDeck.length,
    tacticsDeckCount: game.tacticsDeck.length,
    tacticsPlayed: game.tacticsPlayed,
    leaderUsed: game.leaderUsed,
    discardTactics: game.discardTactics,
    log: game.log.slice(-60),
    pendingDraw,
    pendingScout,
    pendingVassal,
    canPass: engine.canPass(game, viewerIdx),
    claimableFlags: engine.claimableFlags(game, viewerIdx)
  });
}

function broadcast(room) {
  [0, 1].forEach((i) => {
    const sock = room.sockets[i];
    if (sock && sock.readyState === sock.OPEN) {
      sock.send(JSON.stringify({ type: "state", state: sanitize(room, i) }));
    }
  });
}

function sendError(sock, message) {
  if (sock && sock.readyState === sock.OPEN) sock.send(JSON.stringify({ type: "error", message }));
}

const server = http.createServer((req, res) => {
  let reqPath = decodeURIComponent(req.url.split("?")[0]);
  if (reqPath === "/") reqPath = "/index.html";
  const filePath = path.join(PUBLIC_DIR, reqPath);
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end("forbidden"); return; }
  fs.readFile(filePath, (e, data) => {
    if (e) { res.writeHead(404); res.end("not found"); return; }
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });

wss.on("connection", (sock) => {
  sock.room = null;
  sock.playerIdx = null;

  sock.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
    if (!msg || typeof msg.type !== "string") return;

    if (msg.type === "create_room") {
      const room = createRoom();
      room.sockets[0] = sock;
      room.joined[0] = true;
      if (msg.name) room.names[0] = String(msg.name).slice(0, 20);
      sock.room = room; sock.playerIdx = 0;
      sock.send(JSON.stringify({ type: "joined", roomId: room.id, token: room.tokens[0], playerIdx: 0 }));
      broadcast(room);
      return;
    }

    if (msg.type === "join_room") {
      const room = rooms.get(String(msg.roomId || "").toUpperCase());
      if (!room) { sendError(sock, "その部屋コードは見つかりません。"); return; }
      let slot = -1;
      if (!room.joined[1]) slot = 1;
      else if (!room.joined[0]) slot = 0;
      else { sendError(sock, "この部屋はすでに満員です。"); return; }
      room.sockets[slot] = sock;
      room.joined[slot] = true;
      if (msg.name) room.names[slot] = String(msg.name).slice(0, 20);
      sock.room = room; sock.playerIdx = slot;
      maybeStartGame(room);
      sock.send(JSON.stringify({ type: "joined", roomId: room.id, token: room.tokens[slot], playerIdx: slot }));
      broadcast(room);
      return;
    }

    if (msg.type === "rejoin") {
      const room = rooms.get(String(msg.roomId || "").toUpperCase());
      if (!room) { sendError(sock, "その部屋はもう存在しません。"); return; }
      const slot = room.tokens.indexOf(msg.token);
      if (slot === -1) { sendError(sock, "再接続できませんでした。"); return; }
      room.sockets[slot] = sock;
      room.joined[slot] = true;
      sock.room = room; sock.playerIdx = slot;
      sock.send(JSON.stringify({ type: "joined", roomId: room.id, token: room.tokens[slot], playerIdx: slot }));
      broadcast(room);
      return;
    }

    const room = sock.room;
    if (!room || sock.playerIdx === null) return;
    const p = sock.playerIdx;

    if (msg.type === "toggle_pause") {
      togglePause(room, p);
      broadcast(room);
      return;
    }

    if (!room.game) return;
    const g = room.game;
    let result = null;
    const currentBefore = g.current;
    const overBefore = g.gameOver;

    switch (msg.type) {
      case "claim_flag":
        result = engine.claimFlag(g, p, msg.flagIndex);
        break;
      case "proceed_draw":
        result = engine.proceedToDraw(g, p);
        break;
      case "choose_draw":
        result = engine.chooseDrawSource(g, p, msg.source);
        break;
      case "pass_turn":
        result = engine.passTurn(g, p);
        break;
      case "play_troop":
        result = engine.playTroop(g, p, msg.handIndex, msg.flagIndex);
        break;
      case "play_wild":
        result = engine.playWild(g, p, msg.handIndex, msg.flagIndex, msg.suit, msg.value);
        break;
      case "play_mimic":
        result = engine.playMimic(g, p, msg.handIndex, msg.flagIndex, msg.sourceFlag, msg.sourceSlot);
        break;
      case "play_env":
        result = engine.playEnvironment(g, p, msg.handIndex, msg.flagIndex);
        break;
      case "play_scout":
        result = engine.playScout(g, p, msg.handIndex, msg.sources);
        break;
      case "resolve_scout":
        result = engine.resolveScout(g, p, msg.keepIndex, msg.placements);
        break;
      case "play_redeploy":
        result = engine.playRedeploy(g, p, msg.handIndex, msg.fromFlag, msg.slotIndex, msg.toFlag);
        break;
      case "play_deserter":
        result = engine.playDeserter(g, p, msg.handIndex, msg.targetFlag, msg.targetSlotIndex);
        break;
      case "play_bribe":
        result = engine.playBribe(g, p, msg.handIndex);
        break;
      case "play_masquerade":
        result = engine.playMasquerade(g, p, msg.handIndex, msg.giveCardId);
        break;
      case "play_renovate":
        result = engine.playRenovate(g, p, msg.handIndex, msg.targetFlag, msg.targetSlotIndex);
        break;
      case "play_vassal":
        result = engine.playVassal(g, p, msg.handIndex);
        break;
      case "resolve_vassal":
        result = engine.resolveVassal(g, p, msg.choice);
        break;
      case "rematch":
        if (!g.gameOver) return;
        room.game = engine.createGame();
        restartTurnClock(room);
        broadcast(room);
        return;
      default:
        return;
    }

    if (result && !result.ok) { sendError(sock, result.error); return; }

    if (g.gameOver && !overBefore) {
      stopTurnClock(room);
    } else if (!g.gameOver && g.current !== currentBefore) {
      restartTurnClock(room);
    }
    broadcast(room);
  });

  sock.on("close", () => {
    const room = sock.room;
    if (!room) return;
    if (room.sockets[sock.playerIdx] === sock) room.sockets[sock.playerIdx] = null;
    broadcast(room);
  });
});

server.listen(PORT, () => {
  const nets = os.networkInterfaces();
  const lanIps = [];
  Object.values(nets).forEach((ifaces) => {
    (ifaces || []).forEach((i) => { if (i.family === "IPv4" && !i.internal) lanIps.push(i.address); });
  });
  console.log("Battle Line online server is running.");
  console.log("  Local:   http://localhost:" + PORT);
  lanIps.forEach((ip) => console.log("  Network: http://" + ip + ":" + PORT + "   (share this with the other player on your LAN)"));
});
