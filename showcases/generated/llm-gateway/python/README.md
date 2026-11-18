# nexus-ai-llm-gateway-sdk

> ⚡ Generated autonomously by [Watay](https://watay.dev) — Zero runtime dependencies, SpecDrift-safe & contract-verified.

Typed Python client for **NexusAI LLM Gateway** (API version `2.0.0`).
Built with stdlib `dataclasses` + `urllib`, runtime contract validation, idempotent retries and typed errors.

## Usage

```python
from nexus_ai_llm_gateway_sdk import NexusAiLlmGatewayClient

client = NexusAiLlmGatewayClient(base_url="https://api.nexusai.dev/v2")
result = client.list_models()
```

## Operations

- `client.create_chat_completion()` — `POST /v1/chat/completions` — Create a chat completion
- `client.create_embeddings()` — `POST /v1/embeddings` — Generate vector embeddings
- `client.list_models()` — `GET /v1/models` — List available gateway models
- `client.get_model()` — `GET /v1/models/{modelId}` — Get model metadata and limits
- `client.moderate_content()` — `POST /v1/moderations` — Classify text against safety policies

## Verification & Errors

- Run contract tests: `python3 -m unittest discover -s tests`
- `ApiError` — non-2xx response (`status`, `body`, `headers`).
- `ValidationError` — request or response violates the OpenAPI contract (`issues`).
- `NetworkError` — connection problems or timeouts.
