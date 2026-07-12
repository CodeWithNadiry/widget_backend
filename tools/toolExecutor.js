import { AppError } from "../utils/AppError.js";

const BASE_URL = "https://api.innolink.technology/api/pms/apaleo/properties";

/**
 * Executes a tool call from the LLM.
 * propertyId is ALWAYS injected from the session — never from LLM tool input.
 */
export async function executeTool({ toolName, toolInput, session, property }) {
  const propertyId = property.apaleoCode;

  if (!propertyId) {
    throw new AppError("Property not selected. Cannot execute tool.", 400);
  }

  const headers = {
    "X-API-Key": property.apiKey,
    "X-Source": "voice_ai",
    "Content-Type": "application/json",
  };

  switch (toolName) {
    case "getReservation":
      return await getReservation({ propertyId, toolInput, headers });
    case "getOffers":
      return await getOffers({ propertyId, toolInput, headers });
    case "createBooking":
      return await createBooking({ propertyId, toolInput, headers });
    case "checkIn":
      return await checkIn({ propertyId, toolInput, headers });
    case "checkOut":
      return await checkOut({ propertyId, toolInput, headers });
    case "getRoomPasscode":
      return await getRoomPasscode({ propertyId, toolInput, headers });
    case "cancelReservation":
      return await cancelReservation({ propertyId, toolInput, headers });
    case "submitFeedback":
      return await submitFeedback({ propertyId, toolInput, headers });
    case "sendWhatsappRecovery":
      return await sendWhatsappRecovery({ propertyId, toolInput, headers });
    default:
      throw new AppError(`Unknown tool: ${toolName}`, 400);
  }
}

// ─── Tool implementations ──────────────────────────────────────────────────

async function getReservation({ propertyId, toolInput, headers }) {
  const {
    reservationId = "",
    phoneLast4 = "",
    lastName = "",
    dateOfBirth = "",
    roomNumber = "",
  } = toolInput;

  const params = new URLSearchParams();
  if (reservationId) params.set("reservation_id", reservationId);
  if (phoneLast4) params.set("phone_last4", phoneLast4);
  if (lastName) params.set("last_name", lastName);
  if (dateOfBirth) params.set("date_of_birth", dateOfBirth);
  if (roomNumber) params.set("room_number", roomNumber);

  return await apiCall(
    `${BASE_URL}/${propertyId}/voice/reservation?${params.toString()}`,
    { method: "GET", headers },
  );
}

async function getOffers({ propertyId, toolInput, headers }) {
  const { arrival, departure, adults } = toolInput;
  const params = new URLSearchParams({ arrival, departure, adults });
  const url = `${BASE_URL}/${propertyId}/voice/offers?${params.toString()}`;
  const result = await apiCall(url, { method: "GET", headers });

  // Return ONLY what the model needs — force it to use exact ratePlanId
  if (result?.offers) {
    return {
      offers: result.offers.map((offer) => ({
        ratePlanId: offer.rate_plan_id, // renamed to match createBooking param
        name: offer.name,
        amount: offer.total_amount?.amount,
        currency: offer.total_amount?.currency,
        roomName: offer.unit_group.name,
        IMPORTANT: `You MUST pass ratePlanId="${offer.rate_plan_id}" to createBooking. This is the only valid value.`,
      })),
    };
  }

  return result;
}

async function createBooking({ propertyId, toolInput, headers }) {
  const {
    arrival,
    departure,
    adults,
    ratePlanId,
    guestFirstName,
    guestLastName,
    guestPhone,
    guestEmail,
  } = toolInput;

  return await apiCall(`${BASE_URL}/${propertyId}/voice/bookings`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      arrival,
      departure,
      adults,
      rate_plan_id: ratePlanId,
      source: "voice_ai",
      guest: {
        first_name: guestFirstName,
        last_name: guestLastName,
        phone: guestPhone,
        email: guestEmail || null,
      },
    }),
  });
}

async function checkIn({ propertyId, toolInput, headers }) {
  const { reservationId } = toolInput;
  return await apiCall(
    `${BASE_URL}/${propertyId}/voice/reservations/${reservationId}/check-in`,
    { method: "POST", headers },
  );
}

async function checkOut({ propertyId, toolInput, headers }) {
  const { reservationId } = toolInput;
  return await apiCall(
    `${BASE_URL}/${propertyId}/voice/reservations/${reservationId}/check-out`,
    { method: "POST", headers },
  );
}

async function getRoomPasscode({ propertyId, toolInput, headers }) {
  const { dateOfBirth, fullName, reservationId } = toolInput;
  return await apiCall(`${BASE_URL}/${propertyId}/voice/room-passcode`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      date_of_birth: dateOfBirth,
      full_name: fullName || "",
      reservation_id: reservationId || "",
    }),
  });
}

async function cancelReservation({ propertyId, toolInput, headers }) {
  const { reservationId } = toolInput;
  return await apiCall(
    `${BASE_URL}/${propertyId}/voice/reservations/${reservationId}/cancel`,
    { method: "POST", headers },
  );
}

async function submitFeedback({ propertyId, toolInput, headers }) {
  const {
    reservationId,
    rating,
    comment = "",
    cleanlinessRating,
    staffRating,
    locationRating,
    valueRating,
  } = toolInput;

  return await apiCall(
    `${BASE_URL}/${propertyId}/voice/reservations/${reservationId}/feedback`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        rating,
        comment,
        cleanliness_rating: cleanlinessRating,
        staff_rating: staffRating,
        location_rating: locationRating,
        value_rating: valueRating,
      }),
    },
  );
}

async function sendWhatsappRecovery({ propertyId, toolInput, headers }) {
  const { reservationId, messageType, idempotencyKey } = toolInput;
  const result = await apiCall(
    `${BASE_URL}/${propertyId}/voice/reservations/${reservationId}/send-whatsapp`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        message_type: messageType,
        idempotency_key: idempotencyKey || undefined,
      }),
    },
  );
  console.log("sendWhatsappRecovery result:", JSON.stringify(result)); // ← add this
  return result;
}

// ─── Shared fetch helper ───────────────────────────────────────────────────

async function apiCall(url, options) {
  try {
    const response = await fetch(url, options);
    const data = await response.json();

    if (!response.ok) {
      return {
        success: false,
        error: data.message || `API error ${response.status}`,
      };
    }

    
    return data;
  } catch (err) {
    return {
      success: false,
      error: "API request failed: " + err.message,
    };
  }
}
