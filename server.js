/* =====================================================
   COMUNIC · Network Monitor — server.js
   Serveur Express + checks ICMP / TCP / HTTP
   ===================================================== */

const express = require('express');
const path    = require('path');
const net     = require('net');
const ping    = require('ping');
const http    = require('http');
const https   = require('https');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/* ── ICMP Ping ── */
async function icmpPing(host) {
  try {
    const res = await ping.promise.probe(host, { timeout: 4 });
    return {
      alive  : res.alive,
      latency: res.alive ? parseFloat(res.time) : null,
    };
  } catch (e) {
    return { alive: false, latency: null };
  }
}

/* ── TCP Port Check ── */
function tcpCheck(host, port, timeout = 4000) {
  return new Promise(resolve => {
    const start  = Date.now();
    const socket = new net.Socket();
    let done = false;

    const finish = (alive) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve({ alive, latency: alive ? Date.now() - start : null });
    };

    socket.setTimeout(timeout);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error',   () => finish(false));
    socket.connect(port, host);
  });
}

/* ── API : Check générique ── */
app.post('/check', async (req, res) => {
  const { ip, port } = req.body;
  if (!ip) return res.status(400).json({ error: 'IP requise' });

  let result;
  if (port) {
    result = await tcpCheck(ip, parseInt(port));
  } else {
    result = await icmpPing(ip);
  }

  res.json({
    ip,
    port    : port || null,
    alive   : result.alive,
    latency : result.latency,
    time    : new Date().toISOString(),
  });
});

/* ── API : Envoi alerte email (Simulation / Log interne) ── */
app.post('/alert-email', (req, res) => {
  const { to, device, ip, type, time } = req.body;
  console.log(`[EMAIL ALERT] To: ${to} | Client: ${device} (${ip}) | State: ${type.toUpperCase()} at ${time}`);
  res.json({ success: true, msg: 'Email simulé envoyé avec succès' });
});

/* ── API : Géocodage proxy (évite CORS Nominatim) ── */
app.get('/geocode', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ error: 'Query requise' });

  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&limit=1`;
    const data = await new Promise((resolve, reject) => {
      https.get(url, {
        headers: { 'User-Agent': 'COMUNIC-Monitor/1.0', 'Accept-Language': 'fr' }
      }, r => {
        let body = '';
        r.on('data', c => body += c);
        r.on('end', () => resolve(JSON.parse(body)));
      }).on('error', reject);
    });

    if (data.length) {
      res.json({ lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) });
    } else {
      res.json({ lat: null, lng: null });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ── Health ── */
app.get('/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

/* ── Start ── */
app.listen(PORT, () => {
  console.log(`\n  🟢 COMUNIC Monitor lancé sur http://localhost:${PORT}\n`);
});
