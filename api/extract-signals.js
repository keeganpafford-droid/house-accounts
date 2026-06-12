/**
 * Business Signals v2 - Extract real signals from company websites
 * 
 * Attempts to:
 * 1. Identify company website from company name
 * 2. Scrape careers, about, news, and press pages
 * 3. Extract hiring, location, leadership, product, event, and award signals
 * 4. Calculate Business Intelligence Score
 */

const http = require('http');
const https = require('https');
const url = require('url');

// Signal patterns to search for
const SIGNAL_PATTERNS = {
  hiring: {
    patterns: [
      /(?:now\s+)?hiring|join\s+(?:our\s+)?team|career|open\s+position|employment|recruitment|we.?re\s+growing/gi,
      /apply\s+(?:now|here)|submit\s+(?:your\s+)?resume|send\s+us\s+your|talent|internship|graduate|entry.?level/gi
    ],
    type: 'Hiring Activity',
    icon: '👥',
    products: ['Onboarding Kits', 'Team Apparel', 'Welcome Packages']
  },
  locations: {
    patterns: [
      /new\s+(?:office|location|store|branch|warehouse|facility)|opening\s+(?:in|at)|expanded?\s+(?:to|into)|grand\s+opening|now\s+(?:open|available)\s+(?:in|at)/gi,
      /(?:now\s+serving|serving.*locations?)|additional\s+location|multiple\s+offices?|across\s+\d+\s+(?:states?|cities?|countries?)/gi
    ],
    type: 'New Locations',
    icon: '🏢',
    products: ['Grand Opening Kits', 'Location Apparel', 'Employee Welcome Kits']
  },
  leadership: {
    patterns: [
      /(?:announce|appoint|welcome)\s+(?:new\s+)?(?:ceo|cto|cfo|president|director|executive|founder|co-founder)/gi,
      /(?:joins?|named|announced)\s+as\s+(?:ceo|cto|cfo|president|director|vice\s+president|chief|head\s+of)/gi,
      /promotion|leadership\s+transition|executive\s+team\s+expanded?/gi
    ],
    type: 'Leadership Changes',
    icon: '👔',
    products: ['Executive Gifts', 'Leadership Programs', 'Strategic Partnerships']
  },
  products: {
    patterns: [
      /(?:announce|introduce|launch|unveil|release)\s+(?:new\s+)?(?:product|service|feature|line)/gi,
      /new\s+(?:offering|solution|capability|version|model)/gi,
      /available\s+now|coming\s+soon|alpha|beta|launch/gi
    ],
    type: 'Product Launches',
    icon: '🚀',
    products: ['Launch Merchandise', 'Customer Giveaways', 'Campaign Bundles']
  },
  events: {
    patterns: [
      /(?:join\s+us\s+)?(?:at|for)\s+(?:our\s+)?(?:event|conference|summit|expo|trade\s+show|seminar|webinar|workshop)/gi,
      /(?:upcoming|annual|host(?:ing)?)\s+(?:event|conference|summit|expo|show)/gi,
      /register\s+(?:now|here)|(?:save\s+the\s+)?date/gi
    ],
    type: 'Events / Conferences',
    icon: '🎪',
    products: ['Booth Giveaways', 'Attendee Kits', 'Event Signage']
  },
  awards: {
    patterns: [
      /(?:award|recognition|honored|named|selected)\s+(?:as|for)|(?:won|received|earned)\s+(?:an?|the)\s+award/gi,
      /best\s+(?:company|employer|place\s+to\s+work)|top\s+(?:\d+)?(?:companies?|employers?)/gi,
      /(?:industry|market)\s+leader|leading\s+provider/gi
    ],
    type: 'Awards / Recognition',
    icon: '🏆',
    products: ['Recognition Programs', 'Achievement Bundles', 'Employee Celebration Kits']
  }
};

// Helper: Fetch page content
async function fetchPage(urlString, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const urlObj = new url.URL(urlString);
    const protocol = urlObj.protocol === 'https:' ? https : http;

    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      timeout
    };

    const req = protocol.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, html: data }));
    });

    req.on('error', () => reject(new Error('Fetch failed')));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Timeout'));
    });
    req.end();
  });
}

// Helper: Extract text from HTML
function extractText(html) {
  // Remove script and style tags
  html = html.replace(/<script[^>]*>.*?<\/script>/gi, '');
  html = html.replace(/<style[^>]*>.*?<\/style>/gi, '');
  // Remove HTML tags
  html = html.replace(/<[^>]+>/g, ' ');
  // Decode entities and clean whitespace
  html = html.replace(/&nbsp;/g, ' ').replace(/&[a-z]+;/g, ' ');
  html = html.replace(/\s+/g, ' ').trim();
  return html;
}

