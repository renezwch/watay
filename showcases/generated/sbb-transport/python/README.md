# sbb-swiss-public-transport-api-sdk

> ⚡ Generated autonomously by [Watay](https://watay.dev) — Zero runtime dependencies, Contract-safe & contract-verified.

Typed Python client for **SBB Swiss Public Transport API** (API version `1.0.0`).
Built with stdlib `dataclasses` + `urllib`, runtime contract validation, idempotent retries and typed errors.

## Usage

```python
from sbb_swiss_public_transport_api_sdk import SbbSwissPublicTransportApiClient

client = SbbSwissPublicTransportApiClient(base_url="https://transport.opendata.ch")
result = client.get_connections(from_=..., to=...)
```

## Operations

- `client.get_connections()` — `GET /v1/connections` — Find next public transport connections between two Swiss locations
- `client.search_locations()` — `GET /v1/locations` — Search Swiss train stations, bus stops, POIs and addresses
- `client.get_stationboard()` — `GET /v1/stationboard` — Live departure board (Abfahrtstafel) for a Swiss station

## Verification & Errors

- Run contract tests: `python3 -m unittest discover -s tests`
- `ApiError` — non-2xx response (`status`, `body`, `headers`).
- `ValidationError` — request or response violates the OpenAPI contract (`issues`).
- `NetworkError` — connection problems or timeouts.
