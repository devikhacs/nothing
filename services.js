// =============================================================================
// NOTHING // TELEMETRY — State & Services
// =============================================================================

// ── Storage Service ────────────────────────────────────────────────────────
const StorageService = {
    KEYS: {
        SETTINGS: 'nt_settings', LOGS: 'nt_logs', INCIDENTS: 'nt_incidents',
        ATTENDANCE: 'nt_attendance', CYCLE: 'nt_cycle', SESSION: 'nt_session'
    },
    get(key, def = null) {
        try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : def; }
        catch { return def; }
    },
    set(key, val) {
        try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { console.warn('Storage write failed:', e); }
    },
    clear(key) { try { localStorage.removeItem(key); } catch { } }
};

// ── App State ─────────────────────────────────────────────────────────────
const AppState = {
    // Session
    sessionStart: Date.now(),
    sessionPaused: false,
    sessionTimer: null,
    // QR
    qrPaused: false,
    qrCycle: 1,
    qrCountdown: 8,
    qrToken: '',
    qrHash: '',
    qrPayload: null,
    qrTimer: null,
    qrCountdownTimer: null,
    // Attendance
    totalEnrolled: 60,
    present: 38,
    flagged: 3,
    students: [],
    checkins: [],
    incidents: [],
    nextIncidentNum: 104,
    // Simulation
    simTimer: null,
    simEnabled: true,
    // View
    currentView: 'console',
    locked: false,
    // Settings
    settings: {
        qrInterval: 8,
        simInterval: 8,
        simEnabled: true,
        geofenceRadius: 50,
        securitySensitivity: 'medium'
    },
    // Logs
    logs: []
};

// ── Crypto / Token Utilities ──────────────────────────────────────────────
const CryptoUtils = {
    randomHex(len = 16) {
        const arr = new Uint8Array(len / 2);
        crypto.getRandomValues(arr);
        return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
    },
    randomId(prefix = '') { return prefix + this.randomHex(8).toUpperCase(); },
    shortHash(str) {
        // Simple deterministic-looking hash for display
        let h = 0;
        for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
        return (h >>> 0).toString(16).toUpperCase().padStart(8, '0');
    }
};

// ── QR Service ────────────────────────────────────────────────────────────
// NOTE: Real implementation requires server-side token signing & validation.
const QRService = {
    generateToken() { return CryptoUtils.randomHex(24); },
    generateHash(token) { return CryptoUtils.shortHash(token + AppState.qrCycle); },
    buildPayload(token) {
        const now = new Date();
        const exp = new Date(now.getTime() + AppState.settings.qrInterval * 1000);
        return {
            course: 'CS304',
            lecture: 14,
            room: 'Auditorium 2B',
            sessionId: 'SES-' + CryptoUtils.randomHex(6).toUpperCase(),
            cycle: AppState.qrCycle,
            issuedAt: now.toISOString(),
            expiresAt: exp.toISOString(),
            token: token // NOTE: In production, this would be a signed JWT, never exposed raw
        };
    },
    rotate() {
        AppState.qrToken = QRService.generateToken();
        AppState.qrHash = QRService.generateHash(AppState.qrToken);
        AppState.qrPayload = QRService.buildPayload(AppState.qrToken);
        StorageService.set(StorageService.KEYS.CYCLE, AppState.qrCycle);
        LogService.add('system', 'QR_ROTATE', `QR token rotated — Cycle #${AppState.qrCycle} — Hash: ${AppState.qrHash}`);
    }
};

// ── Log Service ────────────────────────────────────────────────────────────
const LogService = {
    add(type, event, desc) {
        const entry = { id: CryptoUtils.randomHex(4), ts: new Date().toISOString(), type, event, desc };
        AppState.logs.unshift(entry);
        if (AppState.logs.length > 500) AppState.logs.pop();
        StorageService.set(StorageService.KEYS.LOGS, AppState.logs.slice(0, 200));
        return entry;
    },
    formatTime(iso) {
        const d = new Date(iso);
        return d.toLocaleTimeString('en-GB', { hour12: false });
    }
};

