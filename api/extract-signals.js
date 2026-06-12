/**
 * Business Intelligence API - Extract real signals from company websites
 * 
 * Endpoint: POST /api/research-signals
 * 
 * Scrapes company websites to extract:
 * - Hiring activity
 * - New locations
 * - Product launches
 * - Events
 * - Leadership changes
 * - Awards & recognition
 */

const http = require('http');
const https = require('https');
const url = require('url');

// Signal patterns to search for
const SIGNAL_PATTERNS = {
  hiring: {
    patterns: [
      /(?:now\s+)?hiring|join\s+(?:our\s+)?team|career|open\s+position|employment|recruitment|we.?re\s+growing|apply\s+now|submit\s+(?:your\s+)?resume/gi,
      /talent\s+acquisition|internship|graduate\s+program|entry.?level\s+position|we.?re\s+hiring/gi
    ],
    type: 'Hiring Activity',
    icon: '👥'
  },
  locations: {
    patterns: [
      /new\s+(?:office|location|store|branch|warehouse|facility)|opening\s+(?:in|at)|expanded?\s+(?:to|into)|grand\s+opening|now\s+(?:open|available)\s+(?:in|at)/gi,
      /(?:now\s+serving|serving.*locations?)|additional\s+location|multiple\s+offices?|across\s+\d+\s+(?:states?|cities?|countries?)/gi
    ],
    type: 'New Locations',
    icon: '🏢'
  },
  leadership: {
    patterns: [
      /(?:announce|appoint|welcome)\s+(?:new\s+)?(?:ceo|cto|cfo|president|director|executive|founder|co-founder)|promote[ds]?\s+(?:to\s+)?(?:ceo|cto|cfo|president|director)/gi,
      /(?:joins?|named|appointed|announced)\s+as\s+(?:ceo|cto|cfo|president|director|vice\s+president|chief)/gi,
      /leadership\s+(?:change|transition|update)|executive\s+team\s+(?:expanded?|announcement)/gi
    ],
    type: 'Leadership Changes',
    icon: '👔'
  },
  products: {
    patterns: [
      /(?:announce|introduce|launch|unveil|release|introducing)\s+(?:new\s+)?(?:product|service|feature|line)|new\s+(?:offering|solution|capability|version|model)/gi,
      /available\s+now|coming\s+soon|launching\s+(?:today|this|in|q\d)|product\s+launch/gi
    ],
    type: 'Product Launches',
    icon: '🚀'
  },
  events: {
    patterns: [
      /(?:join\s+us\s+)?(?:at|for)\s+(?:our\s+)?(?:event|conference|summit|expo|trade\s+show|seminar|webinar|workshop)|(?:upcoming|annual|host(?:ing)?)\s+(?:event|conference|summit|expo|show)/gi,
      /register\s+(?:now|here)|(?:save\s+the\s+)?date|join\s+us\s+at|speaking\s+at|presenting\s+at/gi
    ],
    type: 'Events / Conferences',
    icon: '🎪'
  },
  awards: {
    patterns: [
      /(?:award|recognition|honored|named|selected)\s+(?:as|for)|(?:won|received|earned)\s+(?:an?|the)\s+award|award\s+for/gi,
      /best\s+(?:company|employer|place\s+to\s+work)|top\s+(?:\d+)?(?:companies?|employers?)|industry\s+leader|leading\s+provider/gi
    ],
    type: 'Awards / Recognition',
    icon: '🏆'
  }
};

// Helper: Fetch page with timeout
function fetchPage(urlString, timeout = 5000) {
  return new Promise((resolve) => {
    try {
      const urlObj = new url.URL(urlString);
      const protocol = urlObj.protocol === 'https:' ? https : http;

      const options = {
        hostname: urlObj.hostname,
        path: urlObj.pathname + urlObj.search,
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0'
        },
        timeout
      };

      const req = protocol.request(options, (res) => {
        let data = '';
        const chunks = [];
        
        res.on('data', chunk => {
          chunks.push(chunk);
          data += chunk;
        });
        
        res.on('end', () => {
          // Limit to first 500KB to avoid huge pages
          if (data.length > 500000) data = data.substring(0, 500000);
          resolve({ status: res.statusCode, html: data });
        });
      });

      req.on('error', () => resolve({ status: 0, html: '' }));
      req.on('timeout', () => {
        req.destroy();
        resolve({ status: 0, html: '' });
      });
      
      req.end();
    } catch (e) {
      resolve({ status: 0, html: '' });
    }
  });
}

// Helper: Extract clean text from HTML
function extractText(html) {
  if (!html) return '';
  
  // Remove script and style tags
  html = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
  html = html.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '');
  html = html.replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, '');
  
  // Remove HTML tags
  html = html.replace(/<[^>]+>/g, ' ');
  
  // Decode entities
  html = html.replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&[a-z]+;/g, ' ');
  
  // Clean whitespace
  html = html.replace(/\s+/g, ' ').trim();
  
  return html;
}

