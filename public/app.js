/* =====================================================
   COMUNIC · Network Monitor PRO — app.js
   ===================================================== */

/* ══════════════════════════════════════════════════════
   STATE
══════════════════════════════════════════════════════ */
const devices      = {};   // { [id]: deviceObj }
const monitors     = {};   // { [id]: intervalId }
const pingLogs     = [];   // [ {time, clientId, clientName, ip, event, latency} ]
const markers      = {};   // { [id]: L.marker }
const clientImages = {};   // { [id]: { floorplan, topo, rack } }

let selectedId  = null;
let editingId   = null;
let map         = null;
let itiMap      = null;   // Carte itinéraire
let currentEquipClientId = null;
let officeMarker = null;   // Marqueur bureau rouge

/* ── Adresse bureau par défaut (Strasbourg Alsace) ── */
let BUREAU = { lat: 48.5734, lng: 7.7521, label: 'COMUNIC - Bureau Alsace' };

const CONTRACT_MAP = {
  info: { label: "Maintenance Info Standard", color: "var(--c-info)", class: "info" },
  it: { label: "Maintenance Informatique", color: "var(--c-it)", class: "it" },
  telecom: { label: "Maintenance Téléphonique", color: "var(--c-telecom)", class: "telecom" },
  alarm: { label: "Maintenance Alarme", color: "var(--c-alarm)", class: "alarm" },
  cctv: { label: "Maintenance Vidéo-surveillance", color: "var(--c-cctv)", class: "cctv" }
};

/* ══════════════════════════════════════════════════════
   HORLOGE
══════════════════════════════════════════════════════ */
function updateClock() {
  const el = document.getElementById('clock');
  if (el) el.textContent = new Date().toLocaleTimeString('fr-FR');
}
setInterval(updateClock, 1000);
updateClock();

/* ══════════════════════════════════════════════════════
   SIDEBAR TOGGLE
══════════════════════════════════════════════════════ */
document.getElementById('toggleSidebarBtn').addEventListener('click', () => {
  document.body.classList.toggle('sidebar-hidden');
  setTimeout(() => { if (map) map.invalidateSize(); }, 300);
});

/* ══════════════════════════════════════════════════════
   NAVIGATION VIEWS
══════════════════════════════════════════════════════ */
function switchView(view) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  const target = document.getElementById(`view-${view}`);
  if (target) target.classList.add('active');

  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  const btn = document.querySelector(`.nav-btn[data-view="${view}"]`);
  if (btn) btn.classList.add('active');

  if (view === 'topology') setTimeout(() => { if (map) map.invalidateSize(); }, 60);
  if (view === 'list')     renderList();
  if (view === 'alerts')   renderLogsTable();
}

document.querySelectorAll('.nav-btn[data-view]').forEach(btn => {
  btn.addEventListener('click', () => switchView(btn.dataset.view));
});

/* ══════════════════════════════════════════════════════
   MAP (Leaflet) — Restreinte sur l'Alsace
══════════════════════════════════════════════════════ */
function initMap() {
  // Centrage Alsace par défaut
  map = L.map('map', { zoomControl: true }).setView([48.5, 7.5], 9);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom    : 19,
    attribution: '© OpenStreetMap',
  }).addTo(map);

  updateOfficeMarker();
}

/* Placer/Mettre à jour le marqueur rouge fixe du Bureau */
function updateOfficeMarker() {
  if (officeMarker) map.removeLayer(officeMarker);
  
  const officeSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="30" height="38" viewBox="0 0 28 36">
    <path d="M14 0C6.268 0 0 6.268 0 14c0 9 14 22 14 22S28 23 28 14C28 6.268 21.732 0 14 0z" fill="#ef4444" stroke="#fff" stroke-width="2"/>
    <text x="14" y="18" font-size="10" font-family="sans-serif" font-weight="bold" fill="#fff" text-anchor="middle">HQ</text>
  </svg>`;
  
  const officeIcon = L.divIcon({ html: officeSvg, iconSize: [30,38], iconAnchor: [15,38], className: '' });
  
  officeMarker = L.marker([BUREAU.lat, BUREAU.lng], { icon: officeIcon }).addTo(map);
  officeMarker.bindPopup(`<b>🏢 Siège COMUNIC</b><br>${BUREAU.label}`);
}

/* Centrer la carte sur une adresse (Le Bureau) */
document.getElementById('centerMapBtn').addEventListener('click', async () => {
  const addr = document.getElementById('centerAddress').value.trim();
  if (!addr) return;
  const coords = await geocode(addr);
  if (coords) {
    BUREAU = { lat: coords.lat, lng: coords.lng, label: addr };
    map.setView([coords.lat, coords.lng], 13);
    updateOfficeMarker();
    try { localStorage.setItem('comunic_bureau_v2', JSON.stringify(BUREAU)); } catch(e) {}
    showToast('🎯 Bureau enregistré et Carte centrée', 'info');
  } else {
    showToast('❌ Adresse du bureau introuvable', 'down');
  }
});

/* ── Marqueur Client avec Pastille de couleur de Contrat ── */
function makeIcon(status, contractType) {
  const color = status === 'up' ? '#10b981' : status === 'down' ? '#ef4444' : '#f59e0b';
  const contractObj = CONTRACT_MAP[contractType || 'info'] || CONTRACT_MAP.info;
  
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="40" viewBox="0 0 28 36">
    <path d="M14 0C6.268 0 0 6.268 0 14c0 9 14 22 14 22S28 23 28 14C28 6.268 21.732 0 14 0z" fill="${color}" stroke="#fff" stroke-width="1.5"/>
    <circle cx="14" cy="14" r="6" fill="${contractObj.color}" stroke="#fff" stroke-width="1"/>
  </svg>`;
  return L.divIcon({ html: svg, iconSize: [32,40], iconAnchor: [16,40], className: '' });
}

