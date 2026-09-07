// Battle Line - server-authoritative game engine (CommonJS, no browser APIs,
// no timers/IO - wall-clock turn timers live in server.js).
//
// Turn structure per player: "claim" phase (may declare any number of already
// -won flags) -> draw phase (mandatory, chooses a deck when both remain) ->
// "play" phase (must play one card, or pass if no placement is possible).
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

// kind categories:
//   wild-full   declare suit+value, becomes that troop card (Leader cards)
//   wild-num    declare value only, colorless (never counts for same-suit formations)
//   wild-mimic  copy the suit+value of an opponent's already-placed card
//   env         placed on a flag instead of a card slot; one per flag, mutually exclusive
//   action      resolves an instant/targeted effect, does not occupy a flag slot
// Each game randomly uses only 10 of these 17 types (see freshTacticsDeck).
const TACTICS_META = {
  alexander: { name: "アレクサンダー大王", kind: "wild-full",
    desc: "任意の兵科・数値の部隊カードとして使用できる。ダリウスとはどちらか1枚しか使用できない。" },
  darius: { name: "ダリウス", kind: "wild-full",
    desc: "任意の兵科・数値の部隊カードとして使用できる。アレクサンダー大王とはどちらか1枚しか使用できない。" },
  companion: { name: "近衛騎兵", kind: "wild-num",
    desc: "兵科を持たない任意の数値の部隊カードとして使用できる。楔形陣・陣列など兵科が揃う陣形には使えない。" },
  reinforcement: { name: "援軍", kind: "wild-mimic",
    desc: "相手の場に出ている札を1枚選び、その兵科・数値を持つ部隊カードとして使用できる。" },
  fog: { name: "霧", kind: "env",
    desc: "未決着の旗に配置する。以後その旗は常に混成隊（合計値）として判定される。" },
  mud: { name: "泥濘", kind: "env",
    desc: "未決着の旗に配置する。以後その旗は決着に各3枚ではなく4枚が必要になる。" },
  revolution: { name: "革命", kind: "env",
    desc: "未決着の旗に配置する。以後その旗は、同じ役同士なら数値の小さい方が強いと判定される。" },
  merchant: { name: "商人", kind: "env",
    desc: "未決着の旗に配置する。以後その旗にある自分の札は、それぞれ数値+1（最大10）として判定される。" },
  immunity: { name: "無限泡影", kind: "env",
    desc: "未決着の旗に配置する。以後その旗にある札は、離反工作・再配置・援軍の対象にならない。" },
  diplomat: { name: "外交官", kind: "env",
    desc: "未決着の旗に配置する。決着時に双方が同じ役なら、その旗は引き分け（誰も確保しない）になる。" },
  scout: { name: "偵察[改]", kind: "action-scout",
    desc: "山札から合計3枚を確認し、1枚を手札に加える。残り2枚はそれぞれ好きな山札の上か下に戻す。" },
  redeploy: { name: "再配置", kind: "action-redeploy",
    desc: "未決着の旗にある自分の札を1枚、別の未決着の旗へ移動する。" },
  deserter: { name: "離反工作", kind: "action-deserter",
    desc: "未決着の旗にある相手の札を1枚、除外する。" },
  bribe: { name: "買収", kind: "action-bribe",
    desc: "相手の手札からランダムに1枚を、自分の手札に加える。" },
  masquerade: { name: "仮面舞踏会", kind: "action-masquerade",
    desc: "自分の手札1枚と、相手の手札からランダムな1枚を交換する。" },
  renovate: { name: "改築", kind: "action-renovate",
    desc: "自分の場の札を1枚廃棄し、部隊山札から1枚引く。" },
  vassal: { name: "家臣", kind: "action-vassal",
    desc: "戦術山札の一番上を確認し、手札に加えるか捨てるかを選べる。" }
};
const ALL_TACTICS_TYPES = Object.keys(TACTICS_META);

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

