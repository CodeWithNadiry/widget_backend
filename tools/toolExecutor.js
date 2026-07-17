import { AppError } from "../utils/AppError.js";

const BASE_URL = "https://api.innolink.technology/api/pms/apaleo/properties";

// FIX — no timeout on fetch was the cause of multi-minute hangs on checkIn/
// checkOut/cancelReservation/getReservation. Node's fetch (undici) has NO
// default timeout — if the upstream Apaleo API stalls, retries internally,
// or the connection just sits open, the request waits indefinitely (or
// until some platform-level limit finally kills it, which is exactly the
// "2.1min to checkin" symptom). This adds a hard AbortController timeout so
// a slow/hanging call fails FAST and predictably instead of blocking the
// whole chat turn. Tune API_TIMEOUT_MS to whatever your real Apaleo p99
// latency is — 15s is a reasonable starting point for guest-facing chat.
// (checkIn/checkOut/cancelReservation have since been removed entirely — see
// below — but this timeout still applies to every remaining call.)
const API_TIMEOUT_MS = 15000;

/**
 * Executes a tool call from the LLM (or, for createBooking, directly from
 * deterministic code — see handleGuestDetailCollection in chatbot.service.js).
 * propertyId is ALWAYS injected from the session — never from LLM tool input.
 *
 * NOTE: getRoomPasscode, submitFeedback, and sendWhatsappRecovery have been
 * removed entirely — these tools no longer exist anywhere in the system.
 *
 * NOTE (client requirement — production simplification): checkIn, checkOut,
 * and cancelReservation have been removed entirely — their executor
 * implementations and switch cases no longer exist. Only getReservation,
 * getOffers, and createBooking remain.
 */
export async function executeTool({ toolName, toolInput, session, property }) {
  const propertyId = property.apaleoCode;

  // DEBUG — log exactly what's being sent for every tool call. This is the
  // first thing to check: if propertyId or apiKey is missing/wrong, every
  // getReservation call will fail before it even reaches the PMS correctly.
  console.log(
    `[toolExecutor] CALL toolName=${toolName} propertyId=${propertyId} apiKeyPresent=${Boolean(
      property?.apiKey,
    )} toolInput=${JSON.stringify(toolInput)}`,
  );

  if (!propertyId) {
    console.error(
      `[toolExecutor] ABORT — no apaleoCode on property: ${JSON.stringify(property)}`,
    );
    throw new AppError("Property not selected. Cannot execute tool.", 400);
  }

  const headers = {
    "X-API-Key": property.apiKey,
    "X-Source": "voice_ai",
    "Content-Type": "application/json",
  };

  let result;
  switch (toolName) {
    case "getReservation":
      result = await getReservation({ propertyId, toolInput, headers });
      break;
    case "getOffers":
      result = await getOffers({ propertyId, toolInput, headers });
      break;
    case "createBooking":
      result = await createBooking({ propertyId, toolInput, headers });
      break;
    default:
      throw new AppError(`Unknown tool: ${toolName}`, 400);
  }

  // DEBUG — log the final result being handed back to the chatbot logic, so
  // you can see in one place whether the PMS call actually succeeded or
  // silently returned success:false.
  console.log(`[toolExecutor] RESULT toolName=${toolName} =>`, JSON.stringify(result));

  return result;
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

// ─── Shared fetch helper ───────────────────────────────────────────────────

async function apiCall(url, options) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  const startedAt = Date.now();

  // DEBUG — log every outgoing request. Headers are logged with the API key
  // masked so this is safe to leave in staging logs temporarily.
  const safeHeaders = { ...options.headers, "X-API-Key": options.headers?.["X-API-Key"] ? "***" : undefined };
  console.log(`[toolExecutor] REQUEST ${options.method} ${url} headers=${JSON.stringify(safeHeaders)} body=${options.body || ""}`);

  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const rawText = await response.text();

    // DEBUG — log raw status + body BEFORE any parsing/interpretation, so a
    // 401/403/404/500 is immediately visible instead of being swallowed
    // into a generic "not found" a few lines later.
    console.log(
      `[toolExecutor] RESPONSE status=${response.status} ok=${response.ok} url=${url} body=${rawText.slice(0, 1000)}`,
    );

    let data;
    try {
      data = rawText ? JSON.parse(rawText) : {};
    } catch (parseErr) {
      console.error(`[toolExecutor] JSON PARSE FAILED for ${url}:`, parseErr.message, "raw:", rawText.slice(0, 500));
      return { success: false, error: "Invalid response from server." };
    }

    if (!response.ok) {
      return {
        success: false,
        error: data.message || `API error ${response.status}`,
      };
    }

    return data;
  } catch (err) {
    // FIX — distinguish a timeout from every other failure mode so it's
    // visible in logs instead of looking like a generic network error, and
    // so the guest gets a clean "try again" message instead of a hang.
    const elapsedMs = Date.now() - startedAt;
    if (err.name === "AbortError") {
      console.error(`[toolExecutor] TIMEOUT after ${elapsedMs}ms calling ${url}`);
      return {
        success: false,
        error: "Request timed out.",
      };
    }
    console.error(`[toolExecutor] API request failed after ${elapsedMs}ms calling ${url}:`, err.message);
    return {
      success: false,
      error: "API request failed: " + err.message,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}