function addMarker(device) {
  if (!device.lat || !device.lng) return;
  if (markers[device.id]) map.removeLayer(markers[device.id]);

  const marker = L.marker([device.lat, device.lng], {
    icon : makeIcon(device.status || 'unknown', device.contractType),
    title: device.name,
  }).addTo(map);

  const contractObj = CONTRACT_MAP[device.contractType || 'info'];

  marker.bindPopup(`
    <div style="min-width:180px;font-size:12px">
      <strong style="font-size:13px">${device.name}</strong><br>
      <span style="font-size:10px; color:${contractObj.color}; font-weight:bold;">● ${contractObj.label}</span><br>
      <span style="color:#aaa">${device.ip}</span><br>
      <span>${device.address || ''}</span>
    </div>
  `);

  marker.on('click', () => {
    marker.closePopup();
    openDetailPanel(device.id);
  });

  markers[device.id] = marker;
}

function updateMarkerVisual(id) {
  const d = devices[id];
  if (!d || !markers[id]) return;
  markers[id].setIcon(makeIcon(d.status, d.contractType));
}

/* ══════════════════════════════════════════════════════
   GÉOCODAGE
══════════════════════════════════════════════════════ */
async function geocode(address) {
  try {
    const res  = await fetch(`/geocode?q=${encodeURIComponent(address)}`);
    const data = await res.json();
    if (data.lat && data.lng) return data;
    return null;
  } catch (e) {
    return null;
  }
}

/* ══════════════════════════════════════════════════════
   STATS & STATUS GLOBAL
══════════════════════════════════════════════════════ */
function updateStats() {
  const all   = Object.values(devices);
  const up    = all.filter(d => d.status === 'up').length;
  const down  = all.filter(d => d.status === 'down').length;
  const set   = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
  set('statUp',    up);
  set('statDown',  down);
  set('statTotal', all.length);
}

function updateGlobalStatus() {
  const all   = Object.values(devices);
  const dot   = document.getElementById('globalDot');
  const label = document.getElementById('globalLabel');
  if (!dot || !label) return;

  if (!all.length) {
    dot.className   = 'pulse-dot';
    label.textContent = 'Aucun site supervisé';
    return;
  }
  const down = all.filter(d => d.status === 'down').length;
  if (down === 0) {
    dot.className    = 'pulse-dot all-up';
    label.textContent = '✅ Tous les clients connectés';
    label.style.color = 'var(--up)';
  } else {
    dot.className    = 'pulse-dot has-down';
    label.textContent = `⚠️ ${down} client(s) Down`;
    label.style.color = 'var(--down)';
  }
}

/* ══════════════════════════════════════════════════════
   LOGIQUE DE SUPERVISION (PING AUTOMATIQUE)
══════════════════════════════════════════════════════ */
async function checkDevice(id) {
  const d = devices[id]; if (!d) return;
  
  // Ignorer l'appel si l'utilisateur a coupé la supervision ICMP pour ce client
  if (d.pingActive === false) return;

  try {
    const res  = await fetch('/check', {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify({ ip: d.ip, port: d.port || null }),
    });
    const data = await res.json();

    const prev   = d.status;
    d.status     = data.alive ? 'up' : 'down';
    d.latency    = data.latency;
    d.lastCheck  = new Date().toISOString();

    if (prev !== d.status) {
      d.statusSince = new Date().toISOString();
      
      // CREATION DES LOGS EXIGÉS LORS DU CHANGEMENT D'ÉTAT (UP/DOWN + LATENCE CORRESPONDANTE)
      logPingEvent(d.id, d.name, d.ip, d.status, data.latency);
    }

    if (!d.history) d.history = [];
    d.history.push(data.alive ? 1 : 0);
    if (d.history.length > 60) d.history.shift();

    /* Alerte routage mail si down persistant >= 5 minutes */
    if (prev !== 'down' && d.status === 'down') {
      if (d.emailAlert) {
        clearTimeout(d._emailTimer);
        d._emailTimer = setTimeout(() => {
          if (devices[id]?.status === 'down') sendEmailAlert(d, 'down');
        }, 5 * 60 * 1000); 
      }
    }
    
    if (prev === 'down' && d.status === 'up') {
      clearTimeout(d._emailTimer);
      if (d.emailAlert) sendEmailAlert(d, 'up');
    }

    updateMarkerVisual(id);
    updateStats();
    updateGlobalStatus();
    if (selectedId === id) refreshInfoPane(id);

    checkClientEquipments(id);
    saveDevices();
  } catch (e) {
    console.error(e);
  }
}

