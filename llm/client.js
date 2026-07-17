import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

if (!process.env.OPENAI_API_KEY) {
  console.error("[llm/client] OPENAI_API_KEY is not set — every OpenAI call will fail.");
}

// Main reasoning model
const MODEL = "gpt-4.1";

// Smaller model for translations, intent detection, etc.
export const UTILITY_MODEL = "gpt-4.1-mini";

// ─── Timeouts ───────────────────────────────────────────────────────────────
// FIX — the SDK's default timeout is 10 minutes with 2 automatic retries. A
// stalled OpenAI call could hang a guest turn for minutes before ever
// failing — same failure class as the 504 you hit earlier. These timeouts
// make failures happen FAST instead of hanging, which helps perceived speed
// rather than hurting it, since nothing changes for a normal, successful call.
//
// UTILITY_MODEL is a one-shot classification/translation call, and every
// caller of it in chatbot.service.js already has its own deterministic
// fallback (regex hint, default label, original text). Giving it a short
// timeout and zero SDK retries means it fails fast and lets that fallback
// kick in immediately instead of the guest waiting on a doomed retry.
const UTILITY_TIMEOUT_MS = 8000;
const MAIN_TIMEOUT_MS = 20000;

export async function chatWithTools({
  systemPrompt,
  history,
  tools = [],
  model = MODEL,
  maxTokens = 400,
}) {
  const isUtility = model === UTILITY_MODEL;
  const timeoutMs = isUtility ? UTILITY_TIMEOUT_MS : MAIN_TIMEOUT_MS;
  const maxRetries = isUtility ? 0 : 1;

  const messages = [{ role: "system", content: systemPrompt }, ...history];

  const body = {
    model,
    messages,
    temperature: 0.3,
    max_tokens: maxTokens,
  };

  if (tools.length > 0) {
    body.tools = tools.map(formatTool);
    body.tool_choice = "auto";
  }

  const startedAt = Date.now();
  let response;
  try {
    response = await client.chat.completions.create(body, {
      timeout: timeoutMs,
      maxRetries,
    });
  } catch (err) {
    const elapsedMs = Date.now() - startedAt;
    console.error(
      `[llm] FAILED model=${model} elapsedMs=${elapsedMs} historyLen=${history.length} error=${err.message}`,
    );
    // Re-thrown deliberately — every caller in chatbot.service.js already
    // wraps its own chatWithTools calls in try/catch with a real fallback
    // (analyzeGuestMessage, translateToLanguage, classifyYesNo, etc.). This
    // preserves that existing behavior exactly.
    throw new Error(`OpenAI request failed (${model}): ${err.message}`);
  }

  const elapsedMs = Date.now() - startedAt;
  const assistantMessage = response.choices[0].message;
  const toolCallNames = (assistantMessage.tool_calls || []).map(
    (tc) => tc.function.name,
  );

  // Structured, single-line log instead of dumping the full message object.
  console.log(
    `[llm] OK model=${model} elapsedMs=${elapsedMs} contentLen=${assistantMessage.content?.length || 0} toolCalls=${toolCallNames.join(",") || "none"}`,
  );

  if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
    const toolCalls = [];
    for (const tc of assistantMessage.tool_calls) {
      const rawArgs = tc.function.arguments;
      const safeArgs = rawArgs && rawArgs !== "undefined" ? rawArgs : "{}";
      let parsedInput;
      try {
        parsedInput = JSON.parse(safeArgs);
      } catch (parseErr) {
        // FIX — malformed tool arguments used to throw here uncaught,
        // crashing the whole turn. Fall back to {} instead — the executor's
        // own validation (NO_HOTEL_SELECTED, missing required fields, etc.)
        // then produces a normal guest-visible message instead of a crash.
        console.error(
          `[llm] BAD TOOL ARGS tool=${tc.function.name} raw=${safeArgs.slice(0, 200)} error=${parseErr.message}`,
        );
        parsedInput = {};
      }
      toolCalls.push({ id: tc.id, name: tc.function.name, input: parsedInput });
    }
    return { text: assistantMessage.content || null, toolCalls };
  }

  return { text: assistantMessage.content, toolCalls: null };
}

function formatTool(tool) {
  return {
    type: "function",
    function: {
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters,
    },
  };
}