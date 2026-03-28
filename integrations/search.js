// /root/claude-chatbot/integrations/search.js
const https = require('https');
const http = require('http');

async function webSearch(query, numResults = 5) {
  return new Promise((resolve, reject) => {
    // Use DuckDuckGo HTML search (no API key needed)
    const searchQuery = encodeURIComponent(query);
    const options = {
      hostname: 'html.duckduckgo.com',
      path: `/html/?q=${searchQuery}`,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; TVMbot/1.0)',
        'Accept': 'text/html'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          // Parse results from HTML
          const results = [];
          const blocks = data.split('class="result results_links');
          for (let i = 1; i < blocks.length && results.length < numResults; i++) {
            const block = blocks[i];
            const titleMatch = block.match(/class="result__a"[^>]*>([^<]+)<\/a>/);
            const urlMatch = block.match(/href="([^"]+)"[^>]*class="result__a"/);
            const snippetMatch = block.match(/class="result__snippet"[^>]*>([^<]+)/);
            
            if (titleMatch) {
              results.push({
                title: titleMatch[1].trim(),
                url: urlMatch ? urlMatch[1].replace('//duckduckgo.com/l/?uddg=', '').split('&')[0] : '',
                snippet: snippetMatch ? snippetMatch[1].trim() : ''
              });
            }
          }
          
          if (results.length === 0) {
            // Fallback: extract any links
            const anyLink = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([^<]+)<\/a>/g;
            let m;
            while ((m = anyLink.exec(data)) !== null && results.length < numResults) {
              if (!m[1].includes('duckduckgo.com')) {
                results.push({ title: m[2].trim(), url: m[1], snippet: '' });
              }
            }
          }
          
          resolve({ success: true, query, results });
        } catch (e) {
          resolve({ success: false, error: e.message, raw: data.substring(0, 500) });
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Search timeout')); });
    req.end();
  });
}

async function fetchWebpage(url, maxLength = 5000) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const lib = urlObj.protocol === 'https:' ? https : http;
    
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; TVMbot/1.0)',
        'Accept': 'text/html,text/plain,application/json'
      }
    };

    const req = lib.request(options, (res) => {
      // Handle redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchWebpage(res.headers.location, maxLength).then(resolve).catch(reject);
      }
      
      let data = '';
      res.on('data', chunk => { 
        data += chunk;
        if (data.length > maxLength * 3) req.destroy(); // Stop after getting enough
      });
      res.on('end', () => {
        // Strip HTML tags for readability
        let text = data
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        
        if (text.length > maxLength) {
          text = text.substring(0, maxLength) + '... [truncated]';
        }
        
        resolve({ 
          success: true, 
          url, 
          statusCode: res.statusCode,
          contentType: res.headers['content-type'] || 'unknown',
          text,
          length: text.length
        });
      });
    });

    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('Fetch timeout')); });
    req.end();
  });
}

module.exports = { webSearch, fetchWebpage };
