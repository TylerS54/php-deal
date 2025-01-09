const { onCall, HttpsError } = require('firebase-functions/v2/https');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');
const { FieldValue } = require('firebase-admin/firestore');
admin.initializeApp();

/** 1) Generate 5-character game ID, e.g. 'A12Z7'. */
function generateShortId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  for (let i = 0; i < 5; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/** 2) Create Game */
exports.createGame = onCall(async (request) => {
  const { hostUid, playerIds } = request.data;
  if (!hostUid || !playerIds) {
    throw new HttpsError('invalid-argument', 'Must provide hostUid and playerIds.');
  }

  // Shuffle deck
  const deck = shuffleDeck(createMonopolyDealDeck());

  // 5 starting cards each
  const startingHands = {};
  playerIds.forEach((pId) => {
    startingHands[pId] = deck.splice(0, 5);
  });

  // Prepare the new doc
  const newGame = {
    hostUid,
    playerIds,            // array of usernames
    deck,
    discardPile: [],
    turnIndex: 0,
    createdAt: FieldValue.serverTimestamp(),
    status: 'inProgress',
    hands: startingHands,
    properties: {},
  };

  // Generate a short ID, then store with that ID as the doc.
  const shortId = generateShortId();
  const gameRef = admin.firestore().collection('games').doc(shortId);
  await gameRef.set(newGame);

  logger.info(`Game created with ID: ${shortId}`);
  return { gameId: shortId };
});

/** 3) Play Move */
exports.playMove = onCall(async (request) => {
  const { gameId, move } = request.data;
  if (!gameId || !move) {
    throw new HttpsError('invalid-argument', 'gameId and move are required.');
  }

  const gameRef = admin.firestore().collection('games').doc(gameId);

  return admin.firestore().runTransaction(async (transaction) => {
    const doc = await transaction.get(gameRef);
    if (!doc.exists) {
      throw new HttpsError('not-found', 'Game does not exist.');
    }

    const gameData = doc.data();
    const { playerIds, turnIndex, hands, properties } = gameData;

    // Check turn
    if (move.playerId !== playerIds[turnIndex]) {
      throw new HttpsError('failed-precondition', 'Not your turn!');
    }

    // Example: playing a property
    if (move.actionType === 'PLAY_PROPERTY') {
      // remove from hand
      const cardIndex = hands[move.playerId].findIndex((c) => c.id === move.card.id);
      if (cardIndex === -1) {
        throw new HttpsError('failed-precondition', 'Card not in hand.');
      }
      const [playedCard] = hands[move.playerId].splice(cardIndex, 1);

      // move card to properties
      if (!properties[move.playerId]) {
        properties[move.playerId] = {};
      }
      if (!properties[move.playerId][move.color]) {
        properties[move.playerId][move.color] = [];
      }
      properties[move.playerId][move.color].push(playedCard);
    }

    // rotate turn
    gameData.turnIndex = (turnIndex + 1) % playerIds.length;

    transaction.set(gameRef, gameData);
    return { success: true };
  });
});

/** Creates an array of Monopoly Deal cards (simplified example). */
function createMonopolyDealDeck() {
  return [
    { id: 'p-red-1', type: 'property', color: 'red' },
    { id: 'p-red-2', type: 'property', color: 'red' },
    // ... etc ...
  ];
}

/** Shuffle function */
function shuffleDeck(deck) {
  let m = deck.length;
  while (m) {
    const i = Math.floor(Math.random() * m--);
    [deck[m], deck[i]] = [deck[i], deck[m]];
  }
  return deck;
}