// ── Attendance Service ─────────────────────────────────────────────────────
// NOTE: In production, all check-ins would be validated server-side.
const AttendanceService = {
    get percentage() { return AppState.totalEnrolled ? ((AppState.present / AppState.totalEnrolled) * 100).toFixed(1) : '0.0'; },
    addCheckin(student, flagged = false, incident = null) {
        const wasAbsent = !student.checkedIn;
        student.checkedIn = true;
        student.checkedInAt = new Date().toISOString();
        if (wasAbsent) AppState.present = Math.min(AppState.totalEnrolled, AppState.present + 1);
        const entry = {
            id: CryptoUtils.randomHex(4),
            studentId: student.id,
            name: student.name,
            initials: student.initials,
            studentCode: student.studentCode,
            mac: student.mac,
            flagged,
            incident,
            deviceVerified: student.deviceVerified,
            geoVerified: student.geoVerified,
            time: student.checkedInAt
        };
        AppState.checkins.unshift(entry);
        if (AppState.checkins.length > 50) AppState.checkins.pop();
        if (!flagged) LogService.add('checkin', 'CHECK_IN', `${student.name} (${student.studentCode}) checked in`);
        StorageService.set(StorageService.KEYS.ATTENDANCE, { present: AppState.present, flagged: AppState.flagged, checkins: AppState.checkins.slice(0, 30) });
        return entry;
    }
};

// ── Security Service ───────────────────────────────────────────────────────
// NOTE: Production security checks MUST occur server-side; this is simulation only.
const SecurityService = {
    TYPES: {
        DEVICE_COLLISION: 'DEVICE_COLLISION',
        GEO_FAILURE: 'GEO_FAILURE',
        EXPIRED_TOKEN: 'EXPIRED_TOKEN',
        DOUBLE_CHECKIN: 'DOUBLE_CHECKIN',
        DEVICE_UNVERIFIED: 'DEVICE_UNVERIFIED'
    },
    REASONS: {
        DEVICE_COLLISION: (s1, s2) => `Same device hardware UUID logged ${Math.floor(Math.random() * 5) + 1}m earlier by student ID ${s2.studentCode} (Hardware fingerprint collision).`,
        GEO_FAILURE: () => `Device location does not satisfy geofence radius (>${AppState.settings.geofenceRadius}m from Auditorium 2B).`,
        EXPIRED_TOKEN: () => `QR token presented after expiry window.`,
        DOUBLE_CHECKIN: () => `Duplicate check-in attempt detected within active session.`,
        DEVICE_UNVERIFIED: () => `Device fingerprint could not be verified against enrollment record.`
    },
    createIncident(student, type, reason) {
        const num = 'F-' + String(AppState.nextIncidentNum++).padStart(3, '0');
        const incident = {
            id: CryptoUtils.randomHex(4), num, type, reason,
            studentId: student.id, studentName: student.name,
            studentCode: student.studentCode, mac: student.mac,
            time: new Date().toISOString(), status: 'active',
            deviceVerified: student.deviceVerified, geoVerified: student.geoVerified
        };
        AppState.incidents.unshift(incident);
        AppState.flagged++;
        LogService.add('security', 'SECURITY_COLLISION', `Incident ${num}: ${student.name} — ${type}`);
        StorageService.set(StorageService.KEYS.INCIDENTS, AppState.incidents);
        return incident;
    },
    resolveIncident(incidentId, action) {
        const inc = AppState.incidents.find(i => i.id === incidentId);
        if (!inc) return;
        inc.status = action;
        inc.resolvedAt = new Date().toISOString();
        if (AppState.flagged > 0) AppState.flagged--;
        LogService.add('action', 'INCIDENT_' + action.toUpperCase(), `Incident ${inc.num}: ${inc.studentName} — ${action}`);
        StorageService.set(StorageService.KEYS.INCIDENTS, AppState.incidents);
    }
};

// ── Export Service ─────────────────────────────────────────────────────────
const ExportService = {
    toCSV() {
        const headers = ['Student Name', 'Student ID', 'Attendance Status', 'Check-in Time', 'Device Verified', 'Geofence Verified', 'Flagged', 'Incident ID', 'Flag Reason'];
        const rows = AppState.students.map(s => {
            const inc = AppState.incidents.find(i => i.studentId === s.id && i.status === 'active');
            return [
                `"${s.name}"`, s.studentCode,
                s.checkedIn ? 'PRESENT' : 'ABSENT',
                s.checkedInAt ? new Date(s.checkedInAt).toLocaleTimeString('en-GB') : '',
                s.deviceVerified ? 'YES' : 'NO',
                s.geoVerified ? 'YES' : 'NO',
                inc ? 'YES' : 'NO',
                inc ? inc.num : '',
                inc ? `"${inc.reason}"` : ''
            ].join(',');
        });
        const csvContent = [headers.join(','), ...rows].join('\n');
        const today = new Date().toISOString().split('T')[0];
        const filename = `CS304_Lecture14_Attendance_${today}.csv`;
        try {
            const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = filename; a.click();
            URL.revokeObjectURL(url);
            LogService.add('action', 'EXPORT_CSV', `Attendance CSV exported: ${filename}`);
        } catch (e) { console.error('CSV export failed:', e); }
    }
};

