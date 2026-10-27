const http = require('http');
const counts = {};
http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (origin && /^http:\/\/[a-z0-9-]+\.localhost:55430$/.test(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(200); return res.end(); }
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname === '/__reset') { for (const key of Object.keys(counts)) delete counts[key]; res.writeHead(200); return res.end('{}'); }
  if (pathname === '/__stats') { res.writeHead(200, {'Content-Type':'application/json'}); return res.end(JSON.stringify(counts)); }
  if (req.method !== 'POST' || !['/submit-a','/submit-b','/retry','/failure','/malformed'].includes(pathname)) { res.writeHead(501); return res.end('{}'); }
  let body = req.body;
  if (body === undefined) { const parts = []; for await (const chunk of req) parts.push(chunk); body = Buffer.concat(parts).toString(); }
  const params = new URLSearchParams(typeof body === 'object' && !Buffer.isBuffer(body) ? body : String(body));
  if (!String(req.headers['content-type']).startsWith('application/x-www-form-urlencoded') || !params.get('form_name')) { res.writeHead(400, {'Content-Type':'application/json'}); return res.end('{"code":"ERROR","message":"Invalid form contract"}'); }
  counts[pathname] = (counts[pathname] || 0) + 1;
  if (pathname === '/malformed') { res.writeHead(500, {'Content-Type':'text/html'}); return res.end('<html>Provider gateway unavailable</html>'); }
  const failure = pathname === '/failure' || pathname === '/retry' && counts[pathname] === 1;
  res.writeHead(failure ? 503 : 200, {'Content-Type':'application/json'});
  res.end(JSON.stringify(failure ? {code:'ERROR',message:'Synthetic provider unavailable'} : {code:'OK',meta:{message:'Synthetic form accepted'}}));
}).listen(process.env.PORT || 4901, '127.0.0.1');
