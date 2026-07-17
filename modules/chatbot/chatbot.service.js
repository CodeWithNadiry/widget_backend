import Chatbot from "../../models/chatbot.model.js";
import Property from "../../models/property.model.js";
import { NotFoundError, AppError } from "../../utils/AppError.js";
import { searchSimilarChunks } from "../../lib/rag.js";
import { chatWithTools, UTILITY_MODEL } from "../../llm/client.js";
import { toolDefinitions } from "../../tools/toolDefinitions.js";
import { executeTool } from "../../tools/toolExecutor.js";

// ─── Structured logging ─────────────────────────────────────────────────────
// One line per event, truncated so nothing floods the console. Every log
// starts with [chatbot] so it's grep-able, and includes a short session id
// so a single conversation's events can be traced together.
function shortId(id) {
  return id ? String(id).slice(0, 8) : "none";
}

function truncate(value, max = 140) {
  if (typeof value !== "string") return value;
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function logEvent(sessionId, event, data = {}) {
  const parts = Object.entries(data)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${JSON.stringify(truncate(v))}`)
    .join(" ");
  console.log(`[chatbot] session=${shortId(sessionId)} event=${event}${parts ? " " + parts : ""}`);
}

// ─── Response envelope ──────────────────────────────────────────────────────
function reply(type, { text, data } = {}) {
  return { type, text, data };
}

// ─── Language rule ─────────────────────────────────────────────────────────
const LANGUAGE_RULE = `
LANGUAGE RULE:
- Always reply in the SAME language as the guest's MOST RECENT message — detect it fresh on every
  turn, do not assume it stays the same as an earlier turn.
- If the guest switches languages mid-conversation (in either direction — e.g. Spanish back to
  English, or English to German), switch with them immediately on that very next reply. Do NOT
  stay locked into a language the guest used earlier if their latest message is in a different one.
- Never mix languages in a single reply.
- Never ask the guest what language they prefer.
`.trim();

// ─── Brevity rule ──────────────────────────────────────────────────────────
const BREVITY_RULE = `
BREVITY RULE:
- Maximum ONE sentence per reply. Two only if truly necessary.
- EXCEPTION: if the reply requires a bullet list, a bold lead-in paragraph structure for a
  multi-part question, or a template from the FORMAT RULE (reservation lookups, payment summaries),
  the one-sentence limit does not apply — follow the FORMAT RULE structure instead. Brevity still
  applies to phrasing WITHIN each line or paragraph.
- No filler openers: never start with "Sure,", "Of course,", "Certainly,", "I can help with that,", "No problem,".
- Just answer or ask directly. Go straight to the question or the answer, nothing before it.
- After completing an action (booking, payment, lookup), stop. No closing sentence.
- NEVER end with filler like "Let me know if you need anything else", "Happy to help", "Is there anything else I can help with?".
- Never explain what you are about to do — just do it.
- Never repeat information the guest just gave you.
- Never mention technical formats to the guest (no "YYYY-MM-DD", no "E.164"). Ask in plain language.
- Never explain why you need information — just ask for it.

EXAMPLES:
BAD:  "Sure, I can help with that. Could you please provide me with your check-in and check-out dates, and the number of adults staying?"
GOOD: "What are your check-in and check-out dates, and how many adults?"
BAD:  "I'm sorry, but there are no available rooms for your requested dates. Would you like to try different dates or contact the front desk directly?"
GOOD: "No rooms are available for those dates. Want to try different ones?"
`.trim();

// ─── Punctuation / professionalism rule ────────────────────────────────────
const PUNCTUATION_RULE = `
PUNCTUATION RULE:
- Write in complete, professional sentences. Every independent clause ends with its own full stop,
  question mark, or exclamation point.
- Do NOT use an em dash (—) to join two independent clauses in place of a period. If a sentence
  has two separate thoughts, split it into two sentences with a capital letter starting the second.
- BAD:  "I couldn't find a booking with those details — could you double check and try again?"
- GOOD: "I couldn't find a booking with those details. Could you double check and try again?"
- BAD:  "No rooms are available for those dates — want to try different ones?"
- GOOD: "No rooms are available for those dates. Want to try different ones?"
- An em dash is only acceptable for a short parenthetical aside within a single sentence, never to
  splice two full clauses together.
`.trim();

// ─── Basic format rule ─────────────────────────────────────────────────────
const BASIC_FORMAT_RULE = `
FORMAT RULE (general):
- Always use valid markdown syntax — never describe formatting in words. Write **bold**, not "Room type:" left plain.
- Bold key terms, names, numbers, or anything the guest should notice at a glance (e.g. **Wi-Fi password**, **check-out time**, **12:00 PM**).

ENUMERATION — NOT OPTIONAL:
- Any time you list 3 or more items of the same kind (values, features, amenities, steps, options),
  you MUST use a markdown bullet list — one item per line, format: "- **Item name**: short description."
- Do NOT write enumerated items inline in a sentence separated by commas, even if it "reads fine."

MULTI-PART QUESTIONS:
- If the guest's message asks about two or more distinct topics in one message, answer each
  topic as its own short paragraph, separated by a blank line. Start each paragraph with a
  bolded 2-4 word label naming the topic, acting as a lightweight lead-in (not a markdown heading).
- Never merge answers to different topics into a single run-on paragraph.

GENERAL:
- Never use tables in chat replies.
- Never use nested bullets or markdown headings (#, ##) — this is a chat bubble, not a document.
- Single-topic, non-enumerated answers stay as plain sentences, no bullets, no bold lead-in label.
`.trim();

// ─── Persona & tone ────────────────────────────────────────────────────────
const PERSONA_RULE = `
PERSONA:
You are the front desk assistant for this hotel. Professional, warm, efficient.
Never over-explain. Never apologize unnecessarily. Treat the guest like they know what they want.
`.trim();

// ─── Small talk rule ────────────────────────────────────────────────────────
const SMALL_TALK_INSTRUCTION = `
SMALL TALK:
The guest's latest message is casual small talk (a greeting, "how are you", thanks, goodbye, a
pleasantry, etc.) with no factual content to look up. Respond briefly and warmly in your own
words, in character as the front desk persona, then stop. Do NOT say you lack information for
this — small talk is never a factual question, so the no-information rule never applies to it.
`.trim();

// ─── Action-request rule ────────────────────────────────────────────────────
const ACTION_REQUEST_INSTRUCTION = `
The guest is expressing intent to perform an action (check in/out, or cancel a reservation), not
asking a factual question. (Note: booking a room is handled entirely by the app before this point
— you will not see fresh booking requests here.)

- Do NOT refuse and do NOT say you don't have that information.
- Follow the TOOL RULE section above: ask for whatever details are missing, or call the
  appropriate tool immediately if you already have everything you need.
- The guest's ACTIVE INTENT for this conversation is stated above (e.g. CANCEL, CHECK_IN,
  CHECK_OUT) — stay on that action. Do not drift into booking a new room or any other flow unless
  the guest explicitly says they want something different.
`.trim();

// ─── Tool usage rule ───────────────────────────────────────────────────────
const TOOL_RULE = `
TOOL RULE:
- Always use tools for actions (lookup, check-in, check-out, cancellation). Never simulate or guess results.
- Never ask the guest to repeat information you already have.
- You do NOT have a getOffers or createBooking tool call available to you for fresh bookings —
  the app handles the entire booking flow (hotel, dates, adults, offer selection, guest details,
  confirmation) outside of you. If the guest asks to book a room, you will not normally see that
  message at all; if you ever do, just say booking is handled right here in chat and let the app take it.

SEQUENTIAL TOOL RULES — never call these in the same turn:
1. getReservation → checkIn / checkOut: Before calling checkIn or checkOut, resolve the guest's
   reservationId first via getReservation.
   - Ask for ONLY ONE verification method at a time — the last 4 digits of their phone number,
     by default. Do NOT list both options ("last 4 digits of your phone number or your room
     number and date of birth") in the same message — that reads like a form, not a conversation.
   - Only if the guest says they don't have, don't know, or can't find that (e.g. "I forgot",
     "I don't have my phone"), switch to asking for the alternative (room number + date of birth)
     in one short, friendly sentence — never re-offer the first method again once they've said
     they can't provide it.
   - Never ask the guest for a "reservation ID" by name — once getReservation returns, confirm
     the booking back to the guest in plain terms, then call checkIn/checkOut with the resolved id.
2. One tool call per turn maximum when the second call depends on the first call's output.

MULTIPLE RESERVATIONS RETURNED:
- If getReservation returns more than one matching reservation, list them briefly (name/dates/status)
  and ask which one — but if the guest's NEXT message references one of them naturally ("last one",
  "the confirmed one", "tomorrow's booking", "the second one"), the app resolves that reference for
  you automatically and tells you exactly which reservationId was selected before your next turn.
  Never say "I don't understand" to a reference like that — trust the resolved id you're given.

HOTEL-SPECIFIC TOOL GATE:
- If the guest wants to use ANY hotel-specific tool (getReservation, checkIn, checkOut,
  cancelReservation) and no hotel is confirmed yet for this conversation, you MUST NOT collect any
  other information first (name, phone, reservation details, etc.) — asking which hotel is the
  ONLY thing you do in that turn. Ask which hotel first, in one short sentence, and WAIT for the
  reply before asking anything else.
- Once a hotel IS confirmed for this conversation, NEVER ask which hotel again for this same kind
  of action — continue straight on with resolving the guest's reservation.
- Never combine "which hotel?" with any other question in the same message, even if the guest's
  message already contains other details — hold onto those details, ask which hotel first, and
  use the details the guest already gave once the hotel is confirmed.
- If a tool result ever comes back with error "NO_HOTEL_SELECTED", that confirms no hotel is chosen
  yet — ask which hotel first, in one short sentence, and do not retry the tool until the guest names one.

