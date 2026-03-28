/**
 * web-scraper.js — Web Scraping Module for TVMbot
 * Adds scraping capability so TVMbot can:
 *   - Scrape competitor villa listings (Airbnb, Booking.com, etc.)
 *   - Monitor pricing on competitor sites
 *   - Extract content from marketing sources
 *   - Fetch property listings from real estate sites
 *   - Scrape review data
 *   - Fetch furniture/material prices from supplier sites
 *
 * Registered as Claude tools so the bot can call them during conversations.
 * Uses cheerio for HTML parsing (lightweight, no browser needed).
 */

'use strict';

const https = require('https');
const http = require('http');
const { URL } = require('url');

// ─── HTTP FETCHER ────────────────────────────────────────────────────────────

function fetchUrl(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const { timeout = 15000, maxRedirects = 5, headers = {} } = opts;

    const parsedUrl = new URL(url);
    const protocol = parsedUrl.protocol === 'https:' ? https : http;

    const requestHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
      ...headers,
    };

    const req = protocol.get({
      hostname: parsedUrl.hostname,
      port: parsedUrl.port,
      path: parsedUrl.pathname + parsedUrl.search,
      headers: requestHeaders,
      timeout,
      rejectUnauthorized: false, // Required for scraping — we're fetching public pages, not sending credentials
    }, (res) => {
      // Handle redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && maxRedirects > 0) {
        const redirectUrl = new URL(res.headers.location, url).toString();
        return fetchUrl(redirectUrl, { ...opts, maxRedirects: maxRedirects - 1 })
          .then(resolve).catch(reject);
      }

      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
      }

      const chunks = [];
      let totalSize = 0;
      const maxSize = 2 * 1024 * 1024; // 2MB limit

      res.on('data', (chunk) => {
        totalSize += chunk.length;
        if (totalSize > maxSize) {
          req.destroy();
          reject(new Error('Response too large (>2MB)'));
          return;
        }
        chunks.push(chunk);
      });

      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf-8'),
          url: url,
        });
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
  });
}

// ─── HTML PARSER (lightweight, no cheerio dependency) ─────────────────────

function extractText(html) {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function extractLinks(html, baseUrl) {
  const links = [];
  const regex = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    try {
      const href = new URL(match[1], baseUrl).toString();
      const text = extractText(match[2]).substring(0, 100);
      links.push({ url: href, text });
    } catch (e) { /* invalid URL */ }
  }
  return links;
}

function extractMeta(html) {
  const meta = {};
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch) meta.title = extractText(titleMatch[1]).substring(0, 200);

  const metaRegex = /<meta[^>]+(?:name|property)=["']([^"']+)["'][^>]+content=["']([^"']+)["']/gi;
  let match;
  while ((match = metaRegex.exec(html)) !== null) {
    meta[match[1].toLowerCase()] = match[2].substring(0, 500);
  }
  return meta;
}

function extractImages(html, baseUrl) {
  const images = [];
  const regex = /<img[^>]+src=["']([^"']+)["'][^>]*(?:alt=["']([^"']*)["'])?/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    try {
      images.push({
        url: new URL(match[1], baseUrl).toString(),
        alt: (match[2] || '').substring(0, 100),
      });
    } catch (e) { /* invalid URL */ }
  }
  return images;
}

function extractPrices(text) {
  const prices = [];
  // Match common price formats
  const patterns = [
    /(?:IDR|Rp)\s*[\d,.]+/gi,
    /(?:USD|\$)\s*[\d,.]+/gi,
    /(?:EUR|€)\s*[\d,.]+/gi,
    /[\d,.]+\s*(?:per\s+night|\/night|\/nite)/gi,
    /[\d,.]+\s*(?:juta|ribu|rb|jt)/gi,
  ];
  for (const pattern of patterns) {
    const matches = text.match(pattern) || [];
    prices.push(...matches.map(p => p.trim()));
  }
  return [...new Set(prices)];
}

function extractStructuredData(html) {
  // Extract JSON-LD structured data
  const jsonLd = [];
  const regex = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    try {
      jsonLd.push(JSON.parse(match[1]));
    } catch (e) { /* invalid JSON */ }
  }
  return jsonLd;
}

// ─── SCRAPER FUNCTIONS (exposed as tools) ────────────────────────────────────

/**
 * Scrape a URL and return structured content
 */
async function scrapeUrl(url) {
  try {
    const result = await fetchUrl(url);
    const html = result.body;
    const text = extractText(html);
    const meta = extractMeta(html);
    const links = extractLinks(html, url);
    const images = extractImages(html, url);
    const prices = extractPrices(text);
    const structuredData = extractStructuredData(html);

    return {
      success: true,
      url: result.url,
      title: meta.title || '',
      description: meta.description || meta['og:description'] || '',
      text: text.substring(0, 5000), // Limit text to 5K chars
      links: links.slice(0, 30),
      images: images.slice(0, 20),
      prices,
      structuredData: structuredData.slice(0, 5),
      meta,
      fetchedAt: new Date().toISOString(),
    };
  } catch (e) {
    return { success: false, error: e.message, url };
  }
}

