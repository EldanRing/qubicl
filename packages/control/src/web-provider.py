#!/usr/bin/env python3
"""Keyless DDGS search and bounded local extraction for Qubicl's isolated web service."""

import ipaddress
import io
import json
import os
import re
import socket
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zlib
from html import unescape

from ddgs import DDGS
from lxml import etree, html
from pypdf import PdfReader
from readability import Document as ReadabilityDocument
from trafilatura import extract as trafilatura_extract
from trafilatura.settings import use_config as trafilatura_config

MAX_DOWNLOAD = 8_000_000
MAX_DECOMPRESSED = 16_000_000
MAX_REDIRECTS = 5
TIMEOUT = 12
USER_AGENT = "Qubicl-Web/1.0 (+https://github.com/EldanRing/qubicl)"
MAX_HTML_TREE_SIZE = 500_000
MAX_RENDERED_HTML = 1_500_000
BOILERPLATE_TOKENS = {
    "advert", "advertisement", "comments", "consent", "cookie", "footer",
    "navbar", "navigation", "newsletter", "promo", "related", "share",
    "sharing", "sidebar", "social",
}
TRAFILATURA_CONFIG = trafilatura_config()
TRAFILATURA_CONFIG.set("DEFAULT", "MAX_TREE_SIZE", str(MAX_HTML_TREE_SIZE))
TRAFILATURA_CONFIG.set("DEFAULT", "EXTRACTION_TIMEOUT", "15")
STRUCTURED_KEYS = {
    "availability": "Availability",
    "datecreated": "Date created",
    "datemodified": "Date modified",
    "datepublished": "Date published",
    "highprice": "High price",
    "lowprice": "Low price",
    "offerprice": "Offer price",
    "price": "Price",
    "priceamount": "Price",
    "pricecurrency": "Price currency",
    "productid": "Product ID",
    "ratingvalue": "Rating",
    "reviewcount": "Review count",
    "sku": "SKU",
    "validthrough": "Valid through",
}


class WebError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def policy_profile():
    try:
        return json.loads(os.environ.get("QUBICL_NETWORK_POLICY", '{}')).get("profile", "developer")
    except json.JSONDecodeError:
        return "developer"


def require_online():
    if policy_profile() == "offline":
        raise WebError("network_policy_denied", "This computer's offline network policy denies web access.")


def public_url(value):
    try:
        parsed = urllib.parse.urlsplit(value)
    except ValueError as error:
        raise WebError("web_invalid_url", f"Invalid URL: {error}") from error
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise WebError("web_invalid_url", "Only complete HTTP and HTTPS URLs are allowed.")
    if parsed.username is not None or parsed.password is not None:
        raise WebError("web_invalid_url", "Embedded URL credentials are not allowed.")
    # Restricted profiles place this worker on internal-only networks. In that
    # topology the authenticated egress proxy is the only resolver and applies
    # the same public-address check to every HTTP request and CONNECT target.
    # Resolving here would both fail and create a second, inconsistent policy
    # decision. Developer mode has no proxy, so direct requests still validate
    # every DNS answer locally before opening a connection.
    if os.environ.get("QUBICL_PROXY_URL"):
        return urllib.parse.urlunsplit(parsed)
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    try:
        addresses = {entry[4][0] for entry in socket.getaddrinfo(parsed.hostname, port, type=socket.SOCK_STREAM)}
    except socket.gaierror as error:
        raise WebError("web_dns_failure", f"Could not resolve destination: {error}") from error
    if not addresses:
        raise WebError("web_dns_failure", "The destination resolved to no addresses.")
    for address in addresses:
        ip = ipaddress.ip_address(address.split("%", 1)[0])
        if not ip.is_global:
            raise WebError("web_private_destination", "Loopback, private, link-local, metadata, reserved, and other non-public destinations are blocked.")
    return urllib.parse.urlunsplit(parsed)


class ValidatingRedirect(urllib.request.HTTPRedirectHandler):
    def __init__(self):
        self.redirects = 0

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        self.redirects += 1
        if self.redirects > MAX_REDIRECTS:
            raise WebError("web_redirect_limit", f"Web extraction follows at most {MAX_REDIRECTS} redirects.")
        return super().redirect_request(req, fp, code, msg, headers, public_url(newurl))


