# Phase 1 — How `opencode/` implements `ocmini-spec.md §3, §8`

Phase-1 gate (`ocmini-spec.md §8`): API spike with one call + one tool.
Confirm every row of §3 — model-id, endpoint, reasoning-continuity, web-search; write backoff.

## Point 1. Model-id / Base-URL: catalog, not hardcoded

* `packages/web/src/content/docs/zen.mdx:105-106`: canonical row:
  `Muse Spark 1.3 Contributor Free | muse-spark-1.3-contributor-free | https://opencode.ai/zen/v1/responses | @ai-sdk/openai`
* `packages/opencode/test/tool/fixtures/models-api.json:90326`: `opencode.api=https://opencode.ai/zen/v1`, fetched live from `packages/core/src/models-dev.ts:160` (`https://models.opencode.ai/api.json`).
* Consumed in `packages/opencode/src/provider/provider.ts:1265-1279,1514-1515,1759-1780` → AI-SDK `baseURL`. Auth: `OPENCODE_API_KEY`.
* No `muse-spark*` literal in `packages/llm|opencode|core`; only `packages/console/app/src/lib/request-country.ts:35-38`, `.../zen/util/trainingConsent.ts:2`, `packages/stats/core/src/domain/model-normalization.ts:12`.

> Spike must fetch live catalog: fixture has 79 models, `muse*==[]`.

## Point 2. Endpoint: `/responses` required

* Server gateway: `packages/console/app/src/routes/zen/util/provider/openai.ts:16-18` (`api+"/responses"`, `format:"openai"`) vs `openai-compatible.ts:26-28` (`api+"/chat/completions"`, `format:"oa-compat"`). Routed by `util/handler.ts:208,673-685`, `v1/responses.ts:5-12` vs `v1/chat/completions.ts:5-12`.
* Client: `packages/llm/src/protocols/openai-responses.ts:30` (`PATH="/responses"`) vs `openai-chat.ts:29`, `openai-compatible-chat.ts:20` (`/chat/completions`). Wired in `packages/llm/src/providers/openai.ts:37-45` (`responses(id)` vs `chat(id)`).

## Point 3. Reasoning continuity: `store:false` + `encrypted_content` replay

* Defaults: `openai-responses.ts:991,1019`, `providers/openai-options.ts:66-70`: `store:false`.
* No `previous_response_id` in `packages/llm` (only legacy `packages/core/src/github-copilot/responses/openai-responses-language-model.ts:284`).
* Schema `openai-responses.ts:56-61,98-106,197`: `reasoning{id,summary,encrypted_content}`.
* Lower: `openai-responses.ts:283-299,346-453` (`lowerReasoning`, `item_reference` if stored, else push replay, drop if `encrypted_content!=string`).
* Stream capture: `openai-responses.ts:641-642,656-670,692-787`; include whitelist `protocols/utils/openai-options.ts:12-21` includes `reasoning.encrypted_content` (auto for GPT-5 in `providers/openai-options.ts:53-58`).
* Effort: `schema/ids.ts:29-31` (`none,minimal,low,medium,high,xhigh,max`), validated in `openai-responses.ts:456-475`.

## Point 5. Web search: local tool, not built-in (§4.6 decision)

* `packages/opencode/src/tool/websearch.ts:99-143`, `packages/core/src/tool/websearch.ts:192-260`: local `websearch` → MCP `https://mcp.exa.ai/mcp` / `https://search.parallel.ai/mcp` (`mcp-websearch.ts:4-96`, 25s timeout). Gated by `registry.ts:58-65`.
* Provider-hosted `web_search` only for Copilot: `packages/core/src/github-copilot/responses/tool/web-search.ts:76`.
* `webfetch.ts`: 5MB cap, 30s default/120s max, `ctx.ask({permission:"webfetch"})`; redirects by prompt (`session/prompt/meta.txt:57`), not code; no private-IP/SSRF block (only scheme check) — `ocmini` must add per §4.6.

## Point 6. Backoff: `packages/opencode/src/session/retry.ts:26-83,85-207`

`2000*2^(n-1)+jitter(0.25)`, 30s cap w/o headers, `retry-after`/`retry-after-ms`/HTTP-date, `MAX_RETRIES=5`. `FreeUsageLimitError→free_tier_limit` (`99-111`), `GoUsageLimitError→account_rate_limit`. Retryable regex covers `429|rate limit|overloaded|...`. Wired in `processor.ts:674-688`.