// Helper: Generate possible company domains
function guessCompanyDomains(companyName) {
  const cleaned = companyName
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .split(/[\s-]+/)
    .filter(w => w.length > 0)
    .slice(0, 3)
    .join('');
  
  if (!cleaned) return [];
  
  const extensions = ['com', 'io', 'co', 'net', 'org'];
  const domains = extensions.map(ext => `https://www.${cleaned}.${ext}`);
  
  // Also try without www
  domains.push(...extensions.map(ext => `https://${cleaned}.${ext}`));
  
  return [...new Set(domains)];
}

// Helper: Extract signals from text
function extractSignals(text, sourceUrl, sourceType, pageTitle) {
  const signals = [];
  const textLower = text.substring(0, 100000); // Limit text size for processing
  
  for (const [signalKey, config] of Object.entries(SIGNAL_PATTERNS)) {
    for (const pattern of config.patterns) {
      // Test if pattern matches
      const testMatch = pattern.test(textLower);
      pattern.lastIndex = 0; // Reset regex state
      
      if (testMatch) {
        // Find snippet containing the match
        const match = textLower.match(pattern);
        if (!match) continue;
        
        // Get surrounding context (150 chars before and after)
        const matchIndex = textLower.indexOf(match[0]);
        const start = Math.max(0, matchIndex - 75);
        const end = Math.min(textLower.length, matchIndex + match[0].length + 75);
        const snippet = textLower.substring(start, end).trim();
        
        if (snippet.length > 10) {
          signals.push({
            type: config.type,
            icon: config.icon,
            title: snippet.length > 120 ? snippet.substring(0, 120) + '...' : snippet,
            sourceUrl,
            sourceType,
            confidence: 0.75,
            dateFound: new Date().toISOString().split('T')[0]
          });
          // Only one signal per pattern per source
          break;
        }
      }
    }
  }
  
  return signals;
}

// Helper: Calculate Business Intelligence Score
function calculateBIScore(signals) {
  if (!signals || signals.length === 0) return 0;
  
  let score = 0;
  
  // Signal count (0-30 points)
  score += Math.min(30, signals.length * 10);
  
  // Signal recency (0-40 points)
  const now = new Date();
  const avgAge = signals.reduce((sum, s) => {
    const date = new Date(s.dateFound);
    const ageMs = now - date;
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    return sum + ageDays;
  }, 0) / signals.length;
  
  if (avgAge <= 7) score += 40;
  else if (avgAge <= 30) score += 32;
  else if (avgAge <= 90) score += 24;
  else if (avgAge <= 180) score += 12;
  else score += 5;
  
  // Signal diversity (0-30 points)
  const uniqueTypes = new Set(signals.map(s => s.type)).size;
  score += Math.min(30, uniqueTypes * 5);
  
  return Math.min(100, Math.round(score));
}

// Main extraction function
async function extractRealSignals(companyName) {
  const signals = [];
  const visited = new Set();
  
  // Step 1: Identify website
  const possibleDomains = guessCompanyDomains(companyName);
  let primaryDomain = null;
  
  for (const domain of possibleDomains) {
    const result = await fetchPage(domain, 3000);
    if (result.status === 200) {
      primaryDomain = domain;
      break;
    }
  }
  
  if (!primaryDomain) {
    return {
      signals: [],
      biScore: 0,
      status: 'no_website',
      message: 'Could not identify company website'
    };
  }
  
  // Step 2: Scrape key pages
  const pagePaths = [
    { path: '/careers', type: 'Careers' },
    { path: '/careers/', type: 'Careers' },
    { path: '/about', type: 'About' },
    { path: '/about/', type: 'About' },
    { path: '/about-us', type: 'About' },
    { path: '/news', type: 'News' },
    { path: '/news/', type: 'News' },
    { path: '/press', type: 'Press' },
    { path: '/press/', type: 'Press' },
    { path: '/press-releases', type: 'Press' },
    { path: '/newsroom', type: 'News' },
    { path: '/blog', type: 'Blog' },
    { path: '/blog/', type: 'Blog' },
    { path: '/events', type: 'Events' },
    { path: '/events/', type: 'Events' },
    { path: '/', type: 'Home' }
  ];
  
  for (const page of pagePaths) {
    const fullUrl = primaryDomain + page.path;
    
    if (visited.has(fullUrl)) continue;
    visited.add(fullUrl);
    
    const result = await fetchPage(fullUrl, 4000);
    if (result.status === 200) {
      const text = extractText(result.html);
      const pageSignals = extractSignals(text, fullUrl, page.type, companyName);
      signals.push(...pageSignals);
    }
  }
  
  // Step 3: Deduplicate signals (keep best from each type)
  const uniqueSignals = {};
  for (const signal of signals) {
    if (!uniqueSignals[signal.type]) {
      uniqueSignals[signal.type] = signal;
    } else if (signal.confidence > uniqueSignals[signal.type].confidence) {
      uniqueSignals[signal.type] = signal;
    }
  }
  
  const finalSignals = Object.values(uniqueSignals);
  const biScore = calculateBIScore(finalSignals);
  
  return {
    signals: finalSignals,
    biScore,
    status: finalSignals.length > 0 ? 'success' : 'no_signals',
    message: finalSignals.length > 0 ? `Found ${finalSignals.length} signals` : 'No recent business signals found',
    website: primaryDomain,
    sourceCount: visited.size
  };
}

// Export for use
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { extractRealSignals };
}
