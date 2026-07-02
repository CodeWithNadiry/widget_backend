import Chatbot from "../../models/chatbot.model.js";
import Property from "../../models/property.model.js";
import { NotFoundError, AppError } from "../../utils/AppError.js";
import { searchSimilarChunks } from "../../lib/rag.js";
import { chatWithTools } from "../../llm/client.js";
import { toolDefinitions } from "../../tools/toolDefinitions.js";
import { executeTool } from "../../tools/toolExecutor.js";

// ─── Language rule ─────────────────────────────────────────────────────────
const LANGUAGE_RULE = `
LANGUAGE RULE:
- Always begin in English.
- As soon as the guest writes in any other language, switch to that language immediately and stay in it for every reply after that — including confirmations, errors, and tool results.
- Never mix languages in a single reply.
- Never ask the guest what language they prefer.
`.trim();

// ─── Brevity rule ──────────────────────────────────────────────────────────
// NOTE: explicitly carves out an exception for formatted lists, otherwise this
// rule and BASIC_FORMAT_RULE contradict each other and the model has to guess
// which one wins (in practice, it drops formatting).
const BREVITY_RULE = `
BREVITY RULE:
- Maximum ONE sentence per reply. Two only if truly necessary.
- EXCEPTION: if the reply requires a bullet list, a bold lead-in paragraph structure for a
  multi-part question, or a template from the FORMAT RULE (room offers, booking confirmations,
  reservation lookups, payment summaries), the one-sentence limit does not apply — follow the
  FORMAT RULE structure instead. Brevity still applies to phrasing WITHIN each line or paragraph.
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
  Example of what NOT to do: "values are **A**, **B**, and **C**."
  Do this instead:
  - **A**
  - **B**
  - **C**

MULTI-PART QUESTIONS:
- If the guest's message asks about two or more distinct topics in one message, answer each
  topic as its own short paragraph, separated by a blank line. Start each paragraph with a
  bolded 2-4 word label naming the topic, acting as a lightweight lead-in (not a markdown heading).
  Example:
  **Core values:** short answer here.

  **Voice AI Receptionist:** short answer here.
- Never merge answers to different topics into a single run-on paragraph.

GENERAL:
- Never use tables in chat replies.
- Never use nested bullets or markdown headings (#, ##) — this is a chat bubble, not a document.
- Single-topic, non-enumerated answers stay as plain sentences, no bullets, no bold lead-in label.
`.trim();

// ─── Booking-specific templates (only relevant when tools are available) ──
const BOOKING_FORMAT_RULE = `
FORMAT RULE — TEMPLATES — follow these exactly for the situations they cover.
Bold every label (the text before the colon). Use no emojis except the ✅ shown below.
Never invent a field value — if a field is missing from the tool result, omit that line entirely rather than writing "N/A" or leaving brackets.

──────────────────────────────
ROOM OFFER (after getOffers)
──────────────────────────────
**[Room type]**
**Check-in:** [DD Month YYYY]
**Check-out:** [DD Month YYYY]
**Meal plan:** [e.g. Breakfast included / Room only]
**Price:** [amount] [currency]

To book, share your full name, phone number with country code, and email.

If multiple room types are returned, list each as its own block separated by a blank line — never combine them into one paragraph or a table.

Example:
**Deluxe King Room**
**Check-in:** 24 June 2026
**Check-out:** 27 June 2026
**Meal plan:** Breakfast included
**Price:** 450 EUR

To book, share your full name, phone number with country code, and email.

──────────────────────────────
BOOKING CONFIRMED (after createBooking)
──────────────────────────────
✅ **Booking confirmed**
**Reservation ID:** [ID]
**Dates:** [DD Month] – [DD Month YYYY]
**Total:** [amount] [currency]

──────────────────────────────
RESERVATION LOOKUP
──────────────────────────────
**Reservation [ID]**
**Guest:** [name]
**Dates:** [DD Month] – [DD Month YYYY]
**Room:** [room type]
**Status:** [status]

If the reservation is not found, do NOT use this template — reply in plain sentences: say the ID wasn't found and ask the guest to double-check it.

──────────────────────────────
PAYMENT SUMMARY
──────────────────────────────
**Payment received**
**Reservation ID:** [ID]
**Amount charged:** [amount] [currency]
**Method:** [card type / last 4 digits if available — omit this line entirely if not available]

──────────────────────────────
DATE FORMAT RULE
──────────────────────────────
- Send dates to tools as YYYY-MM-DD.
- Always display dates to the guest as "24 June 2026" — never raw ISO format, never MM/DD/YYYY.

──────────────────────────────
GENERAL
──────────────────────────────
- If a tool call fails or returns no data, say so in plain sentences and suggest a next step — do not fabricate a template with placeholder-looking text.
`.trim();

