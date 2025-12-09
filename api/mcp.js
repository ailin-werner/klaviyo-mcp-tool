/*
api/mcp.js
Minimal Vercel serverless route implementing a Klaviyo helper endpoint.
*/

// --- ROBUST FETCH INITIALIZATION ---
let fetch = globalThis.fetch;
if (!fetch) {
    try {
        // Fallback to 'node-fetch' which must be in package.json
        fetch = require('node-fetch');
    } catch (e) {
        console.error("node-fetch dependency not found.");
    }
}
if (fetch) {
    fetch = fetch.bind(globalThis);
}

const KLAVIYO_BASE = 'https://a.klaviyo.com/api';


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
// --- Helper Function: Strip HTML Tags (Base) ---
// --------------------------------------------------------------------------------------

function stripHtml(html) {
    if (!html) return '';
    // Removes most HTML tags and converts multiple spaces/newlines into a single space
    return html.replace(/<[^>]*>?/gm, ' ').replace(/\s\s+/g, ' ').trim();
}

// --------------------------------------------------------------------------------------
// --- Helper Function: Clean HTML Body for Analysis (FIX 05: Force Vercel Refresh) ---
// --------------------------------------------------------------------------------------

function cleanBodyForAnalysis(html) { // <-- Function start
    if (!html) return '';

    // 1. Remove all content inside <style>...</style> and <script>...</script> tags
    let cleaned = html.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ');
    cleaned = cleaned.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ');
    
    // 2. Remove all HTML comments (which often contain MSO/IE specific CSS noise)
    cleaned = cleaned.replace(//g, ' ');

    // 3. Remove most remaining HTML tags and collapse whitespace
    return stripHtml(cleaned);
} // <-- SYNTAX FIX: This is the critical closing brace on line ~69.


// --------------------------------------------------------------------------------------
// --- Helper Function: Fetch Template HTML ---
// --------------------------------------------------------------------------------------

async function getTemplateHtml(templateId, apiKey) {
    if (!templateId || !apiKey) return '';

    const url = `${KLAVIYO_BASE}/templates/${templateId}`;
    
    if (!fetch) {
        console.error("Fetch is not defined. Cannot fetch template.");
        return '';
    }

    try {
        const resp = await fetch(url, {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'Authorization': 'Klaviyo-API-Key ' + String(apiKey),
                'revision': '2023-10-15', 
            },
        });

        if (!resp.ok) {
            console.error(`Failed to fetch template ${templateId}: ${resp.status}`);
            return '';
        }
        
        const json = await resp.json();
        return json?.data?.attributes?.html || '';
    } catch (err) {
        console.error(`Error fetching template ${templateId}: ${err.message}`);
        return '';
    }
}


// --------------------------------------------------------------------------------------
// --- Main Export & Routing (Defensive Body Parsing) ---
// --------------------------------------------------------------------------------------
const FIX_VERSION = 5; // FORCING VERCEL CACHE CLEAR
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

// 1. POST /execute handler
if (req.method === 'POST' && urlPath.endsWith('/execute')) {
    let body = req.body;
    if (!body) {
      const raw = await readRawBody(req);
      try { 
          body = JSON.parse(raw || '{}'); 
      } catch { 
          body = {}; // Defensive fallback
      }
    }
    const tool = (body.tool || body.name || '').toString();
    const input = body.input || body.args || body;
    if (!tool || tool !== 'search_campaigns') {
      return jsonResponse(res, { error: 'unsupported_tool', details: 'Only search_campaigns is supported' }, 400);
    }
    return runSearchCampaigns(input, req, res);
}

// 2. Generic POST handler
if (req.method === 'POST') {
    let body = req.body;
    if (!body) {
      const raw = await readRawBody(req);
      try { 
          body = JSON.parse(raw || '{}'); 
      } catch { 
          body = {}; // Defensive fallback
      }
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
// --- runSearchCampaigns Logic (Finalized) ---
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
if (!fetch) {
    return jsonResponse(res, { error: 'server_misconfigured', details: 'The \'node-fetch\' dependency is required but was not found or failed to load.' }, 500);
}


// 1. Fetch initial campaign list
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
const rawItems = Array.isArray(campaignsJson?.data) ? campaignsJson.data : (Array.isArray(campaignsJson) ? campaignsJson : (campaignsJson?.campaigns || campaignsJson?.results || []));

const includedMessages = Array.isArray(campaignsJson?.included) ? campaignsJson.included.filter(i => i.type === 'campaign-message') : [];


// 2. Extract data 
const allCampaigns = (rawItems || []).map(item => {
    const id = item.id || item?.campaign_id || item?.uid || (item?.attributes && item.attributes.id) || null;
    const attrs = item.attributes || item || {};
    const name = attrs.name || attrs.title || item.name || item.title || '';
    const created_at = attrs.created_at || attrs.created || attrs.sent_at || attrs.scheduled || item.created_at || item.sent_at || null;

    const subject_lines = [];
    let preview_text = '';
    let template_id = null;
    
    // Extract content from the 'included' section (Campaign Message)
    const messageRelationship = item?.relationships?.['campaign-messages']?.data?.[0];
    if (messageRelationship) {
        const message = includedMessages.find(i => i.id === messageRelationship.id);
        
        // Subject Line
        const subject = message?.attributes?.content?.subject || message?.attributes?.definition?.content?.subject; 
        if (subject) subject_lines.push(subject);
        
        // Preview Text
        preview_text = message?.attributes?.content?.preview_text || '';
        
        // Get Template ID
        template_id = message?.relationships?.template?.data?.id || null;
    }

    if (Array.isArray(attrs.subject_lines)) subject_lines.push(...attrs.subject_lines.filter(Boolean));
    if (attrs.subject) subject_lines.push(attrs.subject);
    if (item.subject) subject_lines.push(item.subject);

    return {
      id: id ? String(id) : null,
      name,
      subject_lines: Array.from(new Set(subject_lines)).filter(Boolean),
      created_at,
      preview_text,
      template_id,
      raw: item,
    };
});


// 3. Apply keyword filtering 
const keywordLower = keyword.toLowerCase();
const matched = allCampaigns.filter(c => {
    if (!c) return false;
    if ((c.name || '').toLowerCase().includes(keywordLower)) return true; 
    for (const s of (c.subject_lines || [])) {
      if ((s || '').toLowerCase().includes(keywordLower)) return true;
    }
    if ((c.preview_text || '').toLowerCase().includes(keywordLower)) return true;
    return false;
}).slice(0, limit);

const subject_lines = [];
const performance_metrics = [];
const themes = [];
const campaignsResult = [];

// 4. Process matches and fetch metrics/HTML/Clean Content
for (const c of matched) {
    
    // --- A. Fetch Template HTML ---
    const body_html = await getTemplateHtml(c.template_id, apiKey);
    
    // --- B. Extract Plain Text and CTA Text/Link ---
    const body_text = cleanBodyForAnalysis(body_html);
    let cta_text = null;
    let cta_link = null;
    
    const ctaMatch = body_html.match(/<td[^>]*class=\"kl-button\"[^>]*>.*?<p[^>]*>([^<]+)<\/p>/is);
    if (ctaMatch && ctaMatch[1]) {
        cta_text = stripHtml(ctaMatch[1]).trim(); 
        
        const ctaButtonHtml = body_html.substring(body_html.indexOf(ctaMatch[0]));
        const linkMatch = ctaButtonHtml.match(/<a[^>]*href=\"([^\"]+)\"[^>]*>/is);
        
        if (linkMatch && linkMatch[1]) {
            cta_link = linkMatch[1].trim();
        } else {
             const contentAreaMatch = body_html.match(/<div class=\"content-padding.*?>([\s\S]*?)<\/div>/i);
             if (contentAreaMatch && contentAreaMatch[1]) {
                 const broaderLinkMatch = contentAreaMatch[1].match(/<a[^>]*href=\"([^\"]+)\"[^>]*>/i);
                 if (broaderLinkMatch && broaderLinkMatch[1]) {
                     cta_link = broaderLinkMatch[1].trim();
                 }
             }
        }
    }
    
    // --- C. Fetch Metrics ---
    let metrics = { open_rate: null, click_rate: null, conversion_rate: null, sent: null, revenue: null, raw: null };
    try {
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
        
        // Using '||' for universal Node.js compatibility
        const open_val = mJson.open_rate || mJson.open_rate_pct || null;
        const click_val = mJson.click_rate || mJson.click_rate_pct || null;
        const conv_val = mJson.conversion_rate || mJson.conversion_rate_pct || null;
        
        const sent_val = mJson.recipients || mJson.number_sent || mJson.sent || null;
        const revenue_val = mJson.revenue || mJson.total_revenue || null;
        
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

    // --- D. Theme Generation ---
    const textToAnalyze = [c.name, c.preview_text].concat(c.subject_lines || []).join(' ') + ' ' + body_text;
    const tokens = textToAnalyze.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    const stopWords = new Set(['the', 'and', 'for', 'you', 'with', 'to', 'of', 'in', 'on', 'at', 'is', 'it', 'from', 'by', 'as', 'we', 'i', 'a', 'an', 'only', 'out', 'up', 'down', 'here', 'now', 'or', 'your', 'us', 'our', 'what', 'day']);
    const freq = {};
    tokens.forEach(t => { 
        if (t.length > 2 && !stopWords.has(t) && !t.includes('klaviyo') && !t.includes('unsubscribe')) {
             freq[t] = (freq[t] || 0) + 1; 
        }
    });
    
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
      preview_text: c.preview_text,
      body_html: body_html, 
      body_text: body_text,
      cta_text: cta_text,
      cta_link: cta_link, 
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
