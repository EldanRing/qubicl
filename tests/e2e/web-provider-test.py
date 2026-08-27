#!/usr/bin/env python3
"""Deterministic tests for the Python provider inside a built Qubicl image."""

import email.message
import gzip
import importlib.util
import io
import json
import socket
import unittest
import urllib.error
import urllib.request
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location("qubicl_web_provider", "/opt/qubicl/web-provider.py")
web = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(web)


class Headers(email.message.Message):
    def get_content_type(self):
        return self.get("content-type", "application/octet-stream").split(";", 1)[0]

    def get_content_charset(self):
        value = self.get("content-type", "")
        return value.split("charset=", 1)[1] if "charset=" in value else None


class Response:
    def __init__(self, body, content_type="text/plain", encoding=""):
        self.body = io.BytesIO(body)
        self.headers = Headers()
        self.headers["content-type"] = content_type
        if encoding:
            self.headers["content-encoding"] = encoding

    def read(self, size=-1):
        return self.body.read(size)


class ProviderTests(unittest.TestCase):
    def test_public_url_rejects_credentials_and_every_non_public_class(self):
        with patch.object(web.socket, "getaddrinfo", return_value=[(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 443))]):
            self.assertEqual(web.public_url("https://example.com/path"), "https://example.com/path")
            with self.assertRaisesRegex(web.WebError, "credentials"):
                web.public_url("https://user:secret@example.com/")
        for address in ("127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.0.1", "169.254.169.254", "100.64.0.1", "::1", "fe80::1", "fd00::1", "2001:db8::1"):
            family = socket.AF_INET6 if ":" in address else socket.AF_INET
            answer = (family, socket.SOCK_STREAM, 6, "", (address, 443, 0, 0) if family == socket.AF_INET6 else (address, 443))
            with patch.object(web.socket, "getaddrinfo", return_value=[answer]):
                with self.assertRaisesRegex(web.WebError, "non-public"):
                    web.public_url("https://example.com/")
        answers = [
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 443)),
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 443)),
        ]
        with patch.object(web.socket, "getaddrinfo", return_value=answers):
            with self.assertRaisesRegex(web.WebError, "non-public"):
                web.public_url("https://example.com/")

    def test_redirects_are_revalidated_and_bounded(self):
        handler = web.ValidatingRedirect()
        request = urllib.request.Request("https://example.com/start")
        headers = Headers()
        with patch.object(web, "public_url", side_effect=lambda value: value) as validate:
            for index in range(web.MAX_REDIRECTS):
                result = handler.redirect_request(request, None, 302, "Found", headers, f"https://example.com/{index}")
                self.assertIsInstance(result, urllib.request.Request)
            with self.assertRaisesRegex(web.WebError, "at most"):
                handler.redirect_request(request, None, 302, "Found", headers, "https://example.com/overflow")
            self.assertEqual(validate.call_count, web.MAX_REDIRECTS)
        handler = web.ValidatingRedirect()
        with patch.object(web.socket, "getaddrinfo", return_value=[(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 80))]):
            with self.assertRaisesRegex(web.WebError, "non-public"):
                handler.redirect_request(request, None, 302, "Found", headers, "http://localhost/private")

    def test_restricted_proxy_is_the_authoritative_dns_policy_boundary(self):
        with patch.dict(web.os.environ, {"QUBICL_PROXY_URL": "http://proxy.invalid:3128"}, clear=False), patch.object(
            web.socket, "getaddrinfo", side_effect=AssertionError("the internal-only worker must not resolve public DNS")
        ):
            self.assertEqual(web.public_url("https://example.com/path"), "https://example.com/path")
            with self.assertRaisesRegex(web.WebError, "credentials"):
                web.public_url("https://user:secret@example.com/")
            with self.assertRaisesRegex(web.WebError, "HTTP and HTTPS"):
                web.public_url("file:///etc/passwd")

    def test_trafilatura_extracts_structured_article_without_page_boilerplate(self):
        html_bytes = b"""<!doctype html><html><head><title>Site - Useful report</title><meta property="og:title" content="Useful report"></head><body>
        <header>Daily Site Subscribe Sign in</header><nav>Home News Sports Weather</nav>
        <div class="cookie consent">Accept cookies Manage preferences</div><main><article>
        <h1>Useful report</h1><p>The primary article explains a carefully researched subject with enough concrete detail to be useful to readers.</p>
        <h2>Evidence</h2><p>Researchers independently confirmed the central result and published the supporting measurements for review.</p>
        <ul><li>First verified finding</li><li>Second verified finding</li></ul>
        <p>Read the <a href="/source">original source</a> for the full methodology.</p>
        <table><tr><th>Measure</th><th>Value</th></tr><tr><td>Accuracy</td><td>98%</td></tr></table>
        </article><aside>Related story Promotional link</aside></main><footer>Privacy Contact Copyright</footer>
        <script>trackingCode()</script></body></html>"""
        title, markdown, method = web.extract_html(html_bytes, "utf-8", "https://example.com/report", "markdown")
        self.assertIn("Useful report", title)
        self.assertEqual(method, "local-html")
        self.assertIn("# Useful report", markdown)
        self.assertIn("carefully researched subject", markdown)
        self.assertIn("[original source](https://example.com/source)", markdown)
        self.assertIn("| Measure | Value |", markdown)
        for noise in ("Subscribe", "Accept cookies", "Related story", "Privacy Contact", "trackingCode"):
            self.assertNotIn(noise, markdown)

        _, plain, plain_method = web.extract_html(html_bytes, "utf-8", "https://example.com/report", "text")
        self.assertEqual(plain_method, "local-html")
        self.assertIn("Useful report", plain)
        self.assertIn("original source", plain)
        self.assertNotIn("[original source]", plain)
        self.assertNotRegex(plain, r"^#|\|---", msg=plain)

    def test_readability_fallback_runs_only_when_trafilatura_is_not_meaningful(self):
        messy = b"""<html><head><title>Fallback story - Example</title></head><body>
        <nav>Home Topics Login</nav><div class="advertisement">Buy this product now</div>
        <div id="article"><h1>Fallback story</h1>
        <p>This fallback article contains the important opening paragraph and enough detail to identify it as meaningful content.</p>
        <p>The second paragraph gives readers additional evidence, context, and a clear conclusion about the reported event.</p></div>
        <section class="related"><a href="/other">Ten unrelated stories</a></section>
        <div class="cookie-banner">Accept every cookie</div><footer>Terms Privacy Contact</footer></body></html>"""
        with patch.object(web, "trafilatura_extract", return_value=None):
            title, content, method = web.extract_html(messy, "utf-8", "https://example.com/fallback", "markdown")
        self.assertEqual(method, "local-html-readability")
        self.assertIn("important opening paragraph", content)
        self.assertIn("additional evidence", content)
        for noise in ("Buy this product", "unrelated stories", "Accept every cookie", "Terms Privacy"):
            self.assertNotIn(noise, content)

    def test_rendered_html_reuses_article_extraction_and_recovers_page_data(self):
        rendered = """<!doctype html><html><head><title>Rendered market</title>
        <script type="application/ld+json">{"@type":"Product","offers":{"price":"187.42","priceCurrency":"USD","availability":"https://schema.org/InStock"}}</script>
        </head><body><nav>Markets Login Subscribe</nav><main><article>
        <h1>Rendered market report</h1>
        <p>The client-rendered article now contains the complete analysis after its JavaScript application finished loading.</p>
        <p>Analysts explain the market movement with enough detail for the primary extractor to identify this as meaningful content.</p>
        <table><tr><th>Session</th><th>Direction</th></tr><tr><td>Close</td><td>Higher</td></tr></table>
        </article><div class="ticker" data-price="187.42" aria-label="Gold price 187.42 USD"></div>
        <footer>Privacy Contact Related stories</footer></main></body></html>"""
        payload = {
            "finalUrl": "https://example.com/market",
            "title": "Rendered market",
            "contentType": "text/html; charset=utf-8",
            "html": rendered,
            "sourceTruncated": False,
            "format": "markdown",
            "maxChars": 10_000,
        }
        with patch.object(web, "public_url", side_effect=lambda value: value):
            result = web.extract_rendered(payload)
        self.assertEqual(result["extractionMethod"], "browser")
        self.assertEqual(result["title"], "Rendered market")
        self.assertEqual(result["contentType"], "text/html")
        self.assertIn("Rendered market report", result["content"])
        self.assertIn("| Session | Direction |", result["content"])
        self.assertIn("## Page data", result["content"])
        self.assertIn("Price: 187.42", result["content"])
        self.assertIn("Price currency: USD", result["content"])
        self.assertNotIn("Markets Login", result["content"])
        self.assertNotIn("Privacy Contact", result["content"])
        self.assertFalse(result["truncated"])

        payload["sourceTruncated"] = True
        payload["format"] = "text"
        with patch.object(web, "public_url", side_effect=lambda value: value):
            plain = web.extract_rendered(payload)
        self.assertTrue(plain["truncated"])
        self.assertIn("Page data", plain["content"])
        self.assertNotIn("## Page data", plain["content"])

        prior_limit = web.MAX_RENDERED_HTML
        try:
            web.MAX_RENDERED_HTML = 100
            with patch.object(web, "public_url", side_effect=lambda value: value), self.assertRaisesRegex(web.WebError, "Rendered HTML exceeds"):
                web.extract_rendered(payload)
        finally:
            web.MAX_RENDERED_HTML = prior_limit

    def test_local_non_html_formats_remain_direct(self):
        html_bytes = b"<html><head><title>Useful</title></head><body><article><h1>Heading</h1><p>Meaningful article body contains enough words and visible detail for reliable extraction without requiring browser rendering at all.</p></article></body></html>"
        fixtures = [
            (("https://example.com/a", "text/html", "utf-8", html_bytes), "local-html", "Meaningful article body"),
            (("https://example.com/a", "text/plain", "utf-8", b"plain content"), "local-text", "plain content"),
            (("https://example.com/a", "application/json", "utf-8", b'{"ok":true}'), "local-json", '"ok": true'),
            (("https://example.com/a", "application/xml", "utf-8", b"<root><item>yes</item></root>"), "local-xml", "<item>yes</item>"),
        ]
        for fetched, method, expected in fixtures:
            with self.subTest(method=method), patch.object(web, "fetch", return_value=fetched):
                result = web.extract({"url": "https://example.com/a", "format": "markdown", "maxChars": 10_000})
                if method == "local-html":
                    self.assertTrue(result["extractionMethod"].startswith("local-html"))
                else:
                    self.assertEqual(result["extractionMethod"], method)
                self.assertIn(expected, result["content"])
                self.assertFalse(result["truncated"])

    def test_pdf_text_path_and_invalid_mime(self):
        writer = web.PdfReader  # prove the installed PDF dependency is the one imported by the provider
        self.assertTrue(callable(writer))
        from pypdf import PdfWriter
        stream = io.BytesIO()
        pdf = PdfWriter()
        pdf.add_blank_page(width=72, height=72)
        pdf.add_metadata({"/Title": "Bounded PDF"})
        pdf.write(stream)
        with patch.object(web, "fetch", return_value=("https://example.com/a.pdf", "application/pdf", "utf-8", stream.getvalue())):
            result = web.extract({"url": "https://example.com/a.pdf", "format": "text", "maxChars": 1000})
        self.assertEqual(result["extractionMethod"], "local-pdf")
        self.assertEqual(result["title"], "Bounded PDF")
        with patch.object(web, "fetch", return_value=("https://example.com/a.png", "image/png", "utf-8", b"not executable")):
            with self.assertRaisesRegex(web.WebError, "Unsupported content type"):
                web.extract({"url": "https://example.com/a.png", "format": "text", "maxChars": 1000})

    def test_download_decompression_and_output_limits(self):
        prior_download, prior_decompressed = web.MAX_DOWNLOAD, web.MAX_DECOMPRESSED
        try:
            web.MAX_DOWNLOAD = 32
            with self.assertRaisesRegex(web.WebError, "download limit"):
                web.read_bounded(Response(b"x" * 33))
            web.MAX_DOWNLOAD = 10_000
            web.MAX_DECOMPRESSED = 64
            with self.assertRaisesRegex(web.WebError, "Decompressed response"):
                web.read_bounded(Response(gzip.compress(b"x" * 1000), encoding="gzip"))
            with patch.object(web, "fetch", return_value=("https://example.com/a", "text/plain", "utf-8", b"abcdefghij")):
                result = web.extract({"url": "https://example.com/a", "format": "text", "maxChars": 5})
            self.assertEqual(result["content"], "abcde")
            self.assertTrue(result["truncated"])
        finally:
            web.MAX_DOWNLOAD, web.MAX_DECOMPRESSED = prior_download, prior_decompressed

    def test_timeout_rate_limit_offline_and_search_normalization(self):
        class TimeoutOpener:
            def open(self, *args, **kwargs):
                raise socket.timeout("late")
        with patch.object(web, "public_url", side_effect=lambda value: value), patch.object(web.urllib.request, "build_opener", return_value=TimeoutOpener()):
            with self.assertRaisesRegex(web.WebError, "timed out"):
                web.fetch("https://example.com/")
        with patch.dict(web.os.environ, {"QUBICL_NETWORK_POLICY": json.dumps({"profile": "offline"})}, clear=False):
            with self.assertRaisesRegex(web.WebError, "offline"):
                web.search({"query": "blocked", "limit": 1})

        class GoodDDGS:
            def __init__(self, **kwargs):
                pass
            def text(self, query, max_results):
                return [{"title": "Title", "href": "https://example.com", "body": "Snippet"}, "malformed"]
        with patch.object(web, "DDGS", GoodDDGS):
            with self.assertRaisesRegex(web.WebError, "malformed"):
                web.search({"query": "query", "limit": 2})
        class NormalDDGS(GoodDDGS):
            def text(self, query, max_results):
                return [{"title": "Title", "href": "https://example.com", "body": "Snippet"}]
        with patch.object(web, "DDGS", NormalDDGS):
            result = web.search({"query": "query", "limit": 1})
        self.assertEqual(result, {"query": "query", "provider": "ddgs", "results": [{"title": "Title", "url": "https://example.com", "description": "Snippet"}]})
        class LimitedDDGS(GoodDDGS):
            def text(self, query, max_results):
                raise RuntimeError("HTTP 429 rate limit")
        with patch.object(web, "DDGS", LimitedDDGS):
            with self.assertRaisesRegex(web.WebError, "rate-limited"):
                web.search({"query": "query", "limit": 1})


if __name__ == "__main__":
    unittest.main(verbosity=2)