// Each game uses a random 10 of the 17 tactics types, one copy each.
function freshTacticsDeck() {
  const chosen = shuffle(ALL_TACTICS_TYPES.slice()).slice(0, 10);
  return shuffle(chosen.map((type) => ({ kind: "tactics", id: uid(type), type })));
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
    flags.push({ num: i + 1, slots: [[], []], effect: null, claimedBy: null, formation: null });
  }
  const game = {
    hands: [troopDeck.splice(0, 7), troopDeck.splice(0, 7)],
    troopDeck,
    tacticsDeck,
    discardTactics: [],
    discardedTroopKeys: [],
    tacticsPlayed: [0, 0],
    leaderUsed: [false, false],
    consecutivePasses: 0,
    flags,
    current: 0,
    turnPhase: "claim",
    log: ["両軍が布陣を開始した。プレイヤー1の手番。"],
    gameOver: false,
    winner: null,
    reason: null,
    pendingDraw: null,    // { player }
    pendingScout: null,   // { player, drawn: [{card, source}] }
    pendingVassal: null   // { player, card }
  };
  return game;
}

function capacity(flag) { return flag.effect && flag.effect.type === "mud" ? 4 : 3; }
function flagIsImmune(flag) { return !!(flag.effect && flag.effect.type === "immunity"); }

function withMerchantBonus(cards, flag, side) {
  if (!flag.effect || flag.effect.type !== "merchant" || flag.effect.owner !== side) return cards;
  return cards.map((c) => Object.assign({}, c, { value: Math.min(10, c.value + 1) }));
}

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

// Plain (non-flag-aware) comparison: used only to pick the best 3-of-4 subset
// for a single side under Mud - Mud and Revolution can never share a flag.
function compareFormations(a, b) {
  if (a.rank !== b.rank) return a.rank - b.rank;
  if (a.tiebreak !== b.tiebreak) return a.tiebreak - b.tiebreak;
  if (a.sum !== b.sum) return a.sum - b.sum;
  for (let i = 0; i < 3; i++) {
    if (a.sortedDesc[i] !== b.sortedDesc[i]) return a.sortedDesc[i] - b.sortedDesc[i];
  }
  return 0;
}

// Flag-aware comparison: honors Revolution (lower tiebreak wins within the
// same rank). Rank itself always determines superiority regardless.
function compareForFlag(a, b, flag) {
  if (a.rank !== b.rank) return a.rank - b.rank;
  const cmp = compareFormations(a, b);
  return flag && flag.effect && flag.effect.type === "revolution" ? -cmp : cmp;
}

function combinations3(cards) {
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
    const evalA = bestFormation(withMerchantBonus(flag.slots[0], flag, 0));
    const evalB = bestFormation(withMerchantBonus(flag.slots[1], flag, 1));
    if (flag.effect && flag.effect.type === "diplomat" && evalA.rank === evalB.rank) {
      flag.claimedBy = "draw";
      flag.formation = "引き分け（外交官）";
      game.log.push("第" + flag.num + "旗は双方「" + evalA.label + "」で並び、外交官により引き分けとなった。");
      return;
    }
    const cmp = compareForFlag(evalA, evalB, flag);
    const winner = cmp >= 0 ? 0 : 1;
    flag.claimedBy = winner;
    flag.formation = winner === 0 ? evalA.label : evalB.label;
    game.log.push("第" + flag.num + "旗は「" + flag.formation + "」を敷いたプレイヤー" + (winner + 1) + "が制圧した。");
  }
}

// ---- Manual claim (proof of an unbeatable, but possibly incomplete, hand) ---

function remainingTroopPool(game, excludeHandOwnerIdx) {
  const used = new Set(game.discardedTroopKeys);
  game.flags.forEach((f) => [0, 1].forEach((side) => f.slots[side].forEach((c) => {
    if (!c.wild) used.add(c.suit + "-" + c.value);
  })));
  game.hands[excludeHandOwnerIdx].forEach((c) => { if (c.kind === "troop") used.add(c.suit + "-" + c.value); });
  const pool = [];
  SUITS.forEach((s) => {
    for (let v = 1; v <= 10; v++) {
      const key = s.id + "-" + v;
      if (!used.has(key)) pool.push({ suit: s.id, value: v });
    }
  });
  return pool;
}

