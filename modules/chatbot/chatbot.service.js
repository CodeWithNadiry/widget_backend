import Chatbot from "../../models/chatbot.model.js";
import Property from "../../models/property.model.js";
import { NotFoundError, AppError } from "../../utils/AppError.js";
import { searchSimilarChunks } from "../../lib/rag.js";
import { chatWithTools, UTILITY_MODEL } from "../../llm/client.js";
import { toolDefinitions } from "../../tools/toolDefinitions.js";
import { executeTool } from "../../tools/toolExecutor.js";

// ─── Response envelope ──────────────────────────────────────────────────────
// Every reply from this service now has this shape instead of a bare string.
// type: "welcome" | "ask_hotel" | "offers" | "booking_confirmed" | "text"
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
GOOD: "No rooms are available for those dates — want to try different ones?"
`.trim();

// ─── Basic format rule (applies to EVERY chatbot, with or without tools) ──
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
// Casual conversational messages (greetings, "how are you", thanks, goodbyes) have no factual
// content to ground against a document, so they must NEVER be routed through the no-context
// hard-stop. This is what lets the bot feel human for day-to-day pleasantries while still
// refusing to hallucinate on real factual questions outside its documents.
const SMALL_TALK_INSTRUCTION = `
SMALL TALK:
The guest's latest message is casual small talk (a greeting, "how are you", thanks, goodbye, a
pleasantry, etc.) with no factual content to look up. Respond briefly and warmly in your own
words, in character as the front desk persona, then stop. Do NOT say you lack information for
this — small talk is never a factual question, so the no-information rule never applies to it.
`.trim();

// ─── Action-request rule ────────────────────────────────────────────────────
// Booking/action intent ("I want to make a reservation", "cancel my booking", "check me in")
// is NOT a factual question that needs document grounding, and must NEVER be routed through the
// no-context hard-stop either — otherwise the guest gets a "I don't have information regarding
// that" refusal before the model ever gets a chance to use its tools.
const ACTION_REQUEST_INSTRUCTION = `
NO DOCUMENT CONTEXT WAS FOUND — but the guest is expressing intent to perform an action (book a
room, check in/out, cancel a reservation, get a passcode, resend a confirmation, etc.), not
asking a factual question.

- Do NOT refuse and do NOT say you don't have that information.
- Follow the BOOKING INTENT and TOOL RULE sections above: ask for whatever details are missing
  (dates/adults for a booking, or which hotel if none is confirmed yet), or call the appropriate
  tool immediately if you already have everything you need.
`.trim();

// ─── Tool usage rule ───────────────────────────────────────────────────────
const TOOL_RULE = `
TOOL RULE:
- Always use tools for actions (booking, lookup, payment, WhatsApp). Never simulate or guess results.
- Never ask the guest to repeat information you already have.

SEQUENTIAL TOOL RULES — never call these in the same turn:
1. getOffers → createBooking: ALWAYS call getOffers first and WAIT for it to return.
   Only after getOffers returns, call createBooking with the exact ratePlanId from that result.
   If the guest already gave full name, phone, and email before or during getOffers, do NOT ask again —
   call createBooking immediately using those details from history.
2. getReservation → sendWhatsappRecovery: ALWAYS call getReservation first and WAIT for it to return,
   then call sendWhatsappRecovery with the reservationId from that result. Never call both in the same turn.
3. getReservation → checkIn: Before calling checkIn, resolve the guest's reservationId first via
   getReservation, using whatever the guest naturally gives you (phone last 4 digits, or last name +
   date of birth + room number). Never ask the guest for a "reservation ID" by name — once getReservation
   returns, confirm the booking back to the guest in plain terms, then call checkIn with the resolved id.
4. One tool call per turn maximum when the second call depends on the first call's output.

REQUIRED FIELDS — NEVER DEFAULT OR ASSUME:
- arrival, departure, AND adults are all required for getOffers. If the guest gives only dates
  and no number of adults (or only adults and no dates), do NOT call getOffers yet — do NOT assume
  adults=1. Ask for exactly the missing piece(s) in one short question, then wait for the reply.
- Only call getOffers once arrival, departure, and adults are all known from the conversation.

DATE VALIDITY:
- Check-in (arrival) must be today's date or later. If the guest gives a check-in date that has
  already passed, do NOT call getOffers with it — ask them to provide a valid date (today or
  later) in one short sentence. Never call getOffers with a past date and never tell the guest
  "no rooms are available" for a date that is simply in the past — the actual problem is the date,
  say so plainly.

BOOKING INTENT (typed text):
- If the guest expresses booking intent via typed text ("book a stay", "reserve a room", "book
  another one", etc.) and has NOT yet given check-in date, check-out date, and adults in that same
  message, ask for those three in one short question — do not open any modal, do not call any tool yet.
- If the guest's message already includes dates, adults, AND enough guest details to book (name,
  phone, email, and a clear plan preference like "cheapest"), proceed directly: call getOffers, then
  continue straight to createBooking without stopping to ask again.

HOTEL-SPECIFIC TOOL GATE:
- If the guest wants to use ANY hotel-specific tool (getOffers, getReservation, checkIn, checkOut,
  getRoomPasscode, cancelReservation, submitFeedback, sendWhatsappRecovery) and no hotel is confirmed
  yet for this conversation, you MUST NOT collect any other information first (dates, name, phone,
  reservation details, offer preference, etc.) — asking which hotel is the ONLY thing you do in
  that turn. Ask which hotel first, in one short sentence, and WAIT for the reply before asking
  anything else.
- Never combine "which hotel?" with any other question in the same message, even if the guest's
  message already contains other details (dates, name, etc.) — hold onto those details, ask which
  hotel first, and use the details the guest already gave once the hotel is confirmed.
- If a tool result ever comes back with error "NO_HOTEL_SELECTED", that confirms no hotel is chosen
  yet — ask which hotel first, in one short sentence, and do not retry the tool until the guest names one.

KNOWN DETAIL REUSE:
- Before asking the guest for any identifier or personal detail a tool needs (reservationId, full
  name, phone, date of birth, email, room number), check the conversation history first. If it
  already appears there, do NOT ask again — state it back and ask for a yes/no confirmation instead
  (e.g. "Using your booking from earlier — is that right?"). Never say the words "reservation ID" to
  the guest — refer to "your booking" or "your reservation" instead.