KNOWN DETAIL REUSE:
- Before asking the guest for any identifier a tool needs (reservationId, phone, date of birth,
  room number), check the conversation history first. If it already appears there, do NOT ask
  again — state it back and ask for a yes/no confirmation instead (e.g. "Using your booking from
  earlier — is that right?"). Never say the words "reservation ID" to the guest — refer to "your
  booking" or "your reservation" instead.
- When restating any known detail back to the guest, always use the EXACT value from history —
  NEVER a placeholder, template variable, or bracketed field name like "[Your Full Name]". If you
  do not actually have the real value, ask for it instead of inventing a placeholder.

HOTEL SWITCHING:
- selectProperty stays available even after a hotel is already confirmed for this conversation.
- If the guest names a DIFFERENT hotel than the one currently confirmed (e.g. "let's move on to the
  Berlin hotel"), call selectProperty with that hotel's id immediately — do not ask for confirmation first.
- If the guest names a hotel that is not in the list you manage, do not call selectProperty — tell them
  which hotels you manage and ask them to pick one.
`.trim();

// ─── Tool ERROR handling rule ──────────────────────────────────────────────
const TOOL_ERROR_RULE = `
TOOL ERROR RULE:
- Once a hotel is confirmed for this conversation, NEVER ask the guest to confirm or re-state the
  hotel name or location again, for any reason, including a failed tool call — UNLESS the guest is
  explicitly switching to a different hotel (see HOTEL SWITCHING above).
- If a tool call fails or returns any other error, that is an availability/system problem — NOT a
  sign that the hotel is unknown. Tell the guest in one short sentence that the request couldn't be
  completed right now, and suggest one next step (contact the front desk directly).
- Never invent a reason for a failure. Never mention API names, error codes, or technical details.
`.trim();

// ─── Capability boundary rule ───────────────────────────────────────────────
const CAPABILITY_BOUNDARY_RULE = `
CAPABILITY BOUNDARY RULE — read carefully, this prevents a serious hallucination bug:
- You do NOT have any tool to send or resend emails, WhatsApp messages, SMS, or any other
  external message to the guest, with exactly ONE exception: right after a NEW booking is
  successfully created in this conversation, the backend automatically sends a confirmation
  email — you may mention that email was sent, but ONLY in that exact situation.
- If the guest asks you to (re)send/resend a confirmation, receipt, form, passcode, or anything
  else by email, WhatsApp, or SMS — outside of that one exception — you must NOT say it was sent,
  resent, or completed. Say plainly and briefly that you're not able to send that from this chat,
  and offer to help with something else related to their reservation.
- Never say "I've sent/resent ..." or imply any message went out unless a tool call earlier in
  THIS same conversation actually performed that exact action. When in doubt, don't claim it.
`.trim();

// ─── Context rule ──────────────────────────────────────────────────────────
const CONTEXT_RULE = `
CONTEXT RULE:
- Always read the full conversation history before replying.
- If the guest answered a clarifying question, immediately address their original request — do not greet again.
- Never ask for information the guest already provided earlier in the conversation.
- Never give a generic "How can I help?" if there is an unanswered question already in the conversation.
`.trim();

// ─── Conversational exception rule ─────────────────────────────────────────
const CONVERSATIONAL_EXCEPTION_INSTRUCTION = `
NO DOCUMENT CONTEXT WAS FOUND FOR THIS MESSAGE — but this appears to be a direct reply to
something YOU (the assistant) just asked for in your previous message (e.g. a reservation ID,
phone last 4, or date of birth).

- Do NOT refuse and do NOT say you don't have that information.
- Use the conversation history to understand what you asked for, take the guest's reply as the
  answer to that, and continue naturally — call the appropriate tool if the guest just supplied
  data a tool needs (e.g. a reservation ID for getReservation).
- Never invent facts not in the tools/history. This exception only covers continuing the
  conversation naturally — it does NOT permit answering a genuinely new factual question from
  general knowledge. If the guest's short reply is actually a brand-new question unrelated to
  what you just asked, treat it as a normal factual question instead.
`.trim();

// ─── Hallucination guard sentence — used when no RAG context is found ──────
const NO_CONTEXT_SENTENCES = {
  doc: "I don't have information regarding that. Let me know if you need something else.",
  property:
    "I don't have information regarding that. Let me know if you need something else.",
};

// ─── Fixed sentences used by deterministic flows ───────────────────────────
const BOOKING_CONFIRMED_SENTENCE =
  "Booking confirmed. Please check your email for the confirmation.";

const PASSCODE_REFUSAL_SENTENCE =
  "For security reasons, I'm not able to share room passcodes here. Please contact the front desk directly for that.";

const ASK_NAME_SENTENCE = "Please enter your full name.";
const ASK_EMAIL_SENTENCE = "Please enter your email address.";
const ASK_PHONE_SENTENCE = "Please enter your phone number.";
const INVALID_NAME_SENTENCE = "Please enter your full name.";
const INVALID_EMAIL_SENTENCE =
  "That doesn't look like a valid email. Please try again.";
const INVALID_PHONE_SENTENCE =
  "That doesn't look like a valid phone number. Please include your country code and try again.";
const BOOKING_CANCELLED_SENTENCE =
  "No problem. Please let me know if your reservation details are incorrect, if you'd like to choose a different room, or if you'd like to cancel this booking.";
const BOOKING_CANCELLED_FINAL_SENTENCE =
  "No problem, this booking request has been cancelled. Let me know if you'd like to start a new one.";
const PAYMENT_LINK_REFUSAL_SENTENCE =
  "Sorry, I can't send payment links through this chat.";
const FEEDBACK_REFUSAL_SENTENCE =
  "Sorry, I can't submit guest feedback through this chat.";
const BOOKING_FAILED_SENTENCE =
  "That booking couldn't be completed right now. Want to try again or pick a different room?";
const UNCLEAR_CONFIRMATION_SENTENCE =
  "Please reply yes to confirm, or let me know what to correct.";
const ASK_CORRECTION_NAME_SENTENCE = "What's the correct full name?";
const ASK_CORRECTION_EMAIL_SENTENCE = "What's the correct email address?";
const ASK_CORRECTION_PHONE_SENTENCE = "What's the correct phone number?";
const NO_SEARCH_STATE_SENTENCE =
  "Let's start over. Please tell me which hotel you'd like to book.";

const ASK_ARRIVAL_SENTENCE = "What's your check-in date?";
const ASK_DEPARTURE_SENTENCE = "And your check-out date?";
const ASK_ADULTS_SENTENCE = "How many adults will be staying?";
const INVALID_DATE_SENTENCE =
  "I couldn't understand that date. Could you try again?";
const PAST_DATE_SENTENCE =
  "That date has already passed. Please give a check-in date of today or later.";
const INVALID_DEPARTURE_SENTENCE =
  "Check-out must be after check-in. Could you give a valid date?";
const INVALID_ADULTS_SENTENCE = "Please enter a number between 1 and 10.";
const NO_ROOMS_SENTENCE =
  "No rooms are available for those dates. Want to try different ones?";
const OFFERS_INTRO_SENTENCE =
  "Here are the available offers. Reply with a number to choose your room.";

// ─── Fixed sentences for the deterministic action-verification flow ───────
const ASK_PHONE_VERIFY_SENTENCE =
  "What are the last 4 digits of the phone number on the booking?";
const INVALID_PHONE_VERIFY_SENTENCE =
  "That doesn't look right. Please give the last 4 digits of your phone number.";
const ASK_ALT_VERIFY_FULL_SENTENCE =
  "No problem. What's your last name, room number, and date of birth?";
const ASK_ALT_VERIFY_NO_NAME_SENTENCE =
  "No problem. What's your room number, and your date of birth?";
const INVALID_ALT_VERIFY_FULL_SENTENCE =
  "I need your last name, room number, and date of birth. Could you send all three?";
const INVALID_ALT_VERIFY_NO_NAME_SENTENCE =
  "I couldn't quite catch that. What's your room number, and your date of birth?";
const RESERVATION_NOT_FOUND_SENTENCE =
  "I couldn't find a booking with those details. Could you double check and try again?";
const ACTION_ABORTED_SENTENCE =
  "No problem. Let me know if there's anything else.";
const ACTION_FAILED_SENTENCE =
  "That couldn't be completed right now. Please contact the front desk directly.";
const UNCLEAR_ACTION_CONFIRMATION_SENTENCE =
  "Please reply yes to go ahead, or no to cancel.";

// Guest asked for something this assistant has no tool for at all (payment
// links, emailing/WhatsApp-ing a receipt/invoice/confirmation/key/passcode,
// etc.) — reply immediately, never collect hotel/verification details first.
const UNSUPPORTED_ACTION_SENTENCE =
  "Sorry, I can't send that through this chat. Please contact the hotel directly for that.";

// Fallback used if the action-verification flow is ever entered for an
// intent it doesn't actually know how to handle (defensive backstop).
const ACTION_UNRECOGNIZED_SENTENCE =
  "I'm not able to help with that request here. Please contact the hotel directly, or let me know if there's something else I can do.";

// ─── Fixed sentence for an LLM/tool failure mid-conversation ──────────────
const LLM_FAILURE_SENTENCE =
  "I'm having trouble processing that right now. Could you try again in a moment?";

const ACTION_SUCCESS_SENTENCES = {
  CANCEL: "Your reservation has been cancelled.",
  CHECK_IN: "You're checked in. Enjoy your stay!",
  CHECK_OUT: "You're checked out. Thank you for staying with us!",
};

const ACTION_TOOL_NAME = {
  CANCEL: "cancelReservation",
  CHECK_IN: "checkIn",
  CHECK_OUT: "checkOut",
};

const ACTION_VERB = {
  CANCEL: "cancel",
  CHECK_IN: "check in",
  CHECK_OUT: "check out",
};

function buildActionConfirmText(activeIntent, reservation) {
  const verb = ACTION_VERB[activeIntent] || "proceed with";
  const name = reservation.guestName
    ? ` under **${reservation.guestName}**`
    : "";
  const dates =
    reservation.arrival && reservation.departure
      ? ` (**${reservation.arrival}** to **${reservation.departure}**)`
      : "";
  return `Found your booking${name}${dates}. Shall I ${verb} now?`;
}

function buildReservationListText(reservations) {
  const lines = reservations.map(
    (r) =>
      `- **${r.guestName || "Guest"}**: ${r.arrival || "?"} to ${r.departure || "?"} (${r.status || "unknown"})`,
  );
  return `I found a few matching bookings. Which one?\n${lines.join("\n")}`;
}

function buildReservationDetailText(reservation) {
  const lines = [
    `- **Reservation ID:** ${reservation.reservationId || "—"}`,
    `- **Guest ID:** ${reservation.guestId || "—"}`,
    `- **Check-in:** ${reservation.arrival || "—"}`,
    `- **Check-out:** ${reservation.departure || "—"}`,
    `- **Status:** ${reservation.status || "—"}`,
  ];
  return lines.join("\n");
}

const RESERVATION_INFO_QUERY_REGEX =
  /\b(detail|details|status|info|information|dates?|when|room number|arrival|departure|check-?in|check-?out)\b/i;

function looksLikeGuestReadableMessage(text) {
  if (!text || typeof text !== "string") return false;
  const trimmed = text.trim();
  if (trimmed.length < 5 || trimmed.length > 200) return false;
  if (!/\s/.test(trimmed)) return false;
  if (/^[A-Z0-9_\-]+$/.test(trimmed)) return false;
  if (
    /exception|stack trace|undefined|null\b|\bENOTFOUND\b|\bECONNREFUSED\b/i.test(
      trimmed,
    )
  )
    return false;
  return true;
}

const UNSUPPORTED_CHANNEL_REGEX =
  /\b(whatsapp|email|e-?mail|sms|text message)\b/i;

function sanitizePmsMessage(text) {
  if (!looksLikeGuestReadableMessage(text)) return null;
  if (!UNSUPPORTED_CHANNEL_REGEX.test(text)) return text;

  const sentences = text.split(/(?<=[.!?])\s+/);
  const kept = sentences.filter((s) => !UNSUPPORTED_CHANNEL_REGEX.test(s));

  if (kept.length === 0) {
    return "This needs to be resolved at the front desk before check-in. Please contact them directly.";
  }
  return `${kept.join(" ")} Please contact the front desk directly for that.`.trim();
}

function buildConfirmationText({ fullName, email, phone }) {
  return [
    "Please confirm your reservation details:",
    "",
    `**Full name:** ${fullName}`,
    `**Email:** ${email}`,
    `**Phone:** ${phone}`,
    "",
    "Shall I proceed with this booking?",
  ].join("\n");
}

function buildAskHotelText(properties, isBooking) {
  const intro = isBooking
    ? "Which hotel would you like to reserve a room with?"
    : "Which hotel are you contacting?";
  const list = properties.map((p) => `- ${p.name}`).join("\n");
  return `${intro}\n${list}`;
}

// ─── Hotel scope rule ───────────────────────────────────────────────────────
const HOTEL_SCOPE_RULE = `
HOTEL SCOPE RULE:
- If no hotel has been named yet in this conversation, answer factual questions using GENERAL
  INFORMATION (chatbot-wide documents). Do NOT ask which hotel just to answer a plain question.
- The moment the guest names one of the hotels you manage — in this message or an earlier one —
  treat that hotel as confirmed for the rest of the conversation, and answer factual questions
  using HOTEL INFORMATION scoped to that property from then on.
- Only ask which hotel BEFORE answering when the guest is trying to use a hotel-specific tool
  (see TOOL RULE), and no hotel is confirmed yet. Never ask which hotel for a plain informational question.
- NOTE: this "stay locked onto the confirmed hotel" behavior applies ONLY to plain informational
  Q&A. It does NOT apply to starting a new booking, cancellation, check-in, check-out, or
  reservation lookup — those always reconfirm the hotel fresh (see ACTION HOTEL RULE below).
`.trim();

const ACTION_HOTEL_RULE = `
ACTION HOTEL RULE:
- Every time the guest starts a NEW booking, cancellation, check-in, check-out, or reservation
  lookup, the hotel must be confirmed FRESH for that specific request — never silently reuse a
  hotel that was only confirmed for an earlier, different action or question in this same
  conversation. A guest who already checked into one property earlier may now be contacting a
  completely different one.
- This is handled deterministically before you are ever invoked for these flows — you will simply
  see the hotel already resolved by the time you're asked to act.
`.trim();

const PROPERTY_SCOPED_TOOLS = new Set([
  "getOffers",
  "getReservation",
  "checkIn",
  "checkOut",
  "cancelReservation",
]);

const CANCEL_INTENT_REGEX = /\b(cancel|cancelling|cancellation)\b/i;
const CHECKIN_INTENT_REGEX = /\b(check[\s-]?in|checking in)\b/i;
const CHECKOUT_INTENT_REGEX = /\b(check[\s-]?out|checking out)\b/i;
const LOOKUP_INTENT_REGEX =
  /\b(detail|details|status|info|information|id|number)\b.{0,25}\b(reservation|booking)\b|\b(reservation|booking)\b.{0,25}\b(detail|details|status|info|information|id|number)\b/i;
const RESERVATION_NOUN_REGEX = /\b(reservation|booking)\b/i;
const BOOK_VERB_REGEX = /\b(book|reserve)\b/i;
const BOOK_INTENT_REGEX = /\b(book|reserve|reservation|booking)\b/i;

function regexIntentHint(text) {
  const t = text || "";
  if (CANCEL_INTENT_REGEX.test(t)) return "CANCEL";
  if (CHECKIN_INTENT_REGEX.test(t)) return "CHECK_IN";
  if (CHECKOUT_INTENT_REGEX.test(t)) return "CHECK_OUT";
  if (LOOKUP_INTENT_REGEX.test(t)) return "LOOKUP";
  if (RESERVATION_NOUN_REGEX.test(t) && !BOOK_VERB_REGEX.test(t))
    return "LOOKUP";
  if (BOOK_INTENT_REGEX.test(t)) return "BOOK";
  return null;
}

const VALID_ACTION_INTENTS = new Set([
  "CANCEL",
  "CHECK_IN",
  "CHECK_OUT",
  "LOOKUP",
  "BOOK",
  "NONE",
]);

const INTENT_LABELS = {
  CANCEL: "The guest wants to CANCEL a reservation.",
  CHECK_IN: "The guest wants to CHECK IN.",
  CHECK_OUT: "The guest wants to CHECK OUT.",
  BOOK: "The guest wants to book a new room.",
  LOOKUP:
    "The guest wants to see their existing reservation DETAILS/STATUS/ID — this is a read-only lookup, nothing gets modified.",
};

function isPastDate(dateStr) {
  if (!dateStr) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const check = new Date(dateStr);
  if (isNaN(check.getTime())) return false;
  check.setHours(0, 0, 0, 0);
  return check < today;
}

const PASSCODE_REGEX =
  /passcode|pass code|door code|key code|access code|room code|entry code|unlock code/i;

const QUICK_REPEAT_REGEX =
  /\b(same (hotel|dates?|details?)|as before|as last time|again|quick reservation|repeat (the )?(same|last|previous))\b/i;
const CHEAPEST_REGEX = /cheap/i;

// ─── Post-decline classification (Problems 1-3, 9): after the guest says
// "No" to a booking confirmation, these deterministically classify what
// they want next WITHOUT involving the LLM, per the "deterministic flow"
// requirement (Problem 10). ─────────────────────────────────────────────
const WANTS_ANOTHER_ROOM_REGEX =
  /\b(another room|different room|other room|change (the )?room|pick another|choose another|different offer|another offer|other offer|new room)\b/i;
const WANTS_CANCEL_BOOKING_REGEX =
  /\b(cancel (this|the|my)?\s*(booking|reservation)?|nevermind|never mind|forget it|don'?t want (it|this)|stop the booking|no longer want)\b/i;
const MENTIONS_NAME_FIELD_REGEX = /\bname\b/i;
const MENTIONS_EMAIL_FIELD_REGEX = /\bemail\b/i;
const MENTIONS_PHONE_FIELD_REGEX = /\bphone|number\b/i;

// Unsupported action requests (Problems 6-8): things the assistant has no
// tool for at all. Detected deterministically so they never trigger the
// hotel-verification gate.
const PAYMENT_LINK_REGEX =
  /\b(payment link|pay link|link to pay|send.*(pay|invoice)|invoice link)\b/i;
const FEEDBACK_REGEX = /\b(feedback|complaint|review|suggestion box)\b/i;

const FIELD_TO_STEP = { fullName: "name", email: "email", phone: "phone" };

function getCorrectionAskSentence(field) {
  if (field === "fullName") return ASK_CORRECTION_NAME_SENTENCE;
  if (field === "email") return ASK_CORRECTION_EMAIL_SENTENCE;
  if (field === "phone") return ASK_CORRECTION_PHONE_SENTENCE;
  return ASK_NAME_SENTENCE;
}

const HOTEL_NAME_STOP_WORDS = new Set([
  "hotel",
  "the",
  "resort",
  "inn",
  "and",
  "at",
]);

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] =
        a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[n];
}

function fuzzyTolerance(len) {
  if (len <= 4) return 1;
  if (len <= 8) return 2;
  return 3;
}

function detectMentionedProperty(message, properties) {
  const lower = message.toLowerCase();

  const exact = properties.find((p) => lower.includes(p.name.toLowerCase()));
  if (exact) return exact;

  const exactWords = properties.find((p) => {
    const words = p.name
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 2 && !HOTEL_NAME_STOP_WORDS.has(w));
    return (
      words.length > 0 &&
      words.every((w) => new RegExp(`\\b${w}\\b`).test(lower))
    );
  });
  if (exactWords) return exactWords;

  const messageTokens = lower.split(/[^a-z0-9]+/).filter(Boolean);
  let best = null;
  let bestDistance = Infinity;

  for (const p of properties) {
    const propertyWords = p.name
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 2 && !HOTEL_NAME_STOP_WORDS.has(w));

    for (const pw of propertyWords) {
      for (const token of messageTokens) {
        if (Math.abs(token.length - pw.length) > fuzzyTolerance(pw.length))
          continue;
        const distance = levenshtein(token, pw);
        if (distance <= fuzzyTolerance(pw.length) && distance < bestDistance) {
          bestDistance = distance;
          best = p;
        }
      }
    }
  }

  return best;
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Fixed: added an upper bound. E.164 numbers max out at 15 digits — without
// this, garbage input like "+920000000000000000" (18 digits) was silently
// accepted as a "valid" phone number.
function isValidPhone(input) {
  const digits = (input || "").replace(/[^\d]/g, "");
  return digits.length >= 7 && digits.length <= 15;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}
function isRealDate(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}

const MONTH_NAMES = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

function nearestFutureDate(month, day, referenceDate = new Date()) {
  const y = referenceDate.getFullYear();
  if (!isRealDate(y, month, day)) return null;
  const candidate = new Date(Date.UTC(y, month - 1, day));
  const todayUTC = new Date(
    Date.UTC(
      referenceDate.getFullYear(),
      referenceDate.getMonth(),
      referenceDate.getDate(),
    ),
  );
  if (candidate < todayUTC) {
    if (!isRealDate(y + 1, month, day)) return null;
    return `${y + 1}-${pad2(month)}-${pad2(day)}`;
  }
  return `${y}-${pad2(month)}-${pad2(day)}`;
}

function tryParseDateFast(input, referenceDate = new Date()) {
  const trimmed = (input || "").trim().toLowerCase();
  if (!trimmed) return null;

  let m = trimmed.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (m) {
    const [, y, mo, d] = m.map(Number);
    if (isRealDate(y, mo, d)) return `${y}-${pad2(mo)}-${pad2(d)}`;
  }

  m = trimmed.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (m) {
    const [, d, mo, y] = m.map(Number);
    if (isRealDate(y, mo, d)) return `${y}-${pad2(mo)}-${pad2(d)}`;
  }

  if (/^today$/.test(trimmed)) {
    const d = referenceDate;
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }
  if (/^tomorrow$/.test(trimmed)) {
    const d = new Date(referenceDate);
    d.setDate(d.getDate() + 1);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }

  m = trimmed.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)$/);
  if (m) {
    const day = Number(m[1]);
    const month = MONTH_NAMES[m[2]];
    if (month) {
      const resolved = nearestFutureDate(month, day, referenceDate);
      if (resolved) return resolved;
    }
  }

  m = trimmed.match(/^([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?$/);
  if (m) {
    const month = MONTH_NAMES[m[1]];
    const day = Number(m[2]);
    if (month) {
      const resolved = nearestFutureDate(month, day, referenceDate);
      if (resolved) return resolved;
    }
  }

  m = trimmed.match(/^(\d{1,2})(?:st|nd|rd|th)?$/);
  if (m) {
    const day = Number(m[1]);
    const resolved = nearestFutureDate(
      referenceDate.getMonth() + 1,
      day,
      referenceDate,
    );
    if (resolved) return resolved;
  }

  return null;
}

async function parseDateSmart(input) {
  const fast = tryParseDateFast(input);
  if (fast) return fast;
  try {
    const today = new Date().toISOString().slice(0, 10);
    const res = await chatWithTools({
      systemPrompt: `Today's date is ${today}. The guest just answered a request for a date, in any language or format (e.g. "5th July", "next Monday", "05.07.2026"). Convert their reply to strict YYYY-MM-DD format. Reply with ONLY the date in that exact format, or exactly "NONE" if it cannot be understood as a date at all.`,
      history: [{ role: "user", content: input }],
      tools: [],
      model: UTILITY_MODEL,
    });
    const text = (res.text || "").trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
  } catch (err) {
    logEvent(null, "parse_date_smart_failed", { error: err.message });
    return null;
  }
}

