# Native web research

`web_search` and `web_extract` are Qubicl tools, not skills. They are enabled by default on every current preset, require a normal lease, obey per-computer tool and connection profiles, and pass through the existing network-policy boundary.

## Search

`web_search` accepts a query and 1–20 results (default 8). Its initial `ddgs` provider uses public DuckDuckGo-compatible search endpoints without an API key or account. Results are normalized to a stable title, URL, and short description. Requests have bounded retry/time/output behavior. Public providers can rate-limit or change; Qubicl reports that explicitly and never silently falls back to a paid provider.

## Extraction

`web_extract` accepts an HTTP(S) URL, `markdown` or `text`, a bounded character budget, and `render: auto|never|browser`. The local provider follows at most five validated redirects, downloads at most 8 MB, permits at most 16 MB after decompression, and extracts HTML/article text, plain text, JSON, XML, and PDF without a hosted scraping service. Metadata identifies final URL, title, content type, method, and truncation.

For HTML, Trafilatura is the primary extractor and favors the article or main body while preserving useful headings, lists, links, and tables in Markdown. If it cannot produce meaningful content, Qubicl tries readability-lxml over the already-fetched document, then a small local structural heuristic. Plain-text output removes Markdown link and heading syntax while retaining readable list and table structure. These extractors never fetch independently: Qubicl's existing validated fetch result is their only input. Non-HTML handling is unchanged.

`auto` normally stays local and may use Qubicl's existing managed Chromium when HTML is clearly unusable without JavaScript. `browser` forces that path; `never` prohibits it. Browser rendering requires a `browser`, `computer`, or `workstation` preset. The browser waits for the main DOM to become stable within a fixed five-second budget, strips executable and non-content nodes, bounds the rendered HTML at 1.5 MB, and sends it to the existing isolated web service. Trafilatura/readability then process that rendered DOM just like directly fetched HTML, so links, tables, headings, and boilerplate behavior remain consistent. High-signal JSON-LD, product/offer microdata, common price attributes, and price-like accessible labels can supplement content that the article extractor did not already include.

Canvas-only pixels are not HTML and therefore remain outside automatic extraction. Use the explicit browser screenshot/inspection tools when visual evidence is required; Qubicl does not silently OCR pages or capture arbitrary network responses. Dynamic facts can change immediately after observation, so models should prefer an official data source for consequential live prices.

Both paths reject embedded credentials and non-public destinations. Direct extraction validates all DNS answers and every redirect; browser extraction validates page requests. Loopback, RFC1918/private, link-local, metadata, reserved, and other non-public addresses are blocked. The `offline` profile denies both tools; `web-only`, `custom`, and `developer` retain their existing semantics. Extracted content is untrusted data, never instructions.

Provider interfaces intentionally keep the public schemas stable. The initial providers are `ddgs` and `local`; optional SearXNG or other providers can be added later without changing agent calls.