- When restating any known detail back to the guest, always use the EXACT value from history or
  from the KNOWN GUEST DETAILS block below — NEVER a placeholder, template variable, or bracketed
  field name like "[Your Full Name]" or "[Your Email]". If you do not actually have the real value,
  ask for it instead of inventing a placeholder.

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
- If a tool result has error "PAST_DATE", tell the guest their check-in date needs to be today or
  later and ask them to provide valid dates — do NOT say "no rooms are available" for this case,
  since the problem is the date itself, not availability.
- If a tool call fails or returns any other error, that is an availability/system problem — NOT a
  sign that the hotel is unknown. Tell the guest in one short sentence that the request couldn't be
  completed right now, and suggest one next step (try different dates, or contact the front desk directly).
- Never invent a reason for a failure. Never mention API names, error codes, or technical details.
`.trim();

// ─── Context rule ──────────────────────────────────────────────────────────
const CONTEXT_RULE = `
CONTEXT RULE:
- Always read the full conversation history before replying.
- If the guest answered a clarifying question, immediately address their original request — do not greet again.
- Never ask for information the guest already provided earlier in the conversation.
- Never give a generic "How can I help?" if there is an unanswered question already in the conversation.
- If the guest provides dates, guest count, AND personal details all in one message,
  call getOffers first, then createBooking right after — no confirmation step needed.
`.trim();

// ─── Conversational exception rule ─────────────────────────────────────────
// Separate from CONTEXT_RULE, SMALL_TALK_INSTRUCTION, and ACTION_REQUEST_INSTRUCTION: this
// governs the case where the guest's message isn't small talk, isn't a booking/action intent,
// and isn't a new factual question either — it's a reply to something the assistant itself just
// asked for (an ID, a name, a DOB, an offer number). This is injected INSTEAD OF the no-context
// block for exactly these turns, so the model never sees a "refuse" instruction for them at all.
const CONVERSATIONAL_EXCEPTION_INSTRUCTION = `
NO DOCUMENT CONTEXT WAS FOUND FOR THIS MESSAGE — but this appears to be a direct reply to
something YOU (the assistant) just asked for in your previous message (e.g. a reservation ID,
name, DOB, or offer number).

- Do NOT refuse and do NOT say you don't have that information.
- Use the conversation history to understand what you asked for, take the guest's reply as the
  answer to that, and continue naturally — call the appropriate tool if the guest just supplied
  data a tool needs (e.g. a reservation ID for getReservation, or verification details for a
  passcode lookup).
- Never invent facts not in the tools/history. This exception only covers continuing the
  conversation naturally — it does NOT permit answering a genuinely new factual question from
  general knowledge. If the guest's short reply is actually a brand-new question unrelated to
  what you just asked, treat it as a normal factual question instead.
`.trim();

// ─── Hallucination guard sentence — used when no RAG context is found ──────
// This sentence is delivered WITHOUT ever routing through the big conversational model (see the
// code-level short-circuits in handleDocumentOnlySession / handleWithProperties below) — it is
// produced directly by translateToLanguage using the language already detected by
// analyzeGuestMessage.
const NO_CONTEXT_SENTENCES = {
  doc: "I don't have information regarding that. Let me know if you need something else.",
  property: "I don't have information regarding that. Let me know if you need something else.",
};

// ─── Fixed booking-confirmation sentence ────────────────────────────────────
// Kept as a single shared constant so both the translation call and any future reuse stay in
// sync — see the createBooking short-circuit in runConversation for how this is used.
  const BOOKING_CONFIRMED_SENTENCE = "Booking confirmed. Please check your email for the confirmation.";

// ─── Hotel scope rule — governs when RAG is chatbot-wide vs property-scoped ─
// and, separately, when (if ever) the bot is allowed to ask which hotel.
const HOTEL_SCOPE_RULE = `
HOTEL SCOPE RULE:
- If no hotel has been named yet in this conversation, answer factual questions using GENERAL
  INFORMATION (chatbot-wide documents). Do NOT ask which hotel just to answer a plain question.
- The moment the guest names one of the hotels you manage — in this message or an earlier one —
  treat that hotel as confirmed for the rest of the conversation, and answer factual questions
  using HOTEL INFORMATION scoped to that property from then on.
- Only ask which hotel BEFORE answering when the guest is trying to make a booking/reservation, or
  use any hotel-specific tool, and no hotel is confirmed yet (see TOOL RULE). Never ask which hotel
  for a plain informational question.
