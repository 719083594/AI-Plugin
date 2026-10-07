# Priority racing gateway

`gateway-race.mjs` implements the optional race entry without changing the AI plugin's stable model bindings. `policy.json` contains public routing policy only; deployment merges its top-level timing and `race` fields with the existing private gateway configuration. Do not put provider credentials into this policy or these tests.

Run synthetic tests with:

```text
node --test gateway-race.test.mjs
```

The tests inject the upstream fetch implementation. The HTTP integration tests bind only to localhost and use synthetic credentials and messages. They do not call any real model or account API. The rollout-policy contract test expects `policy.json` beside the test file.

## Routing and budgets

- With `race.candidates` configured, candidates must exist in New API's inventory and explicitly advertise compatible capabilities. Text requests use text aliases, images use vision aliases, and requests containing tools or tool history require `tools`. Unsupported audio/video/file capabilities are excluded.
- Higher numeric priority runs first. A lower group starts after the higher group fails or exhausts its time window. `maxParallel` bounds concurrent attempts; `maxAttemptsPerTier` defaults to four total attempts per group, allowing a third legacy fallback after the first two fail. Discovery without a candidate policy retains legacy routing behavior.
- `timeoutMs` bounds body upload, inventory and all model groups together. `fallbackReserveMs` preserves a window for the final group; individual `candidate.timeoutMs` can end an attempt earlier. The native incoming `requestTimeoutMs` must be at least the configured total budget. The caller's own timeout must be longer.
- Resource groups share concurrency, RPM and estimated TPM reservations across requests in one process. Failed attempts also consume reservations. Multiple gateway replicas would need a shared limiter before these limits could be treated as account-wide limits.
- Text and tool payloads use conservative UTF-8 byte estimates. Images use `resource.imageTokenBudget` (default 16,384 per image), without downloading, decoding or counting base64 bytes as text. Output reservations use a configured output cap. This is a request guard, not an exact tokenizer or an account InkStone balance.
- `rate_limit_exceeded` and HTTP 429 apply `Retry-After` to the shared resource cooldown. Intern `quota_exceeded` / `insufficient_quota` pauses the resource until restart or trusted in-process `resetResourcePause`. Error parsing retains at most 16 KiB and extracts only recognized public protocol codes. No administrative HTTP reset endpoint is exposed.

## Candidate compatibility

- `normalizeImageDetail: true` supplies missing image `detail: auto` on the candidate clone. It preserves caller-provided detail and the original request.
- `rejectTruncated: true` rejects `finish_reason: length`, so a half-written answer cannot win. Legacy acceptance remains opt-in compatible.
- No global thinking parameter is inserted.
- A returned tool call pins subsequent compatible tool rounds to that winner. Cache keys combine SHA-256 digests of the current user message, an optional caller `user` identifier, assistant content, semantic tool arguments and call ID. Reused IDs with different user messages, tool arguments or caller identifiers cannot overwrite one another. Dynamic system task changes do not break matching. A failed pinned model can use quality peers and then lower-priority fallback. This is tool-chain affinity, not permanent conversation affinity; identical requests without a caller identifier remain indistinguishable to this protocol.
- `restoreToolReasoning` defaults to off. With it off, RAM retains only hashes, winner models and bounded TTL metadata; it does not retain original tool IDs, user messages or tool arguments. When explicitly enabled for a candidate, missing historical `reasoning_content` can be restored only for that same model and matching chain/assistant/tool content. Existing reasoning is preserved. RAM storage is bounded to 64 KiB per reasoning entry, 1 MiB in total by default and a configurable entry count; expiry physically removes entries without waiting for another request. No reasoning text or message contents are logged.

## Observability and practical limits

Responses preserve the entry alias in JSON and expose the actual candidate in `x-qqbot-race-winner`; priority, attempt count, fallback and sticky headers describe routing. `/healthz` reports counters, candidate aliases and paused resource-group names, without credentials, account balances or message contents.

The first usable response within the selected group wins. Structural validation is not a factuality or persona judge. Model quality and support still require actual upstream verification. Losing requests are cancelled promptly, but already-started work may still be billed by the upstream provider.