const EMAIL_EXTRACT_REGEX = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const PHONE_EXTRACT_REGEX = /\+?\d[\d\s-]{6,}\d/;
const ADULTS_EXTRACT_REGEX =
  /\b(\d{1,2})\s*(adults?|guests?|people|persons?)\b/i;

// Fixed: was `name[:\s]+is` which required at least one space/colon between
// "name" and "is", so a typo/no-space reply like "nameis usman" never
// matched. Changed the middle group to `[:\s]*` (zero-or-more) so it still
// catches the common typo'd form without loosening the other alternatives.
const NAME_EXTRACT_REGEX =
  /\b(?:my (?:full )?name is|name[:\s]*is|i'?m|this is)\s+([a-zA-Z][a-zA-Z'\-]*(?:\s+[a-zA-Z][a-zA-Z'\-]*){0,3})/i;

function extractDateRangeFast(message, referenceDate = new Date()) {
  const trimmed = message.toLowerCase();

  let m = trimmed.match(
    /\b(\d{1,2})(?:st|nd|rd|th)?\s*(?:-|to|–|until)\s*(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)\b/,
  );
  if (m) {
    const [, d1, d2, monthWord] = m;
    const month = MONTH_NAMES[monthWord];
    if (month) {
      const arrival = nearestFutureDate(month, Number(d1), referenceDate);
      const departure = nearestFutureDate(month, Number(d2), referenceDate);
      if (arrival && departure) return { arrival, departure };
    }
  }

  const dateTokenRegex =
    /\b(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[-/]\d{1,2}[-/]\d{4}|\d{1,2}(?:st|nd|rd|th)?\s+[a-z]+|[a-z]+\s+\d{1,2}(?:st|nd|rd|th)?)\b/g;
  const found = [];
  let match;
  while ((match = dateTokenRegex.exec(trimmed)) !== null && found.length < 2) {
    const parsed = tryParseDateFast(match[1], referenceDate);
    if (parsed) found.push(parsed);
  }
  if (found.length === 2) return { arrival: found[0], departure: found[1] };

  return {};
}

function extractQuickBookingDetails(message, referenceDate = new Date()) {
  const details = {};

  const { arrival, departure } = extractDateRangeFast(message, referenceDate);
  if (arrival) details.arrival = arrival;
  if (departure) details.departure = departure;

  const adultsMatch = message.match(ADULTS_EXTRACT_REGEX);
  if (adultsMatch) {
    const n = parseInt(adultsMatch[1], 10);
    if (n >= 1 && n <= 10) details.adults = n;
  } else if (/\bone adult\b/i.test(message)) {
    details.adults = 1;
  }

  const emailMatch = message.match(EMAIL_EXTRACT_REGEX);
  if (emailMatch) details.email = emailMatch[0].replace(/[.,;:!?]+$/, "");

  const phoneMatch = message.match(PHONE_EXTRACT_REGEX);
  if (phoneMatch) details.phone = phoneMatch[0].trim();

  const nameMatch = message.match(NAME_EXTRACT_REGEX);
  if (nameMatch) details.fullName = nameMatch[1].trim();

  details.wantsCheapest = CHEAPEST_REGEX.test(message);

  return details;
}

// ─── NEW: correction-field extraction for the guest-detail confirmation
// step. Unlike classifyConfirmationReply (which returns a single label),
// this scans the guest's message directly for any email / phone / name
// values they may have supplied inline (e.g. "no my email is X and phone is
// Y and name is Z") so ALL corrections in one message can be applied at
// once instead of only acting on whichever single field the classifier
// happened to pick. ────────────────────────────────────────────────────────
function extractCorrectionFields(message) {
  const result = {};

  const emailMatch = message.match(EMAIL_EXTRACT_REGEX);
  if (emailMatch) {
    const email = emailMatch[0].replace(/[.,;:!?]+$/, "");
    if (EMAIL_REGEX.test(email)) result.email = email;
  }

  const phoneMatch = message.match(PHONE_EXTRACT_REGEX);
  if (phoneMatch) {
    const phone = phoneMatch[0].trim();
    result.phoneAttempted = phone;
    if (isValidPhone(phone)) result.phone = phone;
  }

  const nameMatch = message.match(NAME_EXTRACT_REGEX);
  if (nameMatch) {
    const fullName = nameMatch[1].trim();
    if (fullName.length >= 2) result.fullName = fullName;
  }

  return result;
}

// ─── In-memory session store ───────────────────────────────────────────────
const sessions = new Map();

setInterval(
  () => {
    const cutoff = Date.now() - 2 * 60 * 60 * 1000;
    let expired = 0;
    for (const [id, session] of sessions) {
      if (session.createdAt < cutoff) {
        sessions.delete(id);
        expired++;
      }
    }
    if (expired > 0) {
      console.log(`[chatbot] event=session_cleanup expired=${expired} remaining=${sessions.size}`);
    }
  },
  15 * 60 * 1000,
);

function getOrCreateSession(sessionId, chatbotId) {
  if (!sessions.has(sessionId)) {
    logEvent(sessionId, "session_created", { chatbotId: shortId(chatbotId) });
    sessions.set(sessionId, {
      chatbotId,
      propertyId: null,
      state: "new",
      history: [],
      lastOffers: null,
      selectedOffer: null,
      lastSearchParams: null,
      knownGuestDetails: null,
      guestDetailStep: null,
      pendingGuestDetails: null,
      correctingField: false,
      correctionQueue: null,
      awaitingHotelForBooking: false,
      awaitingHotelForAction: false,
      searchDetailStep: null,
      pendingSearchDetails: null,
      lastKnownLanguage: "English",
      activeIntent: null,
      lastReservations: null,
      actionFlowStep: null,
      pendingVerification: null,
      resolvedActionReservation: null,
      knownVerification: null,
      createdAt: Date.now(),
    });
  }
  return sessions.get(sessionId);
}

function updateSession(sessionId, updates) {
  const session = sessions.get(sessionId);
  sessions.set(sessionId, { ...session, ...updates });
}

// ─── RAG relevance selection — tiered, not a single blind cutoff ───────────
function selectRelevantChunks(
  chunks,
  { strictThreshold, fallbackCeiling, fallbackTopN = 3 },
) {
  const strict = chunks.filter((c) => c.distance <= strictThreshold);
  if (strict.length > 0) return { chunks: strict, usedFallback: false };

  const sorted = [...chunks]
    .sort((a, b) => a.distance - b.distance)
    .slice(0, fallbackTopN);
  const withinCeiling = sorted.filter((c) => c.distance <= fallbackCeiling);
  if (withinCeiling.length === 0) return { chunks: [], usedFallback: false };
  return { chunks: withinCeiling, usedFallback: true };
}

// ─── Combined message analysis: intent + action-intent + language + English
// query — ONE utility-model call per turn, doing all the semantic work. ────
async function analyzeGuestMessage(message, history, regexHint, sessionId = null) {
  const recentHistory = history
    .filter((h) => typeof h.content === "string")
    .slice(-6);

  try {
    const analysis = await chatWithTools({
      systemPrompt: `
You are analyzing the guest's LATEST message in an ongoing hotel chatbot conversation. Read the
conversation so far, then classify the message by MEANING — never by matching specific words or
spelling. The guest may write in any language, may misspell words, or may phrase things very
differently from any example below; always reason about what they actually want.

Reply with ONLY a single-line JSON object — no markdown fences, no explanation — with exactly
these four fields:
{"intent": "...", "actionIntent": "...", "language": "...", "englishQuery": "..."}

"intent" — one of:
- "SMALL_TALK": casual conversational messages with no factual content — greetings, "how are
  you", "what's up", pleasantries, thanks, goodbyes — in ANY language.
- "ACTION_REQUEST": the guest wants to perform an action — book/reserve a room, check in/out,
  cancel a reservation, or look up their existing reservation — EVEN IF no details (dates, name,
  etc.) have been given yet, and even if the exact words used don't match any fixed keyword. This
  is NOT a factual question and never needs document grounding.
- "FOLLOW_UP": the message directly answers, confirms, or continues what the assistant just
  asked (an ID, phone, DOB, offer number, yes/no, a correction), in ANY language.
- "NEW_QUESTION": an actual factual question about the hotel/property/general info that needs to
  be looked up in documents.

IMPORTANT: if the guest's message is a short, direct answer to a question you can see in the
recent conversation history (like a bare phone-number fragment, a date, a name, or a yes/no),
classify it as "FOLLOW_UP" — NOT "ACTION_REQUEST" — even if the conversation is about booking,
check-in, or another action. Only use "ACTION_REQUEST" when the guest is newly expressing that
they want to perform an action.

"actionIntent" — ONLY meaningful when "intent" is "ACTION_REQUEST" (set to "NONE" otherwise). One of:
- "CANCEL": the guest wants to cancel an existing reservation.
- "CHECK_IN": the guest wants to check in.
- "CHECK_OUT": the guest wants to check out.
- "LOOKUP": the guest wants to see or hear about their EXISTING reservation — its details,
  status, dates, id, or just "my reservation" / "my booking" in a general way — a read-only
  request, nothing gets created or modified. This is the correct choice whenever the guest is
  asking ABOUT a reservation they believe they already have, however they phrase it (e.g. "tell
  me about my reservation", "give me my reservation dtail", "what's the status of my booking",
  "quiero ver mi reserva") — do not require an exact keyword like "detail" or "status" to be
  present; judge from meaning.
- "BOOK": the guest wants to make a brand NEW reservation that does not exist yet (e.g. "I want
  to book a room", "can I reserve for next weekend").
- "NONE": intent is not "ACTION_REQUEST", or the action doesn't fit any of the above (e.g. the
  guest wants to send feedback, get a payment link, or something else this assistant has no tool
  for).
${
  regexHint && regexHint !== "NONE"
    ? `\nHINT (a cheap keyword scan detected a pattern matching ${regexHint} — this is only a weak same-turn signal, not a rule; use it as a tie-breaker ONLY if the message's actual meaning is genuinely ambiguous between two options, and ignore it entirely if the meaning clearly points elsewhere).`
    : ""
}

"language" — the guest's message language, as a plain English language name (e.g. "English",
"German", "Spanish", "Albanian", "Portuguese", "Turkish", "French", "Chinese", "Serbian").

"englishQuery" — the guest's message translated into English. If it is already English, copy it
unchanged.

Judge everything based on MEANING and conversational context, never on exact wording, spelling,
punctuation, or keyword presence.
`.trim(),
      history: [...recentHistory, { role: "user", content: message }],
      tools: [],
      model: UTILITY_MODEL,
    });

    const raw = (analysis.text || "")
      .trim()
      .replace(/^```json\s*|\s*```$/g, "");
    const parsed = JSON.parse(raw);

    if (VALID_ACTION_INTENTS.has(parsed.intent) && parsed.intent !== "NONE") {
      if (!parsed.actionIntent || parsed.actionIntent === "NONE") {
        parsed.actionIntent = parsed.intent;
      }
      parsed.intent = "ACTION_REQUEST";
    }

    const intent = [
      "SMALL_TALK",
      "ACTION_REQUEST",
      "FOLLOW_UP",
      "NEW_QUESTION",
    ].includes(parsed.intent)
      ? parsed.intent
      : "NEW_QUESTION";

    let actionIntent = VALID_ACTION_INTENTS.has(parsed.actionIntent)
      ? parsed.actionIntent
      : "NONE";
    if (intent !== "ACTION_REQUEST") actionIntent = "NONE";
    if (
      intent === "ACTION_REQUEST" &&
      actionIntent === "NONE" &&
      regexHint &&
      regexHint !== "NONE"
    ) {
      actionIntent = regexHint;
    }

    const language =
      typeof parsed.language === "string" && parsed.language.trim()
        ? parsed.language.trim()
        : "English";
    const englishQuery =
      typeof parsed.englishQuery === "string" && parsed.englishQuery.trim()
        ? parsed.englishQuery.trim()
        : message;

    logEvent(sessionId, "intent_analysis", {
      intent,
      actionIntent,
      language,
      regexHint: regexHint || "none",
    });

    return { intent, actionIntent, language, englishQuery };
  } catch (err) {
    const fallbackActionIntent = regexHint && regexHint !== "NONE" ? regexHint : "NONE";
    logEvent(sessionId, "intent_analysis_failed", {
      error: err.message,
      fallbackActionIntent,
    });
    return {
      intent: fallbackActionIntent !== "NONE" ? "ACTION_REQUEST" : "NEW_QUESTION",
      actionIntent: fallbackActionIntent,
      language: "English",
      englishQuery: message,
    };
  }
}

// ─── Direct, directive translation of a fixed sentence into a KNOWN language ─
async function translateToLanguage(fixedSentence, languageName) {
  if (!languageName || languageName.trim().toLowerCase() === "english")
    return fixedSentence;
  try {
    const translation = await chatWithTools({
      systemPrompt: `Translate the following text into ${languageName}. Preserve markdown formatting EXACTLY as-is (**bold** stays **bold**, line breaks stay line breaks) — translate only the words. Use complete, professional sentences with proper punctuation in the target language (equivalent full stops/question marks) — never join two independent clauses with a dash in place of a period. Reply with ONLY the translated text — no quotes, no explanation, nothing else.`,
      history: [{ role: "user", content: fixedSentence }],
      tools: [],
      model: UTILITY_MODEL,
    });
    return translation.text?.trim() || fixedSentence;
  } catch (err) {
    logEvent(null, "translate_failed", { language: languageName, error: err.message });
    return fixedSentence;
  }
}

// ─── Offer selection resolver ──────────────────────────────────────────────
async function resolveOfferSelection(message, offers) {
  if (!offers || offers.length === 0) return null;

  const trimmed = message.trim();

  const bareNumber = trimmed.match(/^#?\s*(\d{1,2})\s*[.)]?$/);
  if (bareNumber) {
    const num = parseInt(bareNumber[1], 10);
    const found = offers.find((o) => o.displayNumber === num);
    if (found) return { offer: found };
    return { outOfRange: true };
  }

  try {
    const offerList = offers
      .map(
        (o) =>
          `${o.displayNumber}. ${o.name} — ${o.roomName} — ${o.amount} ${o.currency}`,
      )
      .join("\n");

    const classification = await chatWithTools({
      systemPrompt: `
The guest is looking at this list of room offers, numbered as shown:
${offerList}

Read the guest's message below and decide which offer number they are selecting, if any.
This includes bare numbers, ordinals ("first", "second", "1st"), numbers embedded in a
sentence ("select 1", "I'll take number 2"), and descriptive references ("the cheaper one",
"the one with breakfast", "the family room"), in ANY language.

Reply with ONLY the offer number exactly as shown above (e.g. "1"), or exactly "NONE" if the
message is not selecting an offer at all (e.g. it's an unrelated question or comment). No
punctuation, no explanation.
`.trim(),
      history: [{ role: "user", content: message }],
      tools: [],
      model: UTILITY_MODEL,
    });

    const label = classification.text?.trim().toUpperCase();
    if (!label || label === "NONE") return null;

    const num = parseInt(label, 10);
    const found = offers.find((o) => o.displayNumber === num);
    if (found) return { offer: found };
    return null;
  } catch (err) {
    logEvent(null, "resolve_offer_failed", { error: err.message });
    return null;
  }
}

// ═════════════════════════════════════════════════════════════════════════
// Reservation reference resolver
// ═════════════════════════════════════════════════════════════════════════
const ORDINAL_WORDS = [
  "first",
  "second",
  "third",
  "fourth",
  "fifth",
  "sixth",
  "seventh",
  "eighth",
  "ninth",
  "tenth",
];

function fastResolveReservationReference(message, reservations) {
  const trimmed = message.trim().toLowerCase();

  const bareNumber = trimmed.match(
    /^#?\s*(\d{1,2})\s*(st|nd|rd|th)?\s*(one)?\s*[.)]?$/,
  );
  if (bareNumber) {
    const num = parseInt(bareNumber[1], 10);
    const found = reservations.find((r) => r.displayNumber === num);
    if (found) return found;
  }

  for (let i = 0; i < ORDINAL_WORDS.length; i++) {
    if (new RegExp(`\\b${ORDINAL_WORDS[i]}\\b`).test(trimmed)) {
      const found = reservations.find((r) => r.displayNumber === i + 1);
      if (found) return found;
    }
  }

  if (/\b(last|latest|most recent|final)\b/.test(trimmed)) {
    return reservations[reservations.length - 1];
  }
  if (
    /\b(first|earliest)\b/.test(trimmed) &&
    !/\bsecond|third\b/.test(trimmed)
  ) {
    return reservations[0];
  }

  const statusMatch = reservations.find((r) => {
    const status = (r.status || "").toLowerCase().replace(/[\s-]/g, "");
    return status && trimmed.replace(/[\s-]/g, "").includes(status);
  });
  if (statusMatch) return statusMatch;

  return null;
}

async function resolveReservationSelection(message, reservations) {
  if (!reservations || reservations.length === 0) return null;

  const fast = fastResolveReservationReference(message, reservations);
  if (fast) return { reservation: fast };

  try {
    const list = reservations
      .map(
        (r) =>
          `${r.displayNumber}. ${r.guestName || ""} — ${r.arrival || "?"} to ${r.departure || "?"} (${r.status || "unknown"})`,
      )
      .join("\n");

    const classification = await chatWithTools({
      systemPrompt: `
The guest is looking at this list of their reservations, numbered as shown:
${list}

Read the guest's message below and decide which reservation number they mean, if any. This
includes descriptive references like "tomorrow's booking", "the one at the room 101", or "the
longer stay", in ANY language.

Reply with ONLY the reservation number exactly as shown above (e.g. "2"), or exactly "NONE" if
the message is not referring to any of these reservations. No punctuation, no explanation.
`.trim(),
      history: [{ role: "user", content: message }],
      tools: [],
      model: UTILITY_MODEL,
    });

    const label = classification.text?.trim().toUpperCase();
    if (!label || label === "NONE") return null;
    const num = parseInt(label, 10);
    const found = reservations.find((r) => r.displayNumber === num);
    return found ? { reservation: found } : null;
  } catch (err) {
    logEvent(null, "resolve_reservation_failed", { error: err.message });
    return null;
  }
}

// ═════════════════════════════════════════════════════════════════════════
// Action-flow verification parsing
// ═════════════════════════════════════════════════════════════════════════
const NO_PHONE_REGEX =
  /\b(don'?t have|forgot|don'?t know|can'?t find|no phone|lost my phone|not with me)\b/i;

// Loose (left-boundary only) mention detectors — used ONLY to catch the
// guest explicitly naming a DIFFERENT action while a confirmation for
// another action is still pending (see confirmAction below). Deliberately
// more tolerant than CANCEL_INTENT_REGEX/CHECKIN_INTENT_REGEX/etc. so a
// typo like "cancely" still registers as "cancel".
function detectExplicitActionSwitch(message, currentActiveIntent) {
  const t = message || "";
  if (/\bcancel/i.test(t) && currentActiveIntent !== "CANCEL") return "CANCEL";
  if (/\bcheck[\s-]?out/i.test(t) && currentActiveIntent !== "CHECK_OUT")
    return "CHECK_OUT";
  if (/\bcheck[\s-]?in/i.test(t) && currentActiveIntent !== "CHECK_IN")
    return "CHECK_IN";
  return null;
}

// ─── Mid-confirmation intent switch detector (final fix) ───────────────────
// While the guest is being asked "Shall I check out / cancel / check in
// now?", they may actually be typing a DIFFERENT action instead of
// answering yes/no (e.g. "ok cancely my reservation" while a check-out
// confirmation is pending). The word-boundary regexes used elsewhere
// (CANCEL_INTENT_REGEX etc.) require an exact word match and miss common
// typos like "cancely", so this uses loose substring matching instead —
// deliberately narrower in scope (only used here, only to catch a genuine
// intent switch) so it doesn't affect other classification paths.
function detectCompetingActionIntent(message, currentIntent) {
  const m = (message || "").toLowerCase();
  if (currentIntent !== "CANCEL" && /cancel/.test(m)) return "CANCEL";
  if (currentIntent !== "CHECK_OUT" && /check[\s-]?out/.test(m)) return "CHECK_OUT";
  if (currentIntent !== "CHECK_IN" && /check[\s-]?in/.test(m)) return "CHECK_IN";
  return null;
}

function extractPhoneLast4(message) {
  const digits = (message || "").replace(/[^\d]/g, "");
  if (digits.length < 4) return null;
  return digits.slice(-4);
}

function buildPhoneVerificationInput(phoneLast4) {
  return { phoneLast4 };
}

function tryParseDobFast(input) {
  const trimmed = (input || "").trim().toLowerCase();
  if (!trimmed) return null;

  let m = trimmed.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (m) {
    const [, y, mo, d] = m.map(Number);
    if (isRealDate(y, mo, d))
      return { value: `${y}-${pad2(mo)}-${pad2(d)}`, matched: m[0] };
  }

  m = trimmed.match(/(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
  if (m) {
    const [, d, mo, y] = m.map(Number);
    if (isRealDate(y, mo, d))
      return { value: `${y}-${pad2(mo)}-${pad2(d)}`, matched: m[0] };
  }

  m = trimmed.match(/(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)\s+(\d{4})/);
  if (m) {
    const day = Number(m[1]);
    const month = MONTH_NAMES[m[2]];
    const year = Number(m[3]);
    if (month && isRealDate(year, month, day))
      return { value: `${year}-${pad2(month)}-${pad2(day)}`, matched: m[0] };
  }

  m = trimmed.match(/([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/);
  if (m) {
    const month = MONTH_NAMES[m[1]];
    const day = Number(m[2]);
    const year = Number(m[3]);
    if (month && isRealDate(year, month, day))
      return { value: `${year}-${pad2(month)}-${pad2(day)}`, matched: m[0] };
  }

  return null;
}

function getKnownLastName(session) {
  const fullName =
    session.knownGuestDetails?.fullName ||
    session.pendingGuestDetails?.fullName;
  if (!fullName) return null;
  const parts = fullName.trim().split(/\s+/);
  return parts.length > 1 ? parts[parts.length - 1] : null;
}

function extractDobAndRemainder(message) {
  const trimmed = (message || "").trim();
  const dob = tryParseDobFast(trimmed);
  let remainder = trimmed.toLowerCase();
  if (dob) remainder = remainder.replace(dob.matched, " ");
  return { dateOfBirth: dob ? dob.value : null, remainder };
}

const ROOM_STOP_WORDS = new Set([
  "room",
  "number",
  "and",
  "my",
  "is",
  "date",
  "birth",
  "of",
  "the",
  "im",
  "i'm",
  "last",
  "name",
  "surname",
  "born",
  "dob",
  "its",
  "it's",
]);

function tokenizeForVerification(remainder) {
  return (remainder || "")
    .split(/[^a-z0-9']+/i)
    .filter(Boolean)
    .filter((t) => !ROOM_STOP_WORDS.has(t.toLowerCase()));
}

function extractRoomNumberToken(tokens) {
  return tokens.find((t) => /^[a-z]?\d{1,4}[a-z]?$/i.test(t)) || null;
}

function extractLastNameToken(tokens) {
  const nameCandidates = tokens.filter((t) => /^[a-z']{2,}$/i.test(t));
  if (nameCandidates.length === 0) return null;
  return nameCandidates.reduce((a, b) => (b.length > a.length ? b : a));
}

function buildAltVerificationInput({ lastName, roomNumber, dateOfBirth }) {
  return { lastName, roomNumber, dateOfBirth };
}

const YES_WORDS_REGEX =
  /\b(yes|yeah|yep|yup|sure|ok(ay)?|go ahead|confirm(ed)?|correct|right|do it|please do|s[ií]|ja|oui|evet|haan|da|tak|si|ha)\b/i;
const NO_WORDS_REGEX =
  /\b(no|nope|nah|don'?t|stop|cancel that|not now|nein|non|hay[ıi]r|nahi|ne)\b/i;

function fastYesNo(message) {
  const trimmed = (message || "").trim().toLowerCase();
  if (!trimmed) return null;
  const isNo = NO_WORDS_REGEX.test(trimmed);
  const isYes = YES_WORDS_REGEX.test(trimmed);
  if (isNo && !isYes) return "NO";
  if (isYes && !isNo) return "YES";
  return null;
}

async function classifyYesNoLLM(message, contextQuestion) {
  try {
    const res = await chatWithTools({
      systemPrompt: `
The guest was just asked: "${contextQuestion}"
Read their reply below, in ANY language, and classify it as EXACTLY ONE of: YES, NO, UNCLEAR.
Reply with ONLY the single label, nothing else.
`.trim(),
      history: [{ role: "user", content: message }],
      tools: [],
      model: UTILITY_MODEL,
    });
    const label = (res.text || "").trim().toUpperCase();
    return ["YES", "NO"].includes(label) ? label : "UNCLEAR";
  } catch (err) {
    logEvent(null, "yes_no_classify_failed", { error: err.message });
    return "UNCLEAR";
  }
}

async function classifyYesNo(message, contextQuestion) {
  const fast = fastYesNo(message);
  if (fast) return fast;
  return await classifyYesNoLLM(message, contextQuestion);
}

async function classifyConfirmationReply(message) {
  try {
    const res = await chatWithTools({
      systemPrompt: `
The guest was just shown their reservation details and asked "Shall I proceed with this booking?"
Read their reply below, in ANY language, and classify it as EXACTLY ONE of:
YES, NO, CORRECTION_NAME, CORRECTION_EMAIL, CORRECTION_PHONE, UNCLEAR

- YES: any clear affirmative ("yes", "correct", "go ahead", "confirm", "sí", "ja", "haan", etc.)
- NO: any clear negative / wants to cancel or stop.
- CORRECTION_NAME / CORRECTION_EMAIL / CORRECTION_PHONE: the guest says one specific field is
  wrong and wants to fix it (e.g. "my email is wrong", "change the phone number").
- UNCLEAR: anything else, including unrelated questions.

Reply with ONLY the single label, nothing else.
`.trim(),
      history: [{ role: "user", content: message }],
      tools: [],
      model: UTILITY_MODEL,
    });
    const label = (res.text || "").trim().toUpperCase();
    const valid = [
      "YES",
      "NO",
      "CORRECTION_NAME",
      "CORRECTION_EMAIL",
      "CORRECTION_PHONE",
    ];
    return valid.includes(label) ? label : "UNCLEAR";
  } catch (err) {
    logEvent(null, "confirmation_classify_failed", { error: err.message });
    return "UNCLEAR";
  }
}

function buildAssistantToolCallEntry(toolCalls) {
  return {
    role: "assistant",
    content: null,
    tool_calls: toolCalls.map((tc) => ({
      id: tc.id,
      type: "function",
      function: { name: tc.name, arguments: JSON.stringify(tc.input) },
    })),
  };
}

function buildToolResultEntries(toolCalls, toolResults) {
  return toolResults.map((tr, i) => ({
    role: "tool",
    tool_call_id: toolCalls[i].id,
    content: JSON.stringify(tr.result),
  }));
}

// ═════════════════════════════════════════════════════════════════════════
// Reservation response normalization
// ═════════════════════════════════════════════════════════════════════════
function pickFirst(obj, keys) {
  if (!obj || typeof obj !== "object") return undefined;
  for (const key of keys) {
    const value = obj[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function normalizeReservation(raw) {
  if (!raw || typeof raw !== "object") return null;

  const nestedDetails =
    raw.reservation_details && typeof raw.reservation_details === "object"
      ? raw.reservation_details
      : {};
  const source = { ...nestedDetails, ...raw };

  const reservationId = pickFirst(source, [
    "reservationId",
    "reservation_id",
    "id",
    "confirmationId",
    "confirmation_id",
    "bookingId",
    "booking_id",
    "reservationNumber",
    "reservation_number",
  ]);
  if (!reservationId) return null;

  let guestId = pickFirst(source, [
    "guestId",
    "guest_id",
    "guestID",
    "customerId",
    "customer_id",
  ]);
  if (!guestId && source.guest && typeof source.guest === "object") {
    guestId = pickFirst(source.guest, ["id", "guestId", "guest_id"]) || null;
  }

  let guestName = pickFirst(source, [
    "guestName",
    "guest_name",
    "name",
    "fullName",
    "full_name",
  ]);
  if (!guestName && source.guest && typeof source.guest === "object") {
    guestName =
      pickFirst(source.guest, ["fullName", "full_name", "name"]) ||
      [
        pickFirst(source.guest, ["firstName", "first_name"]),
        pickFirst(source.guest, ["lastName", "last_name"]),
      ]
        .filter(Boolean)
        .join(" ") ||
      null;
  }
  if (!guestName) {
    for (const key of ["primaryGuest", "booker", "reservationGuest"]) {
      if (source[key] && typeof source[key] === "object") {
        guestName =
          pickFirst(source[key], ["fullName", "full_name", "name"]) ||
          [
            pickFirst(source[key], ["firstName", "first_name"]),
            pickFirst(source[key], ["lastName", "last_name"]),
          ]
            .filter(Boolean)
            .join(" ") ||
          null;
        if (!guestId) guestId = pickFirst(source[key], ["id", "guestId", "guest_id"]) || null;
        if (guestName) break;
      }
    }
  }

  let arrival = pickFirst(source, [
    "arrival",
    "arrival_date",
    "checkIn",
    "check_in",
    "checkInDate",
    "check_in_date",
    "checkin",
    "from",
    "startDate",
    "start_date",
  ]);
  let departure = pickFirst(source, [
    "departure",
    "departure_date",
    "checkOut",
    "check_out",
    "checkOutDate",
    "check_out_date",
    "checkout",
    "to",
    "endDate",
    "end_date",
  ]);
  if ((!arrival || !departure) && source.stay && typeof source.stay === "object") {
    arrival = arrival || pickFirst(source.stay, ["arrival", "from", "checkIn", "check_in"]);
    departure = departure || pickFirst(source.stay, ["departure", "to", "checkOut", "check_out"]);
  }

  return {
    reservationId: String(reservationId),
    guestId: guestId ? String(guestId) : null,
    guestName: guestName || null,
    arrival: arrival ? String(arrival).slice(0, 10) : null,
    departure: departure ? String(departure).slice(0, 10) : null,
    status:
      pickFirst(source, ["status", "reservationStatus", "reservation_status"]) ||
      null,
  };
}

function getRawReservationArray(result) {
  if (!result) return null;
  const candidate =
    result.reservations ||
    result.matches ||
    result.results ||
    (Array.isArray(result) ? result : null);
  return Array.isArray(candidate) ? candidate : null;
}

function extractReservationList(result) {
  const arr = getRawReservationArray(result);
  if (!arr || arr.length <= 1) return null;
  const normalized = arr.map(normalizeReservation).filter(Boolean);
  return normalized.length > 1 ? normalized : null;
}

function extractSingleReservation(result) {
  if (!result) return null;
  const arr = getRawReservationArray(result);
  if (arr && arr.length === 1) return normalizeReservation(arr[0]);
  if (result.reservation) return normalizeReservation(result.reservation);
  return normalizeReservation(result);
}

// ─── Shared: call getOffers and either show offer cards, or (if the guest
// asked for the cheapest) skip straight into guest-detail collection. ──
async function presentOffersOrAutoSelect({
  sessionId,
  session,
  property,
  params,
  lang,
  message,
  autoCheapest,
}) {
  logEvent(sessionId, "get_offers_request", {
    property: property?.name,
    arrival: params.arrival,
    departure: params.departure,
    adults: params.adults,
    autoCheapest,
  });

  const result = await executeTool({
    toolName: "getOffers",
    toolInput: params,
    session,
    property,
  });

  if (!result?.offers || result.offers.length === 0) {
    logEvent(sessionId, "get_offers_empty", { property: property?.name });
    const text = await translateToLanguage(NO_ROOMS_SENTENCE, lang);
    updateSession(sessionId, {
      history: [
        ...session.history,
        { role: "user", content: message },
        { role: "assistant", content: text },
      ],
    });
    return reply("text", { text });
  }

  const numberedOffers = result.offers.map((o, i) => ({
    ...o,
    displayNumber: i + 1,
  }));
  updateSession(sessionId, {
    lastOffers: numberedOffers,
    selectedOffer: null,
    lastSearchParams: params,
  });

  if (autoCheapest) {
    const cheapest = numberedOffers.reduce(
      (min, o) => (o.amount < min.amount ? o : min),
      numberedOffers[0],
    );
    return await enterGuestDetailFlow({
      sessionId,
      session: sessions.get(sessionId),
      message,
      offer: cheapest,
      lang,
    });
  }

  const text = await translateToLanguage(OFFERS_INTRO_SENTENCE, lang);
  updateSession(sessionId, {
    history: [
      ...session.history,
      { role: "user", content: message },
      { role: "assistant", content: text },
    ],
  });
  return reply("offers", { text, data: numberedOffers });
}

// ─── Shared: an offer has just been chosen — move into guest-detail
// collection, pre-filling from a known previous booking if one exists. ──
async function enterGuestDetailFlow({
  sessionId,
  session,
  message,
  offer,
  lang,
}) {
  updateSession(sessionId, { selectedOffer: offer });
  const refreshed = sessions.get(sessionId);

  const pendingComplete =
    refreshed.pendingGuestDetails &&
    refreshed.pendingGuestDetails.fullName &&
    refreshed.pendingGuestDetails.email &&
    refreshed.pendingGuestDetails.phone;

  // Prefer details already collected earlier in THIS booking attempt (e.g.
  // the guest picked a different room after declining a confirmation) over
  // older knownGuestDetails from a previous completed booking.
  const prefillDetails = pendingComplete
    ? refreshed.pendingGuestDetails
    : refreshed.knownGuestDetails;

  if (prefillDetails) {
    logEvent(sessionId, "guest_detail_prefilled", { offer: offer?.name });
    const details = { ...prefillDetails };
    const text = await translateToLanguage(
      buildConfirmationText(details),
      lang,
    );
    updateSession(sessionId, {
      history: [
        ...refreshed.history,
        { role: "user", content: message },
        { role: "assistant", content: text },
      ],
      pendingGuestDetails: details,
      guestDetailStep: "confirm",
      correctingField: false,
      correctionQueue: null,
    });
    return reply("text", { text });
  }

  const text = await translateToLanguage(ASK_NAME_SENTENCE, lang);
  updateSession(sessionId, {
    history: [
      ...refreshed.history,
      { role: "user", content: message },
      { role: "assistant", content: text },
    ],
    pendingGuestDetails: {},
    guestDetailStep: "name",
  });
  return reply("text", { text });
}

// ─── Deterministic search-detail collection: check-in → check-out → adults ─
async function handleSearchDetailCollection({
  sessionId,
  message,
  session,
  property,
}) {
  const step = session.searchDetailStep;
  const lang = session.lastKnownLanguage || "English";
  const pending = session.pendingSearchDetails || {};

  logEvent(sessionId, "search_detail_step", { step });

  const send = async (fixedText, extraUpdates = {}) => {
    const translated = await translateToLanguage(fixedText, lang);
    const newHistory = [
      ...session.history,
      { role: "user", content: message },
      { role: "assistant", content: translated },
    ];
    updateSession(sessionId, { history: newHistory, ...extraUpdates });
    return reply("text", { text: translated });
  };

  if (step === "arrival") {
    const arrival = await parseDateSmart(message);
    if (!arrival) return send(INVALID_DATE_SENTENCE);
    if (isPastDate(arrival)) return send(PAST_DATE_SENTENCE);
    return send(ASK_DEPARTURE_SENTENCE, {
      pendingSearchDetails: { ...pending, arrival },
      searchDetailStep: "departure",
    });
  }

  if (step === "departure") {
    const departure = await parseDateSmart(message);
    if (!departure) return send(INVALID_DATE_SENTENCE);
    if (pending.arrival && new Date(departure) <= new Date(pending.arrival)) {
      return send(INVALID_DEPARTURE_SENTENCE);
    }
    return send(ASK_ADULTS_SENTENCE, {
      pendingSearchDetails: { ...pending, departure },
      searchDetailStep: "adults",
    });
  }

  if (step === "adults") {
    const match = message.match(/\d{1,2}/);
    const adults = match ? parseInt(match[0], 10) : null;
    if (!adults || adults < 1 || adults > 10)
      return send(INVALID_ADULTS_SENTENCE);

    if (!property) {
      return send(NO_SEARCH_STATE_SENTENCE, {
        searchDetailStep: null,
        pendingSearchDetails: null,
      });
    }

    const params = {
      arrival: pending.arrival,
      departure: pending.departure,
      adults,
    };
    updateSession(sessionId, {
      searchDetailStep: null,
      pendingSearchDetails: null,
    });
    return await presentOffersOrAutoSelect({
      sessionId,
      session: sessions.get(sessionId),
      property,
      params,
      lang,
      message,
      autoCheapest: false,
    });
  }

  return send(ASK_ARRIVAL_SENTENCE, {
    searchDetailStep: "arrival",
    pendingSearchDetails: {},
  });
}

// ─── Deterministic guest-detail collection + booking confirmation ─────────
async function handleGuestDetailCollection({
  sessionId,
  message,
  session,
  property,
}) {
  const step = session.guestDetailStep;
  const lang = session.lastKnownLanguage || "English";
  const pending = session.pendingGuestDetails || {};

  logEvent(sessionId, "guest_detail_step", { step });

  const send = async (fixedText, extraUpdates = {}) => {
    const translated = await translateToLanguage(fixedText, lang);
    const newHistory = [
      ...session.history,
      { role: "user", content: message },
      { role: "assistant", content: translated },
    ];
    updateSession(sessionId, { history: newHistory, ...extraUpdates });
    return reply("text", { text: translated });
  };

  if (step === "name") {
    const fullName = message.trim();
    if (fullName.length < 2) return send(INVALID_NAME_SENTENCE);

    const details = { ...pending, fullName };
    if (session.correctingField) {
      const queue = session.correctionQueue || [];
      if (queue.length > 0) {
        const [nextField, ...rest] = queue;
        return send(getCorrectionAskSentence(nextField), {
          pendingGuestDetails: details,
          guestDetailStep: FIELD_TO_STEP[nextField],
          correctingField: true,
          correctionQueue: rest,
        });
      }
      return send(buildConfirmationText(details), {
        pendingGuestDetails: details,
        guestDetailStep: "confirm",
        correctingField: false,
        correctionQueue: null,
      });
    }
    return send(ASK_EMAIL_SENTENCE, {
      pendingGuestDetails: details,
      guestDetailStep: "email",
    });
  }

  if (step === "email") {
    const email = message.trim();
    if (!EMAIL_REGEX.test(email)) return send(INVALID_EMAIL_SENTENCE);

    const details = { ...pending, email };
    if (session.correctingField) {
      const queue = session.correctionQueue || [];
      if (queue.length > 0) {
        const [nextField, ...rest] = queue;
        return send(getCorrectionAskSentence(nextField), {
          pendingGuestDetails: details,
          guestDetailStep: FIELD_TO_STEP[nextField],
          correctingField: true,
          correctionQueue: rest,
        });
      }
      return send(buildConfirmationText(details), {
        pendingGuestDetails: details,
        guestDetailStep: "confirm",
        correctingField: false,
        correctionQueue: null,
      });
    }
    return send(ASK_PHONE_SENTENCE, {
      pendingGuestDetails: details,
      guestDetailStep: "phone",
    });
  }

  if (step === "phone") {
    const phone = message.trim();
    if (!isValidPhone(phone)) return send(INVALID_PHONE_SENTENCE);

    const details = { ...pending, phone };
    if (session.correctingField) {
      const queue = session.correctionQueue || [];
      if (queue.length > 0) {
        const [nextField, ...rest] = queue;
        return send(getCorrectionAskSentence(nextField), {
          pendingGuestDetails: details,
          guestDetailStep: FIELD_TO_STEP[nextField],
          correctingField: true,
          correctionQueue: rest,
        });
      }
    }
    return send(buildConfirmationText(details), {
      pendingGuestDetails: details,
      guestDetailStep: "confirm",
      correctingField: false,
      correctionQueue: null,
    });
  }

  if (step === "confirm") {
    // Fixed: previously we ALWAYS ran classifyConfirmationReply first, which
    // returns only a single label (YES / NO / CORRECTION_NAME /
    // CORRECTION_EMAIL / CORRECTION_PHONE / UNCLEAR). When the guest
    // corrected multiple fields in one message (e.g. "no my email is X,
    // phone is Y, name is Z"), only ONE field's correction was ever acted
    // on, and the other values the guest already gave were discarded —
    // forcing them to re-type a field they'd just supplied.
    //
    // Now we scan the message directly for any valid email/phone/name the
    // guest supplied inline. If we find any, we apply ALL of them at once
    // and re-show the confirmation immediately, instead of asking again.
    const extracted = extractCorrectionFields(message);
    const hasValidCorrection = Boolean(
      extracted.email || extracted.phone || extracted.fullName,
    );

    if (hasValidCorrection) {
      const details = { ...pending };
      if (extracted.fullName) details.fullName = extracted.fullName;
      if (extracted.email) details.email = extracted.email;
      if (extracted.phone) details.phone = extracted.phone;

      logEvent(sessionId, "guest_detail_multi_correction", {
        correctedFields: Object.keys(extracted).filter((k) =>
          ["fullName", "email", "phone"].includes(k),
        ),
      });

      // Guest attempted to correct the phone number too, but what they gave
      // isn't a valid phone — apply the corrections that ARE valid, but ask
      // specifically for a usable phone number instead of silently keeping
      // the old (possibly also wrong) one or accepting garbage.
      if (extracted.phoneAttempted && !extracted.phone) {
        return send(INVALID_PHONE_SENTENCE, {
          pendingGuestDetails: details,
          guestDetailStep: "phone",
          correctingField: true,
        });
      }

      return send(buildConfirmationText(details), {
        pendingGuestDetails: details,
        guestDetailStep: "confirm",
        correctingField: false,
      });
    }

    const label = await classifyConfirmationReply(message);
    logEvent(sessionId, "booking_confirmation_classified", { label });

    if (label === "YES") {
      const params = session.lastSearchParams;
      const offer = session.selectedOffer;
      if (
        !params ||
        !offer ||
        !pending.fullName ||
        !pending.email ||
        !pending.phone
      ) {
        logEvent(sessionId, "booking_confirm_missing_state", {
          hasParams: Boolean(params),
          hasOffer: Boolean(offer),
        });
        return send(NO_SEARCH_STATE_SENTENCE, {
          guestDetailStep: null,
          pendingGuestDetails: null,
          selectedOffer: null,
        });
      }

      const [firstName, ...rest] = pending.fullName.trim().split(/\s+/);
      const lastName = rest.join(" ") || firstName;

      const result = await executeTool({
        toolName: "createBooking",
        toolInput: {
          arrival: params.arrival,
          departure: params.departure,
          adults: params.adults,
          ratePlanId: offer.ratePlanId,
          guestFirstName: firstName,
          guestLastName: lastName,
          guestPhone: pending.phone,
          guestEmail: pending.email,
        },
        session,
        property,
      });

      if (!result || result.success === false) {
        logEvent(sessionId, "booking_failed", { error: result?.error });
        return send(BOOKING_FAILED_SENTENCE, { guestDetailStep: "confirm" });
      }

      logEvent(sessionId, "booking_confirmed", {
        reservationId: result?.reservationId || result?.reservation_id,
        property: property?.name,
      });

      const confirmText = await translateToLanguage(
        BOOKING_CONFIRMED_SENTENCE,
        lang,
      );
      const guest = result?.guest;
      const knownGuestDetails = {
        fullName: pending.fullName,
        phone: guest?.phone || pending.phone,
        email: guest?.email || pending.email,
      };

      updateSession(sessionId, {
        history: [
          ...session.history,
          { role: "user", content: message },
          { role: "assistant", content: confirmText },
        ],
        lastOffers: null,
        selectedOffer: null,
        guestDetailStep: null,
        pendingGuestDetails: null,
        knownGuestDetails,
      });
      return reply("booking_confirmed", { text: confirmText, data: result });
    }

    if (label === "NO") {
      // Problem 1 & 9: do NOT clear selectedOffer, pendingGuestDetails,
      // lastOffers, or lastSearchParams here — the booking session must
      // stay alive so the guest can correct details, pick a different
      // room, or explicitly cancel next.
      return send(BOOKING_CANCELLED_SENTENCE, {
        guestDetailStep: "postDecline",
      });
    }

    if (label === "CORRECTION_NAME")
      return send(ASK_CORRECTION_NAME_SENTENCE, {
        guestDetailStep: "name",
        correctingField: true,
      });
    if (label === "CORRECTION_EMAIL")
      return send(ASK_CORRECTION_EMAIL_SENTENCE, {
        guestDetailStep: "email",
        correctingField: true,
      });
    if (label === "CORRECTION_PHONE")
      return send(ASK_CORRECTION_PHONE_SENTENCE, {
        guestDetailStep: "phone",
        correctingField: true,
      });

    return send(UNCLEAR_CONFIRMATION_SENTENCE);
  }

  if (step === "postDecline") {
    // Priority 1: the guest supplied actual new values inline (e.g. "my
    // email is X and phone is Y") — apply all of them at once and go
    // straight back to the full confirmation card (Problem 2).
    const extracted = extractCorrectionFields(message);
    const hasValidCorrection = Boolean(
      extracted.email || extracted.phone || extracted.fullName,
    );

    if (hasValidCorrection) {
      const details = { ...pending };
      if (extracted.fullName) details.fullName = extracted.fullName;
      if (extracted.email) details.email = extracted.email;
      if (extracted.phone) details.phone = extracted.phone;

      logEvent(sessionId, "post_decline_multi_correction", {
        correctedFields: Object.keys(extracted).filter((k) =>
          ["fullName", "email", "phone"].includes(k),
        ),
      });

      if (extracted.phoneAttempted && !extracted.phone) {
        return send(INVALID_PHONE_SENTENCE, {
          pendingGuestDetails: details,
          guestDetailStep: "phone",
          correctingField: true,
          correctionQueue: [],
        });
      }

      return send(buildConfirmationText(details), {
        pendingGuestDetails: details,
        guestDetailStep: "confirm",
        correctingField: false,
        correctionQueue: null,
      });
    }

    // Priority 2: guest wants a different room (Problem 3) — re-show the
    // SAME previously fetched offers, no new search, no hotel re-ask.
    if (WANTS_ANOTHER_ROOM_REGEX.test(message)) {
      if (!session.lastOffers || session.lastOffers.length === 0) {
        return send(NO_SEARCH_STATE_SENTENCE, {
          guestDetailStep: null,
          pendingGuestDetails: null,
          selectedOffer: null,
          correctingField: false,
          correctionQueue: null,
        });
      }
      logEvent(sessionId, "post_decline_change_room", {});
      const text = await translateToLanguage(OFFERS_INTRO_SENTENCE, lang);
      updateSession(sessionId, {
        history: [
          ...session.history,
          { role: "user", content: message },
          { role: "assistant", content: text },
        ],
        guestDetailStep: null,
        selectedOffer: null,
        correctingField: false,
        correctionQueue: null,
      });
      return reply("offers", { text, data: session.lastOffers });
    }

    // Priority 3: guest explicitly wants to cancel the booking outright —
    // only NOW is it safe to clear the booking state (Problem 9).
    if (WANTS_CANCEL_BOOKING_REGEX.test(message)) {
      logEvent(sessionId, "post_decline_cancel", {});
      return send(BOOKING_CANCELLED_FINAL_SENTENCE, {
        guestDetailStep: null,
        pendingGuestDetails: null,
        selectedOffer: null,
        lastOffers: null,
        lastSearchParams: null,
        correctingField: false,
        correctionQueue: null,
      });
    }

    // Priority 4: guest names which field(s) are wrong without giving new
    // values yet (e.g. "my email and phone number are wrong") — queue them
    // and ask for each value in turn, ending on the full confirmation card.
    const fieldsToAsk = [];
    if (MENTIONS_NAME_FIELD_REGEX.test(message)) fieldsToAsk.push("fullName");
    if (MENTIONS_EMAIL_FIELD_REGEX.test(message)) fieldsToAsk.push("email");
    if (MENTIONS_PHONE_FIELD_REGEX.test(message)) fieldsToAsk.push("phone");

    if (fieldsToAsk.length > 0) {
      const [first, ...rest] = fieldsToAsk;
      logEvent(sessionId, "post_decline_field_correction_queued", {
        fields: fieldsToAsk.join(","),
      });
      return send(getCorrectionAskSentence(first), {
        guestDetailStep: FIELD_TO_STEP[first],
        correctingField: true,
        correctionQueue: rest,
      });
    }

    // Priority 5: unclear — re-ask the same deterministic prompt. State
    // stays untouched (still "postDecline").
    return send(BOOKING_CANCELLED_SENTENCE);
  }

  return send(ASK_NAME_SENTENCE, {
    guestDetailStep: "name",
    pendingGuestDetails: {},
  });
}

// ═════════════════════════════════════════════════════════════════════════
// Deterministic action flow (cancel / check-in / check-out / lookup)
// ═════════════════════════════════════════════════════════════════════════
async function handleActionFlow({ sessionId, message, session, property }) {
  const lang = session.lastKnownLanguage || "English";
  const activeIntent = session.activeIntent;
  const step = session.actionFlowStep;
  const pending = session.pendingVerification || {};

  logEvent(sessionId, "action_flow_step", {
    activeIntent,
    step: step || "start",
    property: property?.name,
  });

  const send = async (fixedText, extraUpdates = {}) => {
    const translated = await translateToLanguage(fixedText, lang);
    const newHistory = [
      ...session.history,
      { role: "user", content: message },
      { role: "assistant", content: translated },
    ];
    updateSession(sessionId, { history: newHistory, ...extraUpdates });
    return reply("text", { text: translated });
  };

  const lookupAndAdvance = async (toolInput, viaStep) => {
    const result = await executeTool({
      toolName: "getReservation",
      toolInput,
      session,
      property,
    });

    if (!result || result.success === false) {
      logEvent(sessionId, "reservation_lookup_not_found", { viaStep, error: result?.error });
      return send(RESERVATION_NOT_FOUND_SENTENCE, {
        actionFlowStep: viaStep,
        pendingVerification: {},
        knownVerification: null,
      });
    }

    const list = extractReservationList(result);
    if (list) {
      logEvent(sessionId, "reservation_lookup_multi_match", { count: list.length });
      const numbered = list.map((r, i) => ({ ...r, displayNumber: i + 1 }));
      updateSession(sessionId, { lastReservations: numbered });
      return send(buildReservationListText(numbered), {
        actionFlowStep: "selectReservation",
        lastReservations: numbered,
      });
    }

    const reservation = extractSingleReservation(result);
    if (!reservation) {
      logEvent(sessionId, "reservation_normalize_failed", { viaStep });
      return send(RESERVATION_NOT_FOUND_SENTENCE, {
        actionFlowStep: viaStep,
        pendingVerification: {},
        knownVerification: null,
      });
    }

    logEvent(sessionId, "reservation_resolved", {
      reservationId: reservation.reservationId,
      activeIntent,
    });

    if (activeIntent === "LOOKUP") {
      return send(buildReservationDetailText(reservation), {
        actionFlowStep: null,
        pendingVerification: null,
        resolvedActionReservation: null,
        activeIntent: null,
        lastReservations: null,
      });
    }

    return send(buildActionConfirmText(activeIntent, reservation), {
      actionFlowStep: "confirmAction",
      resolvedActionReservation: reservation,
      lastReservations: null,
    });
  };

  if (!step) {
    if (session.knownVerification?.phoneLast4) {
      return await lookupAndAdvance(
        buildPhoneVerificationInput(session.knownVerification.phoneLast4),
        "verifyPhone",
      );
    }
    if (
      session.knownVerification?.lastName &&
      session.knownVerification?.roomNumber &&
      session.knownVerification?.dateOfBirth
    ) {
      return await lookupAndAdvance(
        buildAltVerificationInput(session.knownVerification),
        "verifyAlt",
      );
    }
    return send(ASK_PHONE_VERIFY_SENTENCE, {
      actionFlowStep: "verifyPhone",
      pendingVerification: {},
    });
  }

  if (step === "verifyPhone") {
    if (NO_PHONE_REGEX.test(message)) {
      const knownLastName = getKnownLastName(session);
      const sentence = knownLastName
        ? ASK_ALT_VERIFY_NO_NAME_SENTENCE
        : ASK_ALT_VERIFY_FULL_SENTENCE;
      return send(sentence, {
        actionFlowStep: "verifyAlt",
        pendingVerification: {},
      });
    }
    const phoneLast4 = extractPhoneLast4(message);
    if (!phoneLast4) return send(INVALID_PHONE_VERIFY_SENTENCE);

    updateSession(sessionId, { knownVerification: { phoneLast4 } });
    return await lookupAndAdvance(
      buildPhoneVerificationInput(phoneLast4),
      "verifyPhone",
    );
  }

  if (step === "verifyAlt") {
    const knownLastName = getKnownLastName(session);
    const { dateOfBirth, remainder } = extractDobAndRemainder(message);
    const tokens = tokenizeForVerification(remainder);
    const roomNumber = extractRoomNumberToken(tokens);
    const lastName = knownLastName || extractLastNameToken(tokens);

    if (!roomNumber || !dateOfBirth || !lastName) {
      const sentence = knownLastName
        ? INVALID_ALT_VERIFY_NO_NAME_SENTENCE
        : INVALID_ALT_VERIFY_FULL_SENTENCE;
      return send(sentence);
    }

    updateSession(sessionId, {
      knownVerification: { lastName, roomNumber, dateOfBirth },
    });
    return await lookupAndAdvance(
      buildAltVerificationInput({ lastName, roomNumber, dateOfBirth }),
      "verifyAlt",
    );
  }

  if (step === "selectReservation") {
    const resolution = await resolveReservationSelection(
      message,
      session.lastReservations || [],
    );
    if (!resolution?.reservation) {
      return send(buildReservationListText(session.lastReservations || []));
    }

    if (activeIntent === "LOOKUP") {
      return send(buildReservationDetailText(resolution.reservation), {
        actionFlowStep: null,
        pendingVerification: null,
        resolvedActionReservation: null,
        activeIntent: null,
        lastReservations: null,
      });
    }

    return send(buildActionConfirmText(activeIntent, resolution.reservation), {
      actionFlowStep: "confirmAction",
      resolvedActionReservation: resolution.reservation,
      lastReservations: null,
    });
  }

  if (step === "confirmAction") {
    const reservation = session.resolvedActionReservation;
    if (!reservation) {
      return send(ASK_PHONE_VERIFY_SENTENCE, {
        actionFlowStep: "verifyPhone",
        pendingVerification: {},
      });
    }

    const switchedIntent = detectExplicitActionSwitch(message, activeIntent);
    if (switchedIntent) {
      logEvent(sessionId, "action_intent_switched_mid_confirm", {
        from: activeIntent,
        to: switchedIntent,
      });

      if (switchedIntent === "LOOKUP") {
        return send(buildReservationDetailText(reservation), {
          actionFlowStep: null,
          pendingVerification: null,
          resolvedActionReservation: null,
          activeIntent: null,
          lastReservations: null,
        });
      }

      return send(buildActionConfirmText(switchedIntent, reservation), {
        actionFlowStep: "confirmAction",
        resolvedActionReservation: reservation,
        activeIntent: switchedIntent,
      });
    }

    const label = await classifyYesNo(
      message,
      buildActionConfirmText(activeIntent, reservation),
    );
    logEvent(sessionId, "action_confirmation_classified", { label, activeIntent });

    if (label === "NO") {
      return send(ACTION_ABORTED_SENTENCE, {
        actionFlowStep: null,
        pendingVerification: null,
        resolvedActionReservation: null,
        activeIntent: null,
      });
    }

    if (label !== "YES") {
      if (RESERVATION_INFO_QUERY_REGEX.test(message)) {
        const detail = buildReservationDetailText(reservation);
        const reask = buildActionConfirmText(activeIntent, reservation);
        return send(`${detail}\n\n${reask}`);
      }
      return send(UNCLEAR_ACTION_CONFIRMATION_SENTENCE);
    }

    const toolName = ACTION_TOOL_NAME[activeIntent];
    if (!toolName) {
      logEvent(sessionId, "action_tool_unrecognized", { activeIntent });
      return send(ACTION_UNRECOGNIZED_SENTENCE, {
        actionFlowStep: null,
        pendingVerification: null,
        resolvedActionReservation: null,
        activeIntent: null,
      });
    }

    const result = await executeTool({
      toolName,
      toolInput: { reservationId: reservation.reservationId },
      session,
      property,
    });

    if (!result || result.success === false) {
      logEvent(sessionId, "action_execute_failed", {
        toolName,
        reservationId: reservation.reservationId,
        error: result?.error,
      });
      const pmsReason = result?.error;
      const text = sanitizePmsMessage(pmsReason) || ACTION_FAILED_SENTENCE;
      return send(text, { actionFlowStep: "confirmAction" });
    }

    logEvent(sessionId, "action_execute_success", {
      toolName,
      reservationId: reservation.reservationId,
    });

    const successText = ACTION_SUCCESS_SENTENCES[activeIntent] || "Done.";
    return send(successText, {
      actionFlowStep: null,
      pendingVerification: null,
      resolvedActionReservation: null,
      activeIntent: null,
    });
  }

  return send(ASK_PHONE_VERIFY_SENTENCE, {
    actionFlowStep: "verifyPhone",
    pendingVerification: {},
  });
}

// ─── Shared: run the tool-calling loop and persist history ─────────────────
async function runConversation({
  sessionId,
  systemPrompt,
  history,
  tools,
  session,
  property,
  properties,
}) {
  let currentHistory = history;
  let currentProperty = property;
  const lang = session.lastKnownLanguage || "English";
  let loopCount = 0;

  while (true) {
    loopCount++;
    if (loopCount > 6) {
      // Safety valve — should never happen, but prevents a runaway tool-call
      // loop from hanging a turn forever if the model keeps requesting tools.
      logEvent(sessionId, "run_conversation_loop_limit", { loopCount });
      const text = await translateToLanguage(LLM_FAILURE_SENTENCE, lang);
      updateSession(sessionId, {
        history: [...currentHistory, { role: "assistant", content: text }],
      });
      return reply("text", { text });
    }

    let response;
    try {
      response = await chatWithTools({
        systemPrompt,
        history: currentHistory,
        tools,
      });
    } catch (err) {
      logEvent(sessionId, "llm_call_failed", { loopCount, error: err.message });
      const text = await translateToLanguage(LLM_FAILURE_SENTENCE, lang);
      updateSession(sessionId, {
        history: [...currentHistory, { role: "assistant", content: text }],
      });
      return reply("text", { text });
    }

    if (!response.toolCalls || response.toolCalls.length === 0) {
      logEvent(sessionId, "llm_final_text", { loopCount });
      updateSession(sessionId, {
        history: [
          ...currentHistory,
          { role: "assistant", content: response.text },
        ],
      });
      return reply("text", { text: response.text });
    }

    logEvent(sessionId, "llm_tool_calls", {
      loopCount,
      tools: response.toolCalls.map((tc) => tc.name).join(","),
    });

    const toolResults = [];

    for (const toolCall of response.toolCalls) {
      if (toolCall.name === "selectProperty") {
        const newProperty = properties.find(
          (p) => p.propertyId === toolCall.input.propertyId,
        );
        if (!newProperty) {
          toolResults.push({
            toolCallId: toolCall.id,
            result: { success: false, error: "Unknown property id." },
          });
          continue;
        }
        currentProperty = newProperty;
        updateSession(sessionId, {
          propertyId: newProperty.propertyId,
          lastOffers: null,
          selectedOffer: null,
        });
        toolResults.push({
          toolCallId: toolCall.id,
          result: {
            success: true,
            propertyId: newProperty.propertyId,
            name: newProperty.name,
          },
        });
        continue;
      }

      if (PROPERTY_SCOPED_TOOLS.has(toolCall.name) && !currentProperty) {
        toolResults.push({
          toolCallId: toolCall.id,
          result: { success: false, error: "NO_HOTEL_SELECTED" },
        });
        continue;
      }

      if (
        toolCall.name === "getOffers" &&
        isPastDate(toolCall.input?.arrival)
      ) {
        toolResults.push({
          toolCallId: toolCall.id,
          result: { success: false, error: "PAST_DATE" },
        });
        continue;
      }

      let result;
      try {
        result = await executeTool({
          toolName: toolCall.name,
          toolInput: toolCall.input,
          session,
          property: currentProperty,
        });
      } catch (err) {
        logEvent(sessionId, "execute_tool_threw", {
          toolName: toolCall.name,
          propertyId: currentProperty?.propertyId,
          error: err.message,
        });
        result = { success: false, error: "Request failed. Please try again." };
      }
      toolResults.push({ toolCallId: toolCall.id, result });

      if (toolCall.name === "getOffers") {
        if (
          !result?.success &&
          (!result?.offers || result.offers.length === 0)
        ) {
          continue;
        }

        const numberedOffers = (result.offers || []).map((o, i) => ({
          ...o,
          displayNumber: i + 1,
        }));
        result.offers = numberedOffers;

        updateSession(sessionId, {
          lastOffers: numberedOffers,
          selectedOffer: null,
          lastSearchParams: {
            arrival: toolCall.input.arrival,
            departure: toolCall.input.departure,
            adults: toolCall.input.adults,
          },
        });

        const historyWithOffers = [
          ...currentHistory,
          buildAssistantToolCallEntry(response.toolCalls),
          ...buildToolResultEntries(response.toolCalls, toolResults),
        ];
        updateSession(sessionId, { history: historyWithOffers });

        return reply("offers", {
          text: OFFERS_INTRO_SENTENCE,
          data: numberedOffers,
        });
      }

      if (toolCall.name === "getReservation") {
        const list = extractReservationList(result);
        if (list) {
          const numberedReservations = list.map((r, i) => ({
            ...r,
            displayNumber: i + 1,
          }));
          result.reservations = numberedReservations;
          updateSession(sessionId, { lastReservations: numberedReservations });
        } else {
          updateSession(sessionId, { lastReservations: null });
        }
      }
    }

    currentHistory = [
      ...currentHistory,
      buildAssistantToolCallEntry(response.toolCalls),
      ...buildToolResultEntries(response.toolCalls, toolResults),
    ];
  }
}

// ─── Document-only chatbot (no property attached) ───────────────────────────
async function handleDocumentOnlySession({
  sessionId,
  chatbotId,
  message,
  chatbot,
}) {
  const session = sessions.get(sessionId);

  if (!message.trim()) {
    const text = `Welcome to ${chatbot.name}.`;
    updateSession(sessionId, {
      state: "active",
      history: [{ role: "assistant", content: text }],
    });
    return reply("text", { text });
  }

  const { intent, language, englishQuery } = await analyzeGuestMessage(
    message,
    session.history,
    null,
    sessionId,
  );
  const isSmallTalk = intent === "SMALL_TALK";

  const ragChunks = await searchSimilarChunks({
    query: englishQuery,
    chatbotId,
    topK: 8,
  });
  const RELEVANCE_THRESHOLD = 0.35;
  const FALLBACK_RELEVANCE_CEILING = 0.55;
  const { chunks: relevantChunks, usedFallback } = selectRelevantChunks(
    ragChunks,
    {
      strictThreshold: RELEVANCE_THRESHOLD,
      fallbackCeiling: FALLBACK_RELEVANCE_CEILING,
    },
  );
  const hasContext = relevantChunks.length > 0;

  logEvent(sessionId, "rag_result", {
    scope: "document_only",
    retrieved: ragChunks.length,
    used: relevantChunks.length,
    usedFallback,
  });

  const history = [...session.history, { role: "user", content: message }];

  if (!hasContext && !isSmallTalk) {
    const text = await translateToLanguage(NO_CONTEXT_SENTENCES.doc, language);
    updateSession(sessionId, {
      history: [...history, { role: "assistant", content: text }],
    });
    return reply("text", { text });
  }

  const ragContext = hasContext
    ? `INFORMATION — answer using what is written here; understand it by MEANING, not by requiring
the guest's exact words to appear verbatim:\n${relevantChunks.map((c) => c.content).join("\n---\n")}`
    : SMALL_TALK_INSTRUCTION;

  const systemPrompt = `
${chatbot.systemPrompt}
${LANGUAGE_RULE}
${BREVITY_RULE}
${PUNCTUATION_RULE}
${BASIC_FORMAT_RULE}
${CAPABILITY_BOUNDARY_RULE}

You answer guest questions using only the information provided below. You have no booking
tools available — if asked to book or manage a reservation, say that isn't something you can do here.

${
  hasContext
    ? `
CONCISENESS — MOST IMPORTANT RULE, applies above all else:
- Answer ONLY the exact thing the guest asked. Never add extra facts from the same source
  that weren't asked for, even if they're right there in the INFORMATION.
- Never restate information you already gave in an earlier turn.
- If the guest asks a narrow question ("who and where"), give only those specific facts —
  not the full history/background/extra names available in the source.

GROUNDING RULE — apply this check BEFORE answering, every time:
1. Read the guest's exact question — identify the specific subject/entity/topic being asked about,
   by MEANING. The guest's wording, spelling, phrasing, or language may differ completely from the
   INFORMATION below — that is expected and fine. Judge whether the same real-world subject is
   being discussed, not whether the same words appear.
2. Does the INFORMATION below genuinely address that subject, in meaning? Paraphrases, synonyms,
   translations, and loosely-worded restatements of the same fact all count as a match — do not
   require literal word overlap.
3. Answer using only that information, and only the part that answers the question (see
   CONCISENESS above).
4. NEVER invent a specific detail — a date, number, name, or figure — that is not actually
   supported by the INFORMATION above, even in paraphrase. If the specific thing the guest asked
   about is genuinely absent from the INFORMATION (not just differently worded, but actually not
   covered), say you don't have that information rather than estimating or filling it in from
   general knowledge.
${
  usedFallback
    ? `5. This INFORMATION was retrieved as a best-effort match, not a confident one — if it does
   not, even loosely and in meaning, cover the guest's question, say
   "I don't have information regarding that. Let me know if you need something else." instead
   of answering. But if it genuinely does cover the topic just in different words, answer normally
   — don't refuse purely because the guest's phrasing differs from the source text.`
    : ""
}
`.trim()
    : ""
}

${ragContext}
`.trim();

  const result = await runConversation({
    sessionId,
    systemPrompt,
    history,
    tools: [],
    session,
    property: null,
  });

  return result;
}

// ─── Shared: RAG lookup + system prompt + big-model tool-calling turn. ─────
async function continueWithModel({
  sessionId,
  chatbotId,
  message,
  properties,
  chatbot,
  session,
  effectiveProperty,
  intent,
  language,
  englishQuery,
}) {
  const isSmallTalk = intent === "SMALL_TALK";
  const isFollowUp = intent === "FOLLOW_UP";
  const isActionRequest = intent === "ACTION_REQUEST";
  const isConversational = isSmallTalk || isFollowUp || isActionRequest;

  const history = [...session.history, { role: "user", content: message }];

  if (isActionRequest && !effectiveProperty) {
    const text = await translateToLanguage(
      buildAskHotelText(properties, false),
      language,
    );
    updateSession(sessionId, {
      awaitingHotelForAction: true,
      history: [...history, { role: "assistant", content: text }],
    });
    return reply("text", { text });
  }

  let ragChunks = [];
  let usedGeneralFallback = false;
  let relevantChunks = [];
  let usedFallback = false;
  let hasContext = false;

  if (!isConversational) {
    ragChunks = effectiveProperty
      ? await searchSimilarChunks({
          query: englishQuery,
          chatbotId,
          propertyId: effectiveProperty.propertyId,
          topK: 8,
        })
      : await searchSimilarChunks({ query: englishQuery, chatbotId, topK: 8 });

    const STRICT_THRESHOLD = effectiveProperty ? 0.32 : 0.35;
    const FALLBACK_CEILING = effectiveProperty ? 0.5 : 0.55;
    let selection = selectRelevantChunks(ragChunks, {
      strictThreshold: STRICT_THRESHOLD,
      fallbackCeiling: FALLBACK_CEILING,
    });
    relevantChunks = selection.chunks;
    usedFallback = selection.usedFallback;

    if (effectiveProperty && relevantChunks.length === 0) {
      const generalChunks = await searchSimilarChunks({
        query: englishQuery,
        chatbotId,
        topK: 8,
      });
      const generalSelection = selectRelevantChunks(generalChunks, {
        strictThreshold: 0.35,
        fallbackCeiling: 0.55,
      });
      if (generalSelection.chunks.length > 0) {
        ragChunks = generalChunks;
        relevantChunks = generalSelection.chunks;
        usedFallback = generalSelection.usedFallback;
        usedGeneralFallback = true;
      }
    }

    hasContext = relevantChunks.length > 0;

    logEvent(sessionId, "rag_result", {
      scope: effectiveProperty ? "property" : "general",
      retrieved: ragChunks.length,
      used: relevantChunks.length,
      usedFallback,
      usedGeneralFallback,
    });
  }

  const contextLabel =
    effectiveProperty && !usedGeneralFallback
      ? "HOTEL INFORMATION"
      : "GENERAL INFORMATION";

  if (!hasContext && !isConversational) {
    const text = await translateToLanguage(
      NO_CONTEXT_SENTENCES.property,
      language,
    );
    updateSession(sessionId, {
      history: [...history, { role: "assistant", content: text }],
    });
    return reply("text", { text });
  }

  let ragContext;
  if (hasContext) {
    ragContext = `
${contextLabel} — the ONLY source of truth for factual questions:
${relevantChunks.map((c) => c.content).join("\n---\n")}

GROUNDING RULE — apply this check BEFORE answering, every time:
1. Read the guest's exact question — identify the specific subject/entity/topic being asked about,
   by MEANING. The guest's exact wording, spelling, or language may differ from the
   ${contextLabel} below — that's expected. Judge whether the same real-world subject is being
   discussed, not whether identical words appear.
2. Does the ${contextLabel} above genuinely address that subject, in meaning? Paraphrases,
   synonyms, and differently-worded statements of the same fact all count — literal word overlap
   is NOT required.
3. Answer using ONLY that information, and ONLY the part that answers the question.
4. NEVER invent a specific detail — a date, number, name, or figure — that isn't actually
   supported by the ${contextLabel} above, even in paraphrase. If the guest asks something
   specific (e.g. "when was X launched", "how much does Y cost") and that specific fact is
   genuinely absent from the text (not just worded differently), say you don't have that
   information — do not estimate, guess, or fill it in from general knowledge.
${
  usedFallback
    ? `5. This ${contextLabel} was retrieved as a best-effort match, not a confident one — if it
   does not, even loosely and in meaning, cover the guest's question, say you don't have that
   information instead of answering. But if it genuinely covers the topic just in different
   words, answer normally rather than refusing over wording differences.`
    : ""
}

RAG CONCISENESS — MOST IMPORTANT RULE for factual answers, applies above all else:
- Answer ONLY the exact thing the guest asked. Never add extra facts from the source above
  that weren't asked for, even if they're right there in the source.
- If the guest asks a narrow question, give only that specific fact — not the full surrounding
  paragraph/background/extra detail available in the source.
- Never restate information you already gave in an earlier turn.
`.trim();
  } else if (isSmallTalk) {
    ragContext = SMALL_TALK_INSTRUCTION;
  } else if (isActionRequest) {
    ragContext = ACTION_REQUEST_INSTRUCTION;
  } else {
    ragContext = CONVERSATIONAL_EXCEPTION_INSTRUCTION;
  }

  const propertyList = properties
    .map((p) => `- ${p.name} [id: ${p.propertyId}]`)
    .join("\n");

  const hotelStatusBlock = effectiveProperty
    ? `Hotel: ${effectiveProperty.name} (currently confirmed for this conversation)\nAddress: ${effectiveProperty.address}`
    : `No hotel confirmed yet for this conversation. Do NOT ask which hotel just to answer a question — only ask if the guest is trying to use a hotel-specific tool (see TOOL RULE and HOTEL SCOPE RULE below).`;

  const activeIntentBlock = session.activeIntent
    ? `ACTIVE INTENT (do not deviate from this without the guest explicitly changing it): ${INTENT_LABELS[session.activeIntent] || session.activeIntent}`
    : "";

  let resolvedReservationBlock = "";
  if (session.lastReservations) {
    const resolution = await resolveReservationSelection(
      message,
      session.lastReservations,
    );
    if (resolution?.reservation) {
      const r = resolution.reservation;
      resolvedReservationBlock = `
RESOLVED RESERVATION — the guest's last message referred to this specific reservation from the
list you showed earlier; use its reservationId directly, do not ask the guest to identify it again:
reservationId: ${r.reservationId || r.id}, guest: ${r.guestName || "unknown"}, dates: ${r.arrival || "?"} to ${r.departure || "?"}, status: ${r.status || "unknown"}
`.trim();
    }
  }

  const isPureActionFlow = !hasContext && isConversational;

  logEvent(sessionId, "continue_with_model", {
    intent,
    isPureActionFlow,
    hasContext,
    property: effectiveProperty?.name || "none",
  });

  const systemPrompt = isPureActionFlow
    ? `
${chatbot.systemPrompt}
${LANGUAGE_RULE}
${BREVITY_RULE}
${PUNCTUATION_RULE}
${PERSONA_RULE}
${TOOL_RULE}
${TOOL_ERROR_RULE}
${CAPABILITY_BOUNDARY_RULE}
${CONTEXT_RULE}
${ACTION_HOTEL_RULE}

Today's date: ${new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}
${hotelStatusBlock}
${activeIntentBlock}
${resolvedReservationBlock}

Hotels you manage:
${propertyList}

${ragContext}
`.trim()
    : `
${chatbot.systemPrompt}
${LANGUAGE_RULE}
${BREVITY_RULE}
${PUNCTUATION_RULE}

CONCISENESS — MOST IMPORTANT RULE, applies above all else:
- Answer or ask ONLY what's needed for the guest's current turn. Never add unrelated information.
- NEVER repeat a question you already asked in your immediately preceding message — check your
  last message before asking again. If the guest already answered it earlier in the conversation,
  use that answer, don't ask again.
- Never restate details the guest already has from your previous turn unless it's part of a
  required confirmation template.

${PERSONA_RULE}
${TOOL_RULE}
${TOOL_ERROR_RULE}
${CAPABILITY_BOUNDARY_RULE}
${CONTEXT_RULE}
${HOTEL_SCOPE_RULE}
${ACTION_HOTEL_RULE}
${BASIC_FORMAT_RULE}

Today's date: ${new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}
${hotelStatusBlock}
${activeIntentBlock}
${resolvedReservationBlock}

Hotels you manage (for HOTEL SWITCHING in TOOL RULE, and for HOTEL SCOPE RULE):
${propertyList}

HOTEL SWITCH WORDING:
- selectProperty only changes which hotel you're discussing — it does NOT create a booking.
- After switching, say something like "Now contacting {hotel}." or "Switched to {hotel}." — never
  say "you're booked" or imply a reservation was made just from switching.
- If the guest named the hotel together with an actual question (e.g. "what's parking like at
  Hotel London"), answer that question directly using HOTEL INFORMATION below — do not stop at a
  switch confirmation and wait for them to repeat the question.

${ragContext}
`.trim();

  return await runConversation({
    sessionId,
    systemPrompt,
    history,
    tools: getToolsForIntent(session.activeIntent),
    session,
    property: effectiveProperty,
    properties,
  });
}

// ═════════════════════════════════════════════════════════════════════════
// Narrow the tool array by active intent
// ═════════════════════════════════════════════════════════════════════════
const INTENT_TOOL_NAMES = {
  CANCEL: ["getReservation", "cancelReservation"],
  CHECK_IN: ["getReservation", "checkIn"],
  CHECK_OUT: ["getReservation", "checkOut"],
  LOOKUP: ["getReservation"],
};

function getToolsForIntent(activeIntent) {
  const fullSet = [...toolDefinitions.all, toolDefinitions.selectProperty];
  const allowedList = activeIntent && INTENT_TOOL_NAMES[activeIntent];
  if (!allowedList) return fullSet;

  const allowedNames = new Set([...allowedList, "selectProperty"]);
  const narrowed = fullSet.filter((t) =>
    allowedNames.has(t?.function?.name ?? t?.name),
  );
  return narrowed.length > 0 ? narrowed : fullSet;
}

// ─── Chatbot-with-properties handler ────────────────────────────────────────
async function handleWithProperties({
  sessionId,
  chatbotId,
  message,
  properties,
  chatbot,
}) {
  const currentSession = sessions.get(sessionId);

  if (!message.trim()) {
    const text = `Welcome to ${chatbot.name}.`;
    updateSession(sessionId, {
      state: "active",
      history: [{ role: "assistant", content: text }],
    });
    return reply("welcome", { text, data: { showButtons: true } });
  }

  if (message === "__book_stay__") {
    return reply("reopen_modal", {});
  }

  if (message === "__ask_question__") {
    updateSession(sessionId, { state: "active" });
    return reply("text", { text: "What would you like to know?" });
  }

  if (PASSCODE_REGEX.test(message)) {
    logEvent(sessionId, "passcode_request_refused", {});
    const lang = currentSession.lastKnownLanguage || "English";
    const text = await translateToLanguage(PASSCODE_REFUSAL_SENTENCE, lang);
    updateSession(sessionId, {
      history: [
        ...currentSession.history,
        { role: "user", content: message },
        { role: "assistant", content: text },
      ],
    });
    return reply("text", { text });
  }

  const mentioned = detectMentionedProperty(message, properties);
  const effectiveProperty =
    mentioned ||
    properties.find((p) => p.propertyId === currentSession.propertyId) ||
    null;

  logEvent(sessionId, "property_resolved", {
    mentioned: mentioned?.name || "none",
    effective: effectiveProperty?.name || "none",
  });

  if (mentioned && mentioned.propertyId !== currentSession.propertyId) {
    updateSession(sessionId, {
      propertyId: mentioned.propertyId,
      lastOffers: null,
      selectedOffer: null,
    });
  }

  if (
    QUICK_REPEAT_REGEX.test(message) &&
    currentSession.propertyId &&
    currentSession.lastSearchParams
  ) {
    const repeatProperty = properties.find(
      (p) => p.propertyId === currentSession.propertyId,
    );
    const params = currentSession.lastSearchParams;

    if (repeatProperty && !isPastDate(params.arrival)) {
      logEvent(sessionId, "quick_repeat_booking", { property: repeatProperty.name });
      const lang = currentSession.lastKnownLanguage || "English";
      updateSession(sessionId, {
        awaitingHotelForBooking: false,
        awaitingHotelForAction: false,
        searchDetailStep: null,
        pendingSearchDetails: null,
        activeIntent: "BOOK",
      });
      return await presentOffersOrAutoSelect({
        sessionId,
        session: sessions.get(sessionId),
        property: repeatProperty,
        params,
        lang,
        message,
        autoCheapest: CHEAPEST_REGEX.test(message),
      });
    }
  }

  if (currentSession.awaitingHotelForBooking) {
    const lang = currentSession.lastKnownLanguage || "English";

    if (!mentioned) {
      const text = await translateToLanguage(
        buildAskHotelText(properties, true),
        lang,
      );
      updateSession(sessionId, {
        history: [
          ...currentSession.history,
          { role: "user", content: message },
          { role: "assistant", content: text },
        ],
      });
      return reply("text", { text });
    }

    logEvent(sessionId, "route", { branch: "booking_hotel_confirmed", property: mentioned.name });
    const text = await translateToLanguage(ASK_ARRIVAL_SENTENCE, lang);
    updateSession(sessionId, {
      awaitingHotelForBooking: false,
      searchDetailStep: "arrival",
      pendingSearchDetails: {},
      history: [
        ...currentSession.history,
        { role: "user", content: message },
        { role: "assistant", content: text },
      ],
    });
    return reply("text", { text });
  }

  if (currentSession.awaitingHotelForAction) {
    const lang = currentSession.lastKnownLanguage || "English";

    if (!mentioned) {
      const text = await translateToLanguage(
        buildAskHotelText(properties, false),
        lang,
      );
      updateSession(sessionId, {
        history: [
          ...currentSession.history,
          { role: "user", content: message },
          { role: "assistant", content: text },
        ],
      });
      return reply("text", { text });
    }

    logEvent(sessionId, "route", { branch: "action_hotel_confirmed", property: mentioned.name });
    updateSession(sessionId, { awaitingHotelForAction: false });
    return await handleActionFlow({
      sessionId,
      message,
      session: sessions.get(sessionId),
      property: mentioned,
    });
  }

  if (currentSession.searchDetailStep) {
    logEvent(sessionId, "route", { branch: "search_detail_collection" });
    return await handleSearchDetailCollection({
      sessionId,
      message,
      session: currentSession,
      property: effectiveProperty,
    });
  }

  if (currentSession.guestDetailStep) {
    logEvent(sessionId, "route", { branch: "guest_detail_collection" });
    return await handleGuestDetailCollection({
      sessionId,
      message,
      session: sessions.get(sessionId),
      property: effectiveProperty,
    });
  }

  if (currentSession.actionFlowStep) {
    logEvent(sessionId, "route", { branch: "action_flow_continuation" });
    return await handleActionFlow({
      sessionId,
      message,
      session: sessions.get(sessionId),
      property: effectiveProperty,
    });
  }

  const offerSelection = currentSession.lastOffers
    ? await resolveOfferSelection(message, currentSession.lastOffers)
    : null;

  if (offerSelection?.outOfRange) {
    const lang = currentSession.lastKnownLanguage || "English";
    const text = await translateToLanguage(
      `Please give a valid offer number between 1 and ${currentSession.lastOffers.length}.`,
      lang,
    );
    updateSession(sessionId, {
      history: [
        ...currentSession.history,
        { role: "user", content: message },
        { role: "assistant", content: text },
      ],
    });
    return reply("text", { text });
  }

  if (offerSelection?.offer) {
    logEvent(sessionId, "route", { branch: "offer_selected", offer: offerSelection.offer.name });
    const lang = currentSession.lastKnownLanguage || "English";
    return await enterGuestDetailFlow({
      sessionId,
      session: currentSession,
      message,
      offer: offerSelection.offer,
      lang,
    });
  }

  const regexHint = regexIntentHint(message);

  const analysis = await analyzeGuestMessage(
    message,
    currentSession.history,
    regexHint,
    sessionId,
  );
  const { intent, actionIntent, language, englishQuery } = analysis;

  if (intent !== "FOLLOW_UP") {
    updateSession(sessionId, { lastKnownLanguage: language });
  }

  if (intent === "ACTION_REQUEST" && actionIntent && actionIntent !== "NONE") {
    updateSession(sessionId, { activeIntent: actionIntent });
  }

  const history = [
    ...currentSession.history,
    { role: "user", content: message },
  ];

  if (intent === "ACTION_REQUEST" && actionIntent === "BOOK") {
    logEvent(sessionId, "route", { branch: "book", mentioned: Boolean(mentioned) });

    if (!mentioned) {
      const text = await translateToLanguage(
        buildAskHotelText(properties, true),
        language,
      );
      updateSession(sessionId, {
        awaitingHotelForBooking: true,
        history: [...history, { role: "assistant", content: text }],
      });
      return reply("text", { text });
    }

    const extracted = extractQuickBookingDetails(message);
    if (extracted.arrival && isPastDate(extracted.arrival)) {
      delete extracted.arrival;
      delete extracted.departure;
    }
    if (
      extracted.arrival &&
      extracted.departure &&
      new Date(extracted.departure) <= new Date(extracted.arrival)
    ) {
      delete extracted.departure;
    }

    const hasAllSearchDetails = Boolean(
      extracted.arrival && extracted.departure && extracted.adults,
    );

    if (!hasAllSearchDetails) {
      const pendingSearchDetails = {};
      if (extracted.arrival) pendingSearchDetails.arrival = extracted.arrival;
      if (extracted.arrival && extracted.departure)
        pendingSearchDetails.departure = extracted.departure;

      let nextStep = "arrival";
      let askSentence = ASK_ARRIVAL_SENTENCE;
      if (extracted.arrival && !extracted.departure) {
        nextStep = "departure";
        askSentence = ASK_DEPARTURE_SENTENCE;
      } else if (
        extracted.arrival &&
        extracted.departure &&
        !extracted.adults
      ) {
        nextStep = "adults";
        askSentence = ASK_ADULTS_SENTENCE;
      }

      const text = await translateToLanguage(askSentence, language);
      updateSession(sessionId, {
        searchDetailStep: nextStep,
        pendingSearchDetails,
        history: [...history, { role: "assistant", content: text }],
      });
      return reply("text", { text });
    }

    if (extracted.fullName && extracted.email && extracted.phone) {
      updateSession(sessionId, {
        knownGuestDetails: {
          fullName: extracted.fullName,
          email: extracted.email,
          phone: extracted.phone,
        },
      });
    }
    updateSession(sessionId, {
      searchDetailStep: null,
      pendingSearchDetails: null,
    });

    return await presentOffersOrAutoSelect({
      sessionId,
      session: sessions.get(sessionId),
      property: mentioned,
      params: {
        arrival: extracted.arrival,
        departure: extracted.departure,
        adults: extracted.adults,
      },
      lang: language,
      message,
      autoCheapest: extracted.wantsCheapest,
    });
  }

  if (intent === "ACTION_REQUEST" && actionIntent === "LOOKUP") {
    logEvent(sessionId, "route", { branch: "lookup", mentioned: Boolean(mentioned) });

    if (!mentioned) {
      const text = await translateToLanguage(
        buildAskHotelText(properties, false),
        language,
      );
      updateSession(sessionId, {
        awaitingHotelForAction: true,
        history: [...history, { role: "assistant", content: text }],
      });
      return reply("text", { text });
    }

    return await handleActionFlow({
      sessionId,
      message,
      session: sessions.get(sessionId),
      property: mentioned,
    });
  }

  if (
    intent === "ACTION_REQUEST" &&
    (actionIntent === "CANCEL" ||
      actionIntent === "CHECK_IN" ||
      actionIntent === "CHECK_OUT")
  ) {
    logEvent(sessionId, "route", { branch: actionIntent.toLowerCase(), mentioned: Boolean(mentioned) });

    if (!mentioned) {
      const text = await translateToLanguage(
        buildAskHotelText(properties, false),
        language,
      );
      updateSession(sessionId, {
        awaitingHotelForAction: true,
        history: [...history, { role: "assistant", content: text }],
      });
      return reply("text", { text });
    }

    return await handleActionFlow({
      sessionId,
      message,
      session: sessions.get(sessionId),
      property: mentioned,
    });
  }

  if (intent === "ACTION_REQUEST" && (!actionIntent || actionIntent === "NONE")) {
    logEvent(sessionId, "route", { branch: "unsupported_action_request" });
    updateSession(sessionId, { activeIntent: null, lastReservations: null });

    if (PAYMENT_LINK_REGEX.test(message)) {
      const text = await translateToLanguage(
        PAYMENT_LINK_REFUSAL_SENTENCE,
        language,
      );
      updateSession(sessionId, {
        history: [...history, { role: "assistant", content: text }],
      });
      return reply("text", { text });
    }

    if (FEEDBACK_REGEX.test(message)) {
      const text = await translateToLanguage(FEEDBACK_REFUSAL_SENTENCE, language);
      updateSession(sessionId, {
        history: [...history, { role: "assistant", content: text }],
      });
      return reply("text", { text });
    }

    // Not a recognized action and not one of the known unsupported
    // requests either — let the normal LLM/RAG response handle it instead
    // of forcing the hotel-verification flow.
    return await continueWithModel({
      sessionId,
      chatbotId,
      message,
      properties,
      chatbot,
      session: sessions.get(sessionId),
      effectiveProperty,
      intent: "NEW_QUESTION",
      language,
      englishQuery,
    });
  }

  if (
    (intent === "NEW_QUESTION" || intent === "SMALL_TALK") &&
    (!actionIntent || actionIntent === "NONE")
  ) {
    updateSession(sessionId, { activeIntent: null, lastReservations: null });
  }

  logEvent(sessionId, "route", { branch: "continue_with_model", intent });

  return await continueWithModel({
    sessionId,
    chatbotId,
    message,
    properties,
    chatbot,
    session: sessions.get(sessionId),
    effectiveProperty,
    intent,
    language,
    englishQuery,
  });
}

// ─── Main service ──────────────────────────────────────────────────────────
export const chatbotService = {
  async handleMessage({ sessionId, chatbotId, message }) {
    const startedAt = Date.now();
    logEvent(sessionId, "incoming_message", {
      chatbotId: shortId(chatbotId),
      message,
    });

    try {
      const chatbot = await Chatbot.findByPk(chatbotId);
      if (!chatbot) throw new NotFoundError("Chatbot not found.");

      const session = getOrCreateSession(sessionId, chatbotId);
      if (session.chatbotId !== chatbotId)
        throw new AppError("Session does not belong to this chatbot.", 400);

      const chatbotWithProps = await Chatbot.findByPk(chatbotId, {
        include: [{ model: Property, through: { attributes: [] } }],
      });
      const properties = chatbotWithProps?.properties ?? [];

      const result =
        properties.length === 0
          ? await handleDocumentOnlySession({
              sessionId,
              chatbotId,
              message,
              chatbot,
            })
          : await handleWithProperties({
              sessionId,
              chatbotId,
              message,
              properties,
              chatbot,
            });

      logEvent(sessionId, "reply_sent", {
        type: result?.type,
        elapsedMs: Date.now() - startedAt,
        text: result?.text,
      });

      return result;
    } catch (err) {
      logEvent(sessionId, "handle_message_failed", {
        elapsedMs: Date.now() - startedAt,
        error: err.message,
      });
      throw err;
    }
  },

  async getProperties({ chatbotId }) {
    const chatbotWithProps = await Chatbot.findByPk(chatbotId, {
      include: [{ model: Property, through: { attributes: [] } }],
    });
    if (!chatbotWithProps) throw new NotFoundError("Chatbot not found.");

    return (chatbotWithProps.properties ?? []).map((p) => ({
      propertyId: p.propertyId,
      name: p.name,
      address: p.address,
    }));
  },

  async searchOffers({
    sessionId,
    chatbotId,
    propertyId,
    arrival,
    departure,
    adults,
  }) {
    const chatbot = await Chatbot.findByPk(chatbotId);
    if (!chatbot) throw new NotFoundError("Chatbot not found.");

    const chatbotWithProps = await Chatbot.findByPk(chatbotId, {
      include: [{ model: Property, through: { attributes: [] } }],
    });
    const properties = chatbotWithProps?.properties ?? [];
    const property = properties.find((p) => p.propertyId === propertyId);
    if (!property) throw new AppError("Invalid property selected.", 400);

    if (isPastDate(arrival)) {
      return reply("text", {
        text: "Please provide a check-in date of today or later.",
      });
    }

    const session = getOrCreateSession(sessionId, chatbotId);

    updateSession(sessionId, { propertyId, state: "active" });
    const updatedSession = sessions.get(sessionId);

    const result = await executeTool({
      toolName: "getOffers",
      toolInput: { arrival, departure, adults },
      session: updatedSession,
      property,
    });

    if (!result?.offers) {
      return reply("text", {
        text: "No rooms are available for those dates. Want to try different ones?",
      });
    }

    const numberedOffers = result.offers.map((o, i) => ({
      ...o,
      displayNumber: i + 1,
    }));

    updateSession(sessionId, {
      lastOffers: numberedOffers,
      selectedOffer: null,
      lastSearchParams: { arrival, departure, adults },
    });

    return reply("offers", {
      text: "Here are the available offers. Reply with a number to choose your room.",
      data: numberedOffers,
    });
  },
};