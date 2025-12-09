/*
api/mcp.js
Minimal Vercel serverless route implementing a Klaviyo helper endpoint.
*/

const fetch = (typeof globalThis !== 'undefined' && globalThis.fetch)
? globalThis.fetch.bind(globalThis)
: (function () {
try { return require('node-fetch'); } catch (e) { return undefined; }
})();

// ✅ FIXED: Switched back to the modern, non-retired API base path (V3/V4)
const KLAVIYO_BASE = 'https://a.klaviyo.com/api';
const KLAVIYO_V3_API_BASE = KLAVIYO_BASE; 


function safeJsonParse(text) {
try { return JSON.parse(text); } catch { return null; }
}

function jsonResponse(res, body, status = 200) {
res.setHeader('Content-Type', 'application/json');
return res.status(status).send(JSON.stringify(body));
}

function readRawBody(req) {
return new Promise((resolve, reject) => {
let s = '';
req.on('data', (c) => s += c);
req.on('end', () => resolve(s));
req.on('error', (e) => reject(e));
});
}

// --------------------------------------------------------------------------------------
// --- Main Export & Routing ---
// --------------------------------------------------------------------------------------

module.exports = async (req, res) => {
try {
const urlPath = req.url || '';

if (req.method === 'GET' && urlPath.endsWith('/tools')) {
    return jsonResponse(res, [
      {
        name: 'search_campaigns',
        description: 'Search Klaviyo campaigns by keyword and return subjects, metrics, and themes.',
        args: {
          type: 'object',
          properties: {
            keyword: { type: 'string' },
            days: { type: 'number' },
            limit: { type: 'number' }
          },
          required: ['keyword']
        }
      }
    ]);
}

if (req.method === 'POST' && urlPath.endsWith('/execute')) {
    let body = req.body;
    if (!body) {
      const raw = await readRawBody(req);
      try { body = JSON.parse(raw || '{}'); } catch { body = raw || {}; }
    }
    const tool = (body.tool || body.name || '').toString();
    const input = body.input || body.args || body;
    if (!tool || tool !== 'search_campaigns') {
      return jsonResponse(res, { error: 'unsupported_tool', details: 'Only search_campaigns is supported' }, 400);
    }
    return runSearchCampaigns(input, req, res);
}

if (req.method === 'POST') {
    let body = req.body;
    if (!body) {
      const raw = await readRawBody(req);
      try { body = JSON.parse(raw || '{}'); } catch { body = raw || {}; }
    }
    if (body && (body.tool || body.name)) {
      const tool = (body.tool || body.name).toString();
      const input = body.input || body.args || body;
      if (tool === 'search_campaigns') return runSearchCampaigns(input, req, res);
    }
    return runSearchCampaigns(body, req, res);
}

return jsonResponse(res, { message: 'MCP helper — GET /api/mcp/tools, POST /api/mcp/execute or POST /api/mcp' });

} catch (err) {
return jsonResponse(res, { error: 'internal_error', details: String(err && err.message ? err.message : err) }, 500);
}
};

// --------------------------------------------------------------------------------------
// --- runSearchCampaigns Logic (FINAL WORKING VERSION) ---
// --------------------------------------------------------------------------------------

