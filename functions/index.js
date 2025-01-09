const { onCall, HttpsError } = require('firebase-functions/v2/https');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');
const { FieldValue } = require('firebase-admin/firestore');

// Initialize Firebase Admin
admin.initializeApp();

/** Generates a short 5-character ID (e.g. 'ABC12'). */
function generateShortId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  for (let i = 0; i < 5; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/**
 * createGame:
 * - Creates a Firestore doc with a shortId as the doc ID.
 * - Deck is fully shuffled, but nobody is dealt cards yet.
 * - status = 'lobby', so it doesn't start automatically.
 */
exports.createGame = onCall(async (request) => {
  const { hostUid, playerIds } = request.data;
  if (!hostUid || !Array.isArray(playerIds) || playerIds.length === 0) {
    throw new HttpsError(
      'invalid-argument',
      'Must provide hostUid and a non-empty array of playerIds.'
    );
  }

  // Build the entire Monopoly Deal deck (~110 cards).
  const fullDeck = createMonopolyDealDeck();
  // Shuffle it
  const deck = shuffleDeck(fullDeck);

  // Start with empty hands:
  const hands = {};

  // Create Firestore doc
  const newGame = {
    hostUid,               // The host's name or UID
    playerIds,             // e.g. ["Alice", "Bob"]
    deck,                  // ~110 shuffled cards
    discardPile: [],
    turnIndex: 0,
    createdAt: FieldValue.serverTimestamp(),
    status: 'lobby',       // <--- important: "lobby" mode
    hands,                 // no cards yet
    properties: {},
  };

  // Short 5-character ID
  const shortId = generateShortId();
  const gameRef = admin.firestore().collection('games').doc(shortId);
  await gameRef.set(newGame);

  logger.info(`Game created with ID: ${shortId}`);
  return { gameId: shortId };
});

/**
 * startGame:
 * - Host triggers this function to deal 5 cards to each player.
 * - Moves status from 'lobby' -> 'inProgress'.
 * - turnIndex starts at 0 (or random, if you like).
 */
exports.startGame = onCall(async (request) => {
  const { gameId } = request.data;
  if (!gameId) {
    throw new HttpsError('invalid-argument', 'Must provide gameId.');
  }

  const gameRef = admin.firestore().collection('games').doc(gameId);
  return admin.firestore().runTransaction(async (transaction) => {
    const docSnap = await transaction.get(gameRef);
    if (!docSnap.exists) {
      throw new HttpsError('not-found', 'Game does not exist.');
    }

    const gameData = docSnap.data();
    if (gameData.status !== 'lobby') {
      throw new HttpsError(
        'failed-precondition',
        'Game is not in lobby status.'
      );
    }

    const { deck, playerIds, hands } = gameData;
    // Deal 5 cards to each player
    playerIds.forEach((pId) => {
      hands[pId] = deck.splice(0, 5);
    });

    // Now set the game to 'inProgress'
    gameData.status = 'inProgress';
    gameData.turnIndex = 0; // or random

    // Write changes
    transaction.set(gameRef, gameData);

    return { success: true };
  });
});

/**
 * playMove:
 * - The same as before. Allows playing a property, rotates turn, etc.
 */
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
    const { playerIds, turnIndex, hands, properties, status } = gameData;

    // Optionally: ensure we're in inProgress, etc.
    if (status !== 'inProgress') {
      throw new HttpsError(
        'failed-precondition',
        'Cannot play a move unless game is in progress.'
      );
    }

    // Check it's that player's turn
    if (move.playerId !== playerIds[turnIndex]) {
      throw new HttpsError('failed-precondition', 'Not your turn!');
    }

    // Example: playing a property
    if (move.actionType === 'PLAY_PROPERTY') {
      // Remove from hand
      const cardIndex = hands[move.playerId].findIndex(
        (c) => c.id === move.card.id
      );
      if (cardIndex === -1) {
        throw new HttpsError('failed-precondition', 'Card not in hand.');
      }
      const [playedCard] = hands[move.playerId].splice(cardIndex, 1);

      // Move to properties
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

/**
 * createMonopolyDealDeck - Full ~110 card deck (below is partial example).
 * Fill it out as needed for real game logic.
 */
/**
 * Returns an array of 106 Monopoly Deal cards, including:
 * - Action cards (with typical face values)
 * - Property cards (with typical face values)
 * - Property wild/wildcard cards
 * - Rent cards
 * - Money cards
 * - Each has an imageUrl, pointing to /cards/<some-name>.jpg
 * If you want different file names, adjust the `imageUrl` as needed.
 */
function createMonopolyDealDeck() {
  const deck = [];

  // ----------------------------------------------------------------------------------
  // 1) ACTION CARDS
  // (Commonly accepted monetary values for these action cards are noted below)
  // ----------------------------------------------------------------------------------
  // 2 Deal Breaker (value = 5M)
  for (let i = 1; i <= 2; i++) {
    deck.push({
      id: `action-deal-breaker-${i}`,
      type: 'action',
      actionType: 'deal-breaker',
      value: 5,
      imageUrl: '/cards/action-deal-breaker.jpg',
    });
  }

  // 3 Just Say No (value = 4M)
  for (let i = 1; i <= 3; i++) {
    deck.push({
      id: `action-just-say-no-${i}`,
      type: 'action',
      actionType: 'just-say-no',
      value: 4,
      imageUrl: '/cards/action-just-say-no.jpg',
    });
  }

  // 3 Sly Deal (value = 3M)
  for (let i = 1; i <= 3; i++) {
    deck.push({
      id: `action-sly-deal-${i}`,
      type: 'action',
      actionType: 'sly-deal',
      value: 3,
      imageUrl: '/cards/action-sly-deal.jpg',
    });
  }

  // 4 Force Deal (value = 3M)
  for (let i = 1; i <= 4; i++) {
    deck.push({
      id: `action-force-deal-${i}`,
      type: 'action',
      actionType: 'force-deal',
      value: 3,
      imageUrl: '/cards/action-force-deal.jpg',
    });
  }

  // 3 Debt Collector (value = 3M)
  for (let i = 1; i <= 3; i++) {
    deck.push({
      id: `action-debt-collector-${i}`,
      type: 'action',
      actionType: 'debt-collector',
      value: 3,
      imageUrl: '/cards/action-debt-collector.jpg',
    });
  }

  // 3 It’s My Birthday (value = 2M)
  for (let i = 1; i <= 3; i++) {
    deck.push({
      id: `action-its-my-birthday-${i}`,
      type: 'action',
      actionType: 'its-my-birthday',
      value: 2,
      imageUrl: '/cards/action-its-my-birthday.jpg',
    });
  }

  // 10 Pass Go (value = 1M)
  for (let i = 1; i <= 10; i++) {
    deck.push({
      id: `action-pass-go-${i}`,
      type: 'action',
      actionType: 'pass-go',
      value: 1,
      imageUrl: '/cards/action-pass-go.jpg',
    });
  }

  // 3 House (value = 3M or 4M depending on edition; 3M is common)
  for (let i = 1; i <= 3; i++) {
    deck.push({
      id: `action-house-${i}`,
      type: 'action',
      actionType: 'house',
      value: 3,
      imageUrl: '/cards/action-house.jpg',
    });
  }

  // 3 Hotel (value = 4M)
  for (let i = 1; i <= 3; i++) {
    deck.push({
      id: `action-hotel-${i}`,
      type: 'action',
      actionType: 'hotel',
      value: 4,
      imageUrl: '/cards/action-hotel.jpg',
    });
  }

  // 2 Double The Rent (value = 1M)
  for (let i = 1; i <= 2; i++) {
    deck.push({
      id: `action-double-rent-${i}`,
      type: 'action',
      actionType: 'double-rent',
      value: 1,
      imageUrl: '/cards/action-double-rent.jpg',
    });
  }

  // ----------------------------------------------------------------------------------
  // 2) PROPERTY CARDS (with typical face values)
  // ----------------------------------------------------------------------------------
  // Brown (value = 1M)
  for (let i = 1; i <= 2; i++) {
    deck.push({
      id: `property-brown-${i}`,
      type: 'property',
      color: 'brown',
      value: 1,
      imageUrl: '/cards/property-brown.jpg',
    });
  }

  // Dark Blue (value = 4M)
  for (let i = 1; i <= 2; i++) {
    deck.push({
      id: `property-darkblue-${i}`,
      type: 'property',
      color: 'darkblue',
      value: 4,
      imageUrl: '/cards/property-darkblue.jpg',
    });
  }

  // Green (value = 4M)
  for (let i = 1; i <= 3; i++) {
    deck.push({
      id: `property-green-${i}`,
      type: 'property',
      color: 'green',
      value: 4,
      imageUrl: '/cards/property-green.jpg',
    });
  }

  // Light Blue (value = 1M)
  for (let i = 1; i <= 3; i++) {
    deck.push({
      id: `property-lightblue-${i}`,
      type: 'property',
      color: 'lightblue',
      value: 1,
      imageUrl: '/cards/property-lightblue.jpg',
    });
  }

  // Orange (value = 2M)
  for (let i = 1; i <= 3; i++) {
    deck.push({
      id: `property-orange-${i}`,
      type: 'property',
      color: 'orange',
      value: 2,
      imageUrl: '/cards/property-orange.jpg',
    });
  }

  // Purple (value = 2M)
  for (let i = 1; i <= 3; i++) {
    deck.push({
      id: `property-purple-${i}`,
      type: 'property',
      color: 'purple',
      value: 2,
      imageUrl: '/cards/property-purple.jpg',
    });
  }

  // Railroad (black) (value = 2M)
  for (let i = 1; i <= 4; i++) {
    deck.push({
      id: `property-railroad-${i}`,
      type: 'property',
      color: 'railroad',
      value: 2,
      imageUrl: '/cards/property-railroad.jpg',
    });
  }

  // Red (value = 3M)
  for (let i = 1; i <= 3; i++) {
    deck.push({
      id: `property-red-${i}`,
      type: 'property',
      color: 'red',
      value: 3,
      imageUrl: '/cards/property-red.jpg',
    });
  }

  // Utility (value = 2M)
  for (let i = 1; i <= 2; i++) {
    deck.push({
      id: `property-utility-${i}`,
      type: 'property',
      color: 'utility',
      value: 2,
      imageUrl: '/cards/property-utility.jpg',
    });
  }

  // Yellow (value = 3M)
  for (let i = 1; i <= 3; i++) {
    deck.push({
      id: `property-yellow-${i}`,
      type: 'property',
      color: 'yellow',
      value: 3,
      imageUrl: '/cards/property-yellow.jpg',
    });
  }

  // ----------------------------------------------------------------------------------
  // 3) PROPERTY WILDCARDS (typical face values can vary; using some popular references)
  // ----------------------------------------------------------------------------------
  // 2 Purple and Orange wildcards (value = 2M each)
  for (let i = 1; i <= 2; i++) {
    deck.push({
      id: `wild-purple-orange-${i}`,
      type: 'property-wild',
      colors: ['purple', 'orange'],
      value: 2,
      imageUrl: '/cards/wild-purple-orange.jpg',
    });
  }

  // 1 Light Blue and Brown (value = 1M)
  deck.push({
    id: 'wild-lightblue-brown',
    type: 'property-wild',
    colors: ['lightblue', 'brown'],
    value: 1,
    imageUrl: '/cards/wild-lightblue-brown.jpg',
  });

  // 1 Light Blue and Railroad (value = 4M)
  deck.push({
    id: 'wild-lightblue-railroad',
    type: 'property-wild',
    colors: ['lightblue', 'railroad'],
    value: 4,
    imageUrl: '/cards/wild-lightblue-railroad.jpg',
  });

  // 1 Dark Blue and Green (value = 4M)
  deck.push({
    id: 'wild-darkblue-green',
    type: 'property-wild',
    colors: ['darkblue', 'green'],
    value: 4,
    imageUrl: '/cards/wild-darkblue-green.jpg',
  });

  // 1 Railroad and Green (value = 4M)
  deck.push({
    id: 'wild-railroad-green',
    type: 'property-wild',
    colors: ['railroad', 'green'],
    value: 4,
    imageUrl: '/cards/wild-railroad-green.jpg',
  });

  // 2 Red and Yellow (value = 3M)
  for (let i = 1; i <= 2; i++) {
    deck.push({
      id: `wild-red-yellow-${i}`,
      type: 'property-wild',
      colors: ['red', 'yellow'],
      value: 3,
      imageUrl: '/cards/wild-red-yellow.jpg',
    });
  }

  // 1 Utility and Railroad (value = 4M)
  deck.push({
    id: 'wild-utility-railroad',
    type: 'property-wild',
    colors: ['utility', 'railroad'],
    value: 4,
    imageUrl: '/cards/wild-utility-railroad.jpg',
  });

  // 2 multi-color wildcards (value = 0~ or 4~? Official can vary. Let's do 0 for any.)
  // Some references put them at 0 or 1. Let's do 0 to emphasize their "any color" power.
  for (let i = 1; i <= 2; i++) {
    deck.push({
      id: `wild-multicolor-${i}`,
      type: 'property-wild',
      colors: ['any'],
      value: 0,
      imageUrl: '/cards/wild-multicolor.jpg',
    });
  }

  // ----------------------------------------------------------------------------------
  // 4) RENT CARDS
  // (These are typically worth 1M or 2M, but can differ by edition. We'll pick 1M.)
  // ----------------------------------------------------------------------------------
  // 2 Purple and Orange rent
  for (let i = 1; i <= 2; i++) {
    deck.push({
      id: `rent-purple-orange-${i}`,
      type: 'rent',
      rentColors: ['purple', 'orange'],
      value: 1,
      imageUrl: '/cards/rent-purple-orange.jpg',
    });
  }
  // 2 Railroad and Utility rent
  for (let i = 1; i <= 2; i++) {
    deck.push({
      id: `rent-railroad-utility-${i}`,
      type: 'rent',
      rentColors: ['railroad', 'utility'],
      value: 1,
      imageUrl: '/cards/rent-railroad-utility.jpg',
    });
  }
  // 2 Green and Dark Blue rent
  for (let i = 1; i <= 2; i++) {
    deck.push({
      id: `rent-green-darkblue-${i}`,
      type: 'rent',
      rentColors: ['green', 'darkblue'],
      value: 1,
      imageUrl: '/cards/rent-green-darkblue.jpg',
    });
  }
  // 2 Brown and Light Blue rent
  for (let i = 1; i <= 2; i++) {
    deck.push({
      id: `rent-brown-lightblue-${i}`,
      type: 'rent',
      rentColors: ['brown', 'lightblue'],
      value: 1,
      imageUrl: '/cards/rent-brown-lightblue.jpg',
    });
  }
  // 2 Red and Yellow rent
  for (let i = 1; i <= 2; i++) {
    deck.push({
      id: `rent-red-yellow-${i}`,
      type: 'rent',
      rentColors: ['red', 'yellow'],
      value: 1,
      imageUrl: '/cards/rent-red-yellow.jpg',
    });
  }
  // 3 multi-color rent (value = 3M)
  for (let i = 1; i <= 3; i++) {
    deck.push({
      id: `rent-any-${i}`,
      type: 'rent',
      rentColors: ['any'],
      value: 3,
      imageUrl: '/cards/rent-any.jpg',
    });
  }

  // ----------------------------------------------------------------------------------
  // 5) MONEY CARDS (value is face value obviously)
  // ----------------------------------------------------------------------------------
  // $10M x 1
  deck.push({
    id: 'money-10-1',
    type: 'money',
    value: 10,
    imageUrl: '/cards/money-10.jpg',
  });

  // $5M x 2
  for (let i = 1; i <= 2; i++) {
    deck.push({
      id: `money-5-${i}`,
      type: 'money',
      value: 5,
      imageUrl: '/cards/money-5.jpg',
    });
  }

  // $4M x 3
  for (let i = 1; i <= 3; i++) {
    deck.push({
      id: `money-4-${i}`,
      type: 'money',
      value: 4,
      imageUrl: '/cards/money-4.jpg',
    });
  }

  // $3M x 3
  for (let i = 1; i <= 3; i++) {
    deck.push({
      id: `money-3-${i}`,
      type: 'money',
      value: 3,
      imageUrl: '/cards/money-3.jpg',
    });
  }

  // $2M x 5
  for (let i = 1; i <= 5; i++) {
    deck.push({
      id: `money-2-${i}`,
      type: 'money',
      value: 2,
      imageUrl: '/cards/money-2.jpg',
    });
  }

  // $1M x 6
  for (let i = 1; i <= 6; i++) {
    deck.push({
      id: `money-1-${i}`,
      type: 'money',
      value: 1,
      imageUrl: '/cards/money-1.jpg',
    });
  }

  return deck;
}


/** Fisher-Yates Shuffle */
function shuffleDeck(deck) {
  let m = deck.length;
  while (m) {
    const i = Math.floor(Math.random() * m--);
    [deck[m], deck[i]] = [deck[i], deck[m]];
  }
  return deck;
}
