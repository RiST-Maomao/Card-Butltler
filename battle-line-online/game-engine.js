// Battle Line - server-authoritative game engine (CommonJS, no browser APIs).
// Implements the 60-card troop deck plus a 10-card tactics deck of this
// implementation's own design (see TACTICS_META for exact effects).
"use strict";

const SUITS = [
  { id: "sword", kanji: "剣", name: "剣士隊" },
  { id: "bow", kanji: "弓", name: "弓兵隊" },
  { id: "spear", kanji: "槍", name: "槍兵隊" },
  { id: "cavalry", kanji: "騎", name: "騎兵隊" },
  { id: "shield", kanji: "盾", name: "盾兵隊" },
  { id: "banner", kanji: "旗", name: "旗手隊" }
];
const SUIT_BY_ID = {};
SUITS.forEach((s) => (SUIT_BY_ID[s.id] = s));

// kind: 'wild-full' declares suit+value, 'wild-num' declares value only (colorless),
// 'env' is placed on a flag (not a card slot), 'action' resolves an instant effect.
const TACTICS_META = {
  alexander: { name: "アレクサンダー大王", kind: "wild-full", count: 1,
    desc: "任意の兵科・数値の部隊カードとして使用できる。" },
  darius: { name: "ダレイオス一世", kind: "wild-full", count: 1,
    desc: "任意の兵科・数値の部隊カードとして使用できる。" },
  companion: { name: "近衛騎兵", kind: "wild-num", count: 2,
    desc: "兵科を持たない任意の数値の部隊カードとして使用できる。楔形陣・陣列など兵科が揃う陣形には使えない。" },
  fog: { name: "霧", kind: "env", count: 1,
    desc: "未決着の旗に配置する。以後その旗は常に混成隊（合計値）として判定される。" },
  mud: { name: "泥濘", kind: "env", count: 1,
    desc: "未決着の旗に配置する。以後その旗は決着に各3枚ではなく4枚が必要になる。" },
  scout: { name: "斥候", kind: "action", count: 2,
    desc: "山札から合計3枚を確認し、1枚を手札に加えて残り2枚を山札の底に戻す。" },
  redeploy: { name: "再配置", kind: "action", count: 1,
    desc: "未決着の旗にある自分の札を1枚、別の未決着の旗へ移動する。" },
  deserter: { name: "離反工作", kind: "action", count: 1,
    desc: "未決着の旗にある相手の札を1枚、除外する。" }
};

let uidCounter = 1;
function uid(prefix) { return prefix + "-" + uidCounter++; }

function freshTroopDeck() {
  const deck = [];
  SUITS.forEach((s) => {
    for (let v = 1; v <= 10; v++) {
      deck.push({ kind: "troop", id: s.id + "-" + v, suit: s.id, value: v });
    }
  });
  return shuffle(deck);
}

function freshTacticsDeck() {
  const deck = [];
  Object.keys(TACTICS_META).forEach((type) => {
    const meta = TACTICS_META[type];
    for (let i = 0; i < meta.count; i++) {
      deck.push({ kind: "tactics", id: uid(type), type: type });
    }
  });
  return shuffle(deck);
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
  return arr;
}

function createGame() {
  const troopDeck = freshTroopDeck();
  const tacticsDeck = freshTacticsDeck();
  const flags = [];
  for (let i = 0; i < 9; i++) {
    flags.push({ num: i + 1, slots: [[], []], fog: false, mud: false, claimedBy: null, formation: null });
  }
  const game = {
    hands: [troopDeck.splice(0, 7), troopDeck.splice(0, 7)],
    troopDeck,
    tacticsDeck,
    discardTactics: [],
    tacticsPlayed: [0, 0],
    flags,
    current: 0,
    log: ["両軍が布陣を開始した。プレイヤー1の手番。"],
    gameOver: false,
    winner: null,
    reason: null,
    pendingDraw: null,   // { player } - must be resolved before playing a card this turn
    pendingScout: null   // { player, drawn: [{card, source}] }
  };
  beginTurn(game);
  return game;
}

function capacity(flag) { return flag.mud ? 4 : 3; }

