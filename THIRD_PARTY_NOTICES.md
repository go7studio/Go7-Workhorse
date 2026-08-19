# Third-party notices

Go7 Workhorse is MIT (see [LICENSE](LICENSE)). The installer also carries the
packages below. This file is generated from the production dependency tree by
`npm run notices`, and a test fails when it drifts.

77 packages ship.

## Not open source

These declare no redistributable licence. Shipping them inside an installer
is a licensing question, not a formatting one.

| Package | Version | Declared |
| --- | --- | --- |
| `@anthropic-ai/claude-agent-sdk` | 0.3.220 | SEE LICENSE IN README.md |
| `@anthropic-ai/claude-agent-sdk-darwin-arm64` | 0.3.220 | SEE LICENSE IN LICENSE.md |

## All packages

| Package | Version | Licence |
| --- | --- | --- |
| `@agentclientprotocol/claude-agent-acp` | 0.66.0 | Apache-2.0 |
| `@agentclientprotocol/codex-acp` | 1.2.0 | Apache-2.0 |
| `@agentclientprotocol/sdk` | 1.3.0 | Apache-2.0 |
| `@anthropic-ai/claude-agent-sdk` | 0.3.220 | SEE LICENSE IN README.md |
| `@anthropic-ai/claude-agent-sdk-darwin-arm64` | 0.3.220 | SEE LICENSE IN LICENSE.md |
| `@anthropic-ai/claude-agent-sdk-darwin-x64` | — | not installed on this platform |
| `@anthropic-ai/claude-agent-sdk-linux-arm64` | — | not installed on this platform |
| `@anthropic-ai/claude-agent-sdk-linux-arm64-musl` | — | not installed on this platform |
| `@anthropic-ai/claude-agent-sdk-linux-x64` | — | not installed on this platform |
| `@anthropic-ai/claude-agent-sdk-linux-x64-musl` | — | not installed on this platform |
| `@anthropic-ai/claude-agent-sdk-win32-arm64` | — | not installed on this platform |
| `@anthropic-ai/claude-agent-sdk-win32-x64` | — | not installed on this platform |
| `@anthropic-ai/sdk` | 0.116.0 | MIT |
| `@babel/runtime` | 7.29.7 | MIT |
| `@cfworker/json-schema` | — | not installed on this platform |
| `@hono/node-server` | 2.1.0 | MIT |
| `@modelcontextprotocol/sdk` | 1.30.0 | MIT |
| `@openai/codex` | 0.147.0 | Apache-2.0 |
| `@openai/codex-darwin-arm64` | 0.147.0-darwin-arm64 | Apache-2.0 |
| `@openai/codex-darwin-x64` | — | not installed on this platform |
| `@openai/codex-linux-arm64` | — | not installed on this platform |
| `@openai/codex-linux-x64` | — | not installed on this platform |
| `@openai/codex-win32-arm64` | — | not installed on this platform |
| `@openai/codex-win32-x64` | — | not installed on this platform |
| `@stablelib/base64` | 1.0.1 | MIT |
| `ajv` | 8.20.0 | MIT |
| `ajv-formats` | 3.0.1 | MIT |
| `bundle-name` | 4.1.0 | MIT |
| `bytes` | 3.1.2 | MIT |
| `content-type` | 1.0.5 | MIT |
| `cors` | 2.8.6 | MIT |
| `cross-spawn` | 7.0.6 | MIT |
| `debug` | 4.4.3 | MIT |
| `default-browser` | 5.5.0 | MIT |
| `default-browser-id` | 5.0.1 | MIT |
| `define-lazy-prop` | 3.0.0 | MIT |
| `diff` | 9.0.0 | BSD-3-Clause |
| `eventsource` | 3.0.7 | MIT |
| `eventsource-parser` | 3.1.1 | MIT |
| `express` | 5.2.1 | MIT |
| `express-rate-limit` | 8.6.2 | MIT |
| `fast-sha256` | 1.3.0 | Unlicense |
| `hono` | 4.13.2 | MIT |
| `http-errors` | 2.0.1 | MIT |
| `iconv-lite` | 0.7.3 | MIT |
| `ip-address` | 10.5.0 | MIT |
| `is-docker` | 3.0.0 | MIT |
| `is-in-ssh` | 1.0.0 | MIT |
| `is-inside-container` | 1.0.0 | MIT |
| `is-wsl` | 3.1.1 | MIT |
| `isexe` | 2.0.0 | ISC |
| `jose` | 6.2.8 | MIT |
| `json-schema-to-ts` | 3.1.1 | MIT |
| `json-schema-typed` | 8.0.2 | BSD-2-Clause |
| `ms` | 2.1.3 | MIT |
| `object-assign` | 4.1.1 | MIT |
| `open` | 11.0.0 | MIT |
| `path-key` | 3.1.1 | MIT |
| `pkce-challenge` | 5.0.1 | MIT |
| `powershell-utils` | 0.1.0 | MIT |
| `raw-body` | 3.0.2 | MIT |
| `react` | 19.2.8 | MIT |
| `react-dom` | 19.2.8 | MIT |
| `run-applescript` | 7.1.0 | MIT |
| `safer-buffer` | 2.1.2 | MIT |
| `scheduler` | 0.27.0 | MIT |
| `shebang-command` | 2.0.0 | MIT |
| `shebang-regex` | 3.0.0 | MIT |
| `standardwebhooks` | 1.0.0 | MIT |
| `ts-algebra` | 2.0.0 | MIT |
| `unpipe` | 1.0.0 | MIT |
| `vary` | 1.1.2 | MIT |
| `vscode-jsonrpc` | 9.0.1 | MIT |
| `which` | 2.0.2 | ISC |
| `wsl-utils` | 0.3.1 | MIT |
| `zod` | 4.4.3 | MIT |
| `zod-to-json-schema` | 3.25.2 | ISC |

## Electron and Chromium

The app runs on Electron, which is MIT and bundles Chromium under its own
terms. Their notices ship inside the installed application, under
`Contents/Resources` on macOS and `resources` on Windows.
