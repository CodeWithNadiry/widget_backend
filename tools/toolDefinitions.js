// ─── Tool Definitions ──────────────────────────────────────────────────────
// Each tool follows the OpenAI-compatible format Qwen expects.
// property_id is NEVER included — always injected server-side from session.

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
      "Fetch a reservation's full details (status, passcode hint, payment link, tasks). Use this first whenever the guest asks about their booking, wants to resend a confirmation form, payment link, or access details. THREE MUTUALLY EXCLUSIVE modes — use exactly ONE per call: (A) reservationId ONLY — Apaleo confirmation id e.g. ABC-1. (B) phoneLast4 ONLY — exactly 4 digits. (C) lastName + dateOfBirth (YYYY-MM-DD) + roomNumber — all three together. Never mix fields across modes.",
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
      "List available rate plans for given arrival, departure, and adults. Always call this before createBooking. Infer adults from room intent (single=1, double=2, triple=3). Dates must be YYYY-MM-DD; departure must be after arrival.",
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
          description: "Number of adults 1–10",
        },
      },
    },
  },
};

const createBooking = {
  type: "function",
  function: {
    name: "createBooking",
    description:
      "Create a reservation after the guest picks a ratePlanId from getOffers. Collect firstName, lastName, phone in E.164 format; email is optional. Always confirm spelling for email if given.",
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
        arrival: {
          type: "string",
          description: "YYYY-MM-DD",
        },
        departure: {
          type: "string",
          description: "YYYY-MM-DD",
        },
        adults: {
          type: "integer",
          description: "Number of adults 1–10",
        },
        ratePlanId: {
          type: "string",
          description: "From getOffers e.g. RPL-SINGLE-STD",
        },
        guestFirstName: {
          type: "string",
          description: "Guest first name",
        },
        guestLastName: {
          type: "string",
          description: "Guest last name",
        },
        guestPhone: {
          type: "string",
          description: "E.164 format e.g. +491234567890",
        },
        guestEmail: {
          type: "string",
          description: "Optional. Valid email address.",
        },
      },
    },
  },
};

const checkIn = {
  type: "function",
  function: {
    name: "checkIn",
    description:
      "Perform check-in for a reservation. Rules: no negative folio balance; earliest check-in is 14:00 on arrival day. Confirm reservationId with the guest before calling.",
    parameters: {
      type: "object",
      required: ["reservationId"],
      properties: {
        reservationId: {
          type: "string",
          description: "Apaleo reservation id e.g. ABC-1",
        },
      },
    },
  },
};

const checkOut = {
  type: "function",
  function: {
    name: "checkOut",
    description:
      "Check out a guest. Reservation must be in checked-in (in-house) status and balance must not be negative.",
    parameters: {
      type: "object",
      required: ["reservationId"],
      properties: {
        reservationId: {
          type: "string",
          description: "Apaleo reservation id",
        },
      },
    },
  },
};

const getRoomPasscode = {
  type: "function",
  function: {
    name: "getRoomPasscode",
    description:
      "Return the room keypad passcode after identity verification. Use when the guest is checked in and needs the door code. TWO modes: (A) fullName + dateOfBirth. (B) reservationId + dateOfBirth. If both fullName and reservationId are provided, reservationId takes priority.",
    parameters: {
      type: "object",
      required: ["dateOfBirth"],
      properties: {
        dateOfBirth: {
          type: "string",
          description: "YYYY-MM-DD. Required in both modes.",
        },
        fullName: {
          type: "string",
          description:
            "Mode A: full name as registered. Ignored if reservationId is also set.",
        },
        reservationId: {
          type: "string",
          description:
            "Mode B: Apaleo reservation id. Takes priority over fullName.",
        },
      },
    },
  },
};

const cancelReservation = {
  type: "function",
  function: {
    name: "cancelReservation",
    description:
      "Cancel an existing reservation. Not allowed if the guest has already checked out. Confirm reservationId before calling.",
    parameters: {
      type: "object",
      required: ["reservationId"],
      properties: {
        reservationId: {
          type: "string",
          description: "Apaleo reservation id e.g. ABC-1",
        },
      },
    },
  },
};

const submitFeedback = {
  type: "function",
  function: {
    name: "submitFeedback",
    description:
      "Submit guest feedback for a reservation. Required: reservationId and overall rating 1–5. Optional: comment and sub-ratings for cleanliness, staff, location, value (each 1–5). Only call after the guest gives at least the overall rating.",
    parameters: {
      type: "object",
      required: ["reservationId", "rating"],
      properties: {
        reservationId: {
          type: "string",
          description: "Apaleo reservation id",
        },
        rating: {
          type: "integer",
          description: "Overall rating 1–5",
        },
        comment: {
          type: "string",
          description: "Optional free-text comment",
        },
        cleanlinessRating: {
          type: "integer",
          description: "Optional 1–5",
        },
        staffRating: {
          type: "integer",
          description: "Optional 1–5",
        },
        locationRating: {
          type: "integer",
          description: "Optional 1–5",
        },
        valueRating: {
          type: "integer",
          description: "Optional 1–5",
        },
      },
    },
  },
};

const sendWhatsappRecovery = {
  type: "function",
  function: {
    name: "sendWhatsappRecovery",
    description:
      "Resend the guest's confirmation form link, payment link, or room passcode via WhatsApp. Only call after reservationId is already resolved via getReservation. messageType values: 'confirmation' = registration form URL, 'payment' = payment link, 'passcode' = door code via e-key flow.",
    parameters: {
      type: "object",
      required: ["reservationId", "messageType"],
      properties: {
        reservationId: {
          type: "string",
          description:
            "Apaleo reservation id already resolved by getReservation",
        },
        messageType: {
          type: "string",
          enum: ["confirmation", "checkin", "payment_reminder", "passcode"],
          description: "confirmation = registration form, checkin = check-in link, payment_reminder = payment URL, passcode = door code",
        },
        idempotencyKey: {
          type: "string",
          description: "Optional. Short unique key to prevent duplicate sends.",
        },
      },
    },
  },
};

// ─── Exports ────────────────────────────────────────────────────────────────

export const toolDefinitions = {
  // used during awaitingProperty state only
  selectProperty,

  // all tools available once property is locked (active state)
  all: [
    getReservation,
    getOffers,
    createBooking,
    checkIn,
    checkOut,
    getRoomPasscode,
    cancelReservation,
    submitFeedback,
    sendWhatsappRecovery,
  ],
};