// ── Student Data ──────────────────────────────────────────────────────────
function initStudents() {
    const saved = StorageService.get(StorageService.KEYS.ATTENDANCE);
    const base = [
        { id: 's001', name: 'Elena Rostova', initials: 'ER', studentCode: '2021-CS-084', mac: '89:F2:A1:3C', deviceVerified: true, geoVerified: true, checkedIn: true, checkedInAt: _minsAgo(18) },
        { id: 's002', name: 'Marcus Vance', initials: 'MV', studentCode: '2021-CS-032', mac: '12:C8:B4:7D', deviceVerified: true, geoVerified: true, checkedIn: true, checkedInAt: _minsAgo(21) },
        { id: 's003', name: 'Priya Patel', initials: 'PP', studentCode: '2022-CS-110', mac: '7B:04:E9:2A', deviceVerified: true, geoVerified: true, checkedIn: true, checkedInAt: _minsAgo(25) },
        { id: 's004', name: 'Alexander Kim', initials: 'AK', studentCode: '2021-CS-019', mac: '33:A1:C2:5F', deviceVerified: true, geoVerified: false, checkedIn: true, checkedInAt: _minsAgo(14) },
        { id: 's005', name: 'Julian Chen', initials: 'JC', studentCode: '2020-EE-119', mac: 'F8:22:D4:01', deviceVerified: false, geoVerified: true, checkedIn: true, checkedInAt: _minsAgo(7), flagged: true },
        { id: 's006', name: 'Sophia Laurent', initials: 'SL', studentCode: '2022-CS-047', mac: 'A4:B9:F3:8C', deviceVerified: true, geoVerified: true, checkedIn: true, checkedInAt: _minsAgo(30) },
        { id: 's007', name: 'Omar Farouk', initials: 'OF', studentCode: '2021-CS-063', mac: 'C1:D2:E3:F4', deviceVerified: true, geoVerified: true, checkedIn: true, checkedInAt: _minsAgo(22) },
        { id: 's008', name: 'Nadia Kowalski', initials: 'NK', studentCode: '2023-CS-011', mac: '55:66:77:88', deviceVerified: true, geoVerified: true, checkedIn: false, checkedInAt: null },
        { id: 's009', name: 'Riku Tanaka', initials: 'RT', studentCode: '2022-CS-098', mac: '2A:3B:4C:5D', deviceVerified: true, geoVerified: true, checkedIn: false, checkedInAt: null },
        { id: 's010', name: 'Amara Osei', initials: 'AO', studentCode: '2021-CS-077', mac: '9E:8F:7G:6H', deviceVerified: true, geoVerified: true, checkedIn: true, checkedInAt: _minsAgo(10) },
        { id: 's011', name: 'Leon Müller', initials: 'LM', studentCode: '2020-CS-044', mac: '11:22:33:44', deviceVerified: true, geoVerified: true, checkedIn: true, checkedInAt: _minsAgo(27) },
        { id: 's012', name: 'Ines Carvalho', initials: 'IC', studentCode: '2022-CS-055', mac: 'FE:DC:BA:98', deviceVerified: false, geoVerified: true, checkedIn: false, checkedInAt: null },
        { id: 's013', name: 'Dev Malhotra', initials: 'DM', studentCode: '2021-CS-041', mac: 'F8:22:D4:01', deviceVerified: true, geoVerified: true, checkedIn: true, checkedInAt: _minsAgo(9) },
        { id: 's014', name: 'Camille Bernard', initials: 'CB', studentCode: '2023-CS-030', mac: 'AA:BB:CC:DD', deviceVerified: true, geoVerified: true, checkedIn: false, checkedInAt: null },
        { id: 's015', name: 'Yusuf Al-Rashid', initials: 'YA', studentCode: '2021-CS-088', mac: 'EE:FF:00:11', deviceVerified: true, geoVerified: true, checkedIn: true, checkedInAt: _minsAgo(35) },
    ];
    AppState.students = base.map(s => ({ ...s, flagged: s.flagged || false }));
    // Restore saved state
    if (saved) {
        AppState.present = saved.present ?? AppState.present;
        AppState.flagged = saved.flagged ?? AppState.flagged; // will be overwritten after incidents load
    }
}

function _minsAgo(m) { return new Date(Date.now() - m * 60000).toISOString(); }