def read_bounded(response):
    chunks, total = [], 0
    while True:
        chunk = response.read(min(65_536, MAX_DOWNLOAD + 1 - total))
        if not chunk:
            break
        total += len(chunk)
        if total > MAX_DOWNLOAD:
            raise WebError("web_response_too_large", f"Response exceeds the {MAX_DOWNLOAD}-byte download limit.")
        chunks.append(chunk)
    raw = b"".join(chunks)
    encoding = (response.headers.get("content-encoding") or "").lower()
    if encoding in ("gzip", "x-gzip"):
        raw = bounded_inflate(raw, 16 + zlib.MAX_WBITS, "gzip")
    elif encoding == "deflate":
        raw = bounded_inflate(raw, zlib.MAX_WBITS, "deflate")
    elif encoding and encoding != "identity":
        raise WebError("web_invalid_content", f"Unsupported content encoding: {encoding}")
    if len(raw) > MAX_DECOMPRESSED:
        raise WebError("web_decompression_limit", f"Decompressed response exceeds {MAX_DECOMPRESSED} bytes.")
    return raw


def bounded_inflate(data, window_bits, label):
    try:
        inflater = zlib.decompressobj(window_bits)
        result = inflater.decompress(data, MAX_DECOMPRESSED + 1)
        if inflater.unconsumed_tail or len(result) > MAX_DECOMPRESSED:
            raise WebError("web_decompression_limit", f"Decompressed response exceeds {MAX_DECOMPRESSED} bytes.")
        result += inflater.flush(MAX_DECOMPRESSED + 1 - len(result))
        if len(result) > MAX_DECOMPRESSED:
            raise WebError("web_decompression_limit", f"Decompressed response exceeds {MAX_DECOMPRESSED} bytes.")
        return result
    except WebError:
        raise
    except zlib.error as error:
        raise WebError("web_invalid_content", f"Invalid {label}-encoded response.") from error


def fetch(url):
    require_online()
    target = public_url(url)
    redirect = ValidatingRedirect()
    proxy = os.environ.get("QUBICL_PROXY_URL")
    opener = urllib.request.build_opener(redirect, urllib.request.ProxyHandler({"http": proxy, "https": proxy}) if proxy else urllib.request.ProxyHandler({}))
    request = urllib.request.Request(target, headers={"User-Agent": USER_AGENT, "Accept": "text/html,application/pdf,text/plain,application/json,application/xml,text/xml;q=0.9,*/*;q=0.1", "Accept-Encoding": "identity"})
    try:
        with opener.open(request, timeout=TIMEOUT) as response:
            final_url = public_url(response.geturl())
            return final_url, response.headers.get_content_type().lower(), response.headers.get_content_charset() or "utf-8", read_bounded(response)
    except WebError:
        raise
    except urllib.error.HTTPError as error:
        if error.code == 429:
            raise WebError("web_rate_limited", "The upstream site rate-limited this request.") from error
        raise WebError("web_upstream_error", f"Upstream returned HTTP {error.code}.") from error
    except (urllib.error.URLError, TimeoutError, socket.timeout) as error:
        reason = getattr(error, "reason", error)
        if isinstance(reason, (TimeoutError, socket.timeout)):
            raise WebError("web_timeout", "The upstream request timed out.") from error
        raise WebError("web_upstream_error", f"The upstream request failed: {reason}") from error


def clean_text(value):
    return re.sub(r"\n{3,}", "\n\n", re.sub(r"[ \t]+", " ", value)).strip()


def decoded_html(data, charset):
    try:
        return data.decode(charset, errors="replace")
    except LookupError as error:
        raise WebError("web_invalid_content", f"Unsupported HTML encoding: {charset}") from error


def parsed_html(source):
    try:
        return html.fromstring(source)
    except (etree.ParserError, TypeError, ValueError) as error:
        raise WebError("web_invalid_content", f"Could not parse HTML: {error}") from error


