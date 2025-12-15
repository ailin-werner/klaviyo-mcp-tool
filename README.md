# Klaviyo MCP (minimal) - Deploy to Vercel

This server accepts POST /mcp with:
{
  "keyword": "{{Variable value}}",
  "days": 90,
  "limit": 15
}

It queries Klaviyo public API using KLAVIYO_API_KEY and returns:
[
  id,
  name,
  subject_lines,
  metrics,
  themes
]

Deploy:
1. vercel
2. vercel env add KLAVIYO_API_KEY
3. vercel --prod

