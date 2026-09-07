const eng = require("./game-engine.js");

function assert(cond, msg) { if (!cond) { console.error("FAIL:", msg); process.exitCode = 1; } else { console.log("ok:", msg); } }

// --- basic turn flow: claim(none) -> draw -> play ---
let g = eng.createGame();
assert(g.turnPhase === "claim", "starts in claim phase");
let r = eng.playTroop(g, 0, 0, 0);
assert(!r.ok, "cannot play before draw resolves: " + r.error);
r = eng.proceedToDraw(g, 0);
assert(r.ok, "proceedToDraw ok");
if (g.pendingDraw) {
  r = eng.chooseDrawSource(g, 0, "troop");
  assert(r.ok, "chooseDrawSource ok");
}
assert(g.turnPhase === "play", "now in play phase");
const handLenBefore = g.hands[0].length;
r = eng.playTroop(g, 0, 0, 0);
assert(r.ok, "playTroop ok: " + (r.error || ""));
assert(g.current === 1, "turn switched to player 2");
assert(g.turnPhase === "claim", "player 2 starts in claim phase");

// --- tactics usage cap ---
g = eng.createGame();
g.hands[0] = [{ kind: "tactics", id: "t1", type: "bribe" }, { kind: "tactics", id: "t2", type: "bribe2" }];
g.hands[0][1].type = "deserter"; // reuse a real type for the 2nd slot; give player1 two tactics cards manually
g.hands[1] = [{ kind: "troop", id: "sword-1", suit: "sword", value: 1 }];
g.turnPhase = "play"; // skip claim/draw for this synthetic test
r = eng.playBribe(g, 0, 0);
assert(r.ok, "first tactics card allowed: " + (r.error || ""));
assert(g.tacticsPlayed[0] === 1, "tacticsPlayed[0] incremented");
g.current = 0; g.turnPhase = "play";
r = eng.playDeserter(g, 0, 0, 0, 0);
assert(!r.ok, "second tactics card blocked by usage cap");

// --- leader restriction (alexander/darius) ---
g = eng.createGame();
g.hands[0] = [{ kind: "tactics", id: "a1", type: "alexander" }, { kind: "tactics", id: "d1", type: "darius" }];
g.turnPhase = "play";
r = eng.playWild(g, 0, 0, 0, "sword", 5);
assert(r.ok, "alexander played: " + (r.error || ""));
assert(g.leaderUsed[0] === true, "leaderUsed set");
g.current = 0; g.turnPhase = "play";
r = eng.playWild(g, 0, 0, 1, "bow", 6);
assert(!r.ok, "darius blocked after alexander used by same player");

// --- claimed flags block placement ---
g = eng.createGame();
g.flags[0].claimedBy = 0;
g.turnPhase = "play"; g.current = 0;
g.hands[0] = [{ kind: "troop", id: "sword-9", suit: "sword", value: 9 }];
r = eng.playTroop(g, 0, 0, 0);
assert(!r.ok, "cannot place on a claimed flag");

// --- manual claim: complete unbeatable wedge vs empty opponent, near-empty pool ---
g = eng.createGame();
// Fabricate a near-exhausted troop deck/hands so the opponent has almost no pool to beat an 8-9-10 wedge.
g.troopDeck = [];
g.hands[0] = [];
g.hands[1] = [];
g.flags[0].slots[0] = [
  { kind: "troop", id: "sword-8", suit: "sword", value: 8 },
  { kind: "troop", id: "sword-9", suit: "sword", value: 9 },
  { kind: "troop", id: "sword-10", suit: "sword", value: 10 }
];
// mark every other suit/value as already discarded/used so pool for opponent is empty
const usedKeys = [];
eng.SUITS.forEach(s => { for (let v = 1; v <= 10; v++) { if (!(s.id === "sword" && v >= 8)) usedKeys.push(s.id + "-" + v); } });
g.discardedTroopKeys = usedKeys;
g.turnPhase = "claim"; g.current = 0;
const claimable = eng.claimableFlags(g, 0);
assert(claimable.includes(0), "flag 0 is claimable with an unbeatable wedge and empty pool");
r = eng.claimFlag(g, 0, 0);
assert(r.ok, "claim succeeded: " + (r.error || ""));
assert(g.flags[0].claimedBy === 0, "flag 0 now claimed by player 0");

// --- pass mechanic ---
g = eng.createGame();
g.turnPhase = "play"; g.current = 0;
g.flags.forEach(f => { f.slots[0] = [{ kind: "troop", id: "x", suit: "sword", value: 1 }, { kind: "troop", id: "y", suit: "bow", value: 2 }, { kind: "troop", id: "z", suit: "spear", value: 3 }]; });
// player0's side is full (3/3) on every flag but none are claimed -> no room anywhere
assert(!eng.hasLegalPlacement(g, 0), "no legal placement when every flag is full on your side");
r = eng.passTurn(g, 0);
assert(r.ok, "pass allowed: " + (r.error || ""));
assert(g.current === 1, "turn passed to player 2");

console.log("done");