function logPingEvent(clientId, clientName, ip, event, latency) {
  pingLogs.unshift({
    time: new Date().toISOString(),
    clientId,
    clientName,
    ip,
    event,
    latency: latency != null ? latency + ' ms' : 'Inaccessible'
  });
  if (pingLogs.length > 1000) pingLogs.pop(); // Limite mémoire locale
  
  // Mettre à jour le compteur visuel de la barre latérale gauche
  const badge = document.getElementById('alertBadge');
  if (badge) {
    badge.style.display = 'inline';
    badge.textContent = pingLogs.length;
  }
  
  if (document.getElementById('view-alerts').classList.contains('active')) {
    renderLogsTable();
  }
}

function startMonitor(id) {
  if (monitors[id]) clearInterval(monitors[id]);
  if (devices[id]?.pingActive !== false) {
    checkDevice(id);
    const ms = (devices[id]?.checkInterval || 30) * 1000;
    monitors[id] = setInterval(() => checkDevice(id), ms);
  }
}

function toggleDevicePing(id) {
  const d = devices[id]; if (!d) return;
  const checkbox = document.getElementById('dPingToggle');
  d.pingActive = checkbox.checked;
  
  if (!d.pingActive) {
    if (monitors[id]) { clearInterval(monitors[id]); delete monitors[id]; }
    d.status = 'unknown';
    d.latency = null;
    updateMarkerVisual(id);
    showToast(`🛑 Pings désactivés pour ${d.name}`, 'info');
  } else {
    startMonitor(id);
    showToast(`▶️ Pings réactivés pour ${d.name}`, 'up');
  }
  refreshInfoPane(id);
  saveDevices();
}

async function checkClientEquipments(clientId) {
  const d = devices[clientId]; if (!d || !d.equipments) return;
  for (const eq of d.equipments) {
    if (!eq.ip) continue;
    try {
      const res  = await fetch('/check', {
        method : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body   : JSON.stringify({ ip: eq.ip }),
      });
      const data = await res.json();
      eq.status = data.alive ? 'up' : 'down';
    } catch { eq.status = 'unknown'; }
  }
  if (selectedId === clientId) renderEquipList(clientId);
}

/* ══════════════════════════════════════════════════════
   AJOUT CLIENT
══════════════════════════════════════════════════════ */
document.getElementById('addClientBtn').addEventListener('click', async () => {
  const name     = document.getElementById('addName').value.trim();
  const ip       = document.getElementById('addIp').value.trim();
  const address  = document.getElementById('addAddress').value.trim();
  const phone    = document.getElementById('addPhone').value.trim();
  const cEmail   = document.getElementById('addContactEmail').value.trim();
  const port     = document.getElementById('addPort').value.trim();
  const contract = document.getElementById('addContract').value;
  const interval = parseInt(document.getElementById('addInterval').value) || 30;
  const email    = document.getElementById('addEmail').value.trim();

  if (!name || !ip) { showToast('⚠️ Nom et IP requis', 'down'); return; }

  showToast('⏳ Positionnement géographiques (Alsace)…', 'info');

  let lat = null, lng = null;
  if (address) {
    const coords = await geocode(address);
    if (coords) { lat = coords.lat; lng = coords.lng; }
  }

  const id = 'dev_' + Date.now();
  const device = {
    id, name, ip,
    port          : port ? parseInt(port) : null,
    address, phone, contactEmail: cEmail,
    contractType  : contract,
    checkInterval : interval,
    emailAlert    : email,
    pingActive    : true,
    status        : 'unknown',
    statusSince   : new Date().toISOString(),
    history       : [],
    latency       : null,
    lastCheck     : null,
    equipments    : [],
  };

  devices[id] = device;
  clientImages[id] = { floorplan: null, topo: null, rack: null };

  addMarker(device);
  startMonitor(id);
  updateStats();
  updateGlobalStatus();
  renderList();
  saveDevices();

  /* Vider les entrées */
  ['addName','addIp','addAddress','addPhone','addContactEmail','addPort','addEmail'].forEach(fid => {
    document.getElementById(fid).value = '';
  });

  showToast(`✅ Client ${name} enregistré`, 'up');
});

/* ══════════════════════════════════════════════════════
   PANNEAU DE CONFIGURATION INDIVIDUEL (DÉTAILS CLIENT)
══════════════════════════════════════════════════════ */
function openDetailPanel(id) {
  selectedId = id;
  const d = devices[id]; if (!d) return;

  switchDetailTab('info');
  refreshInfoPane(id);

  document.getElementById('detailPanel').classList.add('open');
}