// Helper: Generate likely company domain
function guessCompanyDomain(companyName) {
  const cleaned = companyName
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .trim()
    .split(/\s+/)
    .slice(0, 3)
    .join('');
  
  const common = ['com', 'io', 'co'];
  return common.map(ext => `https://www.${cleaned}.${ext}`);
}

// Helper: Extract signals from text
function extractSignals(text, sourceUrl, sourceType, foundDate) {
  const signals = [];
  
  for (const [signalKey, config] of Object.entries(SIGNAL_PATTERNS)) {
    for (const pattern of config.patterns) {
      const matches = text.match(pattern);
      if (matches) {
        // Find the sentence containing the match
        const sentenceRegex = /[^.!?]*[.!?]+/g;
        const sentences = text.match(sentenceRegex) || [];
        let signalTitle = '';
        
        for (const sentence of sentences) {
          if (pattern.test(sentence)) {
            signalTitle = sentence.trim().substring(0, 150);
            break;
          }
        }
        
        if (signalTitle) {
          signals.push({
            type: config.type,
            title: signalTitle,
            sourceUrl,
            sourceType,
            confidence: 0.7,
            dateFound: foundDate,
            icon: config.icon,
            products: config.products
          });
          // Only extract one signal per pattern per source
          break;
        }
      }
    }
  }
  
  return signals;
}

// Helper: Calculate Business Intelligence Score
function calculateBIScore(signals) {
  if (signals.length === 0) return 0;
  
  const now = new Date();
  let score = 0;
  
  // Score based on signal count (0-30 points)
  score += Math.min(30, signals.length * 5);
  
  // Score based on recency (0-40 points)
  const avgAgeInDays = signals.reduce((sum, s) => {
    const age = (now - new Date(s.dateFound)) / (1000 * 60 * 60 * 24);
    return sum + age;
  }, 0) / signals.length;
  
  if (avgAgeInDays <= 7) score += 40;
  else if (avgAgeInDays <= 30) score += 35;
  else if (avgAgeInDays <= 90) score += 25;
  else if (avgAgeInDays <= 180) score += 15;
  else score += 5;
  
  // Score based on signal quality/diversity (0-30 points)
  const uniqueTypes = new Set(signals.map(s => s.type)).size;
  score += Math.min(30, uniqueTypes * 5);
  
  // Score based on confidence scores (0 already factored)
  const avgConfidence = signals.reduce((sum, s) => sum + (s.confidence || 0.7), 0) / signals.length;
  score = Math.round(score * avgConfidence);
  
  return Math.min(100, score);
}

// Main: Extract signals from company
async function extractSignalsFromCompany(companyName) {
  const signals = [];
  const visited = new Set();
  const foundDate = new Date().toISOString().split('T')[0];
  
  // Guess domain
  const possibleDomains = guessCompanyDomain(companyName);
  let primaryDomain = null;
  
  for (const domain of possibleDomains) {
    try {
      const result = await fetchPage(domain, 3000);
      if (result.status === 200) {
        primaryDomain = domain;
        break;
      }
    } catch (e) {
      // Try next domain
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
  
  // Pages to scrape
  const pagesToScrape = [
    { path: '/careers', type: 'Careers' },
    { path: '/about', type: 'About' },
    { path: '/news', type: 'News' },
    { path: '/press', type: 'Press' },
    { path: '/blog', type: 'Blog' },
    { path: '/events', type: 'Events' }
  ];
  
  // Try different variations
  const urlVariations = [
    ...pagesToScrape,
    { path: '/about-us', type: 'About' },
    { path: '/press-releases', type: 'Press' },
    { path: '/newsroom', type: 'News' },
    { path: '/careers-jobs', type: 'Careers' },
    { path: '/join-us', type: 'Careers' }
  ];
  
  for (const page of urlVariations) {
    const fullUrl = `${primaryDomain}${page.path}`;
    
    if (visited.has(fullUrl)) continue;
    visited.add(fullUrl);
    
    try {
      const result = await fetchPage(fullUrl, 4000);
      if (result.status === 200) {
        const text = extractText(result.html);
        const pageSignals = extractSignals(text, fullUrl, page.type, foundDate);
        signals.push(...pageSignals);
      }
    } catch (e) {
      // Skip this page, continue to next
    }
  }
  
  // Deduplicate signals (same type from different sources)
  const uniqueSignals = [];
  const seenTypes = new Set();
  
  for (const signal of signals) {
    if (!seenTypes.has(signal.type)) {
      uniqueSignals.push(signal);
      seenTypes.add(signal.type);
    }
  }
  
  const biScore = calculateBIScore(uniqueSignals);
  
  return {
    signals: uniqueSignals,
    biScore,
    status: 'success',
    website: primaryDomain,
    sourcesChecked: visited.size
  };
}

// Export for Node.js usage
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { extractSignalsFromCompany };
}