`.trim();

// ─── Property-scoped tools — code-level hard-stop ───────────────────────────
// The HOTEL-SPECIFIC TOOL GATE in TOOL_RULE is a prompt instruction only, and
// prompt instructions aren't reliable enough on their own for a hard
// requirement like this (same reasoning as the hallucination guard above).
// This set backs that rule with an actual code check in runConversation, so a
// property-scoped tool can never reach executeTool with a null property.
const PROPERTY_SCOPED_TOOLS = new Set([
  "getOffers",
  "getReservation",
  "checkIn",
  "checkOut",
  "getRoomPasscode",
  "cancelReservation",
  "submitFeedback",
  "sendWhatsappRecovery",
]);

// ─── Date validation — code-level hard-stop for past check-in dates ────────
// A past arrival date returns "no availability" from Apaleo, which reads to
// the guest as "fully booked" instead of "you gave an invalid date." This is
// checked in code (not left to the prompt alone) for the same reason as the
// other hard-stops above — the model can't be trusted to always catch this.
function isPastDate(dateStr) {
  if (!dateStr) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const check = new Date(dateStr);
  if (isNaN(check.getTime())) return false; // malformed date — let normal flow handle it
  check.setHours(0, 0, 0, 0);
  return check < today;
}

// ─── In-memory session store ───────────────────────────────────────────────
const sessions = new Map();

setInterval(
  () => {
    const cutoff = Date.now() - 2 * 60 * 60 * 1000;
    for (const [id, session] of sessions) {
      if (session.createdAt < cutoff) sessions.delete(id);
    }
  },
  15 * 60 * 1000,
);

function getOrCreateSession(sessionId, chatbotId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      chatbotId,
      propertyId: null,
      state: "new",
      history: [],
      // Cache of the offers last shown to the guest, so a later turn like
      // "I'll take #2" can be resolved to a real ratePlanId without ever
      // re-asking the API or letting the model invent one. Cleared whenever
      // a booking completes or the guest switches to a different hotel.
      lastOffers: null,
      // Persists the offer resolved by resolveOfferSelection across turns,
      // until booking completes or a new search replaces lastOffers. See
      // handleWithProperties and the createBooking hard-override in
      // runConversation for why this can't just be re-derived each turn.
      selectedOffer: null,
      // Captured once a booking succeeds (see runConversation's createBooking
      // handling) — the durable, deterministic record of this guest's name/
      // phone/email, reused for any later booking in the same session instead
      // of re-deriving it from freeform history each time.
      knownGuestDetails: null,
      // Last reliably-detected guest language, persisted across turns. Only
      // updated on substantive messages (small talk, action requests, or new
      // questions — see handleWithProperties) — NEVER on short data-entry
      // FOLLOW_UP replies like a bare name/phone/email, which don't carry
      // enough linguistic signal for detection. This is what the booking
      // confirmation message reuses instead of re-guessing the language from
      // whatever the guest's last message happened to be.
      lastKnownLanguage: "English",
      createdAt: Date.now(),
    });
  }
  return sessions.get(sessionId);
}

function updateSession(sessionId, updates) {
  const session = sessions.get(sessionId);
  sessions.set(sessionId, { ...session, ...updates });
}

// Deterministic, non-LLM check for whether the guest named one of the
// managed hotels in their message. Used purely to decide RAG scope (chatbot-wide
// vs property-scoped) up front, in the SAME turn — so the guest never has to wait
// a full round trip just to get an answer once they've named a hotel. This does
// NOT replace the selectProperty tool, which still exists for the model to use
// for explicit hotel switching during booking flows.
function detectMentionedProperty(message, properties) {
  const lower = message.toLowerCase();
  return properties.find((p) => lower.includes(p.name.toLowerCase())) || null;
}

// ─── Combined message analysis: intent + language + English query ─────────
// This ONE utility-model call replaces what used to be TWO separate calls
// (a translation-only getSearchQuery call, and a separate classifyFollowUpIntent
// call). Merging them cuts a full network round trip off every single turn.
//
// It has FOUR intent buckets: SMALL_TALK, ACTION_REQUEST, FOLLOW_UP, and
// NEW_QUESTION. ACTION_REQUEST exists specifically for booking/action intent
// ("I want to make a reservation", "cancel my booking", "check me in") that
// has no home in a factual-question/document-grounding pipeline — without it,
// these messages fell through to NEW_QUESTION by elimination, found no
// matching document context, and got hard-refused with "I don't have
// information regarding that" before ever reaching the tool-calling model.
//
// Returns { intent: "SMALL_TALK" | "ACTION_REQUEST" | "FOLLOW_UP" | "NEW_QUESTION", language, englishQuery }.
// "language" is a plain English language name (e.g. "German") — used later by
// translateToLanguage with a direct, unambiguous instruction instead of asking
// a model to infer language from an example message.
async function analyzeGuestMessage(message, history) {
  const recentHistory = history.filter((h) => typeof h.content === "string").slice(-6);

  try {
    const analysis = await chatWithTools({
      systemPrompt: `
You are analyzing the guest's LATEST message in an ongoing chatbot conversation. Read the
conversation so far, then classify the message and prepare a translation for downstream use.

Reply with ONLY a single-line JSON object — no markdown fences, no explanation — with exactly
these three fields:
{"intent": "...", "language": "...", "englishQuery": "..."}

"intent" — one of:
- "SMALL_TALK": casual conversational messages with no factual content — greetings, "how are
  you", "what's up", pleasantries, thanks, goodbyes — in ANY language.
- "ACTION_REQUEST": the guest wants to perform an action via a tool — book/reserve a room, check
  in/out, cancel a reservation, get a room passcode, resend a confirmation, or WhatsApp recovery —
  EVEN IF no details (dates, name, etc.) have been given yet. This is NOT a factual question and
  never needs document grounding.
- "FOLLOW_UP": the message directly answers, confirms, or continues what the assistant just
  asked (a name, ID, phone, email, offer number, yes/no, a correction), in ANY language.
- "NEW_QUESTION": an actual factual question about the hotel/property/general info that needs to
  be looked up in documents.

"language" — the guest's message language, as a plain English language name (e.g. "English",
"German", "Spanish", "Albanian", "Portuguese", "Turkish", "French", "Chinese", "Serbian").

"englishQuery" — the guest's message translated into English. If it is already English, copy it
unchanged.

