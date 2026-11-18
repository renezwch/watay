# nexus-ai-llm-gateway-sdk

> ⚡ Generated autonomously by [Watay](https://watay.dev) — Zero runtime dependencies, Contract-safe & contract-verified.

Typed TypeScript client for **NexusAI LLM Gateway** (API version `2.0.0`).
Built with native `fetch`, runtime request/response schema validation, idempotent retries and typed errors.

## Usage

```ts
import { NexusAiLlmGatewayClient } from 'nexus-ai-llm-gateway-sdk';

const client = new NexusAiLlmGatewayClient({ baseUrl: "https://api.nexusai.dev/v2" });
const result = await client.listModels();
```

## Operations

- `client.createChatCompletion()` — `POST /v1/chat/completions` — Create a chat completion
- `client.createEmbeddings()` — `POST /v1/embeddings` — Generate vector embeddings
- `client.listModels()` — `GET /v1/models` — List available gateway models
- `client.getModel()` — `GET /v1/models/{modelId}` — Get model metadata and limits
- `client.moderateContent()` — `POST /v1/moderations` — Classify text against safety policies

## Verification & Errors

- Run contract tests: `node --test tests/`
- `ApiError` — non-2xx response (`status`, `body`, `headers`).
- `ValidationError` — request or response violates the OpenAPI contract (`issues`).
- `NetworkError` — connection problems, timeouts, aborts.
