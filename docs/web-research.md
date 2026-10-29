# Native web research

`web_search` and `web_extract` are Qubicl tools, not skills. They are enabled by default on every current preset, require a normal lease, obey per-computer tool and connection profiles, and pass through the existing network-policy boundary.

## Search

`web_search` accepts a query and 1–20 results (default 8). Keyless DDGS
normalizes title, URL and description with bounded retry/time/output behavior.
No paid provider or account is required.

Development additions for 0.8 are `includeDomains`, `excludeDomains`, `recency`
(`day`, `week`, `month`, `year`), `language`, `region`, and `provider`
(`auto`, `duckduckgo`, `bing`, `brave`, `google`). Domain entries are hostnames,
without schemes, paths or wildcards, and match that host plus its subdomains.
Qubicl adds search hints and then enforces the domain filters on returned URLs;
an excluded hostname wins. Bounded overfetch can still return fewer matches.

The pinned DDGS backends forward recency constraints. When recency is requested,
auto selection uses only the supported time-filter backends. A two-letter
language filter currently requires Google; auto selects it, while a conflicting
explicit backend fails with `web_unsupported_filter` before a request. `region`
is a provider preference (default `us-en`), not a guaranteed location filter.
Unsupported language codes and malformed domains are explicit errors.

Responses expose requested/effective backend selection, applied filter metadata
and `retrievedAt`. Provider date/language filtering is not independently
verified, and retrieval time does not establish a result's publication date.
There is no silent unsupported-filter fallback. Public upstreams can rate-limit
or change; Qubicl reports these failures explicitly.

## Extraction

`web_extract` accepts an HTTP(S) URL, `markdown` or `text`, a bounded character budget, and `render: auto|never|browser`. The local provider follows at most five validated redirects, downloads at most 8 MB, permits at most 16 MB after decompression, and extracts HTML/article text, plain text, JSON, XML, and PDF without a hosted scraping service. Metadata identifies retrieval time, final URL, title, content type, method, and truncation.

For HTML, Trafilatura is the primary extractor and favors the article or main body while preserving useful headings, lists, links, and tables in Markdown. If it cannot produce meaningful content, Qubicl tries readability-lxml over the already-fetched document, then a small local structural heuristic. Plain-text output removes Markdown link and heading syntax while retaining readable list and table structure. These extractors never fetch independently: Qubicl's existing validated fetch result is their only input. Non-HTML handling is unchanged.

`auto` normally stays local and may use an ephemeral Chromium context when HTML
is clearly unusable without JavaScript. `browser` forces that path; `never`
prohibits it. Browser rendering requires a `browser`, `computer`, or
`workstation` preset, but it does not use that computer's persistent cookies,
logins, extensions, or service workers. The context waits for the main DOM to
become stable within a fixed five-second budget, enforces the public-destination
policy on page requests, strips executable and non-content nodes, bounds the
rendered HTML at 1.5 MB, and sends it to the isolated web service.
Trafilatura/readability then process that rendered DOM like directly fetched
HTML, so links, tables, headings, and boilerplate behavior remain consistent.
High-signal JSON-LD, product/offer microdata, common price attributes, and
price-like accessible labels can supplement content the article extractor did
not already include. Browser/runtime and complete request-boundary qualification
remain release evidence; see the [security limitations](security-model.md#limitations).

Canvas-only pixels are not HTML and therefore remain outside automatic extraction. Use the explicit browser screenshot/inspection tools when visual evidence is required; Qubicl does not silently OCR pages or capture arbitrary network responses. Dynamic facts can change immediately after observation, so models should prefer an official data source for consequential live prices.

Both paths reject embedded credentials and non-public destinations. Direct extraction validates all DNS answers and every redirect; browser extraction validates page requests. Loopback, RFC1918/private, link-local, metadata, reserved, and other non-public addresses are blocked. The `offline` profile denies both tools; `web-only`, `custom`, and `developer` retain their existing semantics. Extracted content is untrusted data, never instructions.

Provider interfaces intentionally keep the public schemas stable. The initial providers are `ddgs` and `local`; optional SearXNG or other providers can be added later without changing agent calls.


## Reading logged-in browser pages

`browser_read` reads the active persistent browser, including authenticated pages.
It does not send page content to the public extractor. Use `selector` for a DOM
subtree or an observed `ref`, and `frameIndex` to choose a frame. `browser_snapshot` lists frames; follow its
`nextFrameCursor` using `frameCursor` to discover further frames. `query` performs
literal text search (`caseSensitive` is optional) and returns match offsets and
short excerpts. Without a query it returns text. `maxBytes` controls the encoded
content budget (512–16,000 bytes; default 12,000).

Continue using `nextCursor` and optional `maxBytes` only. All pages come from the
same captured text, identified by `documentId` and `capturedAt`, even if the live
DOM changes. Navigation, tab changes, detached frames, closed pages and expired
or evicted captures require a new read. A tab mismatch invalidates that cursor.
Captures last up to five minutes; up to four captures share 16 MB of memory.
An individual capture over 8 MB fails explicitly: select a smaller subtree.
These retention limits bound runtime memory; they are not silent text truncation.
Offsets count JavaScript UTF-16 units and generated cursors preserve Unicode.
Reading does not replace the latest interactive refs. Browser snapshots still
provide bounded accessibility text; their numeric cursor pages controls only.