function closeDetailPanel() {
  document.getElementById('detailPanel').classList.remove('open');
  selectedId = null;
}
document.getElementById('closePanelBtn').addEventListener('click', closeDetailPanel);

document.querySelectorAll('.dtab').forEach(btn => {
  btn.addEventListener('click', () => {
    switchDetailTab(btn.dataset.tab);
    if (btn.dataset.tab === 'itinerary' && selectedId) loadItinerary(selectedId);
    if (btn.dataset.tab === 'equip'     && selectedId) renderEquipList(selectedId);
    if (btn.dataset.tab === 'plan'      && selectedId) renderPlanPane(selectedId);
    if (btn.dataset.tab === 'topo'      && selectedId) renderTopoPane(selectedId);
  });
});

function switchDetailTab(tab) {
  document.querySelectorAll('.dtab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.dtab-pane').forEach(p => p.classList.toggle('active', p.dataset.pane === tab));
}

function refreshInfoPane(id) {
  const d = devices[id]; if (!d) return;
  const set = (eid, val) => { const e = document.getElementById(eid); if (e) e.textContent = val ?? '—'; };

  const statusEl = document.getElementById('dStatus');
  if (statusEl) {
    statusEl.textContent = d.status === 'up' ? 'En ligne' : d.status === 'down' ? 'Hors ligne' : 'Supervision coupée';
    statusEl.style.color = d.status === 'up' ? 'var(--up)' : d.status === 'down' ? 'var(--down)' : 'var(--warn)';
  }

  const contractObj = CONTRACT_MAP[d.contractType || 'info'];
  set('dContractLabel', contractObj.label);
  
  const cDot = document.getElementById('detailContractBadge');
  if (cDot) cDot.style.backgroundColor = contractObj.color;

  set('dPhone', d.phone || 'Non renseigné');
  set('dContactEmail', d.contactEmail || 'Non renseigné');
  set('dLatency',   d.latency != null ? d.latency + ' ms' : '—');
  set('dSince',      d.statusSince ? timeSince(d.statusSince) : '—');
  set('dLastCheck', d.lastCheck ? new Date(d.lastCheck).toLocaleString('fr-FR') : '—');

  const uptime = d.history?.length
    ? Math.round(d.history.filter(v => v).length / d.history.length * 100) + '%'
    : '—';
  set('dUptime',   uptime);
  set('dInterval', d.checkInterval + ' s');
  set('dAddress',  d.address || '—');

  document.getElementById('detailName').textContent = d.name;
  document.getElementById('detailIp').textContent   = d.ip + (d.port ? ':' + d.port : '');
  document.getElementById('detailStatusDot').className = 'status-dot-lg ' + (d.status || 'unknown');
  
  // Synchro checkbox etat options ping
  document.getElementById('dPingToggle').checked = d.pingActive !== false;

  renderSparkline(d.history || [], document.getElementById('detailSparkline'));
}

function timeSince(iso) {
  const diff = Math.floor((Date.now() - new Date(iso)) / 1000);
  if (diff < 60)    return diff + 's';
  if (diff < 3600)  return Math.floor(diff/60) + ' min';
  if (diff < 86400) return Math.floor(diff/3600) + 'h';
  return Math.floor(diff/86400) + 'j';
}

/* ══════════════════════════════════════════════════════
   PLANS / TOPOLOGIES / BAIES RACKS
══════════════════════════════════════════════════════ */
function renderPlanPane(id) {
  const img = clientImages[id]?.floorplan;
  document.getElementById('floorplanEmpty').style.display   = img ? 'none'  : 'flex';
  document.getElementById('floorplanImgWrap').style.display = img ? 'block' : 'none';
  document.getElementById('clearFloorplanBtn').style.display = img ? 'inline-block' : 'none';
  if (img) document.getElementById('floorplanImg').src = img;
}

document.getElementById('uploadFloorplan').addEventListener('change', e => {
  const file = e.target.files[0]; if (!file || !selectedId) return;
  readImage(file, b64 => {
    clientImages[selectedId].floorplan = b64;
    renderPlanPane(selectedId);
    saveDevices();
    showToast('🖼️ Plan de secours importé', 'info');
  });
  e.target.value = '';
});

function renderTopoPane(id) {
  const img = clientImages[id]?.topo;
  document.getElementById('topoEmpty').style.display    = img ? 'none'  : 'flex';
  document.getElementById('topoImgWrap').style.display  = img ? 'block' : 'none';
  document.getElementById('clearTopoBtn').style.display = img ? 'inline-block' : 'none';
  if (img) document.getElementById('topoImg').src = img;
}

document.getElementById('uploadTopo').addEventListener('change', e => {
  const file = e.target.files[0]; if (!file || !selectedId) return;
  readImage(file, b64 => {
    clientImages[selectedId].topo = b64;
    renderTopoPane(selectedId);
    saveDevices();
    showToast('🖼️ Schéma de topologie lié', 'info');
  });
  e.target.value = '';
});