function evaluateFormation(cards) {
  const values = cards.map((c) => c.value).sort((a, b) => a - b);
  const suits = cards.map((c) => c.suit);
  const sameSuit = suits.every((s) => s !== null && s !== undefined) &&
    suits.every((s) => s === suits[0]);
  const sameValue = values[0] === values[1] && values[1] === values[2];
  const isSeq = values[1] === values[0] + 1 && values[2] === values[1] + 1;
  const sum = values[0] + values[1] + values[2];
  let rank, label, tiebreak;
  if (sameSuit && isSeq) { rank = 5; label = "楔形陣"; tiebreak = values[2]; }
  else if (sameValue) { rank = 4; label = "方陣"; tiebreak = values[0]; }
  else if (sameSuit) { rank = 3; label = "陣列"; tiebreak = sum; }
  else if (isSeq) { rank = 2; label = "散兵線"; tiebreak = values[2]; }
  else { rank = 1; label = "混成隊"; tiebreak = sum; }
  return { rank, label, sum, tiebreak, sortedDesc: values.slice().reverse() };
}

function compareFormations(a, b) {
  if (a.rank !== b.rank) return a.rank - b.rank;
  if (a.tiebreak !== b.tiebreak) return a.tiebreak - b.tiebreak;
  if (a.sum !== b.sum) return a.sum - b.sum;
  for (let i = 0; i < 3; i++) {
    if (a.sortedDesc[i] !== b.sortedDesc[i]) return a.sortedDesc[i] - b.sortedDesc[i];
  }
  return 0;
}

function combinations3(cards) {
  // returns every 3-card subset of a 4-card array
  const out = [];
  for (let skip = 0; skip < cards.length; skip++) {
    out.push(cards.filter((_, i) => i !== skip));
  }
  return out;
}

function bestFormation(cards) {
  if (cards.length <= 3) return evaluateFormation(cards);
  let best = null;
  combinations3(cards).forEach((sub) => {
    const f = evaluateFormation(sub);
    if (!best || compareFormations(f, best) > 0) best = f;
  });
  return best;
}

function resolveFlag(game, idx) {
  const flag = game.flags[idx];
  if (flag.claimedBy !== null) return;
  const cap = capacity(flag);
  if (flag.slots[0].length >= cap && flag.slots[1].length >= cap) {
    const evalA = bestFormation(flag.slots[0]);
    const evalB = bestFormation(flag.slots[1]);
    const cmp = compareFormations(evalA, evalB);
    const winner = cmp >= 0 ? 0 : 1;
    flag.claimedBy = winner;
    flag.formation = winner === 0 ? evalA.label : evalB.label;
    game.log.push("第" + flag.num + "旗は「" + flag.formation + "」を敷いたプレイヤー" + (winner + 1) + "が制圧した。");
  }
}

function checkVictory(game) {
  const counts = [0, 0];
  game.flags.forEach((f) => { if (f.claimedBy !== null) counts[f.claimedBy]++; });
  if (counts[0] >= 5) return { winner: 0, reason: "5本の軍旗を確保" };
  if (counts[1] >= 5) return { winner: 1, reason: "5本の軍旗を確保" };
  for (let i = 0; i <= 6; i++) {
    const a = game.flags[i].claimedBy, b = game.flags[i + 1].claimedBy, c = game.flags[i + 2].claimedBy;
    if (a !== null && a === b && b === c) return { winner: a, reason: "3本の軍旗を連結" };
  }
  return null;
}

function applyVictoryIfAny(game) {
  const v = checkVictory(game);
  if (v) {
    game.gameOver = true;
    game.winner = v.winner;
    game.reason = v.reason;
    game.log.push("プレイヤー" + (v.winner + 1) + "の勝利！（" + v.reason + "）");
  }
  return !!v;
}

function canDeckDraw(game) { return game.troopDeck.length > 0 || game.tacticsDeck.length > 0; }
function canPlayerAct(game, idx) { return game.hands[idx].length > 0 || canDeckDraw(game); }

