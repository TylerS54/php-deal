const { onCall, HttpsError } = require('firebase-functions/v2/https');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');
const { FieldValue } = require('firebase-admin/firestore');

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
 * - status = 'lobby'
 * - Add an empty 'bank' for each player, empty 'hands', empty 'properties'.
 * - We'll also track 'numPlaysThisTurn' so we know how many the current player has played so far.
 */
exports.createGame = onCall(async (request) => {
  const { hostUid, playerIds } = request.data;
  if (!hostUid || !Array.isArray(playerIds) || playerIds.length === 0) {
    throw new HttpsError(
      'invalid-argument',
      'Must provide hostUid and a non-empty array of playerIds.'
    );
  }

  const fullDeck = createMonopolyDealDeck();
  const deck = shuffleDeck(fullDeck);

  // Start with empty hands, bank, properties
  const hands = {};
  const bank = {};
  const properties = {};

  playerIds.forEach((p) => {
    hands[p] = [];       // No cards initially
    bank[p] = [];        // No banked cards
    properties[p] = {};  // color -> []
  });

  const shortId = generateShortId();
  const gameRef = admin.firestore().collection('games').doc(shortId);

  const newGame = {
    hostUid,               // The host's name or UID
    playerIds,             // e.g. ["Alice", "Bob"]
    deck,                  // ~110 shuffled cards
    discardPile: [],
    createdAt: FieldValue.serverTimestamp(),
    status: 'lobby',       // <--- "lobby"
    hands,
    bank,
    properties,
    turnIndex: 0,
    numPlaysThisTurn: 0,   // track how many cards have been played by current player
  };

  await gameRef.set(newGame);
  logger.info(`Game created with ID: ${shortId}`);
  return { gameId: shortId };
});

/**
 * startGame:
 * - Host triggers this to confirm the final player list, deal 5 cards each,
 *   then status => 'inProgress'.
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

    gameData.status = 'inProgress';
    gameData.turnIndex = 0;
    gameData.numPlaysThisTurn = 0;

    transaction.set(gameRef, gameData);
    return { success: true };
  });
});

/**
 * playMove:
 * - Typical Monopoly Deal logic each turn:
 *   - If it's the start of your turn, draw 2 cards from the deck.
 *   - You can PLAY a card (property, action, or money to bank),
 *     as long as you haven't played 3 cards yet.
 *   - You can END your turn at any time.
 *   - On end-turn, if you have more than 7 cards, you must discard down to 7.
 *   - Then turn passes to the next player (who then draws 2).
 *
 * We'll implement this with an "actionType" field:
 *   - "BEGIN_TURN": draws 2
 *   - "PLAY_CARD": plays or banks a single card (if not exceeded 3 plays)
 *   - "END_TURN": finalize turn, discard if needed, move turnIndex
 *   - For property: can't bank it. For action/money/rent: can bank or use action, etc.
 */
exports.playMove = onCall(async (request) => {
  const { gameId, move } = request.data;
  if (!gameId || !move || !move.actionType) {
    throw new HttpsError(
      'invalid-argument',
      'Must provide gameId and a move with actionType.'
    );
  }
  const gameRef = admin.firestore().collection('games').doc(gameId);

  return admin.firestore().runTransaction(async (transaction) => {
    const docSnap = await transaction.get(gameRef);
    if (!docSnap.exists) {
      throw new HttpsError('not-found', 'Game does not exist.');
    }
    const gameData = docSnap.data();
    const {
      status,
      deck,
      discardPile,
      playerIds,
      turnIndex,
      hands,
      properties,
      bank,
      numPlaysThisTurn,
    } = gameData;

    if (status !== 'inProgress') {
      throw new HttpsError(
        'failed-precondition',
        'Cannot play a move unless game is in progress.'
      );
    }

    const currentPlayerId = playerIds[turnIndex];

    if (move.playerId !== currentPlayerId) {
      throw new HttpsError('failed-precondition', 'Not your turn!');
    }

    // Handle each actionType:
    switch (move.actionType) {
      case 'BEGIN_TURN':
        // Draw 2 from deck
        if (!deck || deck.length < 2) {
          throw new HttpsError('failed-precondition', 'Not enough cards in deck to draw 2.');
        }
        hands[currentPlayerId].push(deck.shift());
        hands[currentPlayerId].push(deck.shift());
        // reset plays for turn
        gameData.numPlaysThisTurn = 0;
        break;

      case 'PLAY_CARD': {
        // Enforce max 3 plays
        if (numPlaysThisTurn >= 3) {
          throw new HttpsError(
            'failed-precondition',
            'You have already played 3 cards this turn.'
          );
        }
        const { card, playAs, color } = move; 
        // "playAs" might be "property" or "bank"
        // or for an action card, "action" or "bank"

        // Make sure the card is actually in the player's hand
        const cardIndex = hands[currentPlayerId].findIndex((c) => c.id === card.id);
        if (cardIndex === -1) {
          throw new HttpsError('failed-precondition', 'Card not in hand.');
        }
        // Remove from hand
        const [theCard] = hands[currentPlayerId].splice(cardIndex, 1);

        if (playAs === 'bank') {
          // Put in bank, but only if it's NOT a property
          if (theCard.type === 'property' || theCard.type === 'property-wild') {
            throw new HttpsError(
              'failed-precondition',
              'Properties cannot be banked!'
            );
          }
          bank[currentPlayerId].push(theCard);
        } else if (playAs === 'property') {
          // For property or property-wild
          // If it's a normal property
          if (theCard.type === 'property' || theCard.type === 'property-wild') {
            const propColor = color || theCard.color || 'any';
            if (!properties[currentPlayerId][propColor]) {
              properties[currentPlayerId][propColor] = [];
            }
            properties[currentPlayerId][propColor].push(theCard);
          } else {
            // It's an action or money or rent card, if user tries to place it as property => not possible
            throw new HttpsError(
              'failed-precondition',
              'Non-property cannot be played as property.'
            );
          }
        } else if (playAs === 'action') {
          // e.g. "Just say no", "sly deal", "rent card", etc.
          // For now, we'll just discard it. (Real logic would do something more elaborate.)
          discardPile.push(theCard);
        } else {
          // unrecognized
          throw new HttpsError(
            'invalid-argument',
            'Must provide a valid "playAs" type.'
          );
        }

        gameData.numPlaysThisTurn = numPlaysThisTurn + 1;
        break;
      }

      case 'END_TURN':
        // If > 7 cards in hand, force discard
        while (hands[currentPlayerId].length > 7) {
          discardPile.push(hands[currentPlayerId].pop());
        }
        // Move turn to next player
        gameData.turnIndex = (turnIndex + 1) % playerIds.length;
        // Reset plays
        gameData.numPlaysThisTurn = 0;
        break;

      default:
        throw new HttpsError('invalid-argument', 'Unknown actionType.');
    }

    // Save changes
    transaction.set(gameRef, gameData);
    return { success: true, newState: gameData };
  });
});