def fallback_title(source):
    document = parsed_html(source)
    candidates = [
        "//meta[@property='og:title'][1]/@content",
        "//meta[@name='twitter:title'][1]/@content",
        "//title[1]//text()",
        "//h1[1]//text()",
    ]
    for xpath in candidates:
        title = clean_text(" ".join(str(value) for value in document.xpath(xpath)))
        if title:
            return title
    return None


def meaningful_html(content):
    words = re.findall(r"\b[\w'-]+\b", content, flags=re.UNICODE)
    visible = re.sub(r"[^\w]+", "", content, flags=re.UNICODE)
    return len(words) >= 12 and len(visible) >= 80


def markdownish_to_text(content):
    lines = []
    table_separator = re.compile(r"^\|?(?:\s*:?-{3,}:?\s*\|)+\s*$")
    for original in content.splitlines():
        line = original.strip()
        if not line or line.startswith("```") or table_separator.match(line):
            if lines and lines[-1] != "":
                lines.append("")
            continue
        line = re.sub(r"^#{1,6}\s+", "", line)
        line = re.sub(r"^>\s?", "", line)
        line = re.sub(r"^(?:[-+*]|\d+[.)])\s+", "• ", line)
        line = re.sub(r"\[([^]]+)]\((?:https?://|/)[^)]+\)", r"\1", line)
        line = re.sub(r"(?<!\w)(?:\*\*|__)(.+?)(?:\*\*|__)(?!\w)", r"\1", line)
        line = re.sub(r"(?<!\w)(?:\*|_)(.+?)(?:\*|_)(?!\w)", r"\1", line)
        if line.startswith("|") and line.endswith("|"):
            line = "\t".join(cell.strip() for cell in line[1:-1].split("|"))
        lines.append(line)
    return clean_text("\n".join(lines))


def trafilatura_html(source, final_url, output_format):
    try:
        content = trafilatura_extract(
            source,
            url=final_url,
            output_format="txt" if output_format == "text" else "markdown",
            include_comments=False,
            include_tables=True,
            include_links=output_format == "markdown",
            include_formatting=output_format == "markdown",
            deduplicate=True,
            favor_precision=True,
            with_metadata=False,
            config=TRAFILATURA_CONFIG,
        )
        if not content:
            return None, ""
        if output_format == "text":
            content = markdownish_to_text(content)
        return fallback_title(source), clean_text(content)
    except Exception:
        # Extraction libraries operate only on already-fetched bytes. Treat
        # parser-specific failures as a miss so the bounded local fallback can
        # run without changing network behavior.
        return None, ""


def prune_boilerplate(document):
    for node in document.xpath("//script|//style|//noscript|//nav|//header|//footer|//aside|//form|//svg|//canvas|//template"):
        node.drop_tree()
    for node in document.xpath("//*"):
        if not isinstance(node.tag, str):
            continue
        tokens = set(re.split(r"[^a-z0-9]+", f"{node.get('id', '')} {node.get('class', '')}".lower()))
        role = node.get("role", "").lower()
        if tokens.intersection(BOILERPLATE_TOKENS) or role in {"banner", "complementary", "contentinfo", "dialog", "navigation"}:
            node.drop_tree()


def inline_content(node, output_format, base_url):
    parts = [node.text or ""]
    for child in node:
        nested = inline_content(child, output_format, base_url)
        tag = child.tag.lower() if isinstance(child.tag, str) else ""
        if output_format == "markdown" and tag == "a":
            href = urllib.parse.urljoin(base_url, child.get("href", ""))
            parsed = urllib.parse.urlsplit(href)
            nested = f"[{nested}]({href})" if nested and parsed.scheme in ("http", "https") and parsed.hostname else nested
        elif output_format == "markdown" and tag in ("strong", "b") and nested:
            nested = f"**{nested}**"
        elif output_format == "markdown" and tag in ("em", "i") and nested:
            nested = f"*{nested}*"
        elif output_format == "markdown" and tag == "code" and nested:
            nested = f"`{nested}`"
        elif tag == "br":
            nested = f"\n{nested}"
        parts.extend((nested, child.tail or ""))
    return clean_text("".join(parts))


