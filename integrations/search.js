// integrations/search.js — Robust Web Search
// Strategy: DuckDuckGo Instant Answer API (free, JSON) → DDG HTML fallback → Brave if key set
'use strict';
const https = require('https');
const http  = require('http');

function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get({
      hostname: u.hostname, path: u.pathname + u.search,
      headers: { 'User-Agent': 'Mozilla/5.0 TVMbot/2.0', 'Accept': 'application/json,text/html', ...headers }
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpGet(res.headers.location, headers).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', c => { data += c; if (data.length > 500000) req.destroy(); });
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ── 1. Brave Search (best — if API key set) ──────────────────────────────────
async function braveSearch(query, n = 8) {
  const key = process.env.BRAVE_SEARCH_API_KEY;
  if (!key) return null;
  try {
    const res = await httpGet(
      `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${n}`,
      { 'Accept': 'application/json', 'Accept-Encoding': 'gzip', 'X-Subscription-Token': key }
    );
    const d = JSON.parse(res.body);
    const results = (d.web?.results || []).map(r => ({ title: r.title, url: r.url, snippet: r.description || '' }));
    return { success: true, query, source: 'brave', results };
  } catch(e) { return null; }
}

// ── 2. DuckDuckGo Instant Answer API (JSON, free, no scraping) ───────────────
async function ddgInstantAnswer(query) {
  try {
    const res = await httpGet(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`);
    const d = JSON.parse(res.body);
    const results = [];
    if (d.AbstractText) results.push({ title: d.Heading || query, url: d.AbstractURL || '', snippet: d.AbstractText });
    (d.RelatedTopics || []).slice(0, 6).forEach(t => {
      if (t.Text && t.FirstURL) results.push({ title: t.Text.split(' - ')[0], url: t.FirstURL, snippet: t.Text });
    });
    if (results.length > 0) return { success: true, query, source: 'ddg_instant', results };
    return null;
  } catch(e) { return null; }
}

// ── 3. DuckDuckGo HTML fallback (improved parsing) ───────────────────────────
async function ddgHtml(query, n = 8) {
  try {
    const res = await httpGet(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`);
    const html = res.body;
    const results = [];
    // Multiple regex patterns to handle DDG HTML variations
    const patterns = [
      /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/g,
      /<h2[^>]*class="result__title"[^>]*>.*?<a[^>]+href="([^"]+)"[^>]*>([^<]+)<\/a>/gs,
    ];
    for (const pattern of patterns) {
      let m;
      while ((m = pattern.exec(html)) !== null && results.length < n) {
        let url = m[1], title = m[2].trim();
        // Decode DDG redirect URLs
        if (url.includes('uddg=')) url = decodeURIComponent(url.split('uddg=')[1].split('&')[0]);
        if (!url.startsWith('http') || url.includes('duckduckgo.com')) continue;
        // Get snippet
        const after = html.slice(m.index, m.index + 600);
        const snip = (after.match(/class="result__snippet"[^>]*>([^<]{10,200})/) || [])[1] || '';
        results.push({ title, url, snippet: snip.trim() });
      }
      if (results.length >= 3) break;
    }
    if (results.length > 0) return { success: true, query, source: 'ddg_html', results };
    return null;
  } catch(e) { return null; }
}

// ── Main webSearch function ───────────────────────────────────────────────────
async function webSearch(query, numResults = 8) {
  // Try each source in order of reliability
  const brave = await braveSearch(query, numResults);
  if (brave) return brave;

  const instant = await ddgInstantAnswer(query);
  if (instant && instant.results.length >= 3) return instant;

  const html = await ddgHtml(query, numResults);
  if (html) return html;

  // Last resort: combine what we have
  const combined = [...(instant?.results || []), ...(html?.results || [])];
  if (combined.length > 0) return { success: true, query, source: 'combined', results: combined.slice(0, numResults) };

  return { success: false, query, error: 'All search methods failed', results: [] };
}

// ── Fetch webpage (improved: strips scripts/styles, handles encoding) ─────────
async function fetchWebpage(url, maxLength = 8000) {
  try {
    const res = await httpGet(url);
    let text = res.body
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
      .replace(/<nav[\s\S]*?<\/nav>/gi, '')
      .replace(/<footer[\s\S]*?<\/footer>/gi, '')
      .replace(/<header[\s\S]*?<\/header>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
      .replace(/\s{2,}/g, ' ').trim();
    if (text.length > maxLength) text = text.substring(0, maxLength) + '... [truncated]';
    return { success: true, url, statusCode: res.status, text, length: text.length };
  } catch(e) {
    return { success: false, url, error: e.message };
  }
}

module.exports = { webSearch, fetchWebpage };
