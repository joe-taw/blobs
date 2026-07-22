// Blobs — real-time multiplayer trick-taking game server
// Authoritative game state lives here. Clients only ever see their own hand.

const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
app.use(cors());
app.get('/', (_req, res) => res.send('Blobs server is running.'));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

const PORT = process.env.PORT || 3001;

// ---------- Game constants ----------

const SUITS = ['S', 'H', 'D', 'C'];
const SUIT_NAME = { S: 'Spades', H: 'Hearts', D: 'Diamonds', C: 'Clubs' };
const RANK_NAME = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };

// 16 rounds: cards dealt, whether a trump is drawn, whether bidding is blind
const ROUNDS = [
  { cards: 7, trump: true, blind: false },
  { cards: 6, trump: true, blind: false },
  { cards: 5, trump: true, blind: false },
  { cards: 4, trump: true, blind: false },
  { cards: 3, trump: true, blind: false },
  { cards: 2, trump: true, blind: false },
  { cards: 1, trump: true, blind: false },
  { cards: 2, trump: true, blind: false },
  { cards: 3, trump: true, blind: false },
  { cards: 4, trump: true, blind: false },
  { cards: 5, trump: true, blind: false },
  { cards: 6, trump: true, blind: false },
  { cards: 7, trump: true, blind: false },
  { cards: 7, trump: false, blind: false },
  { cards: 7, trump: true, blind: true },
  { cards: 7, trump: false, blind: true }
];

const rooms = {}; // roomCode -> room state
const EMOTE_PHRASES = ['I was alright', 'Fence Sitter'];

function rankLabel(r) { return RANK_NAME[r] || String(r); }
function cardLabel(c) { return `${rankLabel(c.rank)}${c.suit}`; }

function freshDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (let rank = 2; rank <= 14; rank++) deck.push({ suit, rank });
  }
  return deck;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function makeRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms[code]);
  return code;
}

function publicPlayers(room) {
  return room.players.map((p, i) => ({
    id: p.id,
    name: p.name,
    connected: p.connected,
    isBot: !!p.isBot,
    isHost: i === room.hostIndex,
    isDealer: i === room.dealerIndex,
    handCount: p.hand ? p.hand.length : 0,
    bid: room.phase === 'bidding_blind_hidden' ? null : (p.bid === undefined ? null : p.bid),
    tricksWon: p.tricksWon || 0,
    score: p.score || 0,
    rematchStatus: room.phase === 'rematch_pending'
      ? (room.rematchResponses[p.id] === true ? 'accepted' : room.rematchResponses[p.id] === false ? 'declined' : 'waiting')
      : null
  }));
}

function roundInfo(room) {
  if (room.round < 1) return null;
  const def = ROUNDS[room.round - 1];
  return { number: room.round, totalRounds: ROUNDS.length, cards: def.cards, hasTrump: def.trump, blind: def.blind };
}

// Build a personalized state payload for a given player and emit to everyone in the room
function broadcastState(room) {
  const def = room.round >= 1 ? ROUNDS[room.round - 1] : null;
  const handsHidden = def && def.blind && room.phase === 'bidding';

  for (const p of room.players) {
    const payload = {
      roomCode: room.code,
      phase: room.phase,
      players: publicPlayers(room),
      you: p.id,
      round: roundInfo(room),
      trumpSuit: room.trumpSuit || null,
      currentTrick: room.currentTrick.map(t => ({ playerId: t.playerId, card: t.card })),
      turnPlayerId: room.turnIndex != null ? room.players[room.turnIndex].id : null,
      biddingPlayerId: room.biddingIndex != null ? room.players[room.biddingIndex].id : null,
      dealerId: room.players[room.dealerIndex] ? room.players[room.dealerIndex].id : null,
      leaderId: room.trickLeaderIndex != null ? room.players[room.trickLeaderIndex].id : null,
      forbiddenBid: room.forbiddenBidForCurrentBidder,
      yourHand: handsHidden ? null : (p.hand || []).slice().sort(cardSortKey),
      lastTrickWinnerId: room.lastTrickWinnerId || null,
      roundSummary: room.roundSummary || null,
      rematchDeadline: room.rematchDeadline || null,
      cheatingEnabled: !!room.cheatingEnabled,
      log: room.log.slice(-8)
    };
    if (p.socketId) io.to(p.socketId).emit('state', payload);
  }
}

function cardSortKey(a, b) {
  if (a.suit !== b.suit) return SUITS.indexOf(a.suit) - SUITS.indexOf(b.suit);
  return a.rank - b.rank;
}

function addLog(room, text) {
  room.log.push(text);
  if (room.log.length > 50) room.log.shift();
}

function nextIndex(room, i) {
  return (i + 1) % room.players.length;
}

// ---------- Round lifecycle ----------

function startRound(room) {
  const def = ROUNDS[room.round - 1];
  const n = room.players.length;
  const deck = shuffle(freshDeck());

  for (const p of room.players) {
    p.hand = deck.splice(0, def.cards);
    p.bid = undefined;
    p.tricksWon = 0;
  }

  room.deckRemainder = deck;
  room.trumpSuit = null;
  room.currentTrick = [];
  room.trickLeaderIndex = nextIndex(room, room.dealerIndex);
  room.turnIndex = null;
  room.lastTrickWinnerId = null;
  room.roundSummary = null;
  room.cheatersThisRound = new Set();
  room.caughtCheatersThisRound = new Set();

  room.biddingIndex = nextIndex(room, room.dealerIndex);
  room.bidOrder = [];
  for (let i = 0, idx = room.biddingIndex; i < n; i++, idx = nextIndex(room, idx)) room.bidOrder.push(idx);

  room.phase = 'bidding';
  updateForbiddenBid(room);

  addLog(room, `Round ${room.round} begins — ${def.cards} card${def.cards === 1 ? '' : 's'} each${def.trump ? '' : ', no trump'}${def.blind ? ', blind bidding' : ''}.`);
  broadcastState(room);
  maybeTriggerBot(room);
}

function updateForbiddenBid(room) {
  const def = ROUNDS[room.round - 1];
  const isLastBidder = room.bidOrder[room.bidOrder.length - 1] === room.biddingIndex;
  if (!isLastBidder) { room.forbiddenBidForCurrentBidder = null; return; }
  const sumSoFar = room.players.reduce((s, p) => s + (p.bid || 0), 0);
  room.forbiddenBidForCurrentBidder = def.cards - sumSoFar;
}

function allBidsIn(room) {
  return room.players.every(p => p.bid !== undefined && p.bid !== null);
}

function drawTrump(room) {
  const def = ROUNDS[room.round - 1];
  if (!def.trump) { room.trumpSuit = null; return; }
  if (room.deckRemainder.length === 0) {
    // Shouldn't happen with <=6 players, but guard anyway
    room.trumpSuit = SUITS[Math.floor(Math.random() * SUITS.length)];
    return;
  }
  const card = room.deckRemainder.pop();
  room.trumpSuit = card.suit;
}

function beginPlay(room) {
  drawTrump(room);
  room.phase = 'playing';
  room.turnIndex = room.trickLeaderIndex;
  const def = ROUNDS[room.round - 1];
  addLog(room, def.trump ? `Trump is ${SUIT_NAME[room.trumpSuit]}.` : `No trump this round.`);
}

function legalCards(hand, currentTrick, trumpSuit) {
  if (currentTrick.length === 0) return hand.slice();
  const ledSuit = currentTrick[0].card.suit;
  const haveLed = hand.filter(c => c.suit === ledSuit);
  return haveLed.length > 0 ? haveLed : hand.slice();
}

// ---------- Bot (computer opponent) AI ----------

const BOT_NAMES = ['Blob Byte', 'Blob Cleo', 'Blob Wren', 'Blob Otto', 'Blob Finch'];

function makeBot(index) {
  return {
    id: `bot_${Math.random().toString(36).slice(2, 10)}`,
    socketId: null,
    isBot: true,
    name: BOT_NAMES[index % BOT_NAMES.length],
    connected: true,
    hand: [],
    score: 0,
    tricksWon: 0
  };
}

function cardBeats(challenger, current, ledSuit, trumpSuit) {
  const chTrump = trumpSuit && challenger.suit === trumpSuit;
  const curTrump = trumpSuit && current.suit === trumpSuit;
  if (chTrump && !curTrump) return true;
  if (chTrump && curTrump) return challenger.rank > current.rank;
  if (!chTrump && curTrump) return false;
  if (challenger.suit === ledSuit && current.suit === ledSuit) return challenger.rank > current.rank;
  if (challenger.suit === ledSuit && current.suit !== ledSuit) return true;
  return false;
}