async function runSearchCampaigns(input = {}, req, res) {
try {
const keyword = String(input.keyword || '').trim();
const days = Number.isFinite(Number(input.days)) ? Number(input.days) : Number(process.env.DEFAULT_DAYS || 90);
const limit = Math.min(Number.isFinite(Number(input.limit)) ? Number(input.limit) : 25, 200);
const apiKey = process.env.KLAVIYO_NEW_API_KEY || process.env.KLAVIYO_API_KEY;

if (!apiKey) {
    return jsonResponse(res, { error: 'server_misconfigured', details: 'Missing KLAVIYO_NEW_API_KEY or KLAVIYO_API_KEY' }, 500);
}
if (!keyword) {
    return jsonResponse(res, { error: 'missing_parameter', details: 'keyword is required' }, 400);
}

// 1. Fetch initial campaign list using 'include' (Most reliable V3 method)
const filter = encodeURIComponent("and(equals(messages.channel,'email'),equals(status,'Sent'))");
// Using 'include' to fetch messages in one reliable request.
const campaignsUrl = `${KLAVIYO_BASE}/campaigns?filter=${filter}&include=campaign-messages`; 
const campaignsResp = await fetch(campaignsUrl, {
    method: 'GET',
    headers: {
      'Accept': 'application/json',
      'Authorization': 'Klaviyo-API-Key ' + String(apiKey),
      'revision': '2023-10-15', 
    },
});

const campaignsText = await campaignsResp.text();
if (!campaignsResp.ok) {
    const parsed = safeJsonParse(campaignsText) || campaignsText;
    return jsonResponse(res, { error: 'Failed to fetch campaigns', details: parsed }, 502);
}

const campaignsJson = safeJsonParse(campaignsText) || {};
const rawItems = Array.isArray(campaignsJson?.data) ? campaignsJson.data : (Array.isArray(campaignsJson) ? campaignsJson : (campaignsJson?.campaigns || campaignsJson?.results || []));

// We need the included message data for extraction
const includedMessages = Array.isArray(campaignsJson?.included) ? campaignsJson.included.filter(i => i.type === 'campaign-message') : [];


// 2. Extract data 
const allCampaigns = (rawItems || []).map(item => {
    const id = item.id || item?.campaign_id || item?.uid || (item?.attributes && item.attributes.id) || null;
    const attrs = item.attributes || item || {};
    const name = attrs.name || attrs.title || item.name || item.title || '';
    const created_at = attrs.created_at || attrs.created || attrs.sent_at || attrs.scheduled || item.created_at || item.sent_at || null;

    const subject_lines = [];
    // Extract subject from the 'included' section based on relationship
    const messageRelationship = item?.relationships?.['campaign-messages']?.data?.[0];
    if (messageRelationship) {
        const message = includedMessages.find(i => i.id === messageRelationship.id);
        // 💥 FINAL FIX: Use the correct path found in the debug dump: attributes.content.subject
        const subject = message?.attributes?.content?.subject || message?.attributes?.definition?.content?.subject; 
        if (subject) subject_lines.push(subject);
    }

    // Keep old subject logic as fallback for any pre-V3 data
    if (Array.isArray(attrs.subject_lines)) subject_lines.push(...attrs.subject_lines.filter(Boolean));
    if (attrs.subject) subject_lines.push(attrs.subject);
    if (item.subject) subject_lines.push(item.subject);

    return {
      id: id ? String(id) : null,
      name,
      subject_lines: Array.from(new Set(subject_lines)).filter(Boolean),
      created_at,
      raw: item,
    };
});


// 3. Apply keyword filtering 
const keywordLower = keyword.toLowerCase();
const matched = allCampaigns.filter(c => {
    if (!c) return false;
    // Match on Name 
    if ((c.name || '').toLowerCase().includes(keywordLower)) return true; 
    // Match on subject line (This is now reliable!)
    for (const s of (c.subject_lines || [])) {
      if ((s || '').toLowerCase().includes(keywordLower)) return true;
    }
    return false;
}).slice(0, limit);

const subject_lines = [];
const performance_metrics = [];
const themes = [];
const campaignsResult = [];

// 4. Process matches 
for (const c of matched) {
    let metrics = { open_rate: null, click_rate: null, conversion_rate: null, sent: null, revenue: null, raw: null };
    try {
      // ... (Metrics fetching logic remains the same)
      const metricsUrl = KLAVIYO_BASE + '/campaign-values-reports/'; 
      const metricsResp = await fetch(metricsUrl, {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'Authorization': 'Klaviyo-API-Key ' + String(apiKey),
          'revision': '2023-10-15', 
        },
        body: JSON.stringify({ campaign_id: c.id, since_days: days }), 
      });
      const metricsText = await metricsResp.text();
      if (metricsResp.ok) {
        const mJson = safeJsonParse(metricsText) || {};
        const open_val = (mJson.open_rate ?? mJson.open_rate_pct ?? null);
        const click_val = (mJson.click_rate ?? mJson.click_rate_pct ?? null);
        const conv_val = (mJson.conversion_rate ?? mJson.conversion_rate_pct ?? null);
        const sent_val = (mJson.recipients ?? mJson.number_sent ?? mJson.sent ?? null);
        const revenue_val = (mJson.revenue ?? mJson.total_revenue ?? null);
        metrics = {
          open_rate: open_val !== undefined && open_val !== null ? Number(open_val) : null,
          click_rate: click_val !== undefined && click_val !== null ? Number(click_val) : null,
          conversion_rate: conv_val !== undefined && conv_val !== null ? Number(conv_val) : null,
          sent: sent_val !== undefined && sent_val !== null ? (Number.isFinite(Number(sent_val)) ? Number(sent_val) : null) : null,
          revenue: revenue_val !== undefined && revenue_val !== null ? (Number.isFinite(Number(revenue_val)) ? Number(revenue_val) : null) : null,
          raw: mJson,
        };
      }
    } catch (e) {}

    const textToAnalyze = [c.name].concat(c.subject_lines || []).join(' ').toLowerCase();
    const tokens = textToAnalyze.split(/[^a-z0-9]+/).filter(Boolean);
    const freq = {};
    tokens.forEach(t => { if (t.length > 2) freq[t] = (freq[t] || 0) + 1; });
    const topThemes = Object.keys(freq).sort((a,b) => freq[b] - freq[a]).slice(0, 5);

    for (const subj of (c.subject_lines || [])) {
      subject_lines.push({ campaign_id: c.id, subject: subj });
    }

    performance_metrics.push({
      campaign_id: c.id,
      open_rate: metrics.open_rate,
      click_rate: metrics.click_rate,
      conversion_rate: metrics.conversion_rate,
      sent: metrics.sent,
      revenue: metrics.revenue
    });

    themes.push({ campaign_id: c.id, themes: topThemes });

    campaignsResult.push({
      id: c.id,
      name: c.name,
      subject_lines: c.subject_lines,
      sent_at: c.created_at,
      metrics: metrics.raw || null,
      themes: topThemes,
    });
}

const output = {
    keyword,
    campaign_count: matched.length,
    subject_lines,
    performance_metrics,
    themes,
    campaigns: campaignsResult,
    days_used: days,
    requested_limit: limit
};

return jsonResponse(res, output, 200);

} catch (err) {
return jsonResponse(res, { error: 'Unexpected server error', details: String(err && err.message ? err.message : err) }, 500);
}
}