// True if the opponent has ANY legal way to complete this flag (using only
// unseen troop cards, i.e. ignoring any tactics cards they might still hold)
// that ties or beats myFormation under this flag's own rules.
function opponentCanMatchOrBeat(game, flag, claimantIdx, myFormation) {
  const oppIdx = 1 - claimantIdx;
  const cap = capacity(flag);
  const existing = flag.slots[oppIdx];
  const need = cap - existing.length;
  if (need <= 0) {
    const f = bestFormation(withMerchantBonus(existing, flag, oppIdx));
    return compareForFlag(f, myFormation, flag) >= 0;
  }
  const pool = remainingTroopPool(game, claimantIdx);
  let found = false;
  function recurse(start, chosen) {
    if (found) return;
    if (chosen.length === need) {
      const full = existing.concat(chosen);
      const f = bestFormation(withMerchantBonus(full, flag, oppIdx));
      if (compareForFlag(f, myFormation, flag) >= 0) found = true;
      return;
    }
    for (let i = start; i < pool.length && !found; i++) {
      chosen.push(pool[i]);
      recurse(i + 1, chosen);
      chosen.pop();
    }
  }
  recurse(0, []);
  return found;
}

function canManuallyClaim(game, flagIndex, claimantIdx) {
  const flag = game.flags[flagIndex];
  if (!flag || flag.claimedBy !== null) return false;
  const cap = capacity(flag);
  if (flag.slots[claimantIdx].length < cap) return false;
  if (flag.slots[1 - claimantIdx].length >= cap) return false;
  const myFormation = bestFormation(withMerchantBonus(flag.slots[claimantIdx], flag, claimantIdx));
  return !opponentCanMatchOrBeat(game, flag, claimantIdx, myFormation);
}

function claimableFlags(game, playerIdx) {
  if (game.gameOver || game.current !== playerIdx || game.turnPhase !== "claim") return [];
  const out = [];
  game.flags.forEach((f, idx) => { if (canManuallyClaim(game, idx, playerIdx)) out.push(idx); });
  return out;
}

// ---- Victory / stuck-turn handling ---------------------------------------