function openRackModal(clientId) {
  currentEquipClientId = clientId;
  const d = devices[clientId]; if (!d) return;
  document.getElementById('rackModalTitle').textContent = `Baie Rack — ${d.name}`;

  const img = clientImages[clientId]?.rack;
  document.getElementById('rackEmpty').style.display    = img ? 'none'  : 'flex';
  document.getElementById('rackImgWrap').style.display  = img ? 'block' : 'none';
  document.getElementById('rackFooter').style.display   = img ? 'flex'  : 'none';
  if (img) {
    document.getElementById('rackImg').src = img;
    renderRackLeds(clientId);
  }
  openModal('rackModal');
}

document.getElementById('uploadRack').addEventListener('change', e => {
  const file = e.target.files[0]; if (!file || !currentEquipClientId) return;
  readImage(file, b64 => {
    const id = currentEquipClientId;
    clientImages[id].rack = b64;
    document.getElementById('rackImg').src = b64;
    document.getElementById('rackEmpty').style.display   = 'none';
    document.getElementById('rackImgWrap').style.display = 'block';
    document.getElementById('rackFooter').style.display  = 'flex';
    renderRackLeds(id);
    saveDevices();
    showToast('🖼️ Photo de la baie enregistrée', 'info');
  });
  e.target.value = '';
});

function renderRackLeds(clientId) {
  const d      = devices[clientId]; if (!d) return;
  const wrap   = document.getElementById('rackLeds');
  wrap.innerHTML = '';

  (d.equipments || []).forEach((eq) => {
    if (eq.rackX === undefined || eq.rackY === undefined) return;
    const led = document.createElement('div');
    led.className = `rack-led ${eq.status || 'unknown'}`;
    led.style.left = eq.rackX + '%';
    led.style.top  = eq.rackY + '%';
    led.title = `${eq.name} [${eq.type}] — Statut: ${eq.status || '?'}`;
    led.addEventListener('click', (e) => {
      e.stopPropagation();
      showToast(`Équipement: ${eq.name} est ${eq.status.toUpperCase()}`, eq.status === 'up' ? 'up' : 'down');
    });
    wrap.appendChild(led);
  });
}

function addRackLed() {
  const id = currentEquipClientId; if (!id) return;
  const d  = devices[id]; if (!d) return;

  const eq = d.equipments.find(e => e.rackX === undefined);
  if (!eq) {
    showToast('⚠️ Aucun équipement libre. Ajoutez-en un d\'abord.', 'down');
    return;
  }

  showToast('🖱️ Cliquez sur la photo de la baie pour y positionner la LED', 'info');

  const imgEl = document.getElementById('rackImg');
  const handler = (e) => {
    const rect = imgEl.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width  * 100).toFixed(1);
    const y = ((e.clientY - rect.top)  / rect.height * 100).toFixed(1);

    eq.rackX = parseFloat(x); 
    eq.rackY = parseFloat(y);

    renderRackLeds(id);
    saveDevices();
    imgEl.removeEventListener('click', handler);
    showToast(`📍 LED assignée pour ${eq.name}`, 'up');
  };
  imgEl.addEventListener('click', handler);
}

/* ══════════════════════════════════════════════════════
   GESTION COMPOSANTS INTERNES ÉQUIPEMENTS
══════════════════════════════════════════════════════ */
function openAddEquipModal() {
  currentEquipClientId = selectedId;
  openModal('addEquipModal');
}

function saveEquip() {
  const id   = currentEquipClientId || selectedId; if (!id) return;
  const d    = devices[id]; if (!d) return;
  const name = document.getElementById('equipName').value.trim();
  const ip   = document.getElementById('equipIp').value.trim();
  const type = document.getElementById('equipType').value;
  const note = document.getElementById('equipNote').value.trim();
  if (!name) { showToast('⚠️ Nom requis', 'down'); return; }

  if (!d.equipments) d.equipments = [];
  d.equipments.push({ id: 'eq_'+Date.now(), name, ip, type, note, status: 'unknown' });
  saveDevices();
  renderEquipList(id);
  closeModal('addEquipModal');
  
  document.getElementById('equipName').value = '';
  document.getElementById('equipIp').value   = '';
  document.getElementById('equipNote').value = '';
  
  showToast(`✅ Équipement ${name} associé`, 'up');
  if (ip) checkClientEquipments(id);
}

function renderEquipList(clientId) {
  const d = devices[clientId];
  const el = document.getElementById('equipList');
  if (!el) return;

  if (!d?.equipments?.length) {
    el.innerHTML = `<div class="empty-state"><div style="font-size:32px">🖥️</div><div>Aucun équipement lié</div></div>`;
    return;
  }

  el.innerHTML = d.equipments.map((eq, idx) => `
    <div class="equip-item">
      <div class="equip-led ${eq.status || 'unknown'}"></div>
      <div class="equip-info">
        <div class="equip-name">${eq.name} <span style="font-size:10px;color:var(--text-dim)">${eq.type}</span></div>
        <div class="equip-ip">${eq.ip || 'Pas d\'adresse IP'} ${eq.note ? '· ' + eq.note : ''}</div>
      </div>
      <button class="equip-del" onclick="deleteEquip('${clientId}', ${idx})" title="Supprimer">✕</button>
    </div>
  `).join('');
}