Judge intent based on MEANING and conversational context, not exact wording or punctuation.
`.trim(),
      history: [...recentHistory, { role: "user", content: message }],
      tools: [],
      model: UTILITY_MODEL,
    });

    const raw = (analysis.text || "").trim().replace(/^```json\s*|\s*```$/g, "");
    const parsed = JSON.parse(raw);

    const intent = ["SMALL_TALK", "ACTION_REQUEST", "FOLLOW_UP", "NEW_QUESTION"].includes(parsed.intent)
      ? parsed.intent
      : "NEW_QUESTION";
    const language =
      typeof parsed.language === "string" && parsed.language.trim() ? parsed.language.trim() : "English";
    const englishQuery =
      typeof parsed.englishQuery === "string" && parsed.englishQuery.trim() ? parsed.englishQuery.trim() : message;

    return { intent, language, englishQuery };
  } catch {
    // Fail safe: treat as a new factual question in English. Worst case the guest is asked to
    // repeat themselves or gets the strict refusal once — safer than letting an unrelated
    // question slip through, and safer than guessing a language we didn't actually detect.
    return { intent: "NEW_QUESTION", language: "English", englishQuery: message };
  }
}

// ─── Direct, directive translation of a fixed sentence into a KNOWN language ─
// This intentionally does NOT try to infer language from an example message —
// the language is already known (either detected by analyzeGuestMessage moments
// earlier, or persisted on the session as lastKnownLanguage — see
// BOOKING_CONFIRMED_SENTENCE usage in runConversation), so the instruction to
// the model is simple and unambiguous: "translate into {language}." Small
// models are far more reliable at a direct instruction like this than at a
// two-step inference from a reference message.
async function translateToLanguage(fixedSentence, languageName) {
  if (!languageName || languageName.trim().toLowerCase() === "english") return fixedSentence;
  try {
    const translation = await chatWithTools({
      systemPrompt: `Translate the following sentence into ${languageName}. Reply with ONLY the translated sentence — no quotes, no explanation, nothing else.`,
      history: [{ role: "user", content: fixedSentence }],
      tools: [],
      model: UTILITY_MODEL,
    });
    return translation.text?.trim() || fixedSentence;
  } catch {
    return fixedSentence; // fail safe: better to answer in English than to fail the turn
  }
}

// ─── Offer selection resolver — the actual fix for the "wrong offer picked" bug ──
// Previously, resolving "1" / "the cheaper one" / etc. to a ratePlanId was left
// entirely to the main conversational LLM, which sees the FULL conversation
// history — including raw tool results from any earlier getOffers call in this
// same session. When an earlier offer list was still sitting in that history,
// the model could match the guest's "1" against the WRONG (stale) list instead
// of the current one, and produce the wrong ratePlanId. That's a real financial
// bug (wrong room booked), so it can't be left to LLM judgment.
//
// Fix: resolve the offer index HERE, in code, using ONLY the current offer
// list — never the full history — then hand the model a locked, unambiguous
// fact it cannot second-guess or misapply from stale data.
//
// Returns:
//   { index, offer }   — a valid selection was resolved
//   { index: -1 }      — guest gave a number, but it's out of range
//   null               — message doesn't look like an offer selection at all
async function resolveOfferSelection(message, offers) {
  if (!offers || offers.length === 0) return null;

  const trimmed = message.trim();

  // Fast path: bare number, optionally with #, ., or ) — e.g. "1", "#2", "3."
  // No LLM call needed at all — this is the most common guest reply and is
  // now resolved instantly and unambiguously.
  const bareNumber = trimmed.match(/^#?\s*(\d{1,2})\s*[.)]?$/);
  if (bareNumber) {
    const num = parseInt(bareNumber[1], 10);
    // Match against the offer's explicit displayNumber field — NEVER the raw
    // array index. displayNumber is the single authoritative "offer #N" set
    // once when the offers were cached (see getOffers/searchOffers), and it's
    // exactly what the frontend must render on each card. Matching on this
    // field instead of array position means the resolution is correct even
    // if the array itself is ever re-ordered or filtered downstream.
    const found = offers.find((o) => o.displayNumber === num);
    if (found) return { offer: found };
    return { outOfRange: true };
  }

  // General path: guest phrased it in words — ordinal, description, or a number
  // embedded in a sentence ("select 1", "please pick the first one", "the cheaper
  // one", "the one with breakfast"), possibly in any language. Ask a narrow,
  // HISTORY-FREE classifier call: it only ever sees the CURRENT offer list and
  // the guest's message, so a stale offer list from earlier in the conversation
  // literally cannot influence it. Uses UTILITY_MODEL — this is a single-token
  // classification task.
  try {
    const offerList = offers
      .map((o) => `${o.displayNumber}. ${o.name} — ${o.roomName} — ${o.amount} ${o.currency}`)
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
    return null; // unparseable/unmatched response — treat as "not a selection", fail safe
  } catch {
    return null; // fail safe: fall back to the normal LLM-driven flow
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

// ─── Shared: run the tool-calling loop and persist history ─────────────────
async function runConversation({ sessionId, systemPrompt, history, tools, session, property, properties }) {
  let currentHistory = history;
  let currentProperty = property;
  // Set when getOffers "peeks" ahead (see below) and the model immediately
  // wants to chain into createBooking — lets the next loop iteration reuse
  // that response instead of calling the model again from scratch.
  let pendingResponse = null;

  while (true) {
    const response = pendingResponse || (await chatWithTools({ systemPrompt, history: currentHistory, tools }));
    pendingResponse = null;

    if (!response.toolCalls || response.toolCalls.length === 0) {
      updateSession(sessionId, {
        history: [...currentHistory, { role: "assistant", content: response.text }],
      });
      return reply("text", { text: response.text });
    }

    const toolResults = [];
    let offersHandledAsChain = false;

    for (const toolCall of response.toolCalls) {
      // ── selectProperty: local session-state change, never hits executeTool ──
      // (executeTool has no case for it and requires apaleoCode/apiKey, which
      // is irrelevant here — this is just "switch which hotel we're talking about").
      if (toolCall.name === "selectProperty") {
        const newProperty = properties.find((p) => p.propertyId === toolCall.input.propertyId);
        if (!newProperty) {
          toolResults.push({
            toolCallId: toolCall.id,
            result: { success: false, error: "Unknown property id." },
          });
          continue;
        }
        currentProperty = newProperty;
        updateSession(sessionId, { propertyId: newProperty.propertyId, lastOffers: null, selectedOffer: null });
        toolResults.push({
          toolCallId: toolCall.id,
          result: { success: true, propertyId: newProperty.propertyId, name: newProperty.name },
        });
        continue;
      }

      // ── Hard-stop: never let a property-scoped tool reach executeTool with
      // no property selected (this is what used to crash on `property.apaleoCode`
      // when the model called getOffers before a hotel was confirmed). Instead
      // of executing, hand back a synthetic error the model can react to.
      if (PROPERTY_SCOPED_TOOLS.has(toolCall.name) && !currentProperty) {
        toolResults.push({
          toolCallId: toolCall.id,
          result: { success: false, error: "NO_HOTEL_SELECTED" },
        });
        continue;
      }

      // ── Hard-stop: never let getOffers reach executeTool/Apaleo with a
      // check-in date that's already in the past. Apaleo would just return
      // "no availability", which the model then reports as "fully booked" —
      // misleading, since the actual problem is the date itself.
      if (toolCall.name === "getOffers" && isPastDate(toolCall.input?.arrival)) {
        toolResults.push({
          toolCallId: toolCall.id,
          result: { success: false, error: "PAST_DATE" },
        });
        continue;
      }

      // ── HARD OVERRIDE: createBooking's ratePlanId is never trusted from the
      // model when a selection has been locked in via resolveOfferSelection.
      // This is the actual fix for offers getting swapped between the "which
      // offer?" turn and the "here are my details" turn — a prompt instruction
      // telling the model "use this ratePlanId" is not a strong enough
      // guarantee for something with real financial consequences (booking the
      // wrong room). Code decides this value outright; the model's own
      // toolCall.input.ratePlanId is discarded entirely whenever this applies.
      if (toolCall.name === "createBooking" && session?.selectedOffer?.ratePlanId) {
        toolCall.input.ratePlanId = session.selectedOffer.ratePlanId;
      }

      const result = await executeTool({
        toolName: toolCall.name,
        toolInput: toolCall.input,
        session,
        property: currentProperty,
      });
      toolResults.push({ toolCallId: toolCall.id, result });

      // ── getOffers: peek one turn ahead before deciding to show offer cards ──
      // Previously this always short-circuited immediately, which made a true
      // one-message "book the cheapest room for me, here are my details" flow
      // impossible — the loop never got a chance to continue into createBooking.
      // Now: after getOffers succeeds, we ask the model ONE more time. If it
      // already has everything it needs and wants to call createBooking right
      // away, we let that happen. Otherwise we fall back to showing offer cards,
      // same as before. This is a single bounded peek, not open-ended chaining.
      if (toolCall.name === "getOffers") {
        if (!result?.success || !result?.offers) {
          // Availability/system error (including PAST_DATE above) — let the LLM
          // phrase it per TOOL_ERROR_RULE instead of hard-failing here. Fall
          // through to continue the loop below.
          continue;
        }

        // ── Attach an explicit, authoritative display number to each offer. ──
        // This MUST be the single source of truth for "offer #1", "#2", etc. —
        // never the raw array index alone. The frontend (OfferCards) must render
        // offer.displayNumber, not its own loop index, so the number the guest
        // sees on screen can never drift from the number resolveOfferSelection
        // resolves against, regardless of any sorting/filtering either side does.
        const numberedOffers = result.offers.map((o, i) => ({ ...o, displayNumber: i + 1 }));
        result.offers = numberedOffers;

        updateSession(sessionId, { lastOffers: numberedOffers, selectedOffer: null });

        const historyWithOffers = [
          ...currentHistory,
          buildAssistantToolCallEntry(response.toolCalls),
          ...buildToolResultEntries(response.toolCalls, toolResults),
        ];

        const followUp = await chatWithTools({ systemPrompt, history: historyWithOffers, tools });
        const wantsToBook = followUp.toolCalls?.some((tc) => tc.name === "createBooking");

        if (wantsToBook) {
          currentHistory = historyWithOffers;
          pendingResponse = followUp;
          offersHandledAsChain = true;
          break;
        }

        // Guest didn't already have full details ready — show offer cards as normal.
        updateSession(sessionId, { history: historyWithOffers });
        return reply("offers", {
          text: "Here are the available offers. Reply with a number to choose your room.",
          data: result.offers,
        });
      }

      // ── createBooking short-circuit ──
      if (toolCall.name === "createBooking" && result?.success !== false) {
        const finalHistory = [
          ...currentHistory,
          buildAssistantToolCallEntry(response.toolCalls),
          ...buildToolResultEntries(response.toolCalls, toolResults),
        ];

        // ── Confirmation text uses the session's persisted, reliably-detected ──
        // language (lastKnownLanguage — see getOrCreateSession / handleWithProperties),
        // NOT a guess from the guest's last message. At this point in the flow the
        // guest's last message is almost always just name/phone/email — a string
        // with too little linguistic signal to detect language from — which
        // previously caused the confirmation to come back in the wrong language.
        const confirmLanguage = sessions.get(sessionId)?.lastKnownLanguage || "English";
        const confirmText = await translateToLanguage(BOOKING_CONFIRMED_SENTENCE, confirmLanguage);

        // ── Capture guest details straight from the confirmed booking result. ──
        // This is the single source of truth for "the guest's known details" from
        // here on — no LLM parsing of freeform history involved, so there's no
        // chance of it drifting or hallucinating a placeholder later. It survives
        // for the rest of the session (not cleared alongside lastOffers/selectedOffer)
        // so a later "book another room for me" can reuse it exactly.
        const guest = result?.guest;
        const knownGuestDetails =
          guest?.email && guest?.phone
            ? {
                fullName: [guest.first_name, guest.last_name].filter(Boolean).join(" ").trim(),
                phone: guest.phone,
                email: guest.email,
              }
            : sessions.get(sessionId)?.knownGuestDetails || null;

        updateSession(sessionId, {
          lastOffers: null,
          selectedOffer: null,
          knownGuestDetails,
          history: finalHistory,
        });
        return reply("booking_confirmed", { text: confirmText, data: result });
      }
    }

    if (offersHandledAsChain) continue; // re-enter loop with the peeked response, no new model call

    currentHistory = [
      ...currentHistory,
      buildAssistantToolCallEntry(response.toolCalls),
      ...buildToolResultEntries(response.toolCalls, toolResults),
    ];
  }
}

// ─── Document-only chatbot (no property attached) ───────────────────────────
// Chatbots with zero properties have nothing to scope by, so retrieval is
// chatbot-wide by definition already. No tools exist on this path, so it has
// no booking flow — the only two buckets that matter here are "small talk"
// and "everything else," which either needs grounding or gets refused.
async function handleDocumentOnlySession({ sessionId, chatbotId, message, chatbot }) {
  const session = sessions.get(sessionId);

  // First open of the widget — fixed greeting, no LLM call needed.
  if (!message.trim()) {
    const text = `Welcome to ${chatbot.name}.`;
    updateSession(sessionId, {
      state: "active",
      history: [{ role: "assistant", content: text }],
    });
    return reply("text", { text });
  }

  const { intent, language, englishQuery } = await analyzeGuestMessage(message, session.history);
  const isSmallTalk = intent === "SMALL_TALK";

  const ragChunks = await searchSimilarChunks({ query: englishQuery, chatbotId, topK: 5 });
  // Tightened from 0.8 — that threshold (cosine distance, so 0.8 only requires
  // ~20% similarity) was letting vague/generic queries ("how are you", "capital
  // of pakistan") accidentally match unrelated chunks, which then got fed to the
  // model as "the only source of truth," causing it to answer questions the docs
  // never actually covered. If genuinely relevant content starts getting excluded
  // for your specific documents/embedding model, raise this slightly — but start
  // strict and loosen only if you see real misses, not the other way around.
  const RELEVANCE_THRESHOLD = 0.35;
  const relevantChunks = ragChunks.filter((c) => c.distance <= RELEVANCE_THRESHOLD);
  const hasContext = relevantChunks.length > 0;

  const history = [...session.history, { role: "user", content: message }];

  // ── Skip the big model entirely when this is a genuine no-context refusal. ──
  // Only for genuine factual questions with no matching documents — small talk
  // and action requests never reach this branch (see isConversational below in
  // handleWithProperties for the equivalent property-aware logic; this document-
  // only path has no tools/booking flow, so ACTION_REQUEST isn't classified here,
  // but small talk is still excluded).
  if (!hasContext && !isSmallTalk) {
    const text = await translateToLanguage(NO_CONTEXT_SENTENCES.doc, language);
    updateSession(sessionId, { history: [...history, { role: "assistant", content: text }] });
    return reply("text", { text });
  }

  const ragContext = hasContext
    ? `INFORMATION — answer using ONLY what is written here, nothing else:\n${relevantChunks.map((c) => c.content).join("\n---\n")}`
    : SMALL_TALK_INSTRUCTION;

  const systemPrompt = `