def heuristic_html(source, final_url, output_format):
    document = parsed_html(source)
    title = fallback_title(source)
    prune_boilerplate(document)
    candidates = document.xpath("//article|//main")
    body = document.find("body")
    root = max(candidates, key=lambda node: len(node.text_content()), default=body if body is not None else document)
    lines = []
    blocks = root.xpath(".//*[self::h1 or self::h2 or self::h3 or self::h4 or self::h5 or self::h6 or self::p or self::li or self::blockquote or self::pre or self::table]")
    for node in blocks:
        tag = node.tag.lower()
        if tag == "p" and node.xpath("ancestor::li|ancestor::blockquote"):
            continue
        if tag == "table":
            rows = []
            for row in node.xpath(".//tr"):
                cells = [inline_content(cell, output_format, final_url) for cell in row.xpath("./th|./td")]
                if cells:
                    rows.append(cells)
            if rows:
                if output_format == "markdown":
                    width = max(len(row) for row in rows)
                    normalized = [row + [""] * (width - len(row)) for row in rows]
                    lines.append("| " + " | ".join(normalized[0]) + " |")
                    lines.append("| " + " | ".join("---" for _ in range(width)) + " |")
                    lines.extend("| " + " | ".join(row) + " |" for row in normalized[1:])
                else:
                    lines.extend("\t".join(row) for row in rows)
            continue
        text = inline_content(node, output_format, final_url)
        if not text:
            continue
        if tag in ("h1", "h2", "h3", "h4", "h5", "h6"):
            lines.append(f"{'#' * int(tag[1])} {text}" if output_format == "markdown" else text)
        elif tag == "li":
            lines.append(f"- {text}" if output_format == "markdown" else f"• {text}")
        elif tag == "blockquote":
            lines.append(f"> {text}" if output_format == "markdown" else text)
        elif tag == "pre":
            lines.append(f"```\n{text}\n```" if output_format == "markdown" else text)
        else:
            lines.append(text)
    content = clean_text("\n\n".join(lines))
    if not content:
        content = clean_text(root.text_content())
    return title, content


def readability_html(source, final_url, output_format):
    try:
        readable = ReadabilityDocument(source, url=final_url, min_text_length=25, retry_length=250)
        title = clean_text(readable.short_title()) or None
        summary = readable.summary(html_partial=True)
        fallback_title_value, content = heuristic_html(summary, final_url, output_format)
        return title or fallback_title_value, content
    except Exception:
        # Readability is an optional quality fallback, not a new failure mode.
        return None, ""


def extract_html(data, charset, final_url, output_format):
    source = decoded_html(data, charset)
    title, content = trafilatura_html(source, final_url, output_format)
    if meaningful_html(content):
        return title or fallback_title(source), content, "local-html"
    readability_title, readability_content = readability_html(source, final_url, output_format)
    if meaningful_html(readability_content):
        return readability_title or title or fallback_title(source), readability_content, "local-html-readability"
    heuristic_title, heuristic_content = heuristic_html(source, final_url, output_format)
    choices = [
        (content, title, "local-html"),
        (readability_content, readability_title, "local-html-readability"),
        (heuristic_content, heuristic_title, "local-html-heuristic"),
    ]
    best_content, best_title, method = max(choices, key=lambda choice: len(choice[0]))
    return best_title or fallback_title(source), best_content, method