function deleteEquip(clientId, idx) {
  const d = devices[clientId]; if (!d) return;
  d.equipments.splice(idx, 1);
  saveDevices();
  renderEquipList(clientId);
}

/* ══════════════════════════════════════════════════════
   ITINÉRAIRE DEPUIS LE BUREAU CENTRAL EN ALSACE
══════════════════════════════════════════════════════ */
async function loadItinerary(id) {
  const d = devices[id]; if (!d) return;
  const infoEl    = document.getElementById('itineraryInfo');
  const mapEl     = document.getElementById('itineraryMap');
  const detailEl = document.getElementById('itineraryDetails');

  if (!d.lat || !d.lng) {
    infoEl.innerHTML = '<div style="font-size:36px">📍</div><div>Adresse non géolocalisée</div>';
    infoEl.style.display = 'flex'; mapEl.style.display = 'none'; detailEl.style.display = 'none';
    return;
  }

  infoEl.innerHTML = '<div style="font-size:24px">⏳</div><div>Interrogation du serveur OSRM…</div>';
  infoEl.style.display = 'flex';

  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${BUREAU.lng},${BUREAU.lat};${d.lng},${d.lat}?overview=full&geometries=geojson`;
    const res  = await fetch(url);
    const data = await res.json();
    const route = data.routes?.[0];

    if (!route) throw new Error();

    const dist = (route.distance / 1000).toFixed(1) + ' km';
    const dur  = formatDuration(route.duration);

    document.getElementById('itiDistance').textContent = dist;
    document.getElementById('itiDuration').textContent = dur;
    document.getElementById('itiGoogleLink').href = `https://www.google.com/maps/dir/?api=1&origin=${BUREAU.lat},${BUREAU.lng}&destination=${d.lat},${d.lng}&travelmode=driving`;

    infoEl.style.display  = 'none';
    mapEl.style.display   = 'block';
    detailEl.style.display = 'block';

    if (!itiMap) {
      itiMap = L.map('itineraryMap', { zoomControl: false }).setView([d.lat, d.lng], 10);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(itiMap);
    } else {
      itiMap.eachLayer(l => { if (l instanceof L.Polyline || l instanceof L.Marker) itiMap.removeLayer(l); });
    }

    const geojson = L.geoJSON(route.geometry, { style: { color: 'var(--accent)', weight: 5, opacity: 0.8 } }).addTo(itiMap);
    L.marker([BUREAU.lat, BUREAU.lng]).bindTooltip('Notre Bureau').addTo(itiMap);
    L.marker([d.lat, d.lng]).bindTooltip(d.name).addTo(itiMap);
    itiMap.fitBounds(geojson.getBounds(), { padding: [15, 15] });

  } catch (e) {
    infoEl.innerHTML = `<div>❌ Erreur de calcul OSRM</div>`;
  }
}

function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}min` : `${m} min`;
}

/* ══════════════════════════════════════════════════════
   MODIFIER CLIENT
══════════════════════════════════════════════════════ */
function panelEdit() {
  const id = selectedId; if (!id) return;
  const d  = devices[id]; if (!d) return;
  editingId = id;
  
  const set = (eid, v) => { const e = document.getElementById(eid); if (e) e.value = v ?? ''; };
  set('editName',     d.name);
  set('editIp',        d.ip);
  set('editPort',      d.port || '');
  set('editAddress',   d.address || '');
  set('editPhone',     d.phone || '');
  set('editContactEmail', d.contactEmail || '');
  set('editContract',  d.contractType || 'info');
  set('editEmail',     d.emailAlert || '');
  set('editInterval',  d.checkInterval || 30);
  
  openModal('editModal');
}

async function saveEdit() {
  const id = editingId; if (!id) return;
  const d  = devices[id]; if (!d) return;

  d.name          = document.getElementById('editName').value.trim();
  d.ip            = document.getElementById('editIp').value.trim();
  d.port          = document.getElementById('editPort').value ? parseInt(document.getElementById('editPort').value) : null;
  d.phone         = document.getElementById('editPhone').value.trim();
  d.contactEmail  = document.getElementById('editContactEmail').value.trim();
  d.contractType  = document.getElementById('editContract').value;
  d.emailAlert    = document.getElementById('editEmail').value.trim();
  d.checkInterval = parseInt(document.getElementById('editInterval').value) || 30;

  const newAddr = document.getElementById('editAddress').value.trim();
  if (newAddr !== d.address) {
    d.address = newAddr;
    const coords = await geocode(newAddr);
    if (coords) { d.lat = coords.lat; d.lng = coords.lng; }
  }

  addMarker(d);
  startMonitor(id);
  refreshInfoPane(id);
  renderList();
  saveDevices();
  closeModal('editModal');
  showToast(`✏️ Modifications de ${d.name} enregistrées`, 'up');
  editingId = null;
}

/* ══════════════════════════════════════════════════════
   SUPPRIMER CLIENT
══════════════════════════════════════════════════════ */
function panelDelete() {
  const id = selectedId; if (!id) return;
  const d  = devices[id]; if (!d) return;
  if (!confirm(`Confirmez-vous la suppression définitive du client : ${d.name} ?`)) return;

  if(monitors[id]) clearInterval(monitors[id]);
  clearTimeout(d._emailTimer);
  delete monitors[id];
  delete devices[id];
  delete clientImages[id];
  if (markers[id]) { map.removeLayer(markers[id]); delete markers[id]; }

  closeDetailPanel();
  updateStats();
  updateGlobalStatus();
  renderList();
  saveDevices();
  showToast(`🗑️ ${d.name} effacé de l'infrastructure`, 'down');
}

function panelRefresh() {
  if (selectedId) { checkDevice(selectedId); showToast('🔄 Requête ICMP Ping lancée', 'info'); }
}

document.getElementById('refreshAllBtn').addEventListener('click', () => {
  Object.keys(devices).forEach(id => checkDevice(id));
  showToast('🔄 Lancement d\'un balayage réseau global…', 'info');
});

/* ══════════════════════════════════════════════════════
   RENDU CARTE LISTE CLIENTS
══════════════════════════════════════════════════════ */
function renderList() {
  const el = document.getElementById('deviceListContainer');
  if (!el) return;
  const all = Object.values(devices);

  if (!all.length) {
    el.innerHTML = `<div class="empty-state">📡 Aucun client enregistré dans la base de données.</div>`;
    return;
  }

  el.innerHTML = all.map(d => {
    const c = d.status === 'up' ? 'var(--up)' : d.status === 'down' ? 'var(--down)' : 'var(--warn)';
    const contractObj = CONTRACT_MAP[d.contractType || 'info'];
    const uptime = d.history?.length ? Math.round(d.history.filter(v=>v).length / d.history.length * 100) + '%' : '—';
    
    return `
      <div class="device-card" onclick="openDetailPanel('${d.id}'); switchView('topology')">
        <div class="device-card-header">
          <div>
            <div class="device-card-name">
              <span class="contract-dot ${contractObj.class}" title="${contractObj.label}"></span>
              ${d.name}
            </div>
            <div class="device-card-ip">${d.ip}${d.port ? ':'+d.port : ''}</div>
          </div>
          <div class="device-status-badge" style="background:${c}15; color:${c}; border:1px solid ${c}30">
            ${d.status === 'up' ? 'ONLINE' : d.status === 'down' ? 'OFFLINE' : 'STOPPED'}
          </div>
        </div>
        <div class="device-card-meta">
          <span>📍 ${d.address || 'Alsace'}</span>
          <span>📞 ${d.phone || 'N/A'}</span>
          <span>⏱️ ${d.latency != null ? d.latency+' ms' : '—'}</span>
          <span>📊 Uptime: ${uptime}</span>
        </div>
      </div>`;
  }).join('');
}

/* ══════════════════════════════════════════════════════
   RENDU ET RENDEMENT DES LOGS AVEC FILTRAGE AVANCÉ
══════════════════════════════════════════════════════ */
function renderLogsTable() {
  const tbody = document.getElementById('logsTableBody');
  if (!tbody) return;

  const fClient = document.getElementById('filterClient').value.toLowerCase().trim();
  const fIp = document.getElementById('filterIp').value.toLowerCase().trim();
  const fDate = document.getElementById('filterDate').value; // format YYYY-MM-DD

  const filtered = pingLogs.filter(log => {
    if (fClient && !log.clientName.toLowerCase().includes(fClient)) return false;
    if (fIp && !log.ip.toLowerCase().includes(fIp)) return false;
    if (fDate) {
      const logDate = log.time.split('T')[0];
      if (logDate !== fDate) return false;
    }
    return true;
  });

  if (!filtered.length) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; color:var(--text-dim); padding:20px;">Aucun log trouvé dans le journal de filtrage</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map(log => {
    return `
      <tr>
        <td style="font-variant-numeric: tabular-nums;">${new Date(log.time).toLocaleString('fr-FR')}</td>
        <td><b>${log.clientName}</b></td>
        <td style="color:var(--text-dim);">${log.ip}</td>
        <td><span class="log-event-badge ${log.event}">${log.event.toUpperCase()}</span></td>
        <td style="font-weight:bold; color:${log.event === 'up' ? 'var(--up)' : 'var(--down)'}">${log.latency}</td>
      </tr>
    `;
  }).join('');
}

// Event listeners des inputs de filtrage pour rafraîchissement à la saisie
document.getElementById('filterClient').addEventListener('input', renderLogsTable);
document.getElementById('filterIp').addEventListener('input', renderLogsTable);
document.getElementById('filterDate').addEventListener('change', renderLogsTable);
document.getElementById('clearFiltersBtn').addEventListener('click', () => {
  document.getElementById('filterClient').value = '';
  document.getElementById('filterIp').value = '';
  document.getElementById('filterDate').value = '';
  renderLogsTable();
});

/* ══════════════════════════════════════════════════════
   EMAIL ALERTE PROXY OUTBOUND
══════════════════════════════════════════════════════ */
async function sendEmailAlert(device, type) {
  try {
    await fetch('/alert-email', {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify({
        to: device.emailAlert, device: device.name,
        ip: device.ip, type, time: new Date().toISOString(),
      }),
    });
  } catch (e) { console.warn(e); }
}

/* ══════════════════════════════════════════════════════
   SPARKLINE & TOASTERS HELPERS
══════════════════════════════════════════════════════ */
function renderSparkline(history, el) {
  if (!el) return; el.innerHTML = '';
  if (!history?.length) { el.innerHTML = '<span style="color:var(--text-dim)">Données d\'analyse en cours...</span>'; return; }

  const w = 270, h = 34;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', w); svg.setAttribute('height', h);
  svg.style.display = 'block';

  const barW = Math.max(2, Math.floor(w / history.length) - 1);
  history.forEach((val, i) => {
    const r = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    r.setAttribute('x',       Math.floor(i * (w / history.length)));
    r.setAttribute('y',       val ? 4 : 18);
    r.setAttribute('width',   barW);
    r.setAttribute('height',  val ? 26 : 12);
    r.setAttribute('rx',      1);
    r.setAttribute('fill',    val ? '#10b981' : '#ef4444');
    r.setAttribute('opacity', '0.8');
    svg.appendChild(r);
  });
  el.appendChild(svg);
}

function showToast(message, type = 'info') {
  const c = document.getElementById('toastContainer');
  const t = document.createElement('div');
  t.className = `toast ${type}`; t.textContent = message;
  c.appendChild(t);
  setTimeout(() => {
    t.style.transition = 'opacity .3s'; t.style.opacity = '0';
    setTimeout(() => t.remove(), 300);
  }, 3500);
}

function openModal(id)  { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }
function triggerUpload(type) {
  const map = { floorplan: 'uploadFloorplan', topo: 'uploadTopo', rack: 'uploadRack' };
  document.getElementById(map[type])?.click();
}

function clearImage(type) {
  const id = selectedId || currentEquipClientId; if (!id) return;
  clientImages[id][type] = null;
  if (type === 'floorplan') renderPlanPane(id);
  if (type === 'topo')      renderTopoPane(id);
  if (type === 'rack') {
    document.getElementById('rackImgWrap').style.display = 'none';
    document.getElementById('rackEmpty').style.display   = 'flex';
    document.getElementById('rackFooter').style.display  = 'none';
  }
  saveDevices();
  showToast('🗑️ Image supprimée de la base', 'down');
}

function readImage(file, cb) {
  const r = new FileReader(); r.onload = e => cb(e.target.result); r.readAsDataURL(file);
}

/* ══════════════════════════════════════════════════════
   PERSISTENCE LOCALSTORAGE
══════════════════════════════════════════════════════ */
function saveDevices() {
  try {
    const toSave = {};
    Object.entries(devices).forEach(([k, d]) => {
      const { _emailTimer, ...rest } = d;
      toSave[k] = rest;
    });
    localStorage.setItem('comunic_v3_devices', JSON.stringify(toSave));
    localStorage.setItem('comunic_v3_images',  JSON.stringify(clientImages));
    localStorage.setItem('comunic_v3_logs',    JSON.stringify(pingLogs));
  } catch (e) {}
}

function loadDevices() {
  try {
    const raw = localStorage.getItem('comunic_v3_devices');
    const img = localStorage.getItem('comunic_v3_images');
    const lgs = localStorage.getItem('comunic_v3_logs');
    if (raw) Object.assign(devices, JSON.parse(raw));
    if (img) Object.assign(clientImages, JSON.parse(img));
    if (lgs) {
      const loadedLogs = JSON.parse(lgs);
      pingLogs.push(...loadedLogs);
      const badge = document.getElementById('alertBadge');
      if (badge && pingLogs.length > 0) {
        badge.style.display = 'inline';
        badge.textContent = pingLogs.length;
      }
    }
  } catch (e) {}
}

/* ══════════════════════════════════════════════════════
   INITIALISATION (BOOT)
══════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  try {
    const savedBureau = localStorage.getItem('comunic_bureau_v2');
    if (savedBureau) Object.assign(BUREAU, JSON.parse(savedBureau));
  } catch(e) {}

  initMap();
  loadDevices();

  Object.values(devices).forEach(d => {
    if (!clientImages[d.id]) clientImages[d.id] = { floorplan: null, topo: null, rack: null };
    if (!d.equipments)        d.equipments = [];
    addMarker(d);
    startMonitor(d.id);
  });

  updateStats();
  updateGlobalStatus();
});
