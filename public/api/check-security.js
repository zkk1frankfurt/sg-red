export const config = {
  runtime: 'edge',
};

const CONFIG = {
  ALLOWED_COUNTRY: 'Singapore',
  GEO_API_KEY: '7a531a84655846cba085658009aaf945',
  MAX_REQUESTS: 10,
  TIME_WINDOW: 60000,
  BLOCK_DURATION: 3600000,
};

const BOT_PATTERNS = [
  'bot', 'crawler', 'spider', 'scraper', 'curl', 'wget', 'python', 'java',
  'ruby', 'perl', 'php', 'go-http', 'okhttp', 'postman', 'insomnia', 'axios',
  'fetch', 'scrapy', 'beautifulsoup', 'selenium', 'puppeteer', 'playwright',
  'headless', 'phantomjs', 'slurp', 'mediapartners', 'facebookexternalhit',
  'twitterbot', 'linkedinbot', 'whatsapp', 'telegram', 'discord', 'slack',
  'msnbot', 'yandex', 'baidu', 'duckduck', 'semrush', 'ahrefs'
];

const memoryStore = {
  requests: new Map(),
  blocked: new Map(),
};

function cleanupMemory() {
  const now = Date.now();
  for (const [ip, blockData] of memoryStore.blocked.entries()) {
    if (now - blockData.timestamp > blockData.duration) {
      memoryStore.blocked.delete(ip);
    }
  }
  for (const [ip, timestamps] of memoryStore.requests.entries()) {
    const recent = timestamps.filter(t => now - t < CONFIG.TIME_WINDOW);
    if (recent.length === 0) {
      memoryStore.requests.delete(ip);
    } else {
      memoryStore.requests.set(ip, recent);
    }
  }
}

function getClientIP(request) {
  const xff = request.headers.get('x-forwarded-for');
  const realIp = request.headers.get('x-real-ip');
  const cfIp = request.headers.get('cf-connecting-ip');
  return cfIp || (xff ? xff.split(',')[0].trim() : null) || realIp || 'unknown';
}

function isBot(userAgent) {
  const ua = userAgent?.toLowerCase() || '';
  return BOT_PATTERNS.some(p => ua.includes(p));
}

function checkRateLimit(ip) {
  cleanupMemory();
  const now = Date.now();
  const requests = memoryStore.requests.get(ip) || [];
  const recent = requests.filter(t => now - t < CONFIG.TIME_WINDOW);
  if (recent.length >= CONFIG.MAX_REQUESTS) return false;
  recent.push(now);
  memoryStore.requests.set(ip, recent);
  return true;
}

function isBlocked(ip) {
  const block = memoryStore.blocked.get(ip);
  if (!block) return false;
  if (Date.now() - block.timestamp > block.duration) {
    memoryStore.blocked.delete(ip);
    return false;
  }
  return true;
}

function blockIP(ip, reason, duration = CONFIG.BLOCK_DURATION) {
  memoryStore.blocked.set(ip, {
    reason,
    timestamp: Date.now(),
    duration
  });
}

async function getLocationFromIP(ip) {
  try {
    const response = await fetch(
      `https://api.ipgeolocation.io/ipgeo?apiKey=${CONFIG.GEO_API_KEY}&ip=${ip}`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (response.ok) {
      const data = await response.json();
      return data.country_name;
    }
  } catch (error) {
    try {
      const fallback = await fetch(`https://ipapi.co/${ip}/country_name/`, {
        signal: AbortSignal.timeout(3000)
      });
      if (fallback.ok) {
        return await fallback.text();
      }
    } catch {
      console.error('Geolocation failed');
    }
  }
  return null;
}

export default async function handler(request) {
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
    country: null
  };

  try {
    if (isBlocked(ip)) {
      response.blocked = true;
      return Response.json(response, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store'
        }
      });
    }

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

    const country = await getLocationFromIP(ip);
    response.country = country;

    if (country) {
      const isSingapore = ['singapore', 'sg'].some(c =>
        country.toLowerCase().includes(c)
      );
      response.isSingapore = isSingapore;
      response.allowed = isSingapore;
      if (!isSingapore) {
        blockIP(ip, `Blocked: not Singapore (${country})`, CONFIG.BLOCK_DURATION * 24);
      }
    } else {
      blockIP(ip, 'Geolocation failed', CONFIG.BLOCK_DURATION / 12);
    }

    return Response.json(response, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store'
      }
    });
  } catch (error) {
    console.error('Handler error:', error);
    return Response.json({ error: 'Internal error' }, {
      status: 500,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store'
      }
    });
  }
}