${chatbot.systemPrompt}
${LANGUAGE_RULE}
${BREVITY_RULE}
${BASIC_FORMAT_RULE}

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

STRICT GROUNDING RULE — apply this check BEFORE answering, every time:
1. Read the guest's exact question — identify the specific subject/entity/topic being asked about.
2. Does the INFORMATION below contain that EXACT subject, explicitly? A shared keyword, city name,
   or vague topical overlap does NOT count — the specific thing asked about must be genuinely present.
3. Answer using only that information, and only the part that answers the question (see
   CONCISENESS above).
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

// ─── Chatbot-with-properties handler ────────────────────────────────────────
// RAG scope is chatbot-wide by default, and narrows to a specific property the
// moment that property is named (this message or an earlier one) — detected
// deterministically up front, so scoping and answering happen in the same turn.
async function handleWithProperties({ sessionId, chatbotId, message, properties, chatbot }) {
  const currentSession = sessions.get(sessionId);

  // First open of the widget — fixed greeting, no LLM call, no hotel gate.
  if (!message.trim()) {
    const text = `Welcome to ${chatbot.name}.`;
    updateSession(sessionId, { state: "active", history: [{ role: "assistant", content: text }] });
    return reply("welcome", { text, data: { showButtons: true } });
  }

  // "Book a Stay" button — the ONLY way the booking modal opens. Typed text
  // booking intent ("book a stay", "reserve a room") is handled entirely in
  // chat now (see BOOKING INTENT in TOOL_RULE) — no modal, no requestBookingFlow tool.
  if (message === "__book_stay__") {
    return reply("reopen_modal", {});
  }

  // "Ask a Question" button — just drop straight into the conversation.
  // No forced hotel prompt: the guest can ask anything and gets a chatbot-wide
  // answer until they mention a specific hotel.
  if (message === "__ask_question__") {
    updateSession(sessionId, { state: "active" });
    return reply("text", { text: "What would you like to know?" });
  }

  // Deterministic hotel-mention check — decides RAG scope for THIS turn without
  // waiting on an LLM tool call, and persists it as the confirmed hotel going forward.
  const mentioned = detectMentionedProperty(message, properties);
  const effectiveProperty =
    mentioned || properties.find((p) => p.propertyId === currentSession.propertyId) || null;

  if (mentioned && mentioned.propertyId !== currentSession.propertyId) {
    updateSession(sessionId, { propertyId: mentioned.propertyId, lastOffers: null, selectedOffer: null });
  }

  // ── Offer selection check — runs FIRST, before any RAG work. ──
  // If the guest is currently looking at a cached offer list and their message
  // resolves to a selection (bare number, ordinal, or description — see
  // resolveOfferSelection), there is no reason to spend a translation call, an
  // embedding search, or an intent-classification call on a message like "1".
  // This also sidesteps the RAG "no context" hard-stop entirely for these turns.
  const offerSelection = currentSession.lastOffers
    ? await resolveOfferSelection(message, currentSession.lastOffers)
    : null;

  // ── Persist the resolved selection across turns. ──────────────────────────
  // This is the actual fix for offers getting mixed up between the "which offer?"
  // turn and the "here are my details" turn: resolveOfferSelection only sees
  // THIS turn's message, so on the very next turn (guest typing their name/phone/
  // email, not a number) it returns null — the lock would otherwise vanish from
  // the prompt exactly when the model needs it most, forcing it to re-derive the
  // offer from raw history, which is what caused the mismatch in the first place.
  // Persisting it here means the correct offer keeps being injected on every
  // turn of this booking flow, not just the turn it was chosen on.
  if (offerSelection?.offer) {
    updateSession(sessionId, { selectedOffer: offerSelection.offer });
  }
  const effectiveSelectedOffer = offerSelection?.offer || currentSession.selectedOffer || null;

  let englishQuery, ragChunks, usedGeneralFallback, relevantChunks, hasContext, contextLabel, intent, language;

  if (offerSelection) {
    // Skip RAG and intent analysis entirely — this turn is a selection, not a
    // factual question or small talk, and must never be treated as blocked.
    englishQuery = message;
    ragChunks = [];
    usedGeneralFallback = false;
    relevantChunks = [];
    hasContext = false;
    contextLabel = "GENERAL INFORMATION";
    intent = "FOLLOW_UP"; // booking-flow turns are always conversational, never blocked
    language = "English"; // unused on this path — the big model handles phrasing/language itself
  } else {
    // ── Single combined analysis call: intent + language + English query. ──
    // Replaces what used to be two separate sequential-in-spirit utility calls
    // (getSearchQuery + classifyFollowUpIntent) with one — see analyzeGuestMessage.
    const analysis = await analyzeGuestMessage(message, currentSession.history);
    intent = analysis.intent;
    language = analysis.language;
    englishQuery = analysis.englishQuery;

    // ── Persist reliably-detected language on the session. ──────────────────
    // Only trust this detection to update lastKnownLanguage when the message is
    // substantive (small talk, an action request, or a real question) — NOT a
    // bare FOLLOW_UP data reply like a name/phone/email, which carries too
    // little linguistic signal to detect language from reliably. This persisted
    // value is what the booking-confirmation message reuses later (see
    // runConversation's createBooking short-circuit) instead of re-guessing.
    if (intent !== "FOLLOW_UP") {
      updateSession(sessionId, { lastKnownLanguage: language });
    }

    // ── RAG retrieval: property-scoped once a hotel is known, chatbot-wide otherwise ──
    // If a property is confirmed and the scoped search comes back empty, fall back to
    // a chatbot-wide search — a confirmed hotel shouldn't block questions that are
    // answered by general/chatbot-wide documents.
    ragChunks = effectiveProperty
      ? await searchSimilarChunks({ query: englishQuery, chatbotId, propertyId: effectiveProperty.propertyId, topK: 5 })
      : await searchSimilarChunks({ query: englishQuery, chatbotId, topK: 5 });

    usedGeneralFallback = false;
    // Tightened from 0.78/0.8 — see the comment on RELEVANCE_THRESHOLD in
    // handleDocumentOnlySession for why the looser values caused false-positive
    // matches on vague/generic guest messages.
    relevantChunks = ragChunks.filter((c) => c.distance <= (effectiveProperty ? 0.32 : 0.35));

    if (effectiveProperty && relevantChunks.length === 0) {
      const generalChunks = await searchSimilarChunks({ query: englishQuery, chatbotId, topK: 5 });
      const relevantGeneral = generalChunks.filter((c) => c.distance <= 0.35);
      if (relevantGeneral.length > 0) {
        ragChunks = generalChunks;
        relevantChunks = relevantGeneral;
        usedGeneralFallback = true;
      }
    }

    hasContext = relevantChunks.length > 0;
    // Label the context block correctly depending on whether we ended up using the
    // property-scoped result or fell back to the chatbot-wide general documents.
    contextLabel = effectiveProperty && !usedGeneralFallback ? "HOTEL INFORMATION" : "GENERAL INFORMATION";
  }

  const isSmallTalk = intent === "SMALL_TALK";
  const isFollowUp = intent === "FOLLOW_UP";
  const isActionRequest = intent === "ACTION_REQUEST";
  // ACTION_REQUEST is included here because booking/action intent ("I want to make a
  // reservation") is never a factual question that needs document grounding — without
  // this, it fell through to the no-context hard-stop below and got wrongly refused.
  const isConversational = isSmallTalk || isFollowUp || isActionRequest;

  const history = [...currentSession.history, { role: "user", content: message }];

  // ── Skip the big model entirely when this is a genuine no-context refusal. ──
  // This only fires for real factual NEW_QUESTION turns with no matching
  // documents — small talk, action requests, and follow-ups are all excluded
  // via isConversational above, so they always reach the full model with tools.
  if (!offerSelection && !hasContext && !isConversational) {
    const text = await translateToLanguage(NO_CONTEXT_SENTENCES.property, language);
    updateSession(sessionId, { history: [...history, { role: "assistant", content: text }] });
    return reply("text", { text });
  }

  let ragContext;
  if (offerSelection) {
    // Handled entirely by the SELECTED OFFER block injected into the system
    // prompt below — no document-grounding instruction needed for this turn.
    ragContext = "";
  } else if (hasContext) {
    ragContext = `
${contextLabel} — the ONLY source of truth for factual questions:
${relevantChunks.map((c) => c.content).join("\n---\n")}

STRICT GROUNDING RULE — apply this check BEFORE answering, every time:
1. Read the guest's exact question — identify the specific subject/entity/topic being asked about.
2. Does the ${contextLabel} above contain that EXACT subject, explicitly? A shared
   keyword or vague topical overlap does NOT count — the specific thing asked about must genuinely be present.
3. Answer using ONLY that information, and ONLY the part that answers the question.

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
    // isFollowUp is guaranteed true here — the blocked case was already returned above.
    ragContext = CONVERSATIONAL_EXCEPTION_INSTRUCTION;
  }

  // ── Locked offer selection block — the core fix for the "wrong offer" bug. ──
  // When resolveOfferSelection found a match, hand the model the EXACT resolved
  // offer as a non-negotiable fact. The model is explicitly told to ignore any
  // other offer list that might appear elsewhere in history, so a stale getOffers
  // result from earlier in the session can never override this. When the number
  // was out of range, tell the model to ask again — no tool call, no guessing.
  let offerSelectionBlock = "";
  if (effectiveSelectedOffer) {
    const o = effectiveSelectedOffer;
    offerSelectionBlock = `
GUEST SELECTED THIS OFFER — THIS IS LOCKED AND FINAL, DO NOT RE-DERIVE OR SECOND-GUESS IT:
- Selected: ${o.name} — ${o.roomName} — ${o.amount} ${o.currency} — ratePlanId: ${o.ratePlanId}
This is the ONLY correct offer for this ENTIRE booking flow, on every turn until it completes —
not just the turn it was chosen on. IGNORE any other offer list, ratePlanId, or price that may
appear elsewhere earlier in this conversation's history — those are from a previous search and
are no longer valid. Use ONLY the ratePlanId above.
- If the guest's full name, phone, and email are already known from this conversation, call
  createBooking now using this exact ratePlanId.
- Otherwise, ask for those three details in one short, pleasant sentence (see GUEST DETAIL
  COLLECTION below) — do not restate the room name or price back to the guest.
`.trim();
  } else if (offerSelection?.outOfRange) {
    offerSelectionBlock = `
GUEST TRIED TO SELECT AN OFFER BY NUMBER, BUT IT IS OUT OF RANGE.
Only ${currentSession.lastOffers.length} offers are currently shown. Tell the guest, in one short
sentence, to give a valid offer number between 1 and ${currentSession.lastOffers.length}. Do not
call any tool this turn, and do not guess which offer they meant.
`.trim();
  }

  // Only relevant while there IS a cached offer list — lets the guest refer
  // to an offer by number or description on the next turn.
  const lastOffersBlock = currentSession.lastOffers
    ? `
CURRENT OFFERS SHOWN TO GUEST — if the guest picks one by number or description, resolve it to
the matching ratePlanId below and use that EXACT value in createBooking. Never invent a ratePlanId.
${currentSession.lastOffers
  .map((o) => `${o.displayNumber}. ${o.name} — ${o.roomName} — ${o.amount} ${o.currency} — ratePlanId: ${o.ratePlanId}`)
  .join("\n")}

OFFER SELECTION:
- The guest may reply with JUST a bare number (e.g. "3") to mean "I want offer #3" — this is the
  most common way they'll respond, treat a lone number as an offer selection, not a random digit.
- The guest may also refer to an offer by ordinal or description, in any language (e.g. "the second
  one", "second", "the cheaper one", "the one with breakfast") — match their intent to the correct
  offer in the list above using its position and details, not just bare digits.
- If the number is outside the range above (e.g. they say "30" but there are only ${currentSession.lastOffers.length} offers),
  do NOT guess or pick the closest one — ask them to give a valid offer number instead, in one short sentence.
`.trim()
    : "";

  // ── Known guest details block — deterministic, from the last confirmed booking. ──
  // This is the fix for "book another room for me" flows: rather than the model
  // trying to re-derive name/phone/email from scrollback (which produced placeholder
  // text like "[Your Full Name]" in testing), it's handed the EXACT values captured
  // at the point the guest's last booking succeeded.
  const knownGuestDetailsBlock = currentSession.knownGuestDetails
    ? `
KNOWN GUEST DETAILS — from this guest's earlier booking in this conversation:
- Full name: ${currentSession.knownGuestDetails.fullName}
- Phone: ${currentSession.knownGuestDetails.phone}
- Email: ${currentSession.knownGuestDetails.email}

If the guest wants to book another room/stay and refers to themselves or their earlier details
("book another for me", "use my previous data", "the one I used last time", "same as before"),
do NOT ask them to repeat their name/phone/email. Instead, read the EXACT values above back to
them for confirmation, in one short sentence, e.g.:
"Please confirm — full name **${currentSession.knownGuestDetails.fullName}**, phone
**${currentSession.knownGuestDetails.phone}**, email **${currentSession.knownGuestDetails.email}**.
Is that correct?"
Wait for a yes/no. On yes, proceed with these exact values for createBooking. On no, ask which
detail is wrong and update only that one.
NEVER use placeholder text like "[Your Full Name]" or a template variable — always use the exact
values above, verbatim.
`.trim()
    : "";

  const propertyList = properties.map((p) => `- ${p.name} [id: ${p.propertyId}]`).join("\n");

  const hotelStatusBlock = effectiveProperty
    ? `Hotel: ${effectiveProperty.name} (currently confirmed for this conversation)\nAddress: ${effectiveProperty.address}`
    : `No hotel confirmed yet for this conversation. Do NOT ask which hotel just to answer a question — only ask if the guest is trying to book/reserve or use a hotel-specific tool (see TOOL RULE and HOTEL SCOPE RULE below).`;

  const systemPrompt = `
${chatbot.systemPrompt}
${LANGUAGE_RULE}
${BREVITY_RULE}

CONCISENESS — MOST IMPORTANT RULE, applies above all else:
- Answer or ask ONLY what's needed for the guest's current turn. Never add unrelated information.
- NEVER repeat a question you already asked in your immediately preceding message — check your
  last message before asking again. If the guest already answered it earlier in the conversation,
  use that answer, don't ask again.
- Never restate details (plan name, price, dates) the guest already has from your previous turn
  unless it's part of a required confirmation template.

${PERSONA_RULE}
${TOOL_RULE}
${TOOL_ERROR_RULE}
${CONTEXT_RULE}
${HOTEL_SCOPE_RULE}
${BASIC_FORMAT_RULE}

Today's date: ${new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}
${hotelStatusBlock}

Hotels you manage (for HOTEL SWITCHING in TOOL RULE, and for HOTEL SCOPE RULE):
${propertyList}

HOTEL SWITCH WORDING:
- selectProperty only changes which hotel you're discussing — it does NOT create a booking.
- After switching, say something like "Now contacting {hotel}" or "Switched to {hotel}" — never
  say "you're booked" or imply a reservation was made just from switching.
- If the guest named the hotel together with an actual question (e.g. "what's parking like at
  Hotel London"), answer that question directly using HOTEL INFORMATION below — do not stop at a
  switch confirmation and wait for them to repeat the question.

GUEST DETAIL COLLECTION:
- For a new booking you need: full name, phone number with country code, and email.
- If the guest's name, phone, and email are already known from earlier in this conversation (e.g.
  a previous booking in this same session), do not ask again — confirm using them instead (see
  KNOWN DETAIL REUSE in TOOL RULE).
- The moment the guest selects an offer (by number or description), do NOT restate the room
  name, rate plan, or price — the guest just saw that on the offer card.
- Ask for all three details in one short, pleasant sentence that keeps the guest's impression
  positive — warm, not blunt or transactional.
- Email is required, not optional.

EXAMPLE:
BAD:  "You selected the Flexible — Single room for 109 GBP. Let's proceed with your booking. Can you
       provide your full name, phone number with country code, and email address?"
BAD:  "What's your full name, phone number with country code, and email?"
GOOD: "Great choice! Could you share your full name, phone number, and email to complete your booking?"

TOOL USE RULES:
- After getOffers returns, copy ratePlanId EXACTLY as returned — never construct or modify it.
- Never call createBooking without real guest details confirmed in the conversation.
- If createBooking fails, call getOffers again and use the fresh ratePlanId from that result.
- sendWhatsappRecovery: only after getReservation has returned, using its reservationId.

${offerSelectionBlock}

${knownGuestDetailsBlock}

${lastOffersBlock}

${ragContext}
`.trim();

  const result = await runConversation({
    sessionId,
    systemPrompt,
    history,
    tools: [...toolDefinitions.all, toolDefinitions.selectProperty],
    session: currentSession,
    property: effectiveProperty,
    properties,
  });

  return result;
}

// ─── Main service ──────────────────────────────────────────────────────────
export const chatbotService = {
  async handleMessage({ sessionId, chatbotId, message }) {
    const chatbot = await Chatbot.findByPk(chatbotId);
    if (!chatbot) throw new NotFoundError("Chatbot not found.");

    const session = getOrCreateSession(sessionId, chatbotId);
    if (session.chatbotId !== chatbotId)
      throw new AppError("Session does not belong to this chatbot.", 400);

    const chatbotWithProps = await Chatbot.findByPk(chatbotId, {
      include: [{ model: Property, through: { attributes: [] } }],
    });
    const properties = chatbotWithProps?.properties ?? [];

    // ── Document-only bot: no property at all ──
    if (properties.length === 0) {
      return handleDocumentOnlySession({ sessionId, chatbotId, message, chatbot });
    }

    // ── Chatbot with one or more properties ──
    return handleWithProperties({ sessionId, chatbotId, message, properties, chatbot });
  },

  // ── Pure lookup for the "Book a Stay" modal destination dropdown ──
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

  // ── Non-LLM path: modal form submit ──
  async searchOffers({ sessionId, chatbotId, propertyId, arrival, departure, adults }) {
    const chatbot = await Chatbot.findByPk(chatbotId);
    if (!chatbot) throw new NotFoundError("Chatbot not found.");

    const chatbotWithProps = await Chatbot.findByPk(chatbotId, {
      include: [{ model: Property, through: { attributes: [] } }],
    });
    const properties = chatbotWithProps?.properties ?? [];
    const property = properties.find((p) => p.propertyId === propertyId);
    if (!property) throw new AppError("Invalid property selected.", 400);

    // ── Past-date guard for the modal path (mirrors the tool-call path in
    // runConversation) — checked before touching the session or Apaleo at all. ──
    if (isPastDate(arrival)) {
      return reply("text", {
        text: "Please provide a check-in date of today or later.",
      });
    }

    const session = getOrCreateSession(sessionId, chatbotId);

    // Equivalent to selectProperty — sets the hotel for this session directly,
    // no LLM call needed since the guest already picked it in the modal.
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
        text: "No rooms are available for those dates — want to try different ones?",
      });
    }

    // Same explicit numbering as the tool-call path — see comment there.
    const numberedOffers = result.offers.map((o, i) => ({ ...o, displayNumber: i + 1 }));

    updateSession(sessionId, { lastOffers: numberedOffers, selectedOffer: null });

    return reply("offers", {
      text: "Here are the available offers. Reply with a number to choose your room.",
      data: numberedOffers,
    });
  },
};