function endGameByTally(game, reasonPrefix) {
  const counts = [0, 0];
  game.flags.forEach((f) => { if (f.claimedBy !== null) counts[f.claimedBy]++; });
  game.gameOver = true;
  if (counts[0] > counts[1]) game.winner = 0;
  else if (counts[1] > counts[0]) game.winner = 1;
  else game.winner = null;
  game.reason = "双方とも手が続かなくなった（獲得旗数で判定）";
  game.log.push(reasonPrefix + (game.winner !== null ? "プレイヤー" + (game.winner + 1) + "が旗数で優勢。" : "互角のまま終戦。"));
}

function handleStuckTurns(game) {
  let guard = 0;
  while (!game.gameOver && !canPlayerAct(game, game.current) && guard < 4) {
    guard++;
    const other = 1 - game.current;
    if (!canPlayerAct(game, other)) {
      endGameByTally(game, "両軍とも兵を出し尽くした。");
      return;
    }
    game.log.push("プレイヤー" + (game.current + 1) + "は手も山札もなく、手番を送った。");
    game.current = other;
  }
}

// Battle Line turn order is: draw a card first, then play a card. beginTurn()
// runs the mandatory start-of-turn draw (or opens the pendingDraw choice) for
// whoever game.current is; playing a card is only allowed once it clears.
function beginTurn(game) {
  if (game.gameOver) return;
  handleStuckTurns(game);
  if (game.gameOver) return;
  const troopAvail = game.troopDeck.length > 0;
  const tacticsAvail = game.tacticsDeck.length > 0;
  if (!troopAvail && !tacticsAvail) { game.pendingDraw = null; return; }
  if (troopAvail && tacticsAvail) { game.pendingDraw = { player: game.current }; return; }
  const card = troopAvail ? game.troopDeck.shift() : game.tacticsDeck.shift();
  game.hands[game.current].push(card);
  game.pendingDraw = null;
}

function switchTurn(game) {
  game.current = 1 - game.current;
  beginTurn(game);
}

function err(msg) { return { ok: false, error: msg }; }
function ok() { return { ok: true }; }

function assertTurn(game, playerIdx) {
  if (game.gameOver) return "対局は終了しています。";
  if (game.pendingScout) return "斥候の処理が終わっていません。";
  if (game.pendingDraw) return "まず山札を選択してください。";
  if (game.current !== playerIdx) return "相手の手番です。";
  return null;
}

function assertTacticsLimit(game, playerIdx) {
  if (game.tacticsPlayed[playerIdx] > game.tacticsPlayed[1 - playerIdx]) {
    return "戦術カードの使用上限（相手の使用数+1枚）に達しているため、これ以上は使用できません。";
  }
  return null;
}

function suitName(id) { return id ? SUIT_BY_ID[id].name : "無所属"; }

// ---- Move handlers -------------------------------------------------------

function playTroop(game, playerIdx, handIndex) {
  return function (flagIndex) {
    const e = assertTurn(game, playerIdx); if (e) return err(e);
    const card = game.hands[playerIdx][handIndex];
    if (!card || card.kind !== "troop") return err("不正な手札です。");
    const flag = game.flags[flagIndex];
    if (!flag || flag.claimedBy !== null) return err("その旗はもう決着しています。");
    if (flag.slots[playerIdx].length >= capacity(flag)) return err("これ以上配置できません。");
    game.hands[playerIdx].splice(handIndex, 1);
    flag.slots[playerIdx].push({ kind: "troop", id: card.id, suit: card.suit, value: card.value });
    game.log.push("プレイヤー" + (playerIdx + 1) + "が第" + flag.num + "旗に" + suitName(card.suit) + "『" + card.value + "』を配置。");
    resolveFlag(game, flagIndex);
    if (!applyVictoryIfAny(game)) switchTurn(game);
    return ok();
  };
}

function playWild(game, playerIdx, handIndex, flagIndex, declaredSuit, declaredValue) {
  const e = assertTurn(game, playerIdx); if (e) return err(e);
  const tl = assertTacticsLimit(game, playerIdx); if (tl) return err(tl);
  const card = game.hands[playerIdx][handIndex];
  if (!card || card.kind !== "tactics") return err("不正な手札です。");
  const meta = TACTICS_META[card.type];
  if (!meta || (meta.kind !== "wild-full" && meta.kind !== "wild-num")) return err("この札は部隊カードとして使えません。");
  const value = Number(declaredValue);
  if (!Number.isInteger(value) || value < 1 || value > 10) return err("数値は1〜10で指定してください。");
  let suit = null;
  if (meta.kind === "wild-full") {
    if (!SUIT_BY_ID[declaredSuit]) return err("兵科を指定してください。");
    suit = declaredSuit;
  }
  const flag = game.flags[flagIndex];
  if (!flag || flag.claimedBy !== null) return err("その旗はもう決着しています。");
  if (flag.slots[playerIdx].length >= capacity(flag)) return err("これ以上配置できません。");
  game.hands[playerIdx].splice(handIndex, 1);
  flag.slots[playerIdx].push({ kind: "troop", id: card.id, suit, value, wild: card.type });
  game.tacticsPlayed[playerIdx]++;
  const label = meta.name + (suit ? "（" + suitName(suit) + "『" + value + "』として）" : "（『" + value + "』として）");
  game.log.push("プレイヤー" + (playerIdx + 1) + "が第" + flag.num + "旗に" + label + "を配置。");
  resolveFlag(game, flagIndex);
  if (!applyVictoryIfAny(game)) switchTurn(game);
  return ok();
}

function playEnvironment(game, playerIdx, handIndex, flagIndex) {
  const e = assertTurn(game, playerIdx); if (e) return err(e);
  const tl = assertTacticsLimit(game, playerIdx); if (tl) return err(tl);
  const card = game.hands[playerIdx][handIndex];
  if (!card || card.kind !== "tactics") return err("不正な手札です。");
  const meta = TACTICS_META[card.type];
  if (!meta || meta.kind !== "env") return err("この札は旗に配置できません。");
  const flag = game.flags[flagIndex];
  if (!flag || flag.claimedBy !== null) return err("その旗はもう決着しています。");
  if (flag.fog || flag.mud) return err("その旗にはすでに効果札が置かれています。");
  game.hands[playerIdx].splice(handIndex, 1);
  flag[card.type] = true;
  game.discardTactics.push(card);
  game.tacticsPlayed[playerIdx]++;
  game.log.push("プレイヤー" + (playerIdx + 1) + "が第" + flag.num + "旗に「" + meta.name + "」を発動。");
  resolveFlag(game, flagIndex);
  if (!applyVictoryIfAny(game)) switchTurn(game);
  return ok();
}

function playScout(game, playerIdx, handIndex, sources) {
  const e = assertTurn(game, playerIdx); if (e) return err(e);
  const tl = assertTacticsLimit(game, playerIdx); if (tl) return err(tl);
  const card = game.hands[playerIdx][handIndex];
  if (!card || card.kind !== "tactics" || card.type !== "scout") return err("不正な手札です。");
  if (!Array.isArray(sources) || sources.length === 0) return err("引く山札を指定してください。");
  game.hands[playerIdx].splice(handIndex, 1);
  game.discardTactics.push(card);
  game.tacticsPlayed[playerIdx]++;
  const drawn = [];
  for (let i = 0; i < Math.min(3, sources.length); i++) {
    if (game.troopDeck.length === 0 && game.tacticsDeck.length === 0) break;
    let want = sources[i] === "tactics" ? "tactics" : "troop";
    if (want === "troop" && game.troopDeck.length === 0) want = "tactics";
    if (want === "tactics" && game.tacticsDeck.length === 0) want = "troop";
    if (want === "troop" && game.troopDeck.length === 0) continue;
    const c = want === "troop" ? game.troopDeck.shift() : game.tacticsDeck.shift();
    drawn.push({ card: c, source: want });
  }
  game.pendingScout = { player: playerIdx, drawn };
  game.log.push("プレイヤー" + (playerIdx + 1) + "が「斥候」を発動し、" + drawn.length + "枚を確認中。");
  return ok();
}

