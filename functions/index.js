const { onCall, HttpsError } = require('firebase-functions/v2/https');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');
const { FieldValue } = require('firebase-admin/firestore');
admin.initializeApp();

// CREATE GAME
exports.createGame = onCall(async (request) => {
  const { hostUid, playerIds } = request.data;
  if (!hostUid || !playerIds) {
    throw new HttpsError('invalid-argument', 'Must provide hostUid and playerIds.');

  }

  // Shuffle deck
  const deck = shuffleDeck(createMonopolyDealDeck());

  // Give 5 starting cards
  const startingHands = {};
  playerIds.forEach((pId) => {
    startingHands[pId] = deck.splice(0, 5);
  });

  const newGame = {
    hostUid,
    playerIds,
    deck,
    discardPile: [],
    turnIndex: 0,
    createdAt: FieldValue.serverTimestamp(),
    status: 'inProgress',
    hands: startingHands,
    properties: {},
  };

  const gameRef = await admin.firestore().collection('games').add(newGame);
  logger.info(`Game created with ID: ${gameRef.id}`);

  return { gameId: gameRef.id };
});

// PLAY MOVE
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

    // e.g. check whose turn it is
    if (move.playerId !== playerIds[turnIndex]) {
      throw new HttpsError('failed-precondition', 'Not your turn!');
    }

    // Example: playing a property
    if (move.actionType === 'PLAY_PROPERTY') {
      // Remove card from hand
      const cardIndex = hands[move.playerId].findIndex(
        (c) => c.id === move.card.id
      );
      if (cardIndex === -1) {
        throw new HttpsError('failed-precondition', 'Card not in hand.');
      }
      const [playedCard] = hands[move.playerId].splice(cardIndex, 1);

      // Move card to properties
      if (!properties[move.playerId]) {
        properties[move.playerId] = {};
      }
      if (!properties[move.playerId][move.color]) {
        properties[move.playerId][move.color] = [];
      }
      properties[move.playerId][move.color].push(playedCard);
    }

    // Check for 3 complete sets, etc.
    // ...

    // Move to next player
    gameData.turnIndex = (turnIndex + 1) % playerIds.length;

    // Update the doc
    transaction.set(gameRef, gameData);
    return { success: true };
  });
});

// Helper functions below...


/** Creates an array of Monopoly Deal cards. Extend as needed. */
function createMonopolyDealDeck() {
  return [
    { id: 'p-red-1', type: 'property', color: 'red' },
    { id: 'p-red-2', type: 'property', color: 'red' },
    // ... fill in an entire deck of ~110 cards for Monopoly Deal
  ];
}

/** Example shuffle function */
function shuffleDeck(deck) {
  let m = deck.length;
  while (m) {
    const i = Math.floor(Math.random() * m--);
    [deck[m], deck[i]] = [deck[i], deck[m]];
  }
  return deck;
}

/** Check if the property color is complete. This is placeholder logic. */
function isCompleteSet(color, cards) {
  // Example: red requires 3
  const setRequirements = {
    red: 3,
    blue: 2,
    green: 3,
    yellow: 3,
    // etc...
  };
  return cards.length >= (setRequirements[color] || 3);
}
