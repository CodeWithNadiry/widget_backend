// ─── Tool Definitions ──────────────────────────────────────────────────────
// Each tool follows the OpenAI-compatible format Qwen expects.
// property_id is NEVER included — always injected server-side from session.
//
// NOTE: getRoomPasscode, submitFeedback, and sendWhatsappRecovery have been
// removed entirely — these tools no longer exist anywhere in the system.
//
// NOTE (client requirement — production simplification): checkIn, checkOut,
// and cancelReservation have been removed entirely. The chatbot no longer
// performs online check-in/check-out or cancellations. Guests who ask for
// these are recognized by intent in chatbot.service.js and given a plain-
// text refusal — no tool is ever registered or called for them.
//
// NOTE: createBooking is defined here for documentation/executor reuse only.
// It is intentionally NOT included in `all` — the LLM never sees or calls
// this tool. Booking is completed by deterministic code (see
// handleGuestDetailCollection in chatbot.service.js) only after the guest has
// gone through sequential detail collection and explicitly confirmed. This
// removes booking-with-real-money decisions from LLM judgment entirely.
//
// CHANGE LOG (production simplification pass):
// - Removed checkIn, checkOut, cancelReservation tool definitions (see NOTE
//   above). `all` now only contains getReservation and getOffers.
// - Guest count cap lowered from 10 to 5 across getOffers/createBooking
//   schemas — offers only support up to 5 adults.

const selectProperty = {
  type: "function",
  function: {
    name: "selectProperty",
    description:
      "Call this when the guest has confirmed which property they want. Only call this once per session. Pass the propertyId from the list provided in your context.",
    parameters: {
      type: "object",
      required: ["propertyId"],
      properties: {
        propertyId: {
          type: "string",
          description: "The propertyId of the property the guest confirmed.",
        },
      },
    },
  },
};

const getReservation = {
  type: "function",
  function: {
    name: "getReservation",
    description:
      "Fetch a reservation's full details (status, payment link, tasks). Use this first whenever the guest asks about their booking or wants to resend a confirmation form or payment link. THREE MUTUALLY EXCLUSIVE modes — use exactly ONE per call: (A) reservationId ONLY — Apaleo confirmation id e.g. ABC-1. (B) phoneLast4 ONLY — exactly 4 digits. (C) lastName + dateOfBirth (YYYY-MM-DD) + roomNumber — all three together. Never mix fields across modes. NOTE: if this returns multiple reservations, do NOT ask the guest to repeat identifying details — the app resolves natural references like 'last one', 'the confirmed one', or 'tomorrow's booking' automatically before your next turn.",
    parameters: {
      type: "object",
      properties: {
        reservationId: {
          type: "string",
          description:
            "Mode A ONLY: Apaleo reservation id. Leave other fields unset.",
        },
        phoneLast4: {
          type: "string",
          description:
            "Mode B ONLY: Last 4 digits of guest phone. Leave other fields unset.",
        },
        lastName: {
          type: "string",
          description:
            "Mode C ONLY: Guest last name. Send with dateOfBirth AND roomNumber.",
        },
        dateOfBirth: {
          type: "string",
          description:
            "Mode C ONLY: YYYY-MM-DD. Send with lastName AND roomNumber.",
        },
        roomNumber: {
          type: "string",
          description:
            "Mode C ONLY: Room number as known to guest e.g. 101. Send with lastName AND dateOfBirth.",
        },
      },
    },
  },
};

const getOffers = {
  type: "function",
  function: {
    name: "getOffers",
    description:
      "List available rate plans for given arrival, departure, and adults. Infer adults from room intent (single=1, double=2, triple=3). Dates must be YYYY-MM-DD; departure must be after arrival. Offers only support up to 5 adults. Once this returns, the app shows the offers to the guest and handles the rest of the booking flow automatically — you do not need (and cannot) call createBooking yourself.",
    parameters: {
      type: "object",
      required: ["arrival", "departure", "adults"],
      properties: {
        arrival: {
          type: "string",
          description: "Check-in date YYYY-MM-DD",
        },
        departure: {
          type: "string",
          description: "Check-out date YYYY-MM-DD (must be after arrival)",
        },
        adults: {
          type: "integer",
          description: "Number of adults 1–5",
          minimum: 1,
          maximum: 5,
        },
      },
    },
  },
};

// Not passed to the LLM (see note above) — kept here purely as a documented
// schema, since the executor's createBooking implementation still expects
// these exact field names when called directly from code.
const createBooking = {
  type: "function",
  function: {
    name: "createBooking",
    description:
      "[CODE-INVOKED ONLY — never exposed to the model] Create a reservation after the guest has confirmed their details.",
    parameters: {
      type: "object",
      required: [
        "arrival",
        "departure",
        "adults",
        "ratePlanId",
        "guestFirstName",
        "guestLastName",
        "guestPhone",
      ],
      properties: {
        arrival: { type: "string", description: "YYYY-MM-DD" },
        departure: { type: "string", description: "YYYY-MM-DD" },
        adults: {
          type: "integer",
          description: "Number of adults 1–5",
          minimum: 1,
          maximum: 5,
        },
        ratePlanId: { type: "string", description: "From getOffers e.g. RPL-SINGLE-STD" },
        guestFirstName: { type: "string", description: "Guest first name" },
        guestLastName: { type: "string", description: "Guest last name" },
        guestPhone: { type: "string", description: "E.164 format e.g. +491234567890" },
        guestEmail: { type: "string", description: "Valid email address." },
      },
    },
  },
};

// ─── Exports ────────────────────────────────────────────────────────────────

export const toolDefinitions = {
  // used during awaitingProperty state only
  selectProperty,

  // Kept for the executor / documentation only — NOT passed to the model.
  createBooking,

  // all tools the LLM is allowed to call once a property is locked (active state).
  // createBooking is deliberately excluded — see note above. checkIn, checkOut,
  // and cancelReservation have been removed entirely per the production
  // simplification — they no longer exist as tools anywhere in the system.
  all: [getReservation, getOffers],
};