def structured_html_signals(source):
    document = parsed_html(source)
    signals, seen = [], set()

    def add(label, value):
        if len(signals) >= 24 or isinstance(value, (dict, list, bool)) or value is None:
            return
        rendered = clean_text(unescape(str(value)))[:300]
        if not rendered:
            return
        if rendered.startswith(("http://", "https://")):
            rendered = rendered.rstrip("/").rsplit("/", 1)[-1]
        key = (label.casefold(), rendered.casefold())
        if key in seen:
            return
        seen.add(key)
        signals.append((label, rendered))

    def walk_json(value, depth=0, visited=None):
        if depth > 8 or len(signals) >= 24:
            return
        visited = visited if visited is not None else [0]
        visited[0] += 1
        if visited[0] > 2_000:
            return
        if isinstance(value, dict):
            for key, child in value.items():
                normalized = re.sub(r"[^a-z0-9]", "", str(key).lower())
                if normalized in STRUCTURED_KEYS:
                    add(STRUCTURED_KEYS[normalized], child)
                walk_json(child, depth + 1, visited)
        elif isinstance(value, list):
            for child in value[:100]:
                walk_json(child, depth + 1, visited)

    for script in document.xpath("//script[translate(@type, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')='application/ld+json']")[:20]:
        raw = script.text or ""
        if len(raw) > 100_000:
            continue
        try:
            walk_json(json.loads(raw))
        except (TypeError, ValueError):
            continue

    for node in document.xpath("//meta[@content]")[:500]:
        name = (node.get("property") or node.get("name") or "").lower()
        normalized = re.sub(r"[^a-z0-9]", "", name)
        for key, label in STRUCTURED_KEYS.items():
            if normalized.endswith(key) and any(token in name for token in ("product", "offer", "price", "article")):
                add(label, node.get("content"))
                break

    context_pattern = re.compile(r"(?:price|quote|ticker|rate|market)", re.IGNORECASE)
    value_pattern = re.compile(r"(?:\d|[$\u20ac\u00a3\u00a5])")
    for node in document.xpath("//*[@itemprop or @data-price or @data-last-price or @aria-label or @title]")[:1_000]:
        for item in (node.get("itemprop") or "").split():
            normalized = re.sub(r"[^a-z0-9]", "", item.lower())
            if normalized in STRUCTURED_KEYS:
                add(STRUCTURED_KEYS[normalized], node.get("content") or node.get("value") or node.text_content())
        for attribute, label in (("data-price", "Price"), ("data-last-price", "Price")):
            if node.get(attribute):
                add(label, node.get(attribute))
        context = " ".join((node.get("id") or "", node.get("class") or "", node.get("itemprop") or ""))
        for attribute in ("aria-label", "title"):
            value = node.get(attribute) or ""
            if value_pattern.search(value) and (context_pattern.search(value) or context_pattern.search(context)):
                add("Accessible market data", value)
    return signals


def append_structured_signals(content, signals, output_format):
    novel = []
    existing = content.casefold()
    for label, value in signals:
        if len(value) >= 3 and value.casefold() in existing:
            continue
        novel.append((label, value))
    if not novel:
        return content
    if output_format == "markdown":
        section = "## Page data\n\n" + "\n".join(f"- {label}: {value}" for label, value in novel)
    else:
        section = "Page data\n" + "\n".join(f"{label}: {value}" for label, value in novel)
    return clean_text(f"{content}\n\n{section}" if content else section)


def extract_rendered(payload):
    final_url = public_url(payload["finalUrl"])
    source = payload["html"]
    if not isinstance(source, str):
        raise WebError("web_invalid_content", "Rendered HTML must be text.")
    data = source.encode("utf-8")
    if len(data) > MAX_RENDERED_HTML:
        raise WebError("web_response_too_large", f"Rendered HTML exceeds the {MAX_RENDERED_HTML}-byte limit.")
    output_format = payload.get("format", "markdown")
    extracted_title, content, _ = extract_html(data, "utf-8", final_url, output_format)
    content = append_structured_signals(content, structured_html_signals(source), output_format)
    content = clean_text(unescape(content))
    max_chars = payload["maxChars"]
    truncated = bool(payload.get("sourceTruncated")) or len(content) > max_chars
    return {
        "url": final_url,
        "finalUrl": final_url,
        "title": clean_text(payload.get("title") or "") or extracted_title,
        "contentType": str(payload.get("contentType") or "text/html").split(";", 1)[0].lower(),
        "extractionMethod": "browser",
        "content": content[:max_chars],
        "truncated": truncated,
    }


def extract_pdf(data):
    try:
        reader = PdfReader(io.BytesIO(data), strict=False)
        title = reader.metadata.title if reader.metadata else None
        return title, clean_text("\n\n".join((page.extract_text() or "") for page in reader.pages))
    except Exception as error:
        raise WebError("web_invalid_content", f"Could not extract PDF text: {error}") from error