function currentTrickWinningCard(trick, trumpSuit) {
  const ledSuit = trick[0].card.suit;
  let winner = trick[0].card;
  for (const t of trick.slice(1)) {
    if (cardBeats(t.card, winner, ledSuit, trumpSuit)) winner = t.card;
  }
  return winner;
}

function botDecideBid(room, playerIndex) {
  const def = ROUNDS[room.round - 1];
  const player = room.players[playerIndex];
  const n = room.players.length;
  let estimate;

  if (def.blind) {
    estimate = Math.round(def.cards / n);
  } else {
    let score = 0;
    for (const c of player.hand) {
      if (c.rank >= 13) score += 1;       // King or Ace
      else if (c.rank === 12) score += 0.5; // Queen
    }
    estimate = Math.round(score);
  }
  estimate = Math.max(0, Math.min(def.cards, estimate));

  const isLastBidder = room.bidOrder[room.bidOrder.length - 1] === playerIndex;
  if (isLastBidder) {
    const sumSoFar = room.players.reduce((s, p) => s + (p.bid || 0), 0);
    const forbidden = def.cards - sumSoFar;
    if (estimate === forbidden) {
      estimate = estimate + 1 <= def.cards ? estimate + 1 : Math.max(0, estimate - 1);
    }
  }
  return estimate;
}

function botDecideCard(room, playerIndex) {
  const player = room.players[playerIndex];
  const legal = legalCards(player.hand, room.currentTrick, room.trumpSuit);
  const needsMore = (player.tricksWon || 0) < (player.bid || 0);

  if (room.currentTrick.length === 0) {
    const sorted = legal.slice().sort((a, b) => a.rank - b.rank);
    return needsMore ? sorted[sorted.length - 1] : sorted[0];
  }

  const ledSuit = room.currentTrick[0].card.suit;
  const winningCard = currentTrickWinningCard(room.currentTrick, room.trumpSuit);
  const winners = legal.filter(c => cardBeats(c, winningCard, ledSuit, room.trumpSuit));

  if (needsMore && winners.length > 0) {
    return winners.slice().sort((a, b) => a.rank - b.rank)[0];
  }
  const dumpOrder = legal.slice().sort((a, b) => {
    const aTrump = room.trumpSuit && a.suit === room.trumpSuit;
    const bTrump = room.trumpSuit && b.suit === room.trumpSuit;
    if (aTrump !== bTrump) return aTrump ? 1 : -1;
    return a.rank - b.rank;
  });
  return dumpOrder[0];
}

function maybeTriggerBot(room) {
  if (room.phase === 'bidding' && room.biddingIndex != null) {
    const p = room.players[room.biddingIndex];
    if (p && p.isBot) {
      const idx = room.biddingIndex;
      setTimeout(() => {
        if (room.phase !== 'bidding' || room.biddingIndex !== idx) return;
        commitBid(room, idx, botDecideBid(room, idx));
      }, 900 + Math.random() * 700);
    }
  } else if (room.phase === 'playing' && room.turnIndex != null) {
    const p = room.players[room.turnIndex];
    if (p && p.isBot) {
      const idx = room.turnIndex;
      setTimeout(() => {
        if (room.phase !== 'playing' || room.turnIndex !== idx) return;
        commitPlay(room, idx, botDecideCard(room, idx));
      }, 900 + Math.random() * 700);
    }
  }
}

function resolveTrick(room) {
  const ledSuit = room.currentTrick[0].card.suit;
  let winner = room.currentTrick[0];
  for (const play of room.currentTrick.slice(1)) {
    const w = winner.card, c = play.card;
    const cIsTrump = room.trumpSuit && c.suit === room.trumpSuit;
    const wIsTrump = room.trumpSuit && w.suit === room.trumpSuit;
    if (cIsTrump && !wIsTrump) winner = play;
    else if (cIsTrump && wIsTrump && c.rank > w.rank) winner = play;
    else if (!cIsTrump && !wIsTrump && c.suit === ledSuit && c.rank > w.rank) winner = play;
  }
  const winnerPlayer = room.players.find(p => p.id === winner.playerId);
  winnerPlayer.tricksWon = (winnerPlayer.tricksWon || 0) + 1;
  room.lastTrickWinnerId = winnerPlayer.id;
  addLog(room, `${winnerPlayer.name} wins the trick.`);

  const winnerIndex = room.players.findIndex(p => p.id === winner.playerId);
  room.trickLeaderIndex = winnerIndex;
  room.currentTrick = [];

  const cardsLeft = winnerPlayer.hand.length;
  if (cardsLeft === 0) {
    room.phase = 'scoring';
    room.turnIndex = null;
    broadcastState(room);
    setTimeout(() => finishRound(room), 4000);
  } else {
    room.turnIndex = winnerIndex;
    broadcastState(room);
    maybeTriggerBot(room);
  }
}