// ─── Persona & tone ────────────────────────────────────────────────────────
const PERSONA_RULE = `
PERSONA:
You are the front desk assistant for this hotel. Professional, warm, efficient.
Never over-explain. Never apologize unnecessarily. Treat the guest like they know what they want.
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
   call createBooking immediately on the next turn using those details from history.
2. getReservation → sendWhatsappRecovery: ALWAYS call getReservation first and WAIT for it to return,
   then call sendWhatsappRecovery with the reservationId from that result. Never call both in the same turn.
3. One tool call per turn maximum when the second call depends on the first call's output.

REQUIRED FIELDS — NEVER DEFAULT OR ASSUME:
- arrival, departure, AND adults are all required for getOffers. If the guest gives only dates
  and no number of adults (or only adults and no dates), do NOT call getOffers yet — do NOT assume
  adults=1. Ask for exactly the missing piece(s) in one short question, then wait for the reply.
- Only call getOffers once arrival, departure, and adults are all known from the conversation.
`.trim();

// ─── Tool ERROR handling rule (fixes "asks for hotel name again" bug) ──────
const TOOL_ERROR_RULE = `
TOOL ERROR RULE:
- The hotel/property for this conversation is already confirmed. NEVER ask the guest to confirm or
  re-state the hotel name or location again, for any reason, including a failed tool call.
- If a tool call fails or returns an error, that is an availability/system problem — NOT a sign that
  the hotel is unknown. Tell the guest in one short sentence that the request couldn't be completed
  right now, and suggest one next step (try different dates, or contact the front desk directly).
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
  call getOffers first, then createBooking in the next turn — no confirmation step needed.
`.trim();

// ─── Hallucination guard — used when no RAG context is found ───────────────
const NO_CONTEXT_INSTRUCTION = `
NO INFORMATION AVAILABLE.
Reply with EXACTLY this sentence, translated into the guest's language, nothing else:
"I don't have that information in this document."
- No meta-commentary ("It looks like you're asking...", "I can help with...").
- No suggesting external resources (Google Maps, Yelp, etc.).
- No pivoting to a loosely related topic from the document as a consolation answer.
- Do not soften, explain, or apologize beyond that one sentence.
This does not block actions/tools.
`.trim();

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
      state: "awaitingProperty",
      history: [],
      createdAt: Date.now(),
    });
  }
  return sessions.get(sessionId);
}