def extract(payload):
    final_url, content_type, charset, data = fetch(payload["url"])
    method, title = "local-text", None
    if content_type in ("text/html", "application/xhtml+xml"):
        title, content, method = extract_html(data, charset, final_url, payload.get("format", "markdown"))
    elif content_type == "application/pdf" or data.startswith(b"%PDF-"):
        title, content = extract_pdf(data)
        content_type, method = "application/pdf", "local-pdf"
    elif content_type == "application/json" or content_type.endswith("+json"):
        try:
            content = json.dumps(json.loads(data.decode(charset)), indent=2, ensure_ascii=False)
        except (ValueError, LookupError) as error:
            raise WebError("web_invalid_content", f"Invalid JSON response: {error}") from error
        method = "local-json"
    elif content_type in ("application/xml", "text/xml") or content_type.endswith("+xml"):
        try:
            content = etree.tostring(etree.fromstring(data), pretty_print=True, encoding="unicode")
        except etree.XMLSyntaxError as error:
            raise WebError("web_invalid_content", f"Invalid XML response: {error}") from error
        method = "local-xml"
    elif content_type.startswith("text/"):
        try:
            content = data.decode(charset, errors="replace")
        except LookupError as error:
            raise WebError("web_invalid_content", f"Unsupported text encoding: {charset}") from error
    else:
        raise WebError("web_unsupported_content_type", f"Unsupported content type: {content_type}")
    content = clean_text(unescape(content))
    max_chars = payload["maxChars"]
    truncated = len(content) > max_chars
    content = content[:max_chars]
    # Sparse HTML is a signal for render:auto; raw text formats are never browser-rendered.
    browser_recommended = method.startswith("local-html") and (
        len(content) < 80 or bool(re.search(r"(?:enable|requires?) javascript|javascript is disabled", content, re.IGNORECASE))
    )
    return {"url": final_url, "finalUrl": final_url, "title": title, "contentType": content_type, "extractionMethod": method, "content": content, "truncated": truncated, "browserRecommended": browser_recommended}


def search(payload):
    require_online()
    proxy = os.environ.get("QUBICL_PROXY_URL")
    last = None
    for attempt in range(2):
        try:
            rows = DDGS(proxy=proxy, timeout=TIMEOUT).text(payload["query"], max_results=payload["limit"])
            results = []
            for row in list(rows)[:payload["limit"]]:
                if not isinstance(row, dict):
                    raise WebError("web_provider_malformed", "DDGS returned a malformed result.")
                url = row.get("href") or row.get("url")
                title = row.get("title")
                if not isinstance(url, str) or not isinstance(title, str):
                    continue
                parsed = urllib.parse.urlsplit(url)
                if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username is not None or parsed.password is not None:
                    continue
                results.append({"title": title[:500], "url": url[:8192], "description": str(row.get("body") or row.get("description") or "")[:2000]})
            return {"query": payload["query"], "provider": "ddgs", "results": results}
        except WebError:
            raise
        except Exception as error:
            last = error
            message = str(error).lower()
            if "429" in message or "ratelimit" in message or "rate limit" in message:
                raise WebError("web_rate_limited", "DDGS was rate-limited by its public upstream.") from error
            if attempt == 0:
                time.sleep(0.25)
    raise WebError("web_upstream_error", f"DDGS search failed after bounded retry: {last}")


def main():
    try:
        payload = json.load(sys.stdin)
        operation = sys.argv[1]
        if operation == "search":
            result = search(payload)
        elif operation == "extract":
            result = extract(payload)
        elif operation == "extract-rendered":
            result = extract_rendered(payload)
        else:
            raise WebError("web_provider_failure", "Unknown web provider operation.")
        print(json.dumps(result, ensure_ascii=False))
    except WebError as error:
        print(json.dumps({"error": {"code": error.code, "message": str(error)}}))
        raise SystemExit(2)
    except Exception as error:
        print(json.dumps({"error": {"code": "web_provider_failure", "message": str(error)}}))
        raise SystemExit(2)


if __name__ == "__main__":
    main()