function finishRound(room) {
  const summary = [];
  for (const p of room.players) {
    const cheated = room.cheatersThisRound && room.cheatersThisRound.has(p.id);
    const caught = room.caughtCheatersThisRound && room.caughtCheatersThisRound.has(p.id);
    const hit = p.bid === p.tricksWon;
    const points = caught ? 0 : (hit ? 10 + p.bid : 0);
    p.score = (p.score || 0) + points;
    summary.push({ id: p.id, name: p.name, bid: p.bid, tricksWon: p.tricksWon, points, hit, cheated, caught });
  }
  room.roundSummary = summary;
  room.phase = 'round_end';
  room.currentTrick = [];
  room.turnIndex = null;
  addLog(room, `Round ${room.round} complete.`);
  broadcastState(room);
}

function advanceToNextRound(room) {
  if (room.round >= ROUNDS.length) {
    room.phase = 'game_over';
    addLog(room, 'The game is over!');
    broadcastState(room);
    return;
  }
  room.round += 1;
  room.dealerIndex = nextIndex(room, room.dealerIndex);
  startRound(room);
}

function commitBid(room, idx, n) {
  room.players[idx].bid = n;
  addLog(room, `${room.players[idx].name} bids ${n}.`);

  const pos = room.bidOrder.indexOf(room.biddingIndex);
  if (pos === room.bidOrder.length - 1) {
    beginPlay(room);
    broadcastState(room);
    maybeTriggerBot(room);
  } else {
    room.biddingIndex = room.bidOrder[pos + 1];
    updateForbiddenBid(room);
    broadcastState(room);
    maybeTriggerBot(room);
  }
}

function commitPlay(room, idx, card, cheated = false) {
  const player = room.players[idx];
  const match = player.hand.find(c => c.suit === card.suit && c.rank === card.rank);
  if (!match) return; // shouldn't happen; caller is responsible for resolving a real hand card

  player.hand = player.hand.filter(c => !(c.suit === card.suit && c.rank === card.rank));
  room.currentTrick.push({ playerId: player.id, card: match });
  if (cheated) room.cheatersThisRound.add(player.id);
  addLog(room, `${player.name} plays ${cardLabel(match)}.`);

  if (room.currentTrick.length === room.players.length) {
    broadcastState(room);
    setTimeout(() => resolveTrick(room), 1200);
  } else {
    room.turnIndex = nextIndex(room, room.turnIndex);
    broadcastState(room);
    maybeTriggerBot(room);
  }
}

function endGameEarly(room, logMessage) {
  room.phase = 'game_over';
  room.turnIndex = null;
  room.biddingIndex = null;
  room.currentTrick = [];
  addLog(room, logMessage);
  broadcastState(room);
}

function startRematchVote(room) {
  const hostPlayer = room.players[room.hostIndex];
  room.rematchResponses = {};
  for (const p of room.players) {
    if (p.isBot) room.rematchResponses[p.id] = true;
  }
  room.rematchResponses[hostPlayer.id] = true; // host auto-accepts by starting the vote
  room.rematchDeadline = Date.now() + 30000;
  room.phase = 'rematch_pending';
  addLog(room, `${hostPlayer.name} wants to start a new game — waiting up to 30s for everyone to accept.`);
  broadcastState(room);
  if (room.rematchTimer) clearTimeout(room.rematchTimer);
  room.rematchTimer = setTimeout(() => finalizeRematch(room), 30000);
}

function checkRematchComplete(room) {
  const allResponded = room.players.every(p => room.rematchResponses[p.id] !== undefined);
  if (allResponded) {
    if (room.rematchTimer) clearTimeout(room.rematchTimer);
    finalizeRematch(room);
  }
}

