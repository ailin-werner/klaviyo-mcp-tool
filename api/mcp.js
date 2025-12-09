/*
api/mcp.js
Minimal Vercel serverless route implementing a Klaviyo helper endpoint.
*/

const fetch = (typeof globalThis !== 'undefined' && globalThis.fetch)
? globalThis.fetch.bind(globalThis)
: (function () {
try { return require('node-fetch'); } catch (e) { return undefined; }
})();

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
// --- Helper Function: Strip HTML Tags (Original) ---
// --------------------------------------------------------------------------------------

function stripHtml(html) {
    if (!html) return '';
    // Removes most HTML tags and converts multiple spaces/newlines into a single space
    return html.replace(/<[^>]*>?/gm, ' ').replace(/\s\s+/g, ' ').trim();
}

// --------------------------------------------------------------------------------------
// --- NEW Helper Function: Clean HTML Body for Analysis ---
// --------------------------------------------------------------------------------------

function cleanBodyForAnalysis(html) {
    if (!html) return '';

    // 1. Remove all content inside <style>...</style> and <script>...</script> tags
    let cleaned = html.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ');
    cleaned = cleaned.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ');
    
    // 2. Remove all HTML comments (which often contain MSO/IE specific CSS noise)
    cleaned = cleaned.replace(//g, ' ');

    // 3. Remove most remaining HTML tags and collapse whitespace
    return stripHtml(cleaned);
}


// --------------------------------------------------------------------------------------
// --- Helper Function: Fetch Template HTML ---
// --------------------------------------------------------------------------------------

async function getTemplateHtml(templateId, apiKey) {
    if (!templateId || !apiKey) return '';

    const url = `${KLAVIYO_BASE}/templates/${templateId}`;
    
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
        // The HTML content is directly under attributes.html for the Template resource
        return json?.data?.attributes?.html || '';
    } catch (err) {
        console.error(`Error fetching template ${templateId}: ${err.message}`);
        return '';
    }
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

// 1. Fetch initial campaign list using 'include' (Corrected URL: only campaign-messages allowed)
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

// We need the included message data for extraction
const includedMessages = Array.isArray(campaignsJson?.included) ? campaignsJson.included.filter(i => i.type === 'campaign-message') : [];


// 2. Extract data (Collecting Template ID for later fetch)
const allCampaigns = (rawItems || []).map(item => {
    const id = item.id || item?.campaign_id || item?.uid || (item?.attributes && item.attributes.id) || null;
    const attrs = item.attributes || item || {};
    const name = attrs.name || attrs.title || item.name || item.title || '';
    const created_at = attrs.created_at || attrs.created || attrs.sent_at || attrs.scheduled || item.created_at || item.sent_at || null;

    const subject_lines = [];
    let preview_text = '';
    let template_id = null; // Store template ID for later fetching
    
    // Extract content from the 'included' section (Campaign Message)
    const messageRelationship = item?.relationships?.['campaign-messages']?.data?.[0];
    if (messageRelationship) {
        const message = includedMessages.find(i => i.id === messageRelationship.id);
        
        // Subject Line
        const subject = message?.attributes?.content?.subject || message?.attributes?.definition?.content?.subject; 
        if (subject) subject_lines.push(subject);
        
        // Preview Text
        preview_text = message?.attributes?.content?.preview_text || '';
        
        // Get Template ID to fetch body HTML later
        template_id = message?.relationships?.template?.data?.id || null;
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
      preview_text,
      template_id, // Include template ID
      raw: item,
    };
});


// 3. Apply keyword filtering 
const keywordLower = keyword.toLowerCase();
// The filtering logic relies on easily available fields (name, subject, preview text)
const matched = allCampaigns.filter(c => {
    if (!c) return false;
    // Match on Name 
    if ((c.name || '').toLowerCase().includes(keywordLower)) return true; 
    // Match on subject line
    for (const s of (c.subject_lines || [])) {
      if ((s || '').toLowerCase().includes(keywordLower)) return true;
    }
    // Match on preview text
    if ((c.preview_text || '').toLowerCase().includes(keywordLower)) return true;
    return false;
}).slice(0, limit);

const subject_lines = [];
const performance_metrics = [];
const themes = [];
const campaignsResult = [];

// 4. Process matches and fetch metrics/HTML/Clean Content
for (const c of matched) {
    
    // --- A. Fetch Template HTML (Separate API Call) ---
    const body_html = await getTemplateHtml(c.template_id, apiKey);
    
    // --- B. Extract Plain Text and CTA Text/Link (Using the new cleanBodyForAnalysis) ---
    const body_text = cleanBodyForAnalysis(body_html); // <--- CHANGE HERE
    let cta_text = null;
    let cta_link = null;
    
    // Simple regex to find text inside the Klaviyo button tag (<p> inside the kl-button table)
    // This is robust for typical Klaviyo block structure
    const ctaMatch = body_html.match(/<td[^>]*class=\"kl-button\"[^>]*>.*?<p[^>]*>([^<]+)<\/p>/is);
    if (ctaMatch && ctaMatch[1]) {
        // Clean up the CTA text from extra whitespace and characters
        cta_text = stripHtml(ctaMatch[1]).trim(); 
        
        // Simple regex to find the primary link near the button text
        // Need to be a bit more robust here, looking for the nearest <a> tag with an href
        const linkMatch = body_html.match(/<a[^>]*href=\"([^\"]+)\"[^>]*>.*?Shop Now.*?<\/a>/is); // Targeted search for the Shop Now button link
        if (linkMatch && linkMatch[1]) {
            cta_link = linkMatch[1].trim();
        } else {
             // Fallback: search for any link in the vicinity of the button text
             const broaderLinkMatch = body_html.match(/<a[^>]*href=\"([^\"]+)\"[^>]*>/i);
             if (broaderLinkMatch && broaderLinkMatch[1]) {
                 cta_link = broaderLinkMatch[1].trim();
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

    // --- D. Theme Generation (Using clean text) ---
    const textToAnalyze = [c.name, c.preview_text].concat(c.subject_lines || []).join(' ') + ' ' + body_text;
    const tokens = textToAnalyze.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    // Filter out generic short words common in email structures (like 'to', 'the', 'for', 'in', 'out', 'up', 'td', 'tr', 'div', etc.)
    const stopWords = new Set(['the', 'and', 'for', 'you', 'with', 'td', 'tr', 'div', 'p', 'kl', 'mj', 'to', 'of', 'in', 'on', 'at', 'is', 'it', 'from', 'by', 'as', 'we', 'i', 'a', 'an', 'only', 'out', 'up', 'down', 'here', 'now']);
    const freq = {};
    tokens.forEach(t => { 
        if (t.length > 2 && !stopWords.has(t)) {
             freq[t] = (freq[t] || 0) + 1; 
        }
    });
    
    const topThemes = Object.keys(freq).sort((a,b) => freq[b] - freq[a]).slice(0, 5); // Now theme analysis is based on cleaned text
    
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
      // Retaining the full HTML as originally requested
      body_html: body_html, 
      // NEW CLEANED FIELDS for easy consumption
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
