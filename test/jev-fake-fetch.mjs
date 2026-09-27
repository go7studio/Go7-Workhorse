// Loaded only by the Jev MCP bridge integration test. Never contacts TypeSafe.
globalThis.fetch = async () => new Response(JSON.stringify({
  model: "jev-test",
  answers: { yes: { type: "noul", noul: 0.8 } },
  usage: { input_tokens: 1, output_tokens: 1 },
}), { status: 200 });