function checkVictory(game) {
  const counts = [0, 0];
  game.flags.forEach((f) => { if (f.claimedBy === 0 || f.claimedBy === 1) counts[f.claimedBy]++; });
  if (counts[0] >= 5) return { winner: 0, reason: "5本の軍旗を確保" };
  if (counts[1] >= 5) return { winner: 1, reason: "5本の軍旗を確保" };
  for (let i = 0; i <= 6; i++) {
    const a = game.flags[i].claimedBy, b = game.flags[i + 1].claimedBy, c = game.flags[i + 2].claimedBy;
    if ((a === 0 || a === 1) && a === b && b === c) return { winner: a, reason: "3本の軍旗を連結" };
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

function endGameByTally(game, reasonPrefix) {
  const counts = [0, 0];
  game.flags.forEach((f) => { if (f.claimedBy === 0 || f.claimedBy === 1) counts[f.claimedBy]++; });
  game.gameOver = true;
  if (counts[0] > counts[1]) game.winner = 0;
  else if (counts[1] > counts[0]) game.winner = 1;
  else game.winner = null;
  game.reason = "双方とも手が続かなくなった（獲得旗数で判定）";
  game.log.push(reasonPrefix + (game.winner !== null ? "プレイヤー" + (game.winner + 1) + "が旗数で優勢。" : "互角のまま終戦。"));
}

function forceLoseByTimeout(game, playerIdx) {
  if (game.gameOver) return;
  game.gameOver = true;
  game.winner = 1 - playerIdx;
  game.reason = "プレイヤー" + (playerIdx + 1) + "の持ち時間切れ";
  game.log.push("プレイヤー" + (playerIdx + 1) + "の持ち時間が切れた。プレイヤー" + (game.winner + 1) + "の勝利。");
}

function hasLegalPlacement(game, idx) {
  return game.flags.some((f) => f.claimedBy === null && f.slots[idx].length < capacity(f));
}
function canPass(game, idx) {
  if (game.gameOver || game.turnPhase !== "play") return false;
  return game.hands[idx].length === 0 || !hasLegalPlacement(game, idx);
}

function beginTurn(game) {
  if (game.gameOver) return;
  game.turnPhase = "claim";
  game.pendingDraw = null;
}

function switchTurn(game) {
  game.current = 1 - game.current;
  beginTurn(game);
}

function err(msg) { return { ok: false, error: msg }; }
function ok() { return { ok: true }; }

function assertPlayPhase(game, playerIdx) {
  if (game.gameOver) return "対局は終了しています。";
  if (game.pendingScout) return "偵察の処理が終わっていません。";
  if (game.pendingVassal) return "家臣の処理が終わっていません。";
  if (game.pendingDraw) return "まず山札を選択してください。";
  if (game.current !== playerIdx) return "相手の手番です。";
  if (game.turnPhase !== "play") return "先に旗の確保／ドローを済ませてください。";
  return null;
}

function assertTacticsLimit(game, playerIdx) {
  if (game.tacticsPlayed[playerIdx] > game.tacticsPlayed[1 - playerIdx]) {
    return "戦術カードの使用上限（相手の使用数+1枚）に達しているため、これ以上は使用できません。";
  }
  return null;
}

function assertLeaderLimit(game, playerIdx, cardType) {
  if ((cardType === "alexander" || cardType === "darius") && game.leaderUsed[playerIdx]) {
    return "アレクサンダー大王とダリウスは、1人につきどちらか1枚しか使用できません。";
  }
  return null;
}

function suitName(id) { return id ? SUIT_BY_ID[id].name : "無所属"; }

// ---- Claim / draw phase ---------------------------------------------------

function claimFlag(game, playerIdx, flagIndex) {
  if (game.gameOver) return err("対局は終了しています。");
  if (game.pendingScout || game.pendingVassal) return err("処理中の効果があります。");
  if (game.current !== playerIdx) return err("相手の手番です。");
  if (game.turnPhase !== "claim") return err("旗の確保は、ドローする前のフェーズでのみ行えます。");
  if (!canManuallyClaim(game, flagIndex, playerIdx)) return err("この旗はまだ確保できません。");
  const flag = game.flags[flagIndex];
  const formation = bestFormation(withMerchantBonus(flag.slots[playerIdx], flag, playerIdx));
  flag.claimedBy = playerIdx;
  flag.formation = formation.label + "（宣言確保）";
  game.log.push("プレイヤー" + (playerIdx + 1) + "が第" + flag.num + "旗を宣言により確保した。");
  game.consecutivePasses = 0;
  applyVictoryIfAny(game);
  return ok();
}

function proceedToDraw(game, playerIdx) {
  if (game.gameOver) return err("対局は終了しています。");
  if (game.current !== playerIdx) return err("相手の手番です。");
  if (game.turnPhase !== "claim") return err("すでにドローの段階に進んでいます。");
  const troopAvail = game.troopDeck.length > 0;
  const tacticsAvail = game.tacticsDeck.length > 0;
  if (!troopAvail && !tacticsAvail) { game.turnPhase = "play"; return ok(); }
  if (troopAvail && tacticsAvail) { game.pendingDraw = { player: playerIdx }; return ok(); }
  const c = troopAvail ? game.troopDeck.shift() : game.tacticsDeck.shift();
  game.hands[playerIdx].push(c);
  game.turnPhase = "play";
  return ok();
}

function chooseDrawSource(game, playerIdx, source) {
  if (!game.pendingDraw || game.pendingDraw.player !== playerIdx) return err("山札選択の必要はありません。");
  const deck = source === "tactics" ? game.tacticsDeck : game.troopDeck;
  if (deck.length === 0) return err("その山札は空です。");
  game.hands[playerIdx].push(deck.shift());
  game.pendingDraw = null;
  game.turnPhase = "play";
  return ok();
}

function passTurn(game, playerIdx) {
  const e = assertPlayPhase(game, playerIdx); if (e) return err(e);
  if (!canPass(game, playerIdx)) return err("まだ配置できるカードがあります。");
  game.log.push("プレイヤー" + (playerIdx + 1) + "はカードを配置できず、手番をパスした。");
  game.consecutivePasses = (game.consecutivePasses || 0) + 1;
  if (game.consecutivePasses >= 2) { endGameByTally(game, "両者が連続してパスした。"); return ok(); }
  switchTurn(game);
  return ok();
}

// ---- Move handlers ---------------------------------------------------------

function playTroop(game, playerIdx, handIndex, flagIndex) {
  const e = assertPlayPhase(game, playerIdx); if (e) return err(e);
  const card = game.hands[playerIdx][handIndex];
  if (!card || card.kind !== "troop") return err("不正な手札です。");
  const flag = game.flags[flagIndex];
  if (!flag || flag.claimedBy !== null) return err("その旗はもう決着しています。");
  if (flag.slots[playerIdx].length >= capacity(flag)) return err("これ以上配置できません。");
  game.hands[playerIdx].splice(handIndex, 1);
  flag.slots[playerIdx].push({ kind: "troop", id: card.id, suit: card.suit, value: card.value });
  game.consecutivePasses = 0;
  game.log.push("プレイヤー" + (playerIdx + 1) + "が第" + flag.num + "旗に" + suitName(card.suit) + "『" + card.value + "』を配置。");
  resolveFlag(game, flagIndex);
  if (!applyVictoryIfAny(game)) switchTurn(game);
  return ok();
}

function playWild(game, playerIdx, handIndex, flagIndex, declaredSuit, declaredValue) {
  const e = assertPlayPhase(game, playerIdx); if (e) return err(e);
  const tl = assertTacticsLimit(game, playerIdx); if (tl) return err(tl);
  const card = game.hands[playerIdx][handIndex];
  if (!card || card.kind !== "tactics") return err("不正な手札です。");
  const meta = TACTICS_META[card.type];
  if (!meta || (meta.kind !== "wild-full" && meta.kind !== "wild-num")) return err("この札は部隊カードとして使えません。");
  const ll = assertLeaderLimit(game, playerIdx, card.type); if (ll) return err(ll);
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
  if (card.type === "alexander" || card.type === "darius") game.leaderUsed[playerIdx] = true;
  game.consecutivePasses = 0;
  const label = meta.name + (suit ? "（" + suitName(suit) + "『" + value + "』として）" : "（『" + value + "』として）");
  game.log.push("プレイヤー" + (playerIdx + 1) + "が第" + flag.num + "旗に" + label + "を配置。");
  resolveFlag(game, flagIndex);
  if (!applyVictoryIfAny(game)) switchTurn(game);
  return ok();
}

function playMimic(game, playerIdx, handIndex, flagIndex, sourceFlagIdx, sourceSlotIdx) {
  const e = assertPlayPhase(game, playerIdx); if (e) return err(e);
  const tl = assertTacticsLimit(game, playerIdx); if (tl) return err(tl);
  const card = game.hands[playerIdx][handIndex];
  if (!card || card.kind !== "tactics" || card.type !== "reinforcement") return err("不正な手札です。");
  const srcFlag = game.flags[sourceFlagIdx];
  if (!srcFlag) return err("コピー元の旗が不正です。");
  if (flagIsImmune(srcFlag)) return err("その列は戦術カードの対象になりません。");
  const oppIdx = 1 - playerIdx;
  const source = srcFlag.slots[oppIdx][sourceSlotIdx];
  if (!source || source.suit === null || source.suit === undefined) return err("コピーできる相手の札がありません。");
  const flag = game.flags[flagIndex];
  if (!flag || flag.claimedBy !== null) return err("その旗はもう決着しています。");
  if (flag.slots[playerIdx].length >= capacity(flag)) return err("これ以上配置できません。");
  game.hands[playerIdx].splice(handIndex, 1);
  flag.slots[playerIdx].push({ kind: "troop", id: card.id, suit: source.suit, value: source.value, wild: "reinforcement" });
  game.tacticsPlayed[playerIdx]++;
  game.consecutivePasses = 0;
  game.log.push("プレイヤー" + (playerIdx + 1) + "が「援軍」で第" + flag.num + "旗に" + suitName(source.suit) + "『" + source.value + "』を配置。");
  resolveFlag(game, flagIndex);
  if (!applyVictoryIfAny(game)) switchTurn(game);
  return ok();
}

function playEnvironment(game, playerIdx, handIndex, flagIndex) {
  const e = assertPlayPhase(game, playerIdx); if (e) return err(e);
  const tl = assertTacticsLimit(game, playerIdx); if (tl) return err(tl);
  const card = game.hands[playerIdx][handIndex];
  if (!card || card.kind !== "tactics") return err("不正な手札です。");
  const meta = TACTICS_META[card.type];
  if (!meta || meta.kind !== "env") return err("この札は旗に配置できません。");
  const flag = game.flags[flagIndex];
  if (!flag || flag.claimedBy !== null) return err("その旗はもう決着しています。");
  if (flag.effect) return err("その旗にはすでに効果札が置かれています。");
  game.hands[playerIdx].splice(handIndex, 1);
  flag.effect = { type: card.type, owner: card.type === "merchant" ? playerIdx : null };
  game.discardTactics.push(card);
  game.tacticsPlayed[playerIdx]++;
  game.consecutivePasses = 0;
  game.log.push("プレイヤー" + (playerIdx + 1) + "が第" + flag.num + "旗に「" + meta.name + "」を発動。");
  resolveFlag(game, flagIndex);
  if (!applyVictoryIfAny(game)) switchTurn(game);
  return ok();
}

function playScout(game, playerIdx, handIndex, sources) {
  const e = assertPlayPhase(game, playerIdx); if (e) return err(e);
  const tl = assertTacticsLimit(game, playerIdx); if (tl) return err(tl);
  const card = game.hands[playerIdx][handIndex];
  if (!card || card.kind !== "tactics" || card.type !== "scout") return err("不正な手札です。");
  if (!Array.isArray(sources) || sources.length === 0) return err("引く山札を指定してください。");
  game.hands[playerIdx].splice(handIndex, 1);
  game.discardTactics.push(card);
  game.tacticsPlayed[playerIdx]++;
  game.consecutivePasses = 0;
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
  game.log.push("プレイヤー" + (playerIdx + 1) + "が「偵察」を発動し、" + drawn.length + "枚を確認中。");
  return ok();
}

function resolveScout(game, playerIdx, keepIndex, placements) {
  if (!game.pendingScout || game.pendingScout.player !== playerIdx) return err("偵察の処理はありません。");
  const drawn = game.pendingScout.drawn;
  if (!Number.isInteger(keepIndex) || keepIndex < 0 || keepIndex >= drawn.length) return err("不正な選択です。");
  const others = drawn.map((d, i) => i).filter((i) => i !== keepIndex);
  if (!Array.isArray(placements) || placements.length !== others.length) return err("戻す札の行き先を指定してください。");
  const seen = new Set();
  for (const p of placements) {
    if (!p || typeof p.index !== "number" || !others.includes(p.index) || seen.has(p.index)) return err("不正な指定です。");
    if (p.dest !== "top" && p.dest !== "bottom") return err("戻す位置はtop/bottomで指定してください。");
    seen.add(p.index);
  }
  game.hands[playerIdx].push(drawn[keepIndex].card);
  placements.forEach((p) => {
    const d = drawn[p.index];
    const deck = d.source === "troop" ? game.troopDeck : game.tacticsDeck;
    if (p.dest === "top") deck.unshift(d.card); else deck.push(d.card);
  });
  game.log.push("プレイヤー" + (playerIdx + 1) + "は1枚を手札に加え、残り" + others.length + "枚を山札に戻した。");
  game.pendingScout = null;
  switchTurn(game);
  return ok();
}

function playRedeploy(game, playerIdx, handIndex, fromFlagIdx, slotIndex, toFlagIdx) {
  const e = assertPlayPhase(game, playerIdx); if (e) return err(e);
  const tl = assertTacticsLimit(game, playerIdx); if (tl) return err(tl);
  const card = game.hands[playerIdx][handIndex];
  if (!card || card.kind !== "tactics" || card.type !== "redeploy") return err("不正な手札です。");
  const from = game.flags[fromFlagIdx], to = game.flags[toFlagIdx];
  if (!from || !to || fromFlagIdx === toFlagIdx) return err("移動元と移動先の旗を指定してください。");
  if (from.claimedBy !== null || to.claimedBy !== null) return err("決着済みの旗は指定できません。");
  if (flagIsImmune(from) || flagIsImmune(to)) return err("その列は戦術カードの対象になりません。");
  const moving = from.slots[playerIdx][slotIndex];
  if (!moving) return err("移動する札がありません。");
  if (to.slots[playerIdx].length >= capacity(to)) return err("移動先の旗はいっぱいです。");
  game.hands[playerIdx].splice(handIndex, 1);
  game.discardTactics.push(card);
  game.tacticsPlayed[playerIdx]++;
  game.consecutivePasses = 0;
  from.slots[playerIdx].splice(slotIndex, 1);
  to.slots[playerIdx].push(moving);
  game.log.push("プレイヤー" + (playerIdx + 1) + "が「再配置」で第" + from.num + "旗から第" + to.num + "旗へ札を移動。");
  resolveFlag(game, toFlagIdx);
  if (!applyVictoryIfAny(game)) switchTurn(game);
  return ok();
}

function playDeserter(game, playerIdx, handIndex, targetFlagIdx, targetSlotIndex) {
  const e = assertPlayPhase(game, playerIdx); if (e) return err(e);
  const tl = assertTacticsLimit(game, playerIdx); if (tl) return err(tl);
  const card = game.hands[playerIdx][handIndex];
  if (!card || card.kind !== "tactics" || card.type !== "deserter") return err("不正な手札です。");
  const flag = game.flags[targetFlagIdx];
  if (!flag || flag.claimedBy !== null) return err("決着済みの旗は指定できません。");
  if (flagIsImmune(flag)) return err("その列は戦術カードの対象になりません。");
  const oppIdx = 1 - playerIdx;
  const target = flag.slots[oppIdx][targetSlotIndex];
  if (!target) return err("除外する札がありません。");
  game.hands[playerIdx].splice(handIndex, 1);
  game.discardTactics.push(card);
  game.tacticsPlayed[playerIdx]++;
  game.consecutivePasses = 0;
  flag.slots[oppIdx].splice(targetSlotIndex, 1);
  if (!target.wild) game.discardedTroopKeys.push(target.suit + "-" + target.value);
  game.log.push("プレイヤー" + (playerIdx + 1) + "が「離反工作」で第" + flag.num + "旗の相手の札を除外。");
  if (!applyVictoryIfAny(game)) switchTurn(game);
  return ok();
}

function playBribe(game, playerIdx, handIndex) {
  const e = assertPlayPhase(game, playerIdx); if (e) return err(e);
  const tl = assertTacticsLimit(game, playerIdx); if (tl) return err(tl);
  const card = game.hands[playerIdx][handIndex];
  if (!card || card.kind !== "tactics" || card.type !== "bribe") return err("不正な手札です。");
  game.hands[playerIdx].splice(handIndex, 1);
  game.discardTactics.push(card);
  game.tacticsPlayed[playerIdx]++;
  game.consecutivePasses = 0;
  const oppIdx = 1 - playerIdx;
  if (game.hands[oppIdx].length > 0) {
    const idx = Math.floor(Math.random() * game.hands[oppIdx].length);
    const stolen = game.hands[oppIdx].splice(idx, 1)[0];
    game.hands[playerIdx].push(stolen);
    game.log.push("プレイヤー" + (playerIdx + 1) + "が「買収」で相手の手札を1枚奪った。");
  } else {
    game.log.push("プレイヤー" + (playerIdx + 1) + "が「買収」を発動したが、相手の手札がなかった。");
  }
  switchTurn(game);
  return ok();
}

function playMasquerade(game, playerIdx, handIndex, giveCardId) {
  const e = assertPlayPhase(game, playerIdx); if (e) return err(e);
  const tl = assertTacticsLimit(game, playerIdx); if (tl) return err(tl);
  const card = game.hands[playerIdx][handIndex];
  if (!card || card.kind !== "tactics" || card.type !== "masquerade") return err("不正な手札です。");
  if (!giveCardId || giveCardId === card.id) return err("手放す自分の手札を指定してください。");
  const giveIdx = game.hands[playerIdx].findIndex((c) => c.id === giveCardId);
  if (giveIdx === -1) return err("その手札は見つかりません。");
  game.hands[playerIdx].splice(handIndex, 1);
  game.discardTactics.push(card);
  game.tacticsPlayed[playerIdx]++;
  game.consecutivePasses = 0;
  const giveIdx2 = game.hands[playerIdx].findIndex((c) => c.id === giveCardId);
  const oppIdx = 1 - playerIdx;
  if (game.hands[oppIdx].length > 0) {
    const given = game.hands[playerIdx].splice(giveIdx2, 1)[0];
    const ridx = Math.floor(Math.random() * game.hands[oppIdx].length);
    const received = game.hands[oppIdx].splice(ridx, 1)[0];
    game.hands[oppIdx].push(given);
    game.hands[playerIdx].push(received);
    game.log.push("プレイヤー" + (playerIdx + 1) + "が「仮面舞踏会」で手札を交換した。");
  } else {
    game.log.push("プレイヤー" + (playerIdx + 1) + "が「仮面舞踏会」を発動したが、相手の手札がなく不発だった。");
  }
  switchTurn(game);
  return ok();
}

function playRenovate(game, playerIdx, handIndex, targetFlagIdx, targetSlotIndex) {
  const e = assertPlayPhase(game, playerIdx); if (e) return err(e);
  const tl = assertTacticsLimit(game, playerIdx); if (tl) return err(tl);
  const card = game.hands[playerIdx][handIndex];
  if (!card || card.kind !== "tactics" || card.type !== "renovate") return err("不正な手札です。");
  const flag = game.flags[targetFlagIdx];
  if (!flag || flag.claimedBy !== null) return err("決着済みの旗は指定できません。");
  if (flagIsImmune(flag)) return err("その列は戦術カードの対象になりません。");
  const mine = flag.slots[playerIdx][targetSlotIndex];
  if (!mine) return err("廃棄する自分の札がありません。");
  game.hands[playerIdx].splice(handIndex, 1);
  game.discardTactics.push(card);
  game.tacticsPlayed[playerIdx]++;
  game.consecutivePasses = 0;
  flag.slots[playerIdx].splice(targetSlotIndex, 1);
  if (!mine.wild) game.discardedTroopKeys.push(mine.suit + "-" + mine.value);
  if (game.troopDeck.length > 0) game.hands[playerIdx].push(game.troopDeck.shift());
  game.log.push("プレイヤー" + (playerIdx + 1) + "が「改築」で第" + flag.num + "旗の自分の札を廃棄し、部隊カードを1枚引いた。");
  switchTurn(game);
  return ok();
}

function playVassal(game, playerIdx, handIndex) {
  const e = assertPlayPhase(game, playerIdx); if (e) return err(e);
  const tl = assertTacticsLimit(game, playerIdx); if (tl) return err(tl);
  const card = game.hands[playerIdx][handIndex];
  if (!card || card.kind !== "tactics" || card.type !== "vassal") return err("不正な手札です。");
  game.hands[playerIdx].splice(handIndex, 1);
  game.discardTactics.push(card);
  game.tacticsPlayed[playerIdx]++;
  game.consecutivePasses = 0;
  if (game.tacticsDeck.length === 0) {
    game.log.push("プレイヤー" + (playerIdx + 1) + "が「家臣」を発動したが、戦術山札が空だった。");
    switchTurn(game);
    return ok();
  }
  const top = game.tacticsDeck.shift();
  game.pendingVassal = { player: playerIdx, card: top };
  game.log.push("プレイヤー" + (playerIdx + 1) + "が「家臣」を発動し、戦術山札の一番上を確認中。");
  return ok();
}

function resolveVassal(game, playerIdx, choice) {
  if (!game.pendingVassal || game.pendingVassal.player !== playerIdx) return err("家臣の処理はありません。");
  const top = game.pendingVassal.card;
  if (choice === "keep") {
    game.hands[playerIdx].push(top);
    game.log.push("プレイヤー" + (playerIdx + 1) + "は戦術山札の一番上を手札に加えた。");
  } else {
    game.discardTactics.push(top);
    game.log.push("プレイヤー" + (playerIdx + 1) + "は戦術山札の一番上を捨てた。");
  }
  game.pendingVassal = null;
  switchTurn(game);
  return ok();
}

module.exports = {
  SUITS, SUIT_BY_ID, TACTICS_META, ALL_TACTICS_TYPES,
  createGame, capacity, evaluateFormation, compareFormations, bestFormation,
  resolveFlag, checkVictory, canManuallyClaim, claimableFlags, hasLegalPlacement, canPass,
  forceLoseByTimeout,
  claimFlag, proceedToDraw, chooseDrawSource, passTurn,
  playTroop, playWild, playMimic, playEnvironment,
  playScout, resolveScout, playRedeploy, playDeserter,
  playBribe, playMasquerade, playRenovate, playVassal, resolveVassal
};
