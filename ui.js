// =============================================================================
// NOTHING // TELEMETRY — UI Renderer
// =============================================================================

import { AppState, QRService, LogService, AttendanceService, SecurityService, ExportService, SimulationEngine, StorageService, CryptoUtils } from './services.js';

// Expose globally for inline event handlers
window.UI = {};
window.AppState = AppState;

// ── Helpers ───────────────────────────────────────────────────────────────
function fmt(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleTimeString('en-GB', { hour12: false });
}
function el(id) { return document.getElementById(id); }
function qs(sel, root = document) { return root.querySelector(sel); }
function qsa(sel, root = document) { return [...root.querySelectorAll(sel)]; }

// ── QR Code Renderer ──────────────────────────────────────────────────────
let _qrInstance = null;
function renderQR() {
    const canvas = el('qr-canvas');
    if (!canvas) return;
    const payload = JSON.stringify(AppState.qrPayload || {});
    try {
        if (_qrInstance) {
            _qrInstance.value = payload;
        } else {
            _qrInstance = new QRious({
                element: canvas,
                value: payload,
                size: 180,
                background: '#ffffff',
                foreground: '#1a1a1a',
                level: 'M'
            });
        }
    } catch (e) {
        console.error('QR render error:', e);
        showQRError();
    }
}
function showQRError() {
    const canvas = el('qr-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#f4f3f0';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#c0392b';
    ctx.font = '10px JetBrains Mono, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('QR ERROR', canvas.width / 2, canvas.height / 2);
}


// ── QR Info Panel ─────────────────────────────────────────────────────────
function renderQRInfo() {
    const h = el('qr-hash'); if (h) h.textContent = AppState.qrHash || '—';
    const c = el('qr-cycle'); if (c) c.textContent = '#' + AppState.qrCycle;
    const t = el('qr-token-preview'); if (t) t.textContent = (AppState.qrToken || '').slice(0, 16) + '...';
    const r = el('qr-rotation-label'); if (r) r.textContent = `Rotating QR (${AppState.settings.qrInterval}s)`;
    const overlay = el('qr-paused-overlay');
    if (overlay) overlay.style.display = AppState.qrPaused ? 'flex' : 'none';
}

function renderCountdown() {
    const pct = (AppState.qrCountdown / AppState.settings.qrInterval) * 100;
    const fill = el('countdown-fill');
    if (fill) {
        fill.style.width = pct + '%';
        fill.className = 'countdown-fill' + (AppState.qrCountdown <= 2 ? ' urgent' : '');
    }
    const ctd = el('countdown-num'); if (ctd) ctd.textContent = AppState.qrCountdown + 's';
}

// ── Attendance Summary ─────────────────────────────────────────────────────
function renderSummary() {
    const p = el('sum-present'); if (p) p.textContent = AppState.present;
    const f = el('sum-flagged'); if (f) f.textContent = AppState.flagged;
    const pct = el('sum-pct'); if (pct) pct.textContent = AttendanceService.percentage + '%';
    const flagBtn = el('flag-count-btn'); if (flagBtn) {
        flagBtn.innerHTML = `⚑ REVIEW <span class="flag-count">${AppState.flagged}</span> FLAGS`;
        flagBtn.style.display = AppState.flagged > 0 ? 'flex' : 'none';
    }
}

// ── Check-in Feed ─────────────────────────────────────────────────────────
function renderCheckins() {
    const list = el('checkin-list');
    if (!list) return;
    list.innerHTML = '';
    AppState.checkins.slice(0, 10).forEach((c, i) => {
        const div = document.createElement('div');
        div.className = 'checkin-item' + (i === 0 ? ' new-entry' : '');
        div.dataset.id = c.id;
        div.innerHTML = `
      <div class="checkin-avatar${c.flagged ? ' flagged' : ''}">${c.initials}</div>
      <div style="flex:1;min-width:0">
        <div class="checkin-name">${c.name}</div>
        <div class="checkin-id">${c.studentCode} · MAC: ...${c.mac ? c.mac.slice(-4) : '????'}</div>
        <div class="checkin-status">
          ${c.deviceVerified ? '<span class="status-tag green">DEVICE ✓</span>' : '<span class="status-tag red">DEVICE ✗</span>'}
          ${c.geoVerified ? '<span class="status-tag green">GEO ✓</span>' : '<span class="status-tag red">GEO ✗</span>'}
          ${c.flagged ? '<span class="status-tag red">FLAGGED</span>' : '<span class="status-tag green">VERIFIED</span>'}
        </div>
      </div>
      <div class="checkin-time">${fmt(c.time)}</div>`;
        list.appendChild(div);
    });
}

// ── Security Incident ─────────────────────────────────────────────────────
function renderIncident() {
    const panel = el('incident-panel');
    if (!panel) return;
    const active = AppState.incidents.filter(i => i.status === 'active');
    const latest = active[0];
    if (!latest) { panel.style.display = 'none'; return; }
    panel.style.display = 'block';
    panel.innerHTML = `
    <div class="incident-card">
      <div class="incident-header">
        <span class="incident-title">⚠ SECURITY COLLISION DETECTED</span>
        <span class="incident-id">INCIDENT ${latest.num}</span>
      </div>
      <div class="incident-body">
        <div class="incident-student">${latest.studentName}</div>
        <div class="incident-reason">${latest.reason}</div>
        <div class="incident-actions">
          <button class="inc-btn outline lock-safe" onclick="UI.openReviewFlags()">REVIEW FLAGS</button>
          <button class="inc-btn danger lock-safe" onclick="UI.openOverride('${latest.id}')">OVERRIDE MANUALLY</button>
        </div>
      </div>
    </div>`;
}

// ── Full UI refresh ────────────────────────────────────────────────────────
UI.refresh = function () {
    renderSummary();
    renderCheckins();
    renderIncident();
    renderQRInfo();
    if (AppState.currentView === 'roster') renderRoster();
    if (AppState.currentView === 'telemetry') renderTelemetry();
    if (AppState.currentView === 'logs') renderLogs();
};

// ── Session Clock ─────────────────────────────────────────────────────────
function startClock() {
    const badge = el('session-badge');
    function tick() {
        const elapsed = Math.floor((Date.now() - AppState.sessionStart) / 1000);
        const h = String(Math.floor(elapsed / 3600)).padStart(2, '0');
        const m = String(Math.floor((elapsed % 3600) / 60)).padStart(2, '0');
        const s = String(elapsed % 60).padStart(2, '0');
        if (badge) badge.textContent = `LIVE ${h}:${m}:${s}`;
    }
    tick();
    AppState.sessionTimer = setInterval(tick, 1000);
}

// ── QR Rotation Engine ─────────────────────────────────────────────────────
function rotateQR() {
    AppState.qrCycle++;
    AppState.qrCountdown = AppState.settings.qrInterval;
    QRService.rotate();
    renderQR();
    renderQRInfo();
    renderCountdown();
}

function startQRTimer() {
    if (AppState.qrCountdownTimer) clearInterval(AppState.qrCountdownTimer);
    AppState.qrCountdownTimer = setInterval(() => {
        if (AppState.qrPaused) return;
        AppState.qrCountdown--;
        renderCountdown();
        if (AppState.qrCountdown <= 0) {
            AppState.qrCountdown = AppState.settings.qrInterval;
            rotateQR();
        }
    }, 1000);
}

// ── Views ─────────────────────────────────────────────────────────────────
UI.showView = function (view) {
    AppState.currentView = view;
    qsa('.view').forEach(v => v.classList.remove('active'));
    qsa('.nav-item').forEach(n => n.classList.remove('active'));
    const target = el('view-' + view);
    if (target) target.classList.add('active');
    const navBtn = qs(`[data-view="${view}"]`);
    if (navBtn) navBtn.classList.add('active');
    UI.refresh();
};

// ── Roster ─────────────────────────────────────────────────────────────────
function renderRoster(filter = '', statusFilter = 'all') {
    const tbody = el('roster-tbody');
    if (!tbody) return;
    const q = filter.toLowerCase();
    const students = AppState.students.filter(s => {
        const match = !q || s.name.toLowerCase().includes(q) || s.studentCode.toLowerCase().includes(q);
        const st = statusFilter === 'all' ? true :
            statusFilter === 'present' ? s.checkedIn && !s.flagged :
                statusFilter === 'absent' ? !s.checkedIn :
                    statusFilter === 'flagged' ? s.flagged : true;
        return match && st;
    });
    tbody.innerHTML = students.map(s => {
        const inc = AppState.incidents.find(i => i.studentId === s.id && i.status === 'active');
        const statusClass = inc ? 'status-flagged' : s.checkedIn ? 'status-present' : 'status-absent';
        const statusLabel = inc ? '⚑ FLAGGED' : s.checkedIn ? '● PRESENT' : '○ ABSENT';
        return `<tr>
      <td>${s.name}</td>
      <td class="mono">${s.studentCode}</td>
      <td><span class="${statusClass}">${statusLabel}</span></td>
      <td class="mono">${fmt(s.checkedInAt)}</td>
      <td class="mono">${s.deviceVerified ? '<span style="color:var(--accent-green)">✓</span>' : '<span style="color:var(--accent-red)">✗</span>'}</td>
      <td class="mono">${s.geoVerified !== undefined ? (s.geoVerified ? '<span style="color:var(--accent-green)">✓</span>' : '<span style="color:var(--accent-red)">✗</span>') : '—'}</td>
      <td>${inc ? `<span style="color:var(--accent-red);font-family:var(--font-mono);font-size:9px">${inc.num}</span>` : '—'}</td>
    </tr>`;
    }).join('');
}

// ── Telemetry ──────────────────────────────────────────────────────────────
function renderTelemetry() {
    const grid = el('tele-grid');
    if (!grid) return;
    const elapsed = Math.floor((Date.now() - AppState.sessionStart) / 1000);
    const h = String(Math.floor(elapsed / 3600)).padStart(2, '0');
    const m = String(Math.floor((elapsed % 3600) / 60)).padStart(2, '0');
    const s = String(elapsed % 60).padStart(2, '0');
    const items = [
        { label: 'QR STATUS', value: AppState.qrPaused ? 'PAUSED' : 'ACTIVE', sub: AppState.qrPaused ? '— broadcast paused' : 'rotating every ' + AppState.settings.qrInterval + 's' },
        { label: 'CURRENT CYCLE', value: '#' + AppState.qrCycle, sub: 'hash: ' + (AppState.qrHash || '—') },
        { label: 'SESSION UPTIME', value: `${h}:${m}:${s}`, sub: 'started at ' + new Date(AppState.sessionStart).toLocaleTimeString('en-GB') },
        { label: 'PRESENT', value: AppState.present + '/' + AppState.totalEnrolled, sub: AttendanceService.percentage + '% attendance rate' },
        { label: 'ACTIVE INCIDENTS', value: AppState.incidents.filter(i => i.status === 'active').length, sub: AppState.flagged + ' flagged students' },
        { label: 'DEVICE VERIFIED', value: AppState.students.filter(s => s.deviceVerified && s.checkedIn).length, sub: 'of ' + AppState.present + ' present' },
        { label: 'GEO VERIFIED', value: AppState.students.filter(s => s.geoVerified && s.checkedIn).length, sub: 'of ' + AppState.present + ' present' },
        { label: 'LAST TOKEN', value: new Date().toLocaleTimeString('en-GB'), sub: 'cycle ' + AppState.qrCycle },
        { label: 'SIMULATION', value: AppState.settings.simEnabled ? 'ON' : 'OFF', sub: 'interval: ' + AppState.settings.simInterval + 's' },
        { label: 'TOTAL LOGS', value: AppState.logs.length, sub: 'audit events recorded' },
    ];
    grid.innerHTML = items.map(item => `
    <div class="tele-card">
      <div class="tele-card-label">${item.label}</div>
      <div class="tele-card-value">${item.value}</div>
      <div class="tele-card-sub">${item.sub}</div>
    </div>`).join('');
}

// ── Logs ───────────────────────────────────────────────────────────────────
function renderLogs() {
    const list = el('log-list');
    if (!list) return;
    list.innerHTML = AppState.logs.map(l => {
        const typeMap = { checkin: 'checkin', security: 'security', system: 'system', action: 'action' };
        return `<div class="log-entry">
      <div class="log-time">${LogService.formatTime(l.ts)}</div>
      <div class="log-type ${typeMap[l.type] || 'system'}">${l.event}</div>
      <div class="log-desc">${l.desc}</div>
    </div>`;
    }).join('') || '<div class="empty-state">NO AUDIT EVENTS</div>';
}

// ── Modals ─────────────────────────────────────────────────────────────────
UI.openReviewFlags = function () {
    const modal = el('modal-flags');
    if (!modal) return;
    renderFlagsModal();
    modal.classList.add('open');
};
UI.closeReviewFlags = function () { el('modal-flags')?.classList.remove('open'); };

function renderFlagsModal() {
    const body = el('flags-modal-body');
    if (!body) return;
    const active = AppState.incidents.filter(i => i.status === 'active');
    if (!active.length) { body.innerHTML = '<div class="empty-state">NO ACTIVE FLAGS</div>'; return; }
    body.innerHTML = active.map(inc => `
    <div class="incident-row">
      <div class="incident-row-header">
        <span class="ir-id">${inc.num}</span>
        <span class="ir-time">${fmt(inc.time)}</span>
      </div>
      <div class="incident-row-body">
        <div class="ir-student">${inc.studentName}</div>
        <div class="ir-detail">
          ID: ${inc.studentCode} · MAC: ${inc.mac}<br>
          Type: ${inc.type}<br>
          Device: ${inc.deviceVerified ? 'Verified ✓' : 'Not Verified ✗'} · Geo: ${inc.geoVerified ? 'Pass ✓' : 'Fail ✗'}<br>
          Reason: ${inc.reason}
        </div>
        <div class="ir-actions">
          <button class="inc-btn outline" onclick="UI.resolveIncident('${inc.id}','resolved')">RESOLVE</button>
          <button class="inc-btn outline" onclick="UI.resolveIncident('${inc.id}','rejected')">REJECT</button>
          <button class="inc-btn danger" onclick="UI.openOverride('${inc.id}');UI.closeReviewFlags()">OVERRIDE</button>
        </div>
      </div>
    </div>`).join('');
}

UI.resolveIncident = function (id, action) {
    SecurityService.resolveIncident(id, action);
    renderFlagsModal();
    UI.refresh();
};

UI.openOverride = function (incidentId) {
    const inc = AppState.incidents.find(i => i.id === incidentId);
    if (!inc) return;
    const dialog = el('confirm-dialog');
    el('confirm-student').textContent = inc.studentName;
    el('confirm-incident').textContent = inc.num;
    el('confirm-reason').textContent = inc.reason;
    el('confirm-override-id').value = inc.id;
    dialog?.classList.add('open');
};
UI.closeOverride = function () { el('confirm-dialog')?.classList.remove('open'); };
UI.confirmOverride = function () {
    const id = el('confirm-override-id')?.value;
    if (id) SecurityService.resolveIncident(id, 'overridden');
    UI.closeOverride();
    UI.refresh();
    LogService.add('action', 'MANUAL_OVERRIDE', `Incident manually overridden by faculty`);
};

// ── Bottom Controls ────────────────────────────────────────────────────────
UI.togglePause = function () {
    AppState.qrPaused = !AppState.qrPaused;
    const btn = el('pause-btn');
    if (btn) {
        btn.className = 'bottom-btn' + (AppState.qrPaused ? ' paused' : '') + ' lock-safe';
        qs('.bottom-btn-label', btn).textContent = AppState.qrPaused ? 'RESUME QR BROADCAST' : 'PAUSE QR BROADCAST';
    }
    LogService.add('system', AppState.qrPaused ? 'QR_PAUSED' : 'QR_RESUMED',
        AppState.qrPaused ? 'QR broadcast paused by faculty' : 'QR broadcast resumed');
    renderQRInfo();
};

UI.forceRekey = function () {
    AppState.qrCountdown = AppState.settings.qrInterval;
    AppState.qrCycle++;
    AppState.qrPaused = false;
    QRService.rotate();
    renderQR();
    renderQRInfo();
    renderCountdown();
    LogService.add('action', 'FORCE_REKEY', `QR token manually re-keyed — Cycle #${AppState.qrCycle}`);
    // Flash effect
    const wrapper = qs('.qr-wrapper');
    if (wrapper) { wrapper.style.outline = '2px solid var(--accent-green)'; setTimeout(() => { wrapper.style.outline = ''; }, 600); }
    const btn = el('pause-btn');
    if (btn) {
        btn.className = 'bottom-btn lock-safe';
        qs('.bottom-btn-label', btn).textContent = 'PAUSE QR BROADCAST';
    }
};

UI.toggleFullscreen = function () {
    if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().then(() => {
            document.getElementById('app')?.classList.add('fullscreen-mode');
        }).catch(e => console.warn('Fullscreen failed:', e));
    } else {
        document.exitFullscreen().then(() => {
            document.getElementById('app')?.classList.remove('fullscreen-mode');
        });
    }
};

// ── Header Controls ────────────────────────────────────────────────────────
UI.toggleSensors = function () {
    const panel = el('panel-sensors');
    panel?.classList.toggle('open');
    el('panel-settings')?.classList.remove('open');
};
UI.closeSensors = function () { el('panel-sensors')?.classList.remove('open'); };

UI.toggleLock = function () {
    AppState.locked = !AppState.locked;
    document.body.classList.toggle('locked', AppState.locked);
    const btn = el('lock-btn');
    if (btn) {
        btn.classList.toggle('locked-btn', AppState.locked);
        btn.querySelector('span:last-child').textContent = AppState.locked ? 'UNLOCK VIEW' : 'LOCK VIEW';
    }
    LogService.add('system', AppState.locked ? 'VIEW_LOCKED' : 'VIEW_UNLOCKED',
        AppState.locked ? 'View locked by faculty' : 'View unlocked');
};

UI.toggleSettings = function () {
    const panel = el('panel-settings');
    panel?.classList.toggle('open');
    el('panel-sensors')?.classList.remove('open');
    if (panel?.classList.contains('open')) renderSettingsPanel();
};
UI.closeSettings = function () { el('panel-settings')?.classList.remove('open'); };

function renderSettingsPanel() {
    const s = AppState.settings;
    const qi = el('setting-qr-interval'); if (qi) qi.value = s.qrInterval;
    const si = el('setting-sim-interval'); if (si) si.value = s.simInterval;
    const se = el('setting-sim-enabled'); if (se) se.checked = s.simEnabled;
    const gr = el('setting-geo-radius'); if (gr) gr.value = s.geofenceRadius;
    const ss = el('setting-security'); if (ss) ss.value = s.securitySensitivity;
}

UI.saveSettings = function () {
    const s = AppState.settings;
    s.qrInterval = parseInt(el('setting-qr-interval')?.value) || 8;
    s.simInterval = parseInt(el('setting-sim-interval')?.value) || 8;
    s.simEnabled = el('setting-sim-enabled')?.checked ?? true;
    s.geofenceRadius = parseInt(el('setting-geo-radius')?.value) || 50;
    s.securitySensitivity = el('setting-security')?.value || 'medium';
    StorageService.set(StorageService.KEYS.SETTINGS, s);
    if (s.simEnabled) SimulationEngine.start(); else SimulationEngine.stop();
    LogService.add('system', 'SETTINGS_SAVED', 'Telemetry settings updated');
    UI.closeSettings();
    UI.refresh();
};

UI.resetDemoData = function () {
    if (!confirm('Reset all demo data? This will reload the page.')) return;
    Object.values(StorageService.KEYS).forEach(k => StorageService.clear(k));
    window.location.reload();
};

// ── Keyboard Shortcuts ─────────────────────────────────────────────────────
function initKeyboard() {
    document.addEventListener('keydown', (e) => {
        const tag = document.activeElement?.tagName;
        const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
        if (e.key === ' ' && !typing && e.target === document.body) {
            e.preventDefault(); UI.togglePause();
        }
        if ((e.ctrlKey || e.metaKey) && e.key === 'r' && !typing) {
            e.preventDefault(); UI.forceRekey();
        }
        if (e.key === 'F11') { e.preventDefault(); UI.toggleFullscreen(); }
        if (e.key === 'Escape') {
            el('modal-flags')?.classList.remove('open');
            el('confirm-dialog')?.classList.remove('open');
            el('panel-sensors')?.classList.remove('open');
            el('panel-settings')?.classList.remove('open');
        }
    });
}

// ── Roster listeners ───────────────────────────────────────────────────────
function initRosterListeners() {
    const search = el('roster-search');
    const filter = el('roster-filter');
    function update() { renderRoster(search?.value || '', filter?.value || 'all'); }
    search?.addEventListener('input', update);
    filter?.addEventListener('change', update);
}

// ── Main Init ─────────────────────────────────────────────────────────────
export async function initUI() {
    // Initial QR
    AppState.qrCountdown = AppState.settings.qrInterval;
    QRService.rotate();
    renderQR();
    renderQRInfo();
    renderCountdown();
    // Summary & feed
    UI.refresh();
    // Clock
    startClock();
    // QR timer
    startQRTimer();
    // Simulation
    if (AppState.settings.simEnabled) SimulationEngine.start();
    // Keyboard
    initKeyboard();
    // Roster listeners
    initRosterListeners();
    // Default view
    UI.showView('console');
    // Fullscreen exit via API
    document.addEventListener('fullscreenchange', () => {
        if (!document.fullscreenElement) el('app')?.classList.remove('fullscreen-mode');
    });
}

export { renderRoster, renderTelemetry, renderLogs, renderQR, renderQRInfo, renderCountdown };