function resolveScout(game, playerIdx, keepIndex) {
  if (!game.pendingScout || game.pendingScout.player !== playerIdx) return err("斥候の処理はありません。");
  const drawn = game.pendingScout.drawn;
  if (!Number.isInteger(keepIndex) || keepIndex < 0 || keepIndex >= drawn.length) return err("不正な選択です。");
  const kept = drawn[keepIndex];
  game.hands[playerIdx].push(kept.card);
  drawn.forEach((d, i) => {
    if (i === keepIndex) return;
    if (d.source === "troop") game.troopDeck.push(d.card);
    else game.tacticsDeck.push(d.card);
  });
  game.log.push("プレイヤー" + (playerIdx + 1) + "は1枚を手札に加え、残り" + (drawn.length - 1) + "枚を山札の底に戻した。");
  game.pendingScout = null;
  switchTurn(game);
  return ok();
}

function playRedeploy(game, playerIdx, handIndex, fromFlagIdx, slotIndex, toFlagIdx) {
  const e = assertTurn(game, playerIdx); if (e) return err(e);
  const tl = assertTacticsLimit(game, playerIdx); if (tl) return err(tl);
  const card = game.hands[playerIdx][handIndex];
  if (!card || card.kind !== "tactics" || card.type !== "redeploy") return err("不正な手札です。");
  const from = game.flags[fromFlagIdx], to = game.flags[toFlagIdx];
  if (!from || !to || fromFlagIdx === toFlagIdx) return err("移動元と移動先の旗を指定してください。");
  if (from.claimedBy !== null || to.claimedBy !== null) return err("決着済みの旗は指定できません。");
  const moving = from.slots[playerIdx][slotIndex];
  if (!moving) return err("移動する札がありません。");
  if (to.slots[playerIdx].length >= capacity(to)) return err("移動先の旗はいっぱいです。");
  game.hands[playerIdx].splice(handIndex, 1);
  game.discardTactics.push(card);
  game.tacticsPlayed[playerIdx]++;
  from.slots[playerIdx].splice(slotIndex, 1);
  to.slots[playerIdx].push(moving);
  game.log.push("プレイヤー" + (playerIdx + 1) + "が「再配置」で第" + from.num + "旗から第" + to.num + "旗へ札を移動。");
  resolveFlag(game, toFlagIdx);
  if (!applyVictoryIfAny(game)) switchTurn(game);
  return ok();
}

function playDeserter(game, playerIdx, handIndex, targetFlagIdx, targetSlotIndex) {
  const e = assertTurn(game, playerIdx); if (e) return err(e);
  const tl = assertTacticsLimit(game, playerIdx); if (tl) return err(tl);
  const card = game.hands[playerIdx][handIndex];
  if (!card || card.kind !== "tactics" || card.type !== "deserter") return err("不正な手札です。");
  const flag = game.flags[targetFlagIdx];
  if (!flag || flag.claimedBy !== null) return err("決着済みの旗は指定できません。");
  const oppIdx = 1 - playerIdx;
  const target = flag.slots[oppIdx][targetSlotIndex];
  if (!target) return err("除外する札がありません。");
  game.hands[playerIdx].splice(handIndex, 1);
  game.discardTactics.push(card);
  game.tacticsPlayed[playerIdx]++;
  flag.slots[oppIdx].splice(targetSlotIndex, 1);
  game.log.push("プレイヤー" + (playerIdx + 1) + "が「離反工作」で第" + flag.num + "旗の相手の札を除外。");
  if (!applyVictoryIfAny(game)) switchTurn(game);
  return ok();
}

// Resolves the mandatory start-of-turn draw when both decks are available.
// Playing a card (any of the handlers above) is blocked by assertTurn until
// this clears, matching Battle Line's "draw, then play" turn order.
function chooseDrawSource(game, playerIdx, source) {
  if (!game.pendingDraw || game.pendingDraw.player !== playerIdx) return err("山札選択の必要はありません。");
  const deck = source === "tactics" ? game.tacticsDeck : game.troopDeck;
  if (deck.length === 0) return err("その山札は空です。");
  game.hands[playerIdx].push(deck.shift());
  game.pendingDraw = null;
  return ok();
}

module.exports = {
  SUITS, SUIT_BY_ID, TACTICS_META,
  createGame, capacity, evaluateFormation, compareFormations, bestFormation,
  resolveFlag, checkVictory,
  playTroop, playWild, playEnvironment, playScout, resolveScout, playRedeploy, playDeserter,
  chooseDrawSource
};
