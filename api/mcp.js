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
// --- runSearchCampaigns Logic (DEBUG DUMP) ---
// --------------------------------------------------------------------------------------

async function runSearchCampaigns(input = {}, req, res) {
try {
const keyword = String(input.keyword || '').trim();
const apiKey = process.env.KLAVIYO_NEW_API_KEY || process.env.KLAVIYO_API_KEY;

if (!apiKey) {
    return jsonResponse(res, { error: 'server_misconfigured', details: 'Missing KLAVIYO_NEW_API_KEY or KLAVIYO_API_KEY' }, 500);
}
// Note: We ignore 'keyword' and other params for this debug step

// 1. Fetch initial campaign list using 'include'
const filter = encodeURIComponent("and(equals(messages.channel,'email'),equals(status,'Sent'))");
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

// 💥 CRITICAL DEBUG STEP: Return the raw API response JSON
// THIS WILL RETURN THE FULL DATA DUMP SO WE CAN INSPECT THE SUBJECT LINE PATH
return jsonResponse(res, { raw_klaviyo_response: campaignsJson, keyword_tested: keyword }, 200);

} catch (err) {
return jsonResponse(res, { error: 'Unexpected server error', details: String(err && err.message ? err.message : err) }, 500);
}
}