function initIncidents() {
    const saved = StorageService.get(StorageService.KEYS.INCIDENTS);
    if (saved && Array.isArray(saved) && saved.length > 0) {
        AppState.incidents = saved;
        AppState.flagged = saved.filter(i => i.status === 'active').length;
        AppState.nextIncidentNum = Math.max(...saved.map(i => parseInt(i.num.split('-')[1]) || 103)) + 1;
    } else {
        // Seed with the Julian Chen incident from the screenshot
        const julian = AppState.students.find(s => s.id === 's005');
        const devMal = AppState.students.find(s => s.id === 's013');
        if (julian) {
            SecurityService.createIncident(julian, SecurityService.TYPES.DEVICE_COLLISION,
                SecurityService.REASONS.DEVICE_COLLISION(julian, devMal));
            // Additional incidents for demo
            const ines = AppState.students.find(s => s.id === 's012');
            if (ines) SecurityService.createIncident(ines, SecurityService.TYPES.DEVICE_UNVERIFIED, SecurityService.REASONS.DEVICE_UNVERIFIED());
            const alex = AppState.students.find(s => s.id === 's004');
            if (alex) SecurityService.createIncident(alex, SecurityService.TYPES.GEO_FAILURE, SecurityService.REASONS.GEO_FAILURE());
        }
    }
}

function initLogs() {
    const saved = StorageService.get(StorageService.KEYS.LOGS);
    if (saved && Array.isArray(saved) && saved.length > 0) {
        AppState.logs = saved;
    } else {
        // Seed some initial logs
        LogService.add('system', 'SESSION_START', 'Attendance session started — CS304 Lecture 14, Auditorium 2B');
        AppState.students.filter(s => s.checkedIn).forEach(s =>
            LogService.add('checkin', 'CHECK_IN', `${s.name} (${s.studentCode}) checked in`)
        );
    }
}

function initSettings() {
    const saved = StorageService.get(StorageService.KEYS.SETTINGS);
    if (saved) AppState.settings = { ...AppState.settings, ...saved };
    const savedCycle = StorageService.get(StorageService.KEYS.CYCLE);
    if (savedCycle) AppState.qrCycle = savedCycle;
}

function initCheckins() {
    // Populate initial checkins from present students
    const saved = StorageService.get(StorageService.KEYS.ATTENDANCE);
    if (saved && saved.checkins && saved.checkins.length > 0) {
        AppState.checkins = saved.checkins;
    } else {
        AppState.students.filter(s => s.checkedIn).slice(0, 8).forEach(s => {
            AppState.checkins.push({
                id: CryptoUtils.randomHex(4), studentId: s.id, name: s.name,
                initials: s.initials, studentCode: s.studentCode, mac: s.mac,
                flagged: s.flagged, incident: null, deviceVerified: s.deviceVerified,
                geoVerified: s.geoVerified, time: s.checkedInAt
            });
        });
    }
}

// ── Simulation Engine ─────────────────────────────────────────────────────
// NOTE: This entire engine replaces what would be a real-time WebSocket connection
//       in a production system.
const SimulationEngine = {
    absentStudents() { return AppState.students.filter(s => !s.checkedIn); },
    scheduleNext() {
        if (AppState.simTimer) clearTimeout(AppState.simTimer);
        if (!AppState.settings.simEnabled) return;
        const delay = (AppState.settings.simInterval + Math.random() * 6) * 1000;
        AppState.simTimer = setTimeout(() => SimulationEngine.tick(), delay);
    },
    tick() {
        const absent = SimulationEngine.absentStudents();
        if (absent.length === 0) { SimulationEngine.scheduleNext(); return; }
        const student = absent[Math.floor(Math.random() * absent.length)];
        student.deviceVerified = Math.random() > 0.1;
        student.geoVerified = Math.random() > 0.08;
        // Security collision: chance for device collision
        const allMacs = AppState.students.filter(s => s.checkedIn && s.id !== student.id).map(s => s.mac);
        const deviceCollision = Math.random() < 0.12 && allMacs.length > 0;
        if (deviceCollision) {
            const victim = AppState.students.find(s => s.mac === allMacs[Math.floor(Math.random() * allMacs.length)]);
            student.mac = victim.mac; // Simulate same MAC
            const inc = SecurityService.createIncident(student, SecurityService.TYPES.DEVICE_COLLISION,
                SecurityService.REASONS.DEVICE_COLLISION(student, victim));
            AttendanceService.addCheckin(student, true, inc);
        } else if (!student.geoVerified && AppState.settings.securitySensitivity !== 'low') {
            const inc = SecurityService.createIncident(student, SecurityService.TYPES.GEO_FAILURE,
                SecurityService.REASONS.GEO_FAILURE());
            AttendanceService.addCheckin(student, true, inc);
        } else {
            AttendanceService.addCheckin(student, false, null);
        }
        UI.refresh();
        SimulationEngine.scheduleNext();
    },
    start() {
        SimulationEngine.scheduleNext();
    },
    stop() {
        if (AppState.simTimer) clearTimeout(AppState.simTimer);
        AppState.simTimer = null;
    }
};

export { AppState, StorageService, QRService, LogService, AttendanceService, SecurityService, ExportService, SimulationEngine, CryptoUtils, initStudents, initIncidents, initLogs, initSettings, initCheckins };
