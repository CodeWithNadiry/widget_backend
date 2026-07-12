const HF_URL = "https://router.huggingface.co/v1/chat/completions";

// Main conversational/tool-calling model — used for the actual guest-facing turn.
const MODEL = "Qwen/Qwen2.5-72B-Instruct:novita";

// Lightweight model for small judgment calls that don't need 72B-level reasoning:
// translation, follow-up intent classification, fixed-sentence translation.
// These were previously all running on the 72B model, which is a large part of
// why a single guest message could take 90+ seconds — several of these calls
// stack up sequentially per turn. Swap this string if you'd rather use a
// different fast provider/model; any small instruct model works here.
const UTILITY_MODEL = "Qwen/Qwen2.5-7B-Instruct";

export async function chatWithTools({ systemPrompt, history, tools = [], model = MODEL }) {
  const messages = [{ role: "system", content: systemPrompt }, ...history];

  const body = {
    model,
    messages,
    max_tokens: 400, // was 1024 — replies are concise now, no need for a large budget
    temperature: 0.3,
  };

  if (tools.length > 0) {
    body.tools = tools.map(formatTool);
    // was "required" — this forced a tool call on EVERY turn even when the
    // guest just asked a normal question, doubling round trips (one to call
    // a forced tool, one to produce the actual text). "auto" lets the model
    // answer directly when no tool is actually needed.
    body.tool_choice = "auto";
  }

  const response = await fetch(HF_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.HF_TOKEN}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`HuggingFace API error ${response.status}: ${error}`);
  }

  const data = await response.json();
  const assistantMessage = data.choices[0].message;
  console.log("🚀 assistantMessage:", assistantMessage)

  // LLM wants to call a tool
  if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
    return {
      text: assistantMessage.content || null,
      toolCalls: assistantMessage.tool_calls.map((tc) => {
        // Zero-parameter tools (e.g. requestBookingFlow) sometimes come back
        // with function.arguments as the literal string "undefined" instead
        // of "{}" — JSON.parse("undefined") throws, so guard against it here.
        const rawArgs = tc.function.arguments;
        const safeArgs = rawArgs && rawArgs !== "undefined" ? rawArgs : "{}";
        return {
          id: tc.id,
          name: tc.function.name,
          input: JSON.parse(safeArgs),
        };
      }),
    };
  }

  // LLM returned plain text
  return {
    text: assistantMessage.content,
    toolCalls: null,
  };
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

export { UTILITY_MODEL };