/* =====================================================
   COMUNIC · Network Monitor PRO — server.js
   Prototype local — Auth + Check ICMP/TCP
   ===================================================== */

const express = require('express');
const path    = require('path');
const net     = require('net');
const ping    = require('ping');
const crypto  = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/* ══════════════════════════════════════════════════════
   AUTH — BDD locale temporaire (proto)
══════════════════════════════════════════════════════ */
const users    = []; // { id, username, email, passwordHash, salt, role, createdAt }
const sessions = {}; // { token: { userId, username, role, expires } }

const SESSION_DURATION = 8 * 60 * 60 * 1000; // 8h

function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
}
function generateSalt()  { return crypto.randomBytes(16).toString('hex'); }
function generateToken() { return crypto.randomBytes(32).toString('hex'); }

function requireAuth(req, res, next) {
  const token = req.headers['x-auth-token'];
  if (!token || !sessions[token])
    return res.status(401).json({ error: 'Non authentifié' });

  const session = sessions[token];
  if (Date.now() > session.expires) {
    delete sessions[token];
    return res.status(401).json({ error: 'Session expirée' });
  }
  req.user = session;
  next();
}

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Accès refusé : Administrateur requis' });
  }
  next();
}

app.post('/auth/register', (req, res) => {
  const { username, email, password } = req.body;

  if (!username || !email || !password)
    return res.status(400).json({ error: 'Tous les champs sont requis' });
  if (password.length < 6)
    return res.status(400).json({ error: 'Mot de passe trop court (6 car. min)' });

  const exists = users.find(u => u.email === email || u.username === username);
  if (exists)
    return res.status(409).json({ error: 'Utilisateur ou email déjà existant' });

  const salt = generateSalt();
  const user = {
    id          : crypto.randomUUID(),
    username,
    email,
    passwordHash: hashPassword(password, salt),
    salt,
    role        : users.length === 0 ? 'admin' : 'stagiaire', 
    createdAt   : new Date().toISOString()
  };
  users.push(user);

  const token = generateToken();
  sessions[token] = {
    userId  : user.id,
    username: user.username,
    role    : user.role,
    expires : Date.now() + SESSION_DURATION
  };

  console.log(`[AUTH] Nouvel utilisateur: ${username} (${email}) — Rôle: ${user.role}`);
  res.json({ success: true, token, username: user.username, role: user.role });
});

app.post('/auth/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: 'Email et mot de passe requis' });

  const user = users.find(u => u.email === email);
  if (!user)
    return res.status(401).json({ error: 'Identifiants incorrects' });

  if (hashPassword(password, user.salt) !== user.passwordHash)
    return res.status(401).json({ error: 'Identifiants incorrects' });

  const token = generateToken();
  sessions[token] = {
    userId  : user.id,
    username: user.username,
    role    : user.role,
    expires : Date.now() + SESSION_DURATION
  };

  console.log(`[AUTH] Connexion: ${user.username} (${user.role})`);
  res.json({ success: true, token, username: user.username, role: user.role });
});

app.post('/auth/logout', requireAuth, (req, res) => {
  delete sessions[req.headers['x-auth-token']];
  res.json({ success: true });
});

app.get('/auth/me', requireAuth, (req, res) => {
  res.json({ username: req.user.username, role: req.user.role });
});

app.get('/admin/users', requireAuth, requireAdmin, (req, res) => {
  const list = users.map(u => ({ id: u.id, username: u.username, email: u.email, role: u.role }));
  res.json(list);
});

/* ── ROUTE ADMIN : PUT /admin/users/:id/role ── */
app.put('/admin/users/:id/role', requireAuth, requireAdmin, (req, res) => {
  const { role } = req.body;
  const rolesValides = ['admin', 'responsable', 'technicien', 'stagiaire'];
  if (!rolesValides.includes(role)) return res.status(400).json({ error: 'Rôle invalide' });

  const user = users.find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });

  // 🔒 VERROU : Empêcher un administrateur de modifier son propre rôle
  if (user.id === req.user.userId) {
    return res.status(400).json({ error: 'Interdit : Vous ne pouvez pas modifier votre propre rôle' });
  }

  user.role = role;
  
  Object.keys(sessions).forEach(token => {
    if (sessions[token].userId === user.id) {
      sessions[token].role = role;
    }
  });

  console.log(`[ADMIN] Le rôle de ${user.username} a été modifié en ${role.toUpperCase()}`);
  res.json({ success: true, userId: user.id, newRole: role });
});

/* ══════════════════════════════════════════════════════
   CHECK ICMP / TCP
══════════════════════════════════════════════════════ */
app.post('/check', requireAuth, async (req, res) => {
  const { ip, port } = req.body;

  if (!ip || typeof ip !== 'string' || ip.length > 253)
    return res.status(400).json({ error: 'IP invalide' });

  const start = Date.now();

  try {
    if (port) {
      const alive = await new Promise((resolve) => {
        const sock = new net.Socket();
        sock.setTimeout(3000);
        sock.connect(parseInt(port), ip, () => { sock.destroy(); resolve(true); });
        sock.on('error',   () => { sock.destroy(); resolve(false); });
        sock.on('timeout', () => { sock.destroy(); resolve(false); });
      });
      return res.json({ alive, latency: Date.now() - start });
    }

    const result = await ping.promise.probe(ip, { timeout: 5 });
    res.json({
      alive  : result.alive,
      latency: result.time !== 'unknown' ? Math.round(parseFloat(result.time)) : null
    });
  } catch (e) {
    res.json({ alive: false, latency: null });
  }
});

app.post('/alert-email', requireAuth, (req, res) => {
  const { to, device, ip, type, time } = req.body;
  console.log(`[EMAIL ALERT] To: ${to} | Client: ${device} (${ip}) | State: ${type.toUpperCase()} at ${time}`);
  res.json({ success: true, msg: 'Email simulé envoyé avec succès' });
});

app.get('/geocode', requireAuth, async (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ error: 'Query requise' });
  try {
    const url  = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&limit=1`;
    const resp = await fetch(url, { headers: { 'User-Agent': 'COMUNIC-Monitor/1.0' } });
    const data = await resp.json();
    if (data.length) {
      res.json({ lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) });
    } else {
      res.json({ lat: null, lng: null });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

app.listen(PORT, () => {
  console.log(`\n  🟢 COMUNIC Monitor lancé sur http://localhost:${PORT}\n`);
});