function updateSession(sessionId, updates) {
  const session = sessions.get(sessionId);
  sessions.set(sessionId, { ...session, ...updates });
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
async function runConversation({ sessionId, systemPrompt, history, tools, session, property }) {
  let currentHistory = history;
  let finalReply = "";

  while (true) {
    const response = await chatWithTools({ systemPrompt, history: currentHistory, tools });

    if (!response.toolCalls || response.toolCalls.length === 0) {
      finalReply = response.text;
      break;
    }

    const toolResults = [];
    for (const toolCall of response.toolCalls) {
      console.log("toolCall:", toolCall.name, JSON.stringify(toolCall.input));
      const result = await executeTool({
        toolName: toolCall.name,
        toolInput: toolCall.input,
        session,
        property, // null for document-only bots; toolExecutor will reject any tool calls in that case
      });
      toolResults.push({ toolCallId: toolCall.id, result });
    }

    currentHistory = [
      ...currentHistory,
      buildAssistantToolCallEntry(response.toolCalls),
      ...buildToolResultEntries(response.toolCalls, toolResults),
    ];
  }

  updateSession(sessionId, {
    history: [...currentHistory, { role: "assistant", content: finalReply }],
  });

  return finalReply;
}

// ─── Document-only chatbot (no property attached) ───────────────────────────
async function handleDocumentOnlySession({ sessionId, chatbotId, message, chatbot }) {
  const session = sessions.get(sessionId);

  // First open of the widget — simple generic greeting, no hotel framing.
  if (!message.trim()) {
    const greetingPrompt = `
${chatbot.systemPrompt}
${LANGUAGE_RULE}
${BREVITY_RULE}

Write exactly one short, friendly greeting and ask how you can help.
Do not mention any hotel, property, or business name. Under 12 words. No emojis.
`.trim();

    const response = await chatWithTools({ systemPrompt: greetingPrompt, history: [], tools: [] });
    updateSession(sessionId, {
      state: "active",
      history: [{ role: "assistant", content: response.text }],
    });
    return response.text;
  }

  const ragChunks = await searchSimilarChunks({ query: message, chatbotId, topK: 5 });
  // Tightened from 0.92 — the looser threshold was letting tangentially related chunks
  // (e.g. "Mobile App Development" for a "mobile charger" question) through as if they
  // were real context, which let the model justify a made-up answer instead of
  // triggering the no-context path.
  const RELEVANCE_THRESHOLD = 0.8;
  const relevantChunks = ragChunks.filter((c) => c.distance <= RELEVANCE_THRESHOLD);
  const hasContext = relevantChunks.length > 0;

  const ragContext = hasContext
    ? `INFORMATION — answer using ONLY what is written here, nothing else:\n${relevantChunks.map((c) => c.content).join("\n---\n")}`
    : NO_CONTEXT_INSTRUCTION;

  const systemPrompt = `
${chatbot.systemPrompt}
${LANGUAGE_RULE}
${BREVITY_RULE}
${BASIC_FORMAT_RULE}

You answer guest questions using only the information provided below. You have no booking
tools available — if asked to book or manage a reservation, say that isn't something you can do here.

STRICT GROUNDING RULE — apply this check BEFORE answering, every time:
1. Read the guest's exact question.
2. Does the INFORMATION below explicitly and directly answer THIS question — not a related
   topic, not something that shares a keyword or location name, but the actual thing asked?
3. If yes → answer using only that information.
4. If no → reply with EXACTLY this sentence, translated into the guest's language, nothing else:
   "I don't have that information in this document."
   Do this even if the INFORMATION mentions the same city, building, product name, or keyword
   as the question. No meta-commentary, no external resource suggestions, no pivoting to a
   related-but-different fact as a consolation answer.

Example of a FAILURE to avoid:
Guest asks: "tell me about restaurants in Peshawar"
INFORMATION contains: "Skyware's Peshawar office is at Office 215, Uhad Tower..."
WRONG: answering with the office address because it mentions "Peshawar."
CORRECT: "I don't have that information in this document." — do not mention the office at all.

${ragContext}
`.trim();

  const history = [...session.history, { role: "user", content: message }];

  return runConversation({
    sessionId,
    systemPrompt,
    history,
    tools: [],
    session,
    property: null,
  });
}

// ─── Active session handler (hotel chatbot, property already locked in) ────
async function handleActiveSession({ sessionId, chatbotId, message, properties, chatbot }) {
  const currentSession = sessions.get(sessionId);

  const selectedProperty = properties.find((p) => p.propertyId === currentSession.propertyId);

  if (!selectedProperty) {
    updateSession(sessionId, { propertyId: null, state: "awaitingProperty", history: [] });
    return "Your session expired. Which hotel are you contacting?";
  }

  let ragChunks = await searchSimilarChunks({
    query: message,
    chatbotId,
    propertyId: currentSession.propertyId,
    topK: 5,
  });
  if (ragChunks.length === 0) {
    ragChunks = await searchSimilarChunks({ query: message, chatbotId, topK: 5 });
  }

  const RELEVANCE_THRESHOLD = 0.92;
  const relevantChunks = ragChunks.filter((c) => c.distance <= RELEVANCE_THRESHOLD);
  const hasContext = relevantChunks.length > 0;

  const ragContext = hasContext
    ? `HOTEL INFORMATION — answer factual questions using ONLY what is written here, nothing else:\n${relevantChunks.map((c) => c.content).join("\n---\n")}`
    : NO_CONTEXT_INSTRUCTION;

  const systemPrompt = `
${chatbot.systemPrompt}
${LANGUAGE_RULE}
${BREVITY_RULE}
${PERSONA_RULE}
${TOOL_RULE}
${TOOL_ERROR_RULE}
${CONTEXT_RULE}
${BASIC_FORMAT_RULE}
${BOOKING_FORMAT_RULE}

Today's date: ${new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}
Hotel: ${selectedProperty.name} (already confirmed for this conversation — never ask the guest to reconfirm it)
Address: ${selectedProperty.address}

GUEST DETAIL COLLECTION:
- For a new booking you need: full name, phone number with country code, and email.
- Ask for all three in one short sentence, in plain language (no technical format names).
- Email is required, not optional.

TOOL USE RULES:
- After getOffers returns, copy ratePlanId EXACTLY as returned — never construct or modify it.
- Never call createBooking without real guest details confirmed in the conversation.
- If createBooking fails, call getOffers again and use the fresh ratePlanId from that result.
- sendWhatsappRecovery: only after getReservation has returned, using its reservationId.

${ragContext}
`.trim();

  const history = [...currentSession.history, { role: "user", content: message }];

  return runConversation({
    sessionId,
    systemPrompt,
    history,
    tools: toolDefinitions.all,
    session: currentSession,
    property: selectedProperty,
  });
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

    // ── Document-only bot: no property at all, skip the whole property flow ──
    if (properties.length === 0) {
      return handleDocumentOnlySession({ sessionId, chatbotId, message, chatbot });
    }

    // ── awaitingProperty state (only relevant when properties exist) ────────
    if (session.state === "awaitingProperty") {
      // Widget just opened, no message yet.
      if (!message.trim()) {
        if (properties.length === 1) {
          updateSession(sessionId, { propertyId: properties[0].propertyId, state: "active" });

          const greetingPrompt = `
${chatbot.systemPrompt}
${LANGUAGE_RULE}
${BREVITY_RULE}

You are the assistant for: ${properties[0].name}
Write exactly one sentence greeting the guest and asking how you can help. Under 15 words. No emojis.
`.trim();

          const response = await chatWithTools({ systemPrompt: greetingPrompt, history: [], tools: [] });
          updateSession(sessionId, { history: [{ role: "assistant", content: response.text }] });
          return response.text;
        }

        const propertyList = properties.map((p) => `- ${p.name} (${p.address}) [id: ${p.propertyId}]`).join("\n");
        const greetingPrompt = `
${chatbot.systemPrompt}
${LANGUAGE_RULE}
${BREVITY_RULE}

You manage these hotels:
${propertyList}

Write a single greeting and ask which hotel the guest is contacting.
Show hotel names only — no IDs, no addresses. Under 20 words. No emojis.
`.trim();

        const response = await chatWithTools({ systemPrompt: greetingPrompt, history: [], tools: [] });
        updateSession(sessionId, { history: [{ role: "assistant", content: response.text }] });
        return response.text;
      }

      // Property selection.
      if (properties.length === 1) {
        updateSession(sessionId, {
          propertyId: properties[0].propertyId,
          state: "active",
          history: [...session.history, { role: "user", content: message }],
        });
        // falls through to handleActiveSession below
      } else {
        const propertyList = properties.map((p) => `- ${p.name} (${p.address}) [id: ${p.propertyId}]`).join("\n");
        const selectionPrompt = `
${chatbot.systemPrompt}
${LANGUAGE_RULE}
${BREVITY_RULE}

Properties you manage:
${propertyList}

Your ONLY job right now: identify which property the guest means and call selectProperty.
- If a hotel name is mentioned → call selectProperty immediately. No confirmation, no questions.
- If the message has both a hotel name and a request → still call selectProperty first.
- If no hotel name is mentioned → ask which hotel in one short sentence.
`.trim();

        const history = [...session.history, { role: "user", content: message }];
        const response = await chatWithTools({
          systemPrompt: selectionPrompt,
          history,
          tools: [toolDefinitions.selectProperty],
        });

        if (response.toolCalls?.length > 0) {
          for (const toolCall of response.toolCalls) {
            if (toolCall.name === "selectProperty") {
              const selectedProp = properties.find((p) => p.propertyId === toolCall.input.propertyId);
              if (!selectedProp) throw new AppError("Invalid property selected.", 400);

              updateSession(sessionId, {
                propertyId: selectedProp.propertyId,
                state: "active",
                history: [...session.history, { role: "user", content: message }],
              });
              break;
            }
          }
        }

        if (sessions.get(sessionId).state === "awaitingProperty") {
          updateSession(sessionId, { history: [...history, { role: "assistant", content: response.text }] });
          return response.text;
        }
      }
    }

    return handleActiveSession({ sessionId, chatbotId, message, properties, chatbot });
  },
};