/**
 * createMonopolyDealDeck:
 *  -> Here you would add "title" to each card object
 *  -> e.g. title: 'Deal Breaker' for action-deal-breaker
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
      id: 'action-deal-breaker-1',
      title: 'Deal Breaker',
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
      title:'Just Say No',
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
      title:'Sly Deal',
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
      title:'Force Deal',
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
      title:'Debt Correct',
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
      title:'Its My Birthday',
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
      title:'Pass Go',
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
      title:'House',
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
      title:'Hotel',
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
      title:'Double The Rent',
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
      title:'Brown Property',
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
      title:'DarkBlue Property',
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
      title:'Green Property',
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
      title:'LightBlue Property',
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
      title:'Orange Property',
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
      title:'Purple Property',
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
      title:'Railroad Property',
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
      title:'Red Property',
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
      title:'Utility Property',
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
      title:'Yellow Property',
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
      title:'Purple/Orange Wild',
      type: 'property-wild',
      colors: ['purple', 'orange'],
      value: 2,
      imageUrl: '/cards/wild-purple-orange.jpg',
    });
  }

  // 1 Light Blue and Brown (value = 1M)
  deck.push({
    id: 'wild-lightblue-brown',
    title:'LightBlue/Brown Wild',
    type: 'property-wild',
    colors: ['lightblue', 'brown'],
    value: 1,
    imageUrl: '/cards/wild-lightblue-brown.jpg',
  });

  // 1 Light Blue and Railroad (value = 4M)
  deck.push({
    id: 'wild-lightblue-railroad',
    title:'LightBlue/Railroad Wild',
    type: 'property-wild',
    colors: ['lightblue', 'railroad'],
    value: 4,
    imageUrl: '/cards/wild-lightblue-railroad.jpg',
  });

  // 1 Dark Blue and Green (value = 4M)
  deck.push({
    id: 'wild-darkblue-green',
    title:'DarkBlue/Green Wild',
    type: 'property-wild',
    colors: ['darkblue', 'green'],
    value: 4,
    imageUrl: '/cards/wild-darkblue-green.jpg',
  });

  // 1 Railroad and Green (value = 4M)
  deck.push({
    id: 'wild-railroad-green',
    title:'Green/Railroad Wild',
    type: 'property-wild',
    colors: ['railroad', 'green'],
    value: 4,
    imageUrl: '/cards/wild-railroad-green.jpg',
  });

  // 2 Red and Yellow (value = 3M)
  for (let i = 1; i <= 2; i++) {
    deck.push({
      id: `wild-red-yellow-${i}`,
      title:'Red/Yellow Wild',
      type: 'property-wild',
      colors: ['red', 'yellow'],
      value: 3,
      imageUrl: '/cards/wild-red-yellow.jpg',
    });
  }

  // 1 Utility and Railroad (value = 4M)
  deck.push({
    id: 'wild-utility-railroad',
    title:'Utility/Railroad Wild',
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
      title:'HOLY FUCK Wild',
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
      title:'Purple/Orange Rent',
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
      title:'Railroad/Utility Rent',
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
      title:'Green/DarkBlue Rent',
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
      title:'Brown/LightBlue Rent',
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
      title:'Red/Yellow Rent',
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
      title:'HOLY FUCK Rent',
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
    title:'$10M',
    type: 'money',
    value: 10,
    imageUrl: '/cards/money-10.jpg',
  });

  // $5M x 2
  for (let i = 1; i <= 2; i++) {
    deck.push({
      id: `money-5-${i}`,
      title:'$5M',
      type: 'money',
      value: 5,
      imageUrl: '/cards/money-5.jpg',
    });
  }

  // $4M x 3
  for (let i = 1; i <= 3; i++) {
    deck.push({
      id: `money-4-${i}`,
      title:'$4M',
      type: 'money',
      value: 4,
      imageUrl: '/cards/money-4.jpg',
    });
  }

  // $3M x 3
  for (let i = 1; i <= 3; i++) {
    deck.push({
      id: `money-3-${i}`,
      title:'$3M',
      type: 'money',
      value: 3,
      imageUrl: '/cards/money-3.jpg',
    });
  }

  // $2M x 5
  for (let i = 1; i <= 5; i++) {
    deck.push({
      id: `money-2-${i}`,
      title:'$2M',
      type: 'money',
      value: 2,
      imageUrl: '/cards/money-2.jpg',
    });
  }

  // $1M x 6
  for (let i = 1; i <= 6; i++) {
    deck.push({
      id: `money-1-${i}`,
      title:'$1M (Broke af)',
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
