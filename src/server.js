const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = 8080;
const ZIP = path.join(__dirname, '..', 'deepseek-ai-bridge.zip');
const ROOT = __dirname;

const PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>DeepSeek → AI Bridge — Download</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    background: #0a0c10;
    color: #eef1f5;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .card {
    background: #12151c;
    border: 1px solid #262b38;
    border-radius: 12px;
    padding: 40px;
    max-width: 520px;
    width: 90%;
    text-align: center;
    box-shadow: 0 24px 64px rgba(0,0,0,0.5);
  }
  .icon { font-size: 48px; margin-bottom: 12px; }
  h1 {
    font-size: 20px;
    font-weight: 750;
    letter-spacing: -0.3px;
    margin-bottom: 4px;
  }
  .sub {
    color: #9ba4b8;
    font-size: 13px;
    margin-bottom: 20px;
  }
  .desc {
    color: #9ba4b8;
    font-size: 12px;
    line-height: 1.5;
    margin-bottom: 24px;
  }
  .btn {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    background: #42c6a3;
    color: #07130f;
    border: 0;
    border-radius: 8px;
    padding: 12px 28px;
    font-size: 15px;
    font-weight: 700;
    text-decoration: none;
    cursor: pointer;
    transition: background 120ms ease, transform 120ms ease;
  }
  .btn:hover { background: #4fd1ad; transform: scale(1.02); }
  .files {
    margin-top: 20px;
    text-align: left;
    background: #181c26;
    border-radius: 8px;
    padding: 12px 16px;
    max-height: 200px;
    overflow-y: auto;
  }
  .files .title {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.5px;
    text-transform: uppercase;
    color: #6b7589;
    margin-bottom: 6px;
  }
  .files .row {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 3px 0;
    font-size: 11px;
    color: #9ba4b8;
  }
  .files .row span { color: #42c6a3; }
  .ip {
    margin-top: 16px;
    font-size: 11px;
    color: #6b7589;
  }
  .ip code {
    background: #0e1118;
    padding: 2px 8px;
    border-radius: 4px;
    color: #eef1f5;
    font-size: 12px;
  }
  ::-webkit-scrollbar { width: 6px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: #2e3545; border-radius: 999px; }
</style>
</head>
<body>
<div class="card">
  <div class="icon">🧠</div>
  <h1>DeepSeek → AI Bridge</h1>
  <div class="sub">v0.3.0 · Multi-Agent Orchestrator</div>
  <div class="desc">
    Chrome extension that orchestrates DeepSeek, ChatGPT, Gemini, Perplexity, and HuggingFace
    as a multi-agent pipeline with auto task planning, complexity analysis, and feedback loops.
  </div>
  <a class="btn" href="/download" download="deepseek-ai-bridge.zip">
    ⬇ Download Extension (.zip)
  </a>
  <div class="files">
    <div class="title">Includes</div>
    ${getFileList()}
  </div>
  <div class="ip">
    Server: <code>${getIP()}:${PORT}</code>
  </div>
</div>
</body>
</html>`;

function getIP() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}

function getFileList() {
  const files = fs.readdirSync(ROOT).filter(f => f.endsWith('.js') || f.endsWith('.html') || f.endsWith('.json'));
  return files.map(f => `<div class="row"><span>▸</span> ${f}</div>`).join('');
}

const server = http.createServer((req, res) => {
  if (req.url === '/download') {
    fs.stat(ZIP, (err, stat) => {
      if (err) {
        res.writeHead(404);
        return res.end('Zip not found. Run: zip -r deepseek-ai-bridge.zip deepseek-ai-bridge/');
      }
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Length': stat.size,
        'Content-Disposition': 'attachment; filename="deepseek-ai-bridge.zip"',
      });
      fs.createReadStream(ZIP).pipe(res);
    });
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(PAGE);
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  🧠 DeepSeek → AI Bridge Download Server\n`);
  console.log(`  Local:   http://localhost:${PORT}`);
  console.log(`  Network: http://${getIP()}:${PORT}\n`);
});
