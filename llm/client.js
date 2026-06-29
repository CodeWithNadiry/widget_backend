const HF_URL = "https://router.huggingface.co/v1/chat/completions";
const MODEL = "Qwen/Qwen2.5-72B-Instruct";
// const MODEL  = "Qwen/Qwen2.5-7B-Instruct";

const PROVIDERS = ["sambanova", "together", "fireworks"];

export async function chatWithTools({ systemPrompt, history, tools = [] }) {
  const messages = [{ role: "system", content: systemPrompt }, ...history];

  let lastError;

  for (const provider of PROVIDERS) {
    const body = {
      model: MODEL,
      messages,
      max_tokens: 1024,
      temperature: 0.3,
      provider, // 👈 tries each one
    };

    if (tools.length > 0) {
      body.tools = tools.map(formatTool);
      body.tool_choice = "required";
    }

    const response = await fetch(HF_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.HF_TOKEN}`,
      },
      body: JSON.stringify(body),
    });

    if (response.ok) {
      const data = await response.json();
      const assistantMessage = data.choices[0].message;

      if (assistantMessage.tool_calls?.length > 0) {
        return {
          text: assistantMessage.content || null,
          toolCalls: assistantMessage.tool_calls.map((tc) => ({
            id: tc.id,
            name: tc.function.name,
            input: JSON.parse(tc.function.arguments),
          })),
        };
      }

      return { text: assistantMessage.content, toolCalls: null };
    }

    lastError = await response.text();
    console.warn(`⚠️ Provider "${provider}" failed: ${lastError}`);
  }

  throw new Error(`All providers failed. Last error: ${lastError}`);
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
