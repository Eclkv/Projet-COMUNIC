/* =====================================================
   COMUNIC · Network Monitor PRO — app.js
   ===================================================== */

/* ══════════════════════════════════════════════════════
   STATE
══════════════════════════════════════════════════════ */
const devices      = {};   // { [id]: deviceObj }
const monitors     = {};   // { [id]: intervalId }
const alerts       = [];
const markers      = {};   // { [id]: L.marker }
const clientImages = {};   // { [id]: { floorplan, topo, rack } }

let selectedId  = null;
let editingId   = null;
let alertCount  = 0;
let map         = null;
let itiMap      = null;   // carte itinéraire
let currentEquipClientId = null;

/* ── Adresse bureau (pour itinéraire) ─────────────── */
let BUREAU = { lat: 48.5734, lng: 7.7521, label: 'Strasbourg (bureau)' };

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
  if (view === 'alerts')   renderAlerts();
}

document.querySelectorAll('.nav-btn[data-view]').forEach(btn => {
  btn.addEventListener('click', () => switchView(btn.dataset.view));
});

/* ══════════════════════════════════════════════════════
   MAP (Leaflet) — centrée sur l'Alsace
══════════════════════════════════════════════════════ */
function initMap() {
  map = L.map('map', { zoomControl: true }).setView([48.5, 7.5], 9);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom    : 19,
    attribution: '© OpenStreetMap',
  }).addTo(map);
}

/* Centrer la carte sur une adresse */
document.getElementById('centerMapBtn').addEventListener('click', async () => {
  const addr = document.getElementById('centerAddress').value.trim();
  if (!addr) return;
  const coords = await geocode(addr);
  if (coords) {
    map.setView([coords.lat, coords.lng], 13);
    /* Mémoriser comme point de départ itinéraire */
    BUREAU = { lat: coords.lat, lng: coords.lng, label: addr };
    /* Sauvegarder dans localStorage */
    try { localStorage.setItem('comunic_bureau', JSON.stringify(BUREAU)); } catch(e) {}
    showToast('🎯 Carte centrée — bureau mis à jour', 'info');
  } else {
    showToast('❌ Adresse introuvable', 'down');
  }
});

/* ── Icône marqueur ──────────────────────────────── */
function makeIcon(status) {
  const color =
    status === 'up'   ? '#10b981' :
    status === 'down' ? '#ef4444' : '#f59e0b';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="36" viewBox="0 0 28 36">
    <path d="M14 0C6.268 0 0 6.268 0 14c0 9 14 22 14 22S28 23 28 14C28 6.268 21.732 0 14 0z"
      fill="${color}" stroke="#fff" stroke-width="1.5"/>
    <circle cx="14" cy="14" r="6" fill="#fff" opacity="0.9"/>
  </svg>`;
  return L.divIcon({ html: svg, iconSize: [28,36], iconAnchor: [14,36], className: '' });
}

function addMarker(device) {
  if (!device.lat || !device.lng) return;
  if (markers[device.id]) map.removeLayer(markers[device.id]);

  const marker = L.marker([device.lat, device.lng], {
    icon : makeIcon(device.status || 'unknown'),
    title: device.name,
  }).addTo(map);

  marker.bindPopup(`
    <div style="min-width:160px;font-size:12px">
      <strong style="font-size:13px">${device.name}</strong><br>
      <span style="color:#888">${device.ip}</span><br>
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
  markers[id].setIcon(makeIcon(d.status));
}

/* ══════════════════════════════════════════════════════
   GÉOCODAGE (proxy serveur pour éviter CORS)
══════════════════════════════════════════════════════ */
async function geocode(address) {
  try {
    const res  = await fetch(`/geocode?q=${encodeURIComponent(address)}`);
    const data = await res.json();
    if (data.lat && data.lng) return data;
    return null;
  } catch (e) {
    console.error('geocode error:', e);
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
    label.textContent = 'Aucun équipement';
    return;
  }
  const down = all.filter(d => d.status === 'down').length;
  if (down === 0) {
    dot.className    = 'pulse-dot all-up';
    label.textContent = '✅ Tout opérationnel';
    label.style.color = 'var(--up)';
  } else {
    dot.className    = 'pulse-dot has-down';
    label.textContent = `⚠️ ${down} hors ligne`;
    label.style.color = 'var(--down)';
  }
}

/* ══════════════════════════════════════════════════════
   MONITORING
══════════════════════════════════════════════════════ */
async function checkDevice(id) {
  const d = devices[id]; if (!d) return;
  try {
    const res  = await fetch('/check', {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify({ ip: d.ip, port: d.port || null }),
    });
    const data = await res.json();

    const prev   = d.status;
    const wasUp  = prev === 'up';
    d.status     = data.alive ? 'up' : 'down';
    d.latency    = data.latency;
    d.lastCheck  = new Date().toISOString();

    /* Timestamp de changement d'état */
    if (prev !== d.status) {
      d.statusSince = new Date().toISOString();
    }

    if (!d.history) d.history = [];
    d.history.push(data.alive ? 1 : 0);
    if (d.history.length > 60) d.history.shift();

    /* Alertes changement d'état */
    if (prev !== 'down' && d.status === 'down') {
      addAlert(id, 'down', `${d.name} est hors ligne`);
      /* Timer 5 min avant email */
      if (d.emailAlert) {
        clearTimeout(d._emailTimer);
        d._emailTimer = setTimeout(() => {
          if (devices[id]?.status === 'down') sendEmailAlert(d, 'down');
        }, 5 * 60 * 1000);
      }
    }
    if (prev === 'down' && d.status === 'up') {
      addAlert(id, 'up', `${d.name} est de nouveau en ligne`);
      clearTimeout(d._emailTimer);
      if (d.emailAlert) sendEmailAlert(d, 'up');
    }

    /* Mise à jour visuelle */
    updateMarkerVisual(id);
    updateStats();
    updateGlobalStatus();
    if (selectedId === id) refreshInfoPane(id);

    /* Mise à jour LEDs équipements du client */
    checkClientEquipments(id);

    saveDevices();
  } catch (e) {
    console.error('checkDevice error:', e);
  }
}

function startMonitor(id) {
  if (monitors[id]) clearInterval(monitors[id]);
  checkDevice(id);
  const ms = (devices[id]?.checkInterval || 30) * 1000;
  monitors[id] = setInterval(() => checkDevice(id), ms);
}

/* Vérification individuelle des équipements d'un client */
async function checkClientEquipments(clientId) {
  const d = devices[clientId]; if (!d || !d.equipments) return;
  for (const eq of d.equipments) {
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
  const port     = document.getElementById('addPort').value.trim();
  const interval = parseInt(document.getElementById('addInterval').value) || 30;
  const email    = document.getElementById('addEmail').value.trim();

  if (!name || !ip) { showToast('⚠️ Nom et IP requis', 'down'); return; }

  showToast('⏳ Géocodage en cours…', 'info');

  let lat = null, lng = null;
  if (address) {
    const coords = await geocode(address);
    if (coords) { lat = coords.lat; lng = coords.lng; }
  }

  const id = 'dev_' + Date.now();
  const device = {
    id, name, ip,
    port          : port ? parseInt(port) : null,
    address,
    lat, lng,
    checkInterval : interval,
    emailAlert    : email,
    status        : 'unknown',
    statusSince   : new Date().toISOString(),
    history       : [],
    latency       : null,
    lastCheck     : null,
    equipments    : [],
  };

  devices[id]      = device;
  clientImages[id] = { floorplan: null, topo: null, rack: null };

  addMarker(device);
  startMonitor(id);
  updateStats();
  updateGlobalStatus();
  renderList();
  saveDevices();

  /* Reset form */
  ['addName','addIp','addAddress','addPort','addEmail'].forEach(fid => {
    document.getElementById(fid).value = '';
  });

  showToast(`✅ ${name} ajouté`, 'up');
});

/* ══════════════════════════════════════════════════════
   DETAIL PANEL
══════════════════════════════════════════════════════ */
function openDetailPanel(id) {
  selectedId = id;
  const d = devices[id]; if (!d) return;

  /* Statut dot header */
  const dot = document.getElementById('detailStatusDot');
  dot.className = 'status-dot-lg ' + (d.status || 'unknown');

  document.getElementById('detailName').textContent = d.name;
  document.getElementById('detailIp').textContent   = d.ip + (d.port ? ':' + d.port : '');

  /* Activer onglet info par défaut */
  switchDetailTab('info');

  document.getElementById('detailPanel').classList.add('open');
}

function closeDetailPanel() {
  document.getElementById('detailPanel').classList.remove('open');
  selectedId = null;
}

document.getElementById('closePanelBtn').addEventListener('click', closeDetailPanel);

/* Onglets internes */
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

/* ── Onglet INFO ─────────────────────────────────── */
function refreshInfoPane(id) {
  const d = devices[id]; if (!d) return;
  const set = (eid, val) => {
    const e = document.getElementById(eid);
    if (e) e.textContent = val ?? '—';
  };

  const statusEl = document.getElementById('dStatus');
  if (statusEl) {
    statusEl.textContent = d.status || 'inconnu';
    statusEl.style.color =
      d.status === 'up'   ? 'var(--up)'   :
      d.status === 'down' ? 'var(--down)' : 'var(--warn)';
  }

  set('dLatency',   d.latency != null ? d.latency + ' ms' : '—');
  set('dSince',     d.statusSince ? timeSince(d.statusSince) : '—');
  set('dLastCheck', d.lastCheck   ? new Date(d.lastCheck).toLocaleString('fr-FR') : '—');

  const uptime = d.history?.length
    ? Math.round(d.history.filter(v => v).length / d.history.length * 100) + '%'
    : '—';
  set('dUptime',   uptime);
  set('dInterval', (d.checkInterval || 30) + ' s');
  set('dAddress',  d.address || '—');

  const dot = document.getElementById('detailStatusDot');
  if (dot) dot.className = 'status-dot-lg ' + (d.status || 'unknown');

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
   PLAN (floorplan)
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
    showToast('🖼️ Plan importé', 'info');
  });
  e.target.value = '';
});

/* ══════════════════════════════════════════════════════
   TOPOLOGIE
══════════════════════════════════════════════════════ */
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
    showToast('🖼️ Schéma importé', 'info');
  });
  e.target.value = '';
});

/* ══════════════════════════════════════════════════════
   RACK MODAL
══════════════════════════════════════════════════════ */
// Ouverture depuis une zone cliquable du plan
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
    showToast('🖼️ Photo importée', 'info');
  });
  e.target.value = '';
});

function renderRackLeds(clientId) {
  const d      = devices[clientId]; if (!d) return;
  const wrap   = document.getElementById('rackLeds');
  const imgEl  = document.getElementById('rackImg');
  wrap.innerHTML = '';

  (d.equipments || []).forEach((eq, idx) => {
    if (!eq.rackX && !eq.rackY) return;  // pas de position définie
    const led = document.createElement('div');
    led.className = `rack-led ${eq.status || 'unknown'}`;
    led.style.left = eq.rackX + '%';
    led.style.top  = eq.rackY + '%';
    led.title = `${eq.name} — ${eq.status || '?'}`;
    led.addEventListener('click', () =>
      showToast(`${eq.name} : ${eq.status || 'inconnu'}`, eq.status === 'up' ? 'up' : 'down'));
    wrap.appendChild(led);
  });
}

/* Ajouter une LED sur le rack en cliquant sur l'image */
function addRackLed() {
  const id = currentEquipClientId; if (!id) return;
  const d  = devices[id]; if (!d) return;

  if (!d.equipments?.length) {
    showToast('⚠️ Ajoutez d\'abord des équipements dans l\'onglet Équipements', 'down');
    return;
  }

  showToast('🖱️ Cliquez sur la photo pour placer la LED', 'info');

  const imgEl = document.getElementById('rackImg');
  const handler = (e) => {
    const rect = imgEl.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width  * 100).toFixed(1);
    const y = ((e.clientY - rect.top)  / rect.height * 100).toFixed(1);

    /* Attribuer au premier équipement sans position */
    const eq = d.equipments.find(e => !e.rackX && !e.rackY);
    if (eq) { eq.rackX = parseFloat(x); eq.rackY = parseFloat(y); }

    renderRackLeds(id);
    saveDevices();
    imgEl.removeEventListener('click', handler);
  };
  imgEl.addEventListener('click', handler);
}

/* ══════════════════════════════════════════════════════
   ÉQUIPEMENTS
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
  showToast(`✅ ${name} ajouté`, 'up');
  if (ip) checkClientEquipments(id);
}

function renderEquipList(clientId) {
  const d = devices[clientId];
  const el = document.getElementById('equipList');
  if (!el) return;

  if (!d?.equipments?.length) {
    el.innerHTML = `<div class="empty-state"><div style="font-size:32px">🖥️</div><div>Aucun équipement</div></div>`;
    return;
  }

  el.innerHTML = d.equipments.map((eq, idx) => `
    <div class="equip-item">
      <div class="equip-led ${eq.status || 'unknown'}"></div>
      <div class="equip-info">
        <div class="equip-name">${eq.name} <span style="font-size:10px;color:var(--text-dim)">${eq.type}</span></div>
        <div class="equip-ip">${eq.ip || 'Pas d\'IP'} ${eq.note ? '· ' + eq.note : ''}</div>
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
   ITINÉRAIRE (OSRM open-source)
══════════════════════════════════════════════════════ */
async function loadItinerary(id) {
  const d = devices[id]; if (!d) return;
  const infoEl   = document.getElementById('itineraryInfo');
  const mapEl    = document.getElementById('itineraryMap');
  const detailEl = document.getElementById('itineraryDetails');

  if (!d.lat || !d.lng) {
    infoEl.innerHTML = '<div style="font-size:36px">📍</div><div>Adresse non géolocalisée</div>';
    infoEl.style.display = 'flex'; mapEl.style.display = 'none'; detailEl.style.display = 'none';
    return;
  }

  infoEl.innerHTML = '<div style="font-size:28px">⏳</div><div>Calcul en cours…</div>';
  infoEl.style.display = 'flex';

  try {
    /* OSRM public — données ne sortent que lat/lng, pas le nom du client */
    const url = `https://router.project-osrm.org/route/v1/driving/`
      + `${BUREAU.lng},${BUREAU.lat};${d.lng},${d.lat}`
      + `?overview=full&geometries=geojson`;

    const res  = await fetch(url);
    const data = await res.json();
    const route = data.routes?.[0];

    if (!route) throw new Error('Pas de route');

    const dist = (route.distance / 1000).toFixed(1) + ' km';
    const dur  = formatDuration(route.duration);

    document.getElementById('itiDistance').textContent = dist;
    document.getElementById('itiDuration').textContent = dur;
    document.getElementById('itiGoogleLink').href =
      `https://www.google.com/maps/dir/?api=1&origin=${BUREAU.lat},${BUREAU.lng}&destination=${d.lat},${d.lng}&travelmode=driving`;

    infoEl.style.display  = 'none';
    mapEl.style.display   = 'block';
    detailEl.style.display = 'block';

    /* Carte itinéraire */
    if (!itiMap) {
      itiMap = L.map('itineraryMap', { zoomControl: false }).setView([d.lat, d.lng], 10);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap',
      }).addTo(itiMap);
    } else {
      itiMap.eachLayer(l => { if (l instanceof L.Polyline || l instanceof L.Marker) itiMap.removeLayer(l); });
    }

    const geojson = L.geoJSON(route.geometry, { style: { color: '#00d4ff', weight: 4, opacity: 0.8 } }).addTo(itiMap);
    L.marker([BUREAU.lat, BUREAU.lng]).bindTooltip('Bureau').addTo(itiMap);
    L.marker([d.lat, d.lng]).bindTooltip(d.name).addTo(itiMap);
    itiMap.fitBounds(geojson.getBounds(), { padding: [20, 20] });

  } catch (e) {
    infoEl.innerHTML = `<div style="font-size:28px">❌</div><div>Impossible de calculer l'itinéraire</div>`;
    infoEl.style.display = 'flex'; mapEl.style.display = 'none'; detailEl.style.display = 'none';
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
  set('editIp',       d.ip);
  set('editPort',     d.port || '');
  set('editAddress',  d.address || '');
  set('editEmail',    d.emailAlert || '');
  set('editInterval', d.checkInterval || 30);
  openModal('editModal');
}

async function saveEdit() {
  const id = editingId; if (!id) return;
  const d  = devices[id]; if (!d) return;

  d.name          = document.getElementById('editName').value.trim();
  d.ip            = document.getElementById('editIp').value.trim();
  d.port          = document.getElementById('editPort').value ? parseInt(document.getElementById('editPort').value) : null;
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
  showToast(`✏️ ${d.name} mis à jour`, 'up');
  editingId = null;
}

/* ══════════════════════════════════════════════════════
   SUPPRIMER CLIENT
══════════════════════════════════════════════════════ */
function panelDelete() {
  const id = selectedId; if (!id) return;
  const d  = devices[id]; if (!d) return;
  if (!confirm(`Supprimer « ${d.name} » ?`)) return;

  clearInterval(monitors[id]);
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
  showToast(`🗑️ ${d.name} supprimé`, 'down');
}

/* ══════════════════════════════════════════════════════
   PING MANUEL
══════════════════════════════════════════════════════ */
function panelRefresh() {
  if (selectedId) {
    checkDevice(selectedId);
    showToast('🔄 Ping en cours…', 'info');
  }
}

document.getElementById('refreshAllBtn').addEventListener('click', () => {
  Object.keys(devices).forEach(id => checkDevice(id));
  showToast('🔄 Rafraîchissement global…', 'info');
});

/* ══════════════════════════════════════════════════════
   LISTE CLIENTS
══════════════════════════════════════════════════════ */
function renderList() {
  const el = document.getElementById('deviceListContainer');
  if (!el) return;
  const all = Object.values(devices);

  if (!all.length) {
    el.innerHTML = `
      <div class="empty-state" style="padding:60px 20px">
        <div style="font-size:48px">📡</div>
        <div>Aucun client surveillé</div>
        <div style="font-size:11px">Ajoutez un client depuis la sidebar</div>
      </div>`;
    return;
  }

  el.innerHTML = all.map(d => {
    const c = d.status === 'up' ? 'var(--up)' : d.status === 'down' ? 'var(--down)' : 'var(--warn)';
    const uptime = d.history?.length
      ? Math.round(d.history.filter(v=>v).length / d.history.length * 100) + '%'
      : '—';
    return `
      <div class="device-card" onclick="openDetailPanel('${d.id}'); switchView('topology')">
        <div class="device-card-header">
          <div>
            <div class="device-card-name">${d.name}</div>
            <div class="device-card-ip">${d.ip}${d.port ? ':'+d.port : ''}</div>
          </div>
          <div class="device-status-badge" style="background:${c}22;color:${c};border:1px solid ${c}44">
            ${d.status || 'inconnu'}
          </div>
        </div>
        <div class="device-card-meta">
          <span>📍 ${d.address || 'N/A'}</span>
          <span>⏱️ ${d.latency != null ? d.latency+' ms' : '—'}</span>
          <span>📊 ${uptime}</span>
          ${d.statusSince ? `<span>🕐 ${timeSince(d.statusSince)}</span>` : ''}
        </div>
      </div>`;
  }).join('');
}

/* ══════════════════════════════════════════════════════
   ALERTES
══════════════════════════════════════════════════════ */
function addAlert(deviceId, type, message) {
  alertCount++;
  alerts.unshift({ id: 'a_'+Date.now(), deviceId, type, message, time: new Date().toISOString() });
  if (alerts.length > 200) alerts.pop();

  const badge = document.getElementById('alertBadge');
  if (badge) { badge.style.display = 'inline'; badge.textContent = alertCount > 99 ? '99+' : alertCount; }
}

function renderAlerts() {
  const el = document.getElementById('view-alerts');
  if (!el) return;

  if (!alerts.length) {
    el.innerHTML = `
      <div class="empty-state" style="padding:60px 20px">
        <div style="font-size:48px">🔔</div>
        <div>Aucune alerte</div>
      </div>`;
    return;
  }

  el.innerHTML = alerts.map(a => {
    const d = devices[a.deviceId];
    return `
      <div class="alert-row ${a.type}">
        <div class="alert-time">${new Date(a.time).toLocaleString('fr-FR')}</div>
        <div class="alert-msg"><b>${d?.name || a.deviceId}</b> — ${a.message}</div>
        <div class="alert-type ${a.type}">${a.type.toUpperCase()}</div>
      </div>`;
  }).join('');
}

/* ══════════════════════════════════════════════════════
   EMAIL ALERTE
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
  } catch (e) { console.warn('Email alert failed:', e); }
}

/* ══════════════════════════════════════════════════════
   SPARKLINE
══════════════════════════════════════════════════════ */
function renderSparkline(history, el) {
  if (!el) return;
  el.innerHTML = '';

  if (!history?.length) {
    el.innerHTML = '<span style="color:var(--text-dim);font-size:11px">Pas encore de données</span>';
    return;
  }

  const w = 270, h = 38;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', w); svg.setAttribute('height', h);
  svg.style.display = 'block';

  const barW = Math.max(2, Math.floor(w / history.length) - 1);
  history.forEach((val, i) => {
    const r = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    r.setAttribute('x',       Math.floor(i * (w / history.length)));
    r.setAttribute('y',       val ? 4 : 20);
    r.setAttribute('width',   barW);
    r.setAttribute('height',  val ? 34 : 18);
    r.setAttribute('rx',      2);
    r.setAttribute('fill',    val ? '#10b981' : '#ef4444');
    r.setAttribute('opacity', '0.8');
    svg.appendChild(r);
  });
  el.appendChild(svg);
}

/* ══════════════════════════════════════════════════════
   TOAST
══════════════════════════════════════════════════════ */
function showToast(message, type = 'info') {
  const c = document.getElementById('toastContainer');
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = message;
  c.appendChild(t);
  setTimeout(() => {
    t.style.transition = 'opacity .3s';
    t.style.opacity = '0';
    setTimeout(() => t.remove(), 300);
  }, 3500);
}

/* ══════════════════════════════════════════════════════
   HELPERS MODALS / IMAGES
══════════════════════════════════════════════════════ */
function openModal(id)  { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }

function triggerUpload(type) {
  const map = { floorplan: 'uploadFloorplan', topo: 'uploadTopo', rack: 'uploadRack' };
  document.getElementById(map[type])?.click();
}

function clearImage(type) {
  const id = selectedId || currentEquipClientId; if (!id) return;
  if (!clientImages[id]) return;
  clientImages[id][type] = null;
  if (type === 'floorplan') renderPlanPane(id);
  if (type === 'topo')      renderTopoPane(id);
  if (type === 'rack') {
    document.getElementById('rackImgWrap').style.display = 'none';
    document.getElementById('rackEmpty').style.display   = 'flex';
    document.getElementById('rackFooter').style.display  = 'none';
  }
  saveDevices();
  showToast('🗑️ Image supprimée', 'down');
}

function readImage(file, cb) {
  const r = new FileReader();
  r.onload = e => cb(e.target.result);
  r.readAsDataURL(file);
}

/* ══════════════════════════════════════════════════════
   PERSISTENCE (localStorage)
══════════════════════════════════════════════════════ */
function saveDevices() {
  try {
    // On ne sauvegarde pas les images dans devices, elles sont séparées
    const toSave = {};
    Object.entries(devices).forEach(([k, d]) => {
      const { _emailTimer, ...rest } = d;
      toSave[k] = rest;
    });
    localStorage.setItem('comunic_v2_devices', JSON.stringify(toSave));
    localStorage.setItem('comunic_v2_images',  JSON.stringify(clientImages));
  } catch (e) { /* quota */ }
}

function loadDevices() {
  try {
    const raw = localStorage.getItem('comunic_v2_devices');
    const img = localStorage.getItem('comunic_v2_images');
    if (raw) Object.assign(devices, JSON.parse(raw));
    if (img) Object.assign(clientImages, JSON.parse(img));
  } catch (e) { console.warn('loadDevices error:', e); }
}

/* ══════════════════════════════════════════════════════
   BOOT
══════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  /* Restaurer le bureau sauvegardé */
  try {
    const savedBureau = localStorage.getItem('comunic_bureau');
    if (savedBureau) Object.assign(BUREAU, JSON.parse(savedBureau));
  } catch(e) {}

  initMap();
  loadDevices();

  Object.values(devices).forEach(d => {
    if (!clientImages[d.id]) clientImages[d.id] = { floorplan: null, topo: null, rack: null };
    if (!d.equipments)       d.equipments = [];
    addMarker(d);
    startMonitor(d.id);
  });

  updateStats();
  updateGlobalStatus();
});
