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
const BREVITY_RULE = `
BREVITY RULE:
- Be direct and concise.
- Maximum 2 sentences for any reply.
- After completing an action (booking, payment, lookup), stop. Do not add any closing sentence.
- NEVER end a reply with any of these phrases or anything similar:
  "If you need any further assistance, feel free to ask."
  "If you have any other questions, let me know."
  "Is there anything else I can help you with?"
  "Feel free to reach out."
  "Happy to help."
  "Of course!", "Certainly!", "Sure,"
  "What specific details are you interested in?"
  "Let me know if you need anything else."
- Never explain what you are about to do — just do it.
- Never repeat information the guest just gave you.
- Never mention technical formats to the guest (no "YYYY-MM-DD", no "E.164", no "ISO"). Ask in plain language.
- Never explain why you need information — just ask for it.
`.trim();

// ─── Format rule ───────────────────────────────────────────────────────────
const FORMAT_RULE = `
FORMAT RULE — follow these templates exactly. Bold every label. No emojis except where shown.

ROOM OFFER (after getOffers):
**[Room type]**
**Check-in:** [DD Month YYYY]
**Check-out:** [DD Month YYYY]
**Meal plan:** [e.g. Breakfast included / Room only]
**Price:** [amount] [currency]

To book, share your full name, phone number with country code, and email.

BOOKING CONFIRMED (after createBooking):
✅ **Booking confirmed**
**Reservation ID:** [ID]
**Dates:** [DD Month] – [DD Month YYYY]
**Total:** [amount] [currency]

RESERVATION LOOKUP:
**Reservation [ID]**
**Guest:** [name]
**Dates:** [DD Month] – [DD Month YYYY]
**Room:** [room type]
**Status:** [status]

PAYMENT SUMMARY:
**Payment received**
**Reservation ID:** [ID]
**Amount charged:** [amount] [currency]
**Method:** [card type / last 4 digits if available]

ALL OTHER REPLIES:
Plain sentences. No headers. No bullets unless listing 3+ distinct items.

DATE FORMAT RULE:
- Send dates to tools as YYYY-MM-DD (e.g. 2026-06-24).
- Always display dates to the guest as "24 June 2026" — never show raw ISO format.
`.trim();

// ─── Persona & tone ────────────────────────────────────────────────────────
const PERSONA_RULE = `
PERSONA:
You are the front desk assistant for UNO Hotels. You are professional, warm, and efficient.
Never over-explain. Never apologize unnecessarily. Treat the guest like they know what they want.
`.trim();

// ─── Tool usage rule ───────────────────────────────────────────────────────
const TOOL_RULE = `
TOOL RULE:
- Always use tools for actions (booking, lookup, payment, WhatsApp). Never simulate or guess results.
- If a tool fails, say so in one sentence and offer one alternative.
- Never ask the guest to repeat information you already have.

SEQUENTIAL TOOL RULES — never call these in the same turn:
1. getOffers → createBooking: ALWAYS call getOffers first and WAIT for it to return.
   Only after getOffers returns, call createBooking with the exact ratePlanId from that result.
   Never invent or guess a ratePlanId. Never call both in the same turn.

   CRITICAL: If the guest already provided their full name, phone number, and email BEFORE
   or DURING the getOffers call, do NOT ask for them again. In the very next turn after
   getOffers returns, call createBooking immediately using those details from the conversation history.
   Only ask for guest details if they are genuinely missing from the conversation.

2. getReservation → sendWhatsappRecovery: ALWAYS call getReservation first and WAIT for it to return.
   Only after getReservation returns, call sendWhatsappRecovery with the reservationId from that result.
   Never call both in the same turn.

3. One tool call per turn maximum when the second call depends on the first call's output.
`.trim();

// ─── Context rule ──────────────────────────────────────────────────────────
const CONTEXT_RULE = `
CONTEXT RULE:
- Always read the full conversation history before replying.
- If the guest answered a clarifying question (e.g. which hotel), immediately address their original request — do not greet them again.
- Never ask for information the guest already provided earlier in the conversation.
- Never give a generic "How can I help?" if there is an unanswered question already in the conversation.
- If the guest provides check-in dates, guest count, AND personal details (name, phone, email) all in one message,
  call getOffers first, then createBooking in the next turn — no confirmation step needed.
`.trim();


// ─── Hallucination guard — used when no RAG context is found ───────────────
const NO_CONTEXT_INSTRUCTION = `
NO INFORMATION AVAILABLE.

You have no documents or data about this hotel loaded into your context.

HARD RULES — no exceptions:
1. Do NOT answer any factual question about the hotel (location, amenities, facilities, services, policies, prices, rooms, etc.).
2. Do NOT use your training data to answer hotel questions — your training data is not reliable for this specific hotel.
3. Do NOT guess, infer, or make up any hotel detail whatsoever.
4. For any informational question about the hotel: reply with exactly one sentence saying you don't have that information.
   Example: "I don't have that information available."
5. This rule does NOT block actions — still use tools for bookings, lookups, payments, and check-in/out.
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

// ─── Session helpers ───────────────────────────────────────────────────────
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

// ─── Tool history builders ─────────────────────────────────────────────────
function buildAssistantToolCallEntry(toolCalls) {
  return {
    role: "assistant",
    content: null,
    tool_calls: toolCalls.map((tc) => ({
      id: tc.id,
      type: "function",
      function: {
        name: tc.name,
        arguments: JSON.stringify(tc.input),
      },
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

// ─── Active session handler ────────────────────────────────────────────────
async function handleActiveSession({ sessionId, chatbotId, message, properties, chatbot }) {
  const currentSession = sessions.get(sessionId);

  const selectedProperty = properties.find(
    (p) => p.propertyId === currentSession.propertyId,
  );

  if (!selectedProperty) {
    updateSession(sessionId, {
      propertyId: null,
      state: "awaitingProperty",
      history: [],
    });
    return "Your session expired. Which hotel are you contacting?";
  }

  // RAG retrieval
  let ragChunks = await searchSimilarChunks({
    query: message,
    chatbotId,
    propertyId: currentSession.propertyId,
    topK: 5,
  });

  if (ragChunks.length === 0) {
    ragChunks = await searchSimilarChunks({
      query: message,
      chatbotId,
      topK: 5,
    });
  }

  const RELEVANCE_THRESHOLD = 0.92;
  const relevantChunks = ragChunks.filter(
    (chunk) => chunk.distance <= RELEVANCE_THRESHOLD,
  );
  const hasContext = relevantChunks.length > 0;

  const ragContext = hasContext
    ? `HOTEL INFORMATION — answer factual questions using ONLY what is written here, nothing else:\n${relevantChunks.map((c) => c.content).join("\n---\n")}`
    : NO_CONTEXT_INSTRUCTION;

  // Build system prompt
  const systemPrompt = `
${chatbot.systemPrompt}
${LANGUAGE_RULE}
${BREVITY_RULE}
${PERSONA_RULE}
${TOOL_RULE}
${CONTEXT_RULE}
${FORMAT_RULE}

Today's date: ${new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}
Hotel: ${selectedProperty.name}
Address: ${selectedProperty.address}
Apaleo property code: ${selectedProperty.apaleoCode}

INFORMATION RULES:
1. ONLY answer factual questions about this hotel using the hotel information section below.
2. If the information section says "NO INFORMATION AVAILABLE" — do not answer any factual hotel question. Say "I don't have that information available." and stop.
3. Never use your own training data to answer hotel-specific questions — it is not reliable for this hotel.
4. Never invent, guess, or infer hotel details (address, amenities, policies, room types, prices, facilities).
5. Never answer questions unrelated to hotels or the guest's booking.

GUEST DETAIL COLLECTION:
- When collecting guest details for a new booking, you need: full name, phone number with country code, and email address.
- Ask for all three in one short sentence.
- Never use technical terms like "E.164" — just say "phone number with country code".
- Email is required — never mark it as optional.

TOOL USE RULES:
- Always use tools for actions (bookings, reservation lookups, check-in, check-out).
- After getOffers returns results, copy the ratePlanId EXACTLY as returned — never construct or modify it.
- Never call createBooking without real guest details confirmed in the conversation.
- Never invent guest names, phone numbers, or emails.
- If createBooking fails, call getOffers again and use the fresh ratePlanId from that result.
- sendWhatsappRecovery: ALWAYS call getReservation FIRST in a separate step.
  Wait for getReservation to return. Only then call sendWhatsappRecovery with
  the reservationId from that result. Never call both in the same turn.

${ragContext}
  `.trim();

  const history = [
    ...currentSession.history,
    { role: "user", content: message },
  ];

  // Tool loop
  let finalReply = "";
  let currentHistory = history;

  while (true) {
    const response = await chatWithTools({
      systemPrompt,
      history: currentHistory,
      tools: toolDefinitions.all,
    });

    if (!response.toolCalls || response.toolCalls.length === 0) {
      finalReply = response.text;
      break;
    }

    const toolResults = [];
    for (const toolCall of response.toolCalls) {
      console.log("toolCall", toolCall);
      const result = await executeTool({
        toolName: toolCall.name,
        toolInput: toolCall.input,
        session: currentSession,
        property: selectedProperty,
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

    // ── awaitingProperty state ─────────────────────────────────────────────
    if (session.state === "awaitingProperty") {

      // GREETING (empty message = widget just opened)
      if (!message.trim()) {
        if (properties.length === 1) {
          updateSession(sessionId, {
            propertyId: properties[0].propertyId,
            state: "active",
          });

          const greetingPrompt = `
${chatbot.systemPrompt}
${LANGUAGE_RULE}
${BREVITY_RULE}

You are the assistant for: ${properties[0].name}

Write exactly one sentence greeting the guest and asking how you can help.
No emojis. No filler words. Under 15 words.
`.trim();

          const response = await chatWithTools({
            systemPrompt: greetingPrompt,
            history: [],
            tools: [],
          });

          updateSession(sessionId, {
            history: [{ role: "assistant", content: response.text }],
          });

          return response.text;
        } else {
          const propertyList = properties
            .map((p) => `- ${p.name} (${p.address}) [id: ${p.propertyId}]`)
            .join("\n");

          const greetingPrompt = `
${chatbot.systemPrompt}
${LANGUAGE_RULE}
${BREVITY_RULE}

You manage these hotels:
${propertyList}

Write a single greeting and ask which hotel the guest is contacting.
Show hotel names only — no IDs, no addresses.
No emojis. Under 20 words total.
`.trim();

          const response = await chatWithTools({
            systemPrompt: greetingPrompt,
            history: [],
            tools: [],
          });

          updateSession(sessionId, {
            history: [{ role: "assistant", content: response.text }],
          });

          return response.text;
        }
      }

      // PROPERTY SELECTION
      if (properties.length === 1) {
        updateSession(sessionId, {
          propertyId: properties[0].propertyId,
          state: "active",
          history: [
            ...session.history,
            { role: "user", content: message },
          ],
        });
        // Fall through to active session handler
      } else {
        const propertyList = properties
          .map((p) => `- ${p.name} (${p.address}) [id: ${p.propertyId}]`)
          .join("\n");

        const selectionPrompt = `
${chatbot.systemPrompt}
${LANGUAGE_RULE}
${BREVITY_RULE}

Properties you manage:
${propertyList}

Your ONLY job right now: identify which property the guest is referring to and call selectProperty.

STRICT RULES:
- If a hotel name is mentioned → call selectProperty immediately. No confirmation. No questions.
- If the message contains both a hotel name and a request → still call selectProperty first.
- If no hotel name is mentioned → ask which hotel in one short sentence.
- Never respond with plain text if a hotel name is mentioned.
        `.trim();

        const history = [
          ...session.history,
          { role: "user", content: message },
        ];

        const response = await chatWithTools({
          systemPrompt: selectionPrompt,
          history,
          tools: [toolDefinitions.selectProperty],
        });

        if (response.toolCalls?.length > 0) {
          for (const toolCall of response.toolCalls) {
            if (toolCall.name === "selectProperty") {
              const selectedPropertyId = toolCall.input.propertyId;
              const selectedProp = properties.find(
                (p) => p.propertyId === selectedPropertyId,
              );
              if (!selectedProp)
                throw new AppError("Invalid property selected.", 400);

              // Preserve full history so original question is answered
              updateSession(sessionId, {
                propertyId: selectedPropertyId,
                state: "active",
                history: [
                  ...session.history,
                  { role: "user", content: message },
                ],
              });

              break;
            }
          }
        }

        // Property not identified — save clarifying question and return
        if (sessions.get(sessionId).state === "awaitingProperty") {
          updateSession(sessionId, {
            history: [...history, { role: "assistant", content: response.text }],
          });
          return response.text;
        }
      }
    }

    // ── Active session — runs directly or after falling through from property selection ──
    return handleActiveSession({ sessionId, chatbotId, message, properties, chatbot });
  },
};