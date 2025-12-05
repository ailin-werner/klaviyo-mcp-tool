// api/mcp/tools.js
try {
  const main = require('../mcp.js');
  module.exports = (req, res) => main(req, res);
} catch (err) {
  module.exports = (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.statusCode = 500;
    res.end(JSON.stringify({
      error: 'wrapper_import_failed',
      message: String(err.message || err),
      stack: err.stack ? String(err.stack).split('\n').slice(0,10).join('\n') : null
    }));
  };
}