function finalizeRematch(room) {
  if (room.phase !== 'rematch_pending') return;
  const accepted = room.players.filter(p => room.rematchResponses[p.id] === true);
  const declined = room.players.filter(p => room.rematchResponses[p.id] !== true);

  for (const p of declined) {
    if (p.socketId) {
      io.to(p.socketId).emit('kicked', { message: "The new game started without you since you didn't accept in time." });
      const s = io.sockets.sockets.get(p.socketId);
      if (s) s.leave(room.code);
    }
  }

  if (accepted.length < 2) {
    room.rematchDeadline = null;
    room.phase = 'game_over';
    addLog(room, 'Not enough players accepted the rematch — staying on final scores.');
    broadcastState(room);
    return;
  }

  const oldHostId = room.players[room.hostIndex].id;
  room.players = accepted.map(p => ({ ...p, hand: [], bid: undefined, tricksWon: 0, score: 0 }));
  room.hostIndex = Math.max(0, room.players.findIndex(p => p.id === oldHostId));
  room.rematchResponses = {};
  room.rematchDeadline = null;
  room.dealerIndex = Math.floor(Math.random() * room.players.length);
  room.round = 1;
  addLog(room, 'New game starting!');
  startRound(room);
}

// ---------- Socket handling ----------

io.on('connection', (socket) => {
  socket.on('create_room', ({ name }) => {
    const code = makeRoomCode();
    const room = {
      code,
      players: [],
      hostIndex: 0,
      dealerIndex: 0,
      round: 0,
      phase: 'lobby',
      currentTrick: [],
      log: []
    };
    rooms[code] = room;
    joinRoom(socket, room, name);
  });

  socket.on('join_room', ({ roomCode, name }) => {
    const room = rooms[(roomCode || '').toUpperCase()];
    if (!room) return socket.emit('error_message', { message: 'Room not found.' });
    if (room.phase !== 'lobby') return socket.emit('error_message', { message: 'That game has already started.' });
    if (room.players.length >= 6) return socket.emit('error_message', { message: 'Room is full (6 players max).' });
    joinRoom(socket, room, name);
  });

  function joinRoom(socket, room, name) {
    const player = {
      id: `p_${Math.random().toString(36).slice(2, 10)}`,
      socketId: socket.id,
      name: (name || 'Player').slice(0, 20),
      connected: true,
      hand: [],
      score: 0,
      tricksWon: 0
    };
    room.players.push(player);
    socket.join(room.code);
    socket.data.roomCode = room.code;
    socket.data.playerId = player.id;
    socket.emit('joined', { roomCode: room.code, playerId: player.id });
    broadcastState(room);
  }

  socket.on('start_game', ({ botCount, cheatingEnabled } = {}) => {
    const room = getRoom(socket);
    if (!room) return;
    const idx = room.players.findIndex(p => p.id === socket.data.playerId);
    if (idx !== room.hostIndex) return socket.emit('error_message', { message: 'Only the host can start the game.' });

    const bots = Math.max(0, Math.min(5, Number(botCount) || 0));
    const humanCount = room.players.length;
    if (humanCount + bots < 2) return socket.emit('error_message', { message: 'Need at least 2 players total.' });
    if (humanCount + bots > 6) return socket.emit('error_message', { message: 'A maximum of 6 players total (humans + computer opponents).' });

    for (let i = 0; i < bots; i++) room.players.push(makeBot(i));

    room.cheatingEnabled = !!cheatingEnabled;
    room.dealerIndex = Math.floor(Math.random() * room.players.length);
    room.round = 1;
    startRound(room);
  });

  socket.on('submit_bid', ({ bid }) => {
    const room = getRoom(socket);
    if (!room || (room.phase !== 'bidding')) return;
    const idx = room.players.findIndex(p => p.id === socket.data.playerId);
    if (idx !== room.biddingIndex) return socket.emit('error_message', { message: 'Not your turn to bid.' });
    const def = ROUNDS[room.round - 1];
    const n = Number(bid);
    if (!Number.isInteger(n) || n < 0 || n > def.cards) {
      return socket.emit('error_message', { message: `Bid must be between 0 and ${def.cards}.` });
    }
    const isLastBidder = room.bidOrder[room.bidOrder.length - 1] === room.biddingIndex;
    if (isLastBidder && n === room.forbiddenBidForCurrentBidder) {
      return socket.emit('error_message', { message: `As last bidder, you cannot bid ${n} (bids can't total ${def.cards}).` });
    }
    commitBid(room, idx, n);
  });

  socket.on('play_card', ({ card }) => {
    const room = getRoom(socket);
    if (!room || room.phase !== 'playing') return;
    const idx = room.players.findIndex(p => p.id === socket.data.playerId);
    if (idx !== room.turnIndex) return socket.emit('error_message', { message: 'Not your turn.' });
    const player = room.players[idx];
    const legal = legalCards(player.hand, room.currentTrick, room.trumpSuit);
    let match = legal.find(c => c.suit === card.suit && c.rank === card.rank);
    let cheated = false;

    if (!match && room.cheatingEnabled) {
      const anyHandMatch = player.hand.find(c => c.suit === card.suit && c.rank === card.rank);
      if (anyHandMatch) {
        match = anyHandMatch;
        const ledSuit = room.currentTrick.length > 0 ? room.currentTrick[0].card.suit : null;
        const hadLedSuit = ledSuit ? player.hand.some(c => c.suit === ledSuit) : false;
        cheated = ledSuit && hadLedSuit && match.suit !== ledSuit;
      }
    }

    if (!match) return socket.emit('error_message', { message: 'You must follow suit if you can.' });
    commitPlay(room, idx, match, cheated);
  });

  socket.on('send_emote', ({ phrase }) => {
    const room = getRoom(socket);
    if (!room || !EMOTE_PHRASES.includes(phrase)) return;
    const player = room.players.find(p => p.id === socket.data.playerId);
    if (!player) return;
    io.to(room.code).emit('emote', { playerId: player.id, phrase });
  });

  socket.on('accuse_cheating', () => {
    const room = getRoom(socket);
    if (!room || !room.cheatingEnabled) return;
    if (room.phase !== 'playing') {
      return socket.emit('error_message', { message: 'You can only call that out while cards are being played.' });
    }
    const accuser = room.players.find(p => p.id === socket.data.playerId);
    if (!accuser) return;

    io.to(room.code).emit('emote', { playerId: accuser.id, phrase: 'Someone is definitely cheating!' });

    const uncaught = [...room.cheatersThisRound].filter(id => !room.caughtCheatersThisRound.has(id));
    if (uncaught.length > 0) {
      uncaught.forEach(id => room.caughtCheatersThisRound.add(id));
      const names = uncaught.map(id => room.players.find(p => p.id === id)?.name || 'someone').join(', ');
      addLog(room, `🚨 ${accuser.name} caught ${names} cheating! They'll score 0 this round.`);
    } else {
      accuser.score = (accuser.score || 0) - 1;
      addLog(room, `${accuser.name} accused someone of cheating, but no one was — 1 point deducted.`);
    }
    broadcastState(room);
  });

  socket.on('next_round', () => {
    const room = getRoom(socket);
    if (!room || room.phase !== 'round_end') return;
    const idx = room.players.findIndex(p => p.id === socket.data.playerId);
    if (idx !== room.hostIndex) return;
    advanceToNextRound(room);
  });

  socket.on('end_game', () => {
    const room = getRoom(socket);
    if (!room) return;
    const idx = room.players.findIndex(p => p.id === socket.data.playerId);
    if (idx !== room.hostIndex) return socket.emit('error_message', { message: 'Only the host can end the game.' });
    if (!['bidding', 'playing', 'scoring', 'round_end'].includes(room.phase)) return;
    endGameEarly(room, `${room.players[idx].name} ended the game early.`);
  });

  socket.on('request_rematch', () => {
    const room = getRoom(socket);
    if (!room || room.phase !== 'game_over') return;
    const idx = room.players.findIndex(p => p.id === socket.data.playerId);
    if (idx !== room.hostIndex) return socket.emit('error_message', { message: 'Only the host can start a new game.' });
    startRematchVote(room);
  });

  socket.on('rematch_response', ({ accept }) => {
    const room = getRoom(socket);
    if (!room || room.phase !== 'rematch_pending') return;
    const idx = room.players.findIndex(p => p.id === socket.data.playerId);
    if (idx < 0) return;
    room.rematchResponses[room.players[idx].id] = !!accept;
    addLog(room, `${room.players[idx].name} ${accept ? 'accepted' : 'declined'} the new game.`);
    broadcastState(room);
    checkRematchComplete(room);
  });

  socket.on('disconnect', () => {
    const room = getRoom(socket);
    if (!room) return;
    const p = room.players.find(pl => pl.socketId === socket.id);
    if (p) { p.connected = false; broadcastState(room); }
  });

  function getRoom(socket) {
    const code = socket.data.roomCode;
    return code ? rooms[code] : null;
  }
});

server.listen(PORT, () => console.log(`Blobs server listening on port ${PORT}`));
