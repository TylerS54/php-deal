/**
 * /functions/index.js
 *
 * Example Cloud Functions for Monopoly Deal
 */
const { onCall } = require('firebase-functions/v2/https');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');

// Initialize Admin
admin.initializeApp();

exports.createGame = onCall(async (request) => {
  const { hostUid, playerIds } = request.data;
  if (!hostUid || !playerIds || !Array.isArray(playerIds)) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'Must provide hostUid and an array of player UIDs.'
    );
  }

  // Shuffle a Monopoly Deal deck
  const deck = shuffleDeck(createMonopolyDealDeck());

  // Each player starts with 5 cards
  const startingHands = {};
  playerIds.forEach((pId) => {
    startingHands[pId] = deck.splice(0, 5);
  });

  // Create game doc
  const newGame = {
    hostUid,
    playerIds,
    deck,
    discardPile: [],
    turnIndex: 0, // index into playerIds array
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    status: 'inProgress',
    hands: startingHands, // { [playerId]: [cards...] }
    properties: {},        // { [playerId]: { colorName: [cards], ...} }
  };

  const gameRef = await admin.firestore().collection('games').add(newGame);

  logger.info(`Game created with ID: ${gameRef.id}`);
  return { gameId: gameRef.id };
});

exports.playMove = onCall(async (request) => {
  // Example of a move: { actionType: 'PLAY_PROPERTY', card, color, playerId }
  // Validate and then apply to Firestore doc
  const { gameId, move } = request.data;

  if (!gameId || !move) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'gameId and move are required.'
    );
  }

  const gameRef = admin.firestore().collection('games').doc(gameId);

  return await admin.firestore().runTransaction(async (transaction) => {
    const doc = await transaction.get(gameRef);
    if (!doc.exists) {
      throw new functions.https.HttpsError('not-found', 'Game does not exist.');
    }
    const gameData = doc.data();

    // Validate whose turn it is
    const playerId = move.playerId;
    const currentPlayer = gameData.playerIds[gameData.turnIndex];
    if (playerId !== currentPlayer) {
      throw new functions.https.HttpsError('failed-precondition', 'Not your turn!');
    }

    // TODO: Validate the move type, e.g. "PLAY_PROPERTY", "CHARGE_RENT", etc.
    //       Check the gameData.hands[playerId], ensure that card is available, etc.

    // Example: if action is PLAY_PROPERTY
    if (move.actionType === 'PLAY_PROPERTY') {
      // Remove the card from player’s hand
      const cardIndex = gameData.hands[playerId].findIndex((c) => c.id === move.card.id);
      if (cardIndex === -1) {
        throw new functions.https.HttpsError('failed-precondition', 'Card not in hand.');
      }
      // Move the card to properties
      const [playedCard] = gameData.hands[playerId].splice(cardIndex, 1);
      if (!gameData.properties[playerId]) {
        gameData.properties[playerId] = {};
      }
      if (!gameData.properties[playerId][move.color]) {
        gameData.properties[playerId][move.color] = [];
      }
      gameData.properties[playerId][move.color].push(playedCard);
    }

    // TODO: Possibly decrement the number of actions the player has left if you track it.

    // Check for win condition: 3 complete sets
    const sets = Object.keys(gameData.properties[playerId] || {}).filter((color) => {
      // For example, each color might require a certain # of properties
      // In real rules: Brown needs 2, Dark Blue needs 2, etc.
      return isCompleteSet(color, gameData.properties[playerId][color]);
    });
    if (sets.length >= 3) {
      gameData.status = 'finished';
      gameData.winner = playerId;
    }

    // If the move is finished, pass the turn
    // (Add your logic for limiting 3 plays, etc.)
    // This is a simplistic example: we simply rotate turnIndex
    gameData.turnIndex = (gameData.turnIndex + 1) % gameData.playerIds.length;

    transaction.set(gameRef, gameData);
    return { success: true };
  });
});

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
