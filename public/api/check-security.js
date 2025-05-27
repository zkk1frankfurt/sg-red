// api/check-security.js - Vercel Edge Function with in-memory storage
export const config = {
  runtime: 'edge',
};

// Configuration
const CONFIG = {
  ALLOWED_COUNTRY: 'Singapore',
  GEO_API_KEY: '7a531a84655846cba085658009aaf945',
  MAX_REQUESTS: 10,
  TIME_WINDOW: 60000, // 60 seconds in milliseconds
  BLOCK_DURATION: 3600000, // 1 hour in milliseconds
};

// Bot patterns
const BOT_PATTERNS = [
  'bot', 'crawler', 'spider', 'scraper', 'curl', 'wget', 'python', 'java',
  'ruby', 'perl', 'php', 'go-http', 'okhttp', 'postman', 'insomnia', 'axios',
  'fetch', 'scrapy', 'beautifulsoup', 'selenium', 'puppeteer', 'playwright',
  'headless', 'phantomjs', 'slurp', 'mediapartners', 'facebookexternalhit',
  'twitterbot', 'linkedinbot', 'whatsapp', 'telegram', 'discord', 'slack',
  'msnbot', 'yandex', 'baidu', 'duckduck', 'semrush', 'ahrefs'
];

// In-memory storage (resets when function cold starts)
const memoryStore = {
  requests: new Map(), // IP -> array of timestamps
  blocked: new Map(),  // IP -> { reason, timestamp, duration }
};

// Clean up old entries periodically
function cleanupMemory() {
  const now = Date.now();
  
  // Clean expired blocks
  for (const [ip, blockData] of memoryStore.blocked.entries()) {
    if (now - blockData.timestamp > blockData.duration) {
      memoryStore.blocked.delete(ip);
    }
  }
  
  // Clean old request timestamps
  for (const [ip, timestamps] of memoryStore.requests.entries()) {
    const validTimestamps = timestamps.filter(t => now - t < CONFIG.TIME_WINDOW);
    if (validTimestamps.length === 0) {
      memoryStore.requests.delete(ip);
    } else {
      memoryStore.requests.set(ip, validTimestamps);
    }
  }
}

// Get real IP from headers
function getClientIP(request) {
  const xff = request.headers.get('x-forwarded-for');
  const realIp = request.headers.get('x-real-ip');
  const cfIp = request.headers.get('cf-connecting-ip');
  
  return cfIp || (xff ? xff.split(',')[0].trim() : null) || realIp || 'unknown';
}

// Check if bot
function isBot(userAgent) {
  const ua = userAgent?.toLowerCase() || '';
  return BOT_PATTERNS.some(pattern => ua.includes(pattern));
}

// Check rate limit
function checkRateLimit(ip) {
  cleanupMemory();
  
  const now = Date.now();
  const requests = memoryStore.requests.get(ip) || [];
  const recentRequests = requests.filter(t => now - t < CONFIG.TIME_WINDOW);
  
  if (recentRequests.length >= CONFIG.MAX_REQUESTS) {
    return false;
  }
  
  recentRequests.push(now);
  memoryStore.requests.set(ip, recentRequests);
  return true;
}

// Check if blocked
function isBlocked(ip) {
  const blockData = memoryStore.blocked.get(ip);
  if (!blockData) return false;
  
  const now = Date.now();
  if (now - blockData.timestamp > blockData.duration) {
    memoryStore.blocked.delete(ip);
    return false;
  }
  
  return true;
}

// Block IP
function blockIP(ip, reason, duration = CONFIG.BLOCK_DURATION) {
  memoryStore.blocked.set(ip, {
    reason,
    timestamp: Date.now(),
    duration
  });
}

// Get location from IP
async function getLocationFromIP(ip) {
  try {
    const response = await fetch(
      `https://api.ipgeolocation.io/ipgeo?apiKey=${CONFIG.GEO_API_KEY}&ip=${ip}`,
      { 
        signal: AbortSignal.timeout(5000) // 5 second timeout
      }
    );
    
    if (response.ok) {
      const data = await response.json();
      return data.country_name;
    }
  } catch (error) {
    // Try fallback service
    try {
      const fallbackResponse = await fetch(
        `https://ipapi.co/${ip}/country_name/`,
        { 
          signal: AbortSignal.timeout(3000) // 3 second timeout
        }
      );
      
      if (fallbackResponse.ok) {
        return await fallbackResponse.text();
      }
    } catch (fallbackError) {
      console.error('All geolocation services failed');
    }
  }
  return null;
}

export default async function handler(request) {
  // Handle CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    });
  }

  const ip = getClientIP(request);
  const userAgent = request.headers.get('user-agent') || '';
  
  const response = {
    ip,
    blocked: false,
    isBot: false,
    isSingapore: false,
    allowed: false,
  };

  try {
    // Check if blocked
    if (isBlocked(ip)) {
      response.blocked = true;
      return Response.json(response, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store'
        }
      });
    }

    // Bot detection
    if (isBot(userAgent)) {
      blockIP(ip, 'Bot detected', CONFIG.BLOCK_DURATION * 4);
      response.isBot = true;
      return Response.json(response, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store'
        }
      });
    }

    // Rate limiting
    if (!checkRateLimit(ip)) {
      blockIP(ip, 'Rate limit exceeded', CONFIG.BLOCK_DURATION * 2);
      response.blocked = true;
      return Response.json(response, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store'
        }
      });
    }

    // Location check
    const country = await getLocationFromIP(ip);
    if (country) {
      const SingaporeVariations = ['Singapore', 'singapore', 'SG', 'sg'];
      response.isSingapore = SingaporeVariations.some(variation =>
        country.toLowerCase().includes(variation.toLowerCase())
      );
      
      if (response.isSingapore) {
        response.allowed = true;
      } else {
        blockIP(ip, `Geographic restriction - ${country}`, CONFIG.BLOCK_DURATION * 24);
      }
    } else {
      // If geolocation fails, block for safety
      blockIP(ip, 'Geolocation check failed', CONFIG.BLOCK_DURATION / 12); // 5 minute block
    }

    return Response.json(response, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store'
      }
    });
  } catch (error) {
    console.error('Handler error:', error);
    return Response.json(
      { error: 'Internal error' }, 
      { 
        status: 500,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store'
        }
      }
    );
  }
}