/**
 * Scrape multiple URLs
 */
async function scrapeMultiple(urls, opts = {}) {
  const { concurrency = 3 } = opts;
  const results = [];

  // Process in batches
  for (let i = 0; i < urls.length; i += concurrency) {
    const batch = urls.slice(i, i + concurrency);
    const batchResults = await Promise.allSettled(
      batch.map(url => scrapeUrl(url))
    );
    for (const result of batchResults) {
      results.push(result.status === 'fulfilled' ? result.value : { success: false, error: result.reason?.message });
    }
  }

  return results;
}

/**
 * Extract competitor pricing from a URL
 */
async function scrapePricing(url) {
  const result = await scrapeUrl(url);
  if (!result.success) return result;

  return {
    success: true,
    url: result.url,
    title: result.title,
    prices: result.prices,
    priceContext: result.text.split(/[.!?\n]/)
      .filter(sentence => /\b(price|rate|cost|per\s+night|Rp|IDR|\$|USD)/i.test(sentence))
      .slice(0, 10)
      .map(s => s.trim()),
    structuredPricing: result.structuredData.filter(d =>
      d['@type'] === 'Product' || d['@type'] === 'Offer' || d['@type'] === 'Hotel'
    ),
    fetchedAt: result.fetchedAt,
  };
}

/**
 * Scrape and extract specific content type
 */
async function scrapeAndExtract(url, extractType = 'text') {
  const result = await scrapeUrl(url);
  if (!result.success) return result;

  switch (extractType) {
    case 'text':
      return { success: true, url: result.url, title: result.title, content: result.text };
    case 'links':
      return { success: true, url: result.url, title: result.title, links: result.links };
    case 'images':
      return { success: true, url: result.url, title: result.title, images: result.images };
    case 'prices':
      return { success: true, url: result.url, title: result.title, prices: result.prices };
    case 'meta':
      return { success: true, url: result.url, title: result.title, meta: result.meta };
    default:
      return result;
  }
}

// ─── TOOL DEFINITIONS (for Claude) ──────────────────────────────────────────
// These get added to tools.js so Claude can call them

const SCRAPER_TOOLS = [
  {
    name: 'web_scrape_url',
    description: 'Scrape a webpage and extract its content (text, links, images, prices, metadata). Use for competitor research, price monitoring, content extraction from any website.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to scrape' },
        extract_type: {
          type: 'string',
          enum: ['all', 'text', 'links', 'images', 'prices', 'meta'],
          description: 'What to extract from the page. Default: all',
        },
      },
      required: ['url'],
    },
    execute: async (args) => {
      const type = args.extract_type || 'all';
      if (type === 'all') return scrapeUrl(args.url);
      return scrapeAndExtract(args.url, type);
    },
  },
  {
    name: 'web_scrape_prices',
    description: 'Scrape a webpage specifically for pricing information. Extracts prices in IDR, USD, EUR and any per-night rates. Use for competitor price monitoring.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to scrape for pricing' },
      },
      required: ['url'],
    },
    execute: async (args) => scrapePricing(args.url),
  },
  {
    name: 'web_scrape_multiple',
    description: 'Scrape multiple URLs at once (max 5). Returns structured content from each page. Use for comparing multiple competitors or gathering data from several sources.',
    input_schema: {
      type: 'object',
      properties: {
        urls: {
          type: 'array',
          items: { type: 'string' },
          maxItems: 5,
          description: 'List of URLs to scrape (max 5)',
        },
      },
      required: ['urls'],
    },
    execute: async (args) => {
      const urls = (args.urls || []).slice(0, 5);
      return scrapeMultiple(urls);
    },
  },
];

// ─── MODULE EXPORT ──────────────────────────────────────────────────────────

/**
 * executeTool — unified entry point for Ruflo pipeline integration
 * Maps tool names to scraper functions so executeScraperTool() works
 */
async function executeTool(toolName, toolInput) {
  switch (toolName) {
    case 'scrape_url':
    case 'web_scrape_url': {
      const type = toolInput.extract_type || 'all';
      if (type === 'all') return scrapeUrl(toolInput.url);
      return scrapeAndExtract(toolInput.url, type);
    }

    case 'scrape_multiple':
    case 'web_scrape_multiple': {
      const urls = (toolInput.urls || []).slice(0, 5);
      return scrapeMultiple(urls);
    }

    case 'scrape_competitor_prices':
    case 'web_scrape_prices': {
      return scrapePricing(toolInput.url);
    }

    default:
      throw new Error('Unknown scraper tool: ' + toolName);
  }
}

module.exports = {
  scrapeUrl,
  scrapeMultiple,
  scrapePricing,
  scrapeAndExtract,
  extractText,
  extractLinks,
  extractPrices,
  executeTool,
  SCRAPER_TOOLS,
};
