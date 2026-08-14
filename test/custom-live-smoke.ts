import { detectCustomLogin } from "../electron/custom-login";
import { streamCustomHttp } from "../electron/custom-http";

const detected = detectCustomLogin();
if (!detected.connected) {
  console.log("FAIL: no MiniMax config from OpenClaw");
  process.exit(1);
}
console.log(`source=${detected.source}`);
console.log(`baseUrl=${detected.config.baseUrl}`);
console.log(`model=${detected.config.model}`);
console.log(`api=${detected.config.api}`);
console.log(`keySet=${Boolean(detected.config.apiKey)}`);

void (async () => {
  const chunks: string[] = [];
  try {
    const result = await streamCustomHttp(
      detected.config,
      {
        messages: [{ role: "user", text: "Reply with the single word pong." }],
        effort: "low",
      },
      {
        onChunk: (text) => chunks.push(text),
      },
    );
    const text = (result.text || chunks.join("")).trim();
    console.log(`text=${JSON.stringify(text)}`);
    console.log(`usage=${JSON.stringify(result.usage ?? null)}`);
    console.log(text.toLowerCase().includes("pong") ? "PASS: MiniMax answered" : "PASS: HTTP completed");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`error=${message.slice(0, 300)}`);
    process.exit(1);
  }
})();
