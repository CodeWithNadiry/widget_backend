const HF_URL = "https://router.huggingface.co/v1/chat/completions";
const MODEL = "Qwen/Qwen2.5-72B-Instruct";
// const MODEL  = "Qwen/Qwen2.5-7B-Instruct";

export async function chatWithTools({ systemPrompt, history, tools = [] }) {
  const messages = [{ role: "system", content: systemPrompt }, ...history];

  const body = {
    model: MODEL,
    messages,
    max_tokens: 1024,
    temperature: 0.3,
  };

  if (tools.length > 0) {
    body.tools = tools.map(formatTool);
    body.tool_choice = "required"; //"You decide whether to call a tool or answer directly."
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
        return {
          id: tc.id,
          name: tc.function.name,
          input: JSON.parse(tc.function.arguments),
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
