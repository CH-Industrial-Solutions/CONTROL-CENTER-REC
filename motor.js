/*
 * QORVEX Recibo — Motor de datos (v0.4.2)
 * Sin servidor. Un solo equipo. Historial en archivo append-only (JSON Lines)
 * dentro de una carpeta local elegida por el usuario.
 *
 * Se carga como script clásico (no módulo ES) para funcionar con file://.
 */
(function (root) {
  'use strict';

  const VERSION = '0.5.2';
  const FILES = Object.freeze({
    config: 'config.json',
    historial: 'historial.jsonl',
    sesion: 'sesion.lock.json',
    usuarios: 'usuarios.json',
    respaldos: 'respaldos'
  });
  const PBKDF2_ITER = 210000;
  const ROLES = ['admin', 'supervisor', 'capturista'];
  // Perfil anterior 'operador' pasa a llamarse 'capturista'.
  const normalizeRole = (r) => (r === 'operador' ? 'capturista' : r);
  const KPI_KEYS = ['descargadas', 'recolectadas', 'manuales', 'validadas', 'procesadas', 'ubicadas', 'pallets_ubicados',
    'cargadas_retornable', 'cargadas_racks', 'cargadas', 'vacias'];
  // Flujo de rampa fijo (no editable). "Descargado" solo se alcanza con pasarABahia().
  const TRAILER_STAGES = Object.freeze(['Por descarga', 'Descargado', 'Cargando retornable', 'Cargando racks', 'Salió']);
  const TRANSICIONES = Object.freeze({
    'Por descarga': ['Descargado'],
    'Descargado': ['Cargando retornable', 'Cargando racks', 'Salió'],
    'Cargando retornable': ['Salió'],
    'Cargando racks': ['Salió']
  });
  const SALIDAS = Object.freeze(['RETORNABLE', 'RACKS', 'VACIA']);
  const UNIDADES = Object.freeze(['CAJA', 'PALLET']);
  const MAX_CAJAS_BAHIA = 100;
  // Responsable según el estatus: solo 'Por ubicar' es Putaway; lo demás es Recibo.
  const responsableDe = (stage) => (stage === 'Por ubicar' ? 'Putaway' : 'Recibo');
  // Si la caja ya está cargando, la salida debe ser de ese mismo tipo.
  const SALIDA_DE = Object.freeze({ 'Cargando retornable': 'RETORNABLE', 'Cargando racks': 'RACKS' });

  class MotorError extends Error {
    constructor(message) { super(message); this.name = 'MotorError'; }
  }
  const fail = (m) => { throw new MotorError(m); };

  // ---------- utilidades ----------
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const pad = (n, w = 6) => String(n).padStart(w, '0');
  const str = (v) => String(v ?? '').trim();
  const toInt = (v) => {
    const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
    return Number.isInteger(n) ? n : NaN;
  };
  const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => String(a + i));
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1, 2)}-${pad(d.getDate(), 2)}`;
  const hm = (d) => `${pad(d.getHours(), 2)}:${pad(d.getMinutes(), 2)}`;
  const localStamp = (d) => `${ymd(d)} ${hm(d)}:${pad(d.getSeconds(), 2)}`;
  const toMin = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
  const isHHMM = (s) => /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
  const slug = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, '_');

  function nextCode(prefix, existing) {
    let max = 0;
    const re = new RegExp(`^${prefix}-(\\d+)$`);
    for (const c of existing) { const m = re.exec(c); if (m) max = Math.max(max, Number(m[1])); }
    return `${prefix}-${pad(max + 1)}`;
  }

  // ---------- configuración predefinida (editable en Configuración) ----------
  const DEFAULT_CONFIG = Object.freeze({
    schema: 1,
    ramps: range(743, 755),
    bays: ['743', '744', '745', '746', '746A', '746B', '747', '748', '749', '750', '751', '752', '753', '754', '755'],
    shifts: [
      { name: 'Día', start: '07:00', end: '15:00', meta: 0 },
      { name: 'Tarde', start: '15:00', end: '22:30', meta: 0 },
      { name: 'Noche', start: '22:30', end: '07:00', meta: 0 }
    ],
    // Días laborales (0 = domingo … 6 = sábado): turnos que se trabajan cada día.
    work_days: [[], ['Día', 'Tarde', 'Noche'], ['Día', 'Tarde', 'Noche'], ['Día', 'Tarde', 'Noche'], ['Día', 'Tarde', 'Noche'], ['Día', 'Tarde', 'Noche'], ['Día', 'Tarde']],
    // Festivos / no laborables: { date: 'YYYY-MM-DD', shifts: 'ALL' | [nombres], nota }
    holidays: [],
    product_stages: ['Por validar', 'Por etiquetar', 'Por ubicar', 'Ubicado parcial', 'Ubicado total'],
    min_reason_length: 5,
    stale_lock_minutes: 10,
    lockout: { attempts: 5, minutes: 10 }
  });

  function validateConfig(c, hasHistory, prev) {
    const list = (arr, name) => {
      if (!Array.isArray(arr) || !arr.length) fail(`${name} no puede estar vacío.`);
      const clean = arr.map(str);
      if (clean.some((x) => !x) || new Set(clean).size !== clean.length) fail(`${name} tiene valores vacíos o repetidos.`);
      return clean;
    };
    c.ramps = list(c.ramps, 'Rampas');
    c.bays = list(c.bays, 'Bahías');
    c.product_stages = list(c.product_stages, 'Estatus de producto');
    if (!Array.isArray(c.shifts) || !c.shifts.length) fail('Configura al menos un turno.');
    for (const s of c.shifts) {
      if (!str(s.name) || !isHHMM(s.start) || !isHHMM(s.end)) fail('Turno con nombre u horario inválido.');
      s.meta = s.meta === undefined || s.meta === '' ? 0 : Number(s.meta);
      if (!Number.isInteger(s.meta) || s.meta < 0) fail(`La meta del turno ${s.name} debe ser un número entero de cero o más.`);
    }
    const nombres = c.shifts.map((s) => s.name);
    if (new Set(nombres).size !== nombres.length) fail('Los nombres de turno no pueden repetirse.');
    if (!Array.isArray(c.work_days) || c.work_days.length !== 7) fail('El calendario laboral necesita los 7 días.');
    for (const dia of c.work_days) {
      if (!Array.isArray(dia) || dia.some((t) => !nombres.includes(t))) fail('El calendario laboral tiene turnos que no existen.');
    }
    if (!Array.isArray(c.holidays)) fail('Los días festivos no son válidos.');
    for (const h of c.holidays) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(h.date))) fail('Fecha de festivo no válida.');
      if (h.shifts !== 'ALL' && (!Array.isArray(h.shifts) || h.shifts.some((t) => !nombres.includes(t)))) fail('El festivo tiene turnos que no existen.');
    }
    if (hasHistory && JSON.stringify(prev.product_stages) !== JSON.stringify(c.product_stages)) {
      fail('El flujo de estatus no se puede cambiar mientras exista historial.');
    }
    if (!(c.min_reason_length >= 1) || !(c.stale_lock_minutes >= 1)) fail('Valores de seguridad inválidos.');
    return c;
  }

  // ---------- turnos ----------
  // Devuelve el turno de una fecha local. Un turno que cruza medianoche
  // (Noche 22:30–07:00) toma como fecha de turno el día en que empezó.
  function shiftFor(date, shifts) {
    const m = date.getHours() * 60 + date.getMinutes();
    for (const s of shifts) {
      const a = toMin(s.start), b = toMin(s.end);
      const wraps = a > b;
      const inside = wraps ? (m >= a || m < b) : (m >= a && m < b);
      if (!inside) continue;
      const back = wraps && m < b ? 1 : 0;
      return { name: s.name, shift_date: ymd(new Date(date.getFullYear(), date.getMonth(), date.getDate() - back)) };
    }
    return { name: 'Sin turno', shift_date: ymd(date) };
  }

  // ---------- historial (JSON Lines, append-only) ----------
  const serializeEvent = (e) => JSON.stringify(e) + '\n';

  function parseHistorial(text) {
    const events = [];
    let truncated = 0;
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      const t = line.trim();
      if (!t) return;
      try { events.push(JSON.parse(t)); }
      catch (err) {
        // Una última línea incompleta suele ser un corte de energía: se ignora y se reporta.
        if (i === lines.length - 1) truncated += 1;
        else fail(`El historial tiene una línea dañada (${i + 1}). No se abre para evitar pérdida de datos.`);
      }
    });
    return { events, truncated };
  }

  function emptyState() { return { visits: {}, lots: {}, collections: {} }; }

  function applyEvent(st, e, cfg) {
    switch (e.type) {
      case 'VISIT_CREATED':
        st.visits[e.entity.code] = {
          code: e.entity.code, box_code: e.data.box_code, supplier: e.data.supplier, ramp: e.data.ramp,
          stage: TRAILER_STAGES[0], closed: false, salida: null,
          created_at: e.data.arrived_at || e.at // llegada: la hora que captura el operador, o el registro
        };
        break;
      case 'VISIT_STATUS': {
        const v = st.visits[e.entity.code];
        v.stage = e.data.to;
        if (e.data.salida) v.salida = e.data.salida;
        v.closed = e.data.to === 'Salió';
        break;
      }
      case 'LOT_CREATED':
        st.lots[e.entity.code] = {
          code: e.entity.code, parent: e.data.parent, origin: e.data.origin, box_code: e.data.box_code,
          bay: e.data.bay, capture_mode: e.data.capture_mode,
          pallets_total: e.data.pallets_total, pallets_remaining: e.data.pallets_total,
          stage: cfg.product_stages[0], stage_index: 0, closed: false, created_at: e.at,
          unit: e.data.unit || 'CAJA'
        };
        break;
      case 'LOT_STATUS': {
        const l = st.lots[e.entity.code];
        l.stage = e.data.to;
        l.stage_index = cfg.product_stages.indexOf(e.data.to);
        l.pallets_remaining = e.data.pallets_remaining;
        l.closed = e.data.to === 'Ubicado total';
        break;
      }
      case 'COLLECTION_CREATED':
        st.collections[e.entity.code] = {
          code: e.entity.code, box_code: e.data.box_code, origin_area: e.data.origin_area,
          capture_mode: e.data.capture_mode, reason: e.data.reason, occurrence_at: e.data.occurrence_at,
          bays: e.data.bays, created_at: e.at
        };
        break;
      default: break; // CONFIG_CHANGED, SHIFT_CLOSED, etc. no alteran el estado de cajas.
    }
  }

  function replay(events, cfg) {
    const st = emptyState();
    for (const e of events) applyEvent(st, e, cfg);
    return st;
  }

  // ---------- reglas de flujo ----------
  // Avanza solo hacia adelante. Al saltar pasos, los intermedios se dan por cumplidos (quedan en skipped).
  function planForward(stages, fromIdx, to, comment, minLen, allowRepeat) {
    const ti = stages.indexOf(to);
    if (ti < 0) fail('Estatus no válido.');
    if (ti < fromIdx) fail('No se puede regresar a un estatus anterior.');
    if (ti === fromIdx && !allowRepeat) fail('La caja ya tiene ese estatus.');
    const skipped = ti - fromIdx > 1 ? stages.slice(fromIdx + 1, ti) : [];
    return { ti, skipped };
  }

  function planLotAdvance(lot, input, cfg) {
    if (lot.closed) fail('El lote ya está cerrado en Ubicado total.');
    const to = str(input.to);
    const { skipped } = planForward(cfg.product_stages, lot.stage_index, to, input.comment,
      cfg.min_reason_length, to === 'Ubicado parcial');
    let moved = 0;
    let remaining = lot.pallets_remaining;
    if (to === 'Ubicado parcial') {
      moved = toInt(input.pallets_located);
      if (!(moved >= 1 && moved < remaining)) {
        fail('Para ubicación parcial indica pallets mayores a cero y menores al saldo pendiente.');
      }
      remaining -= moved;
    } else if (to === 'Ubicado total') {
      moved = remaining;
      remaining = 0;
    }
    return { skipped, moved, remaining };
  }

  // ---------- sesión de escritura (bloqueo en la carpeta) ----------
  // libre: nadie escribe. mia: esta misma sesión. ocupada: otra sesión con latido reciente.
  // vencida: otra sesión sin latido por más de staleMin (se puede tomar con confirmación).
  function evaluateLock(lock, nowDate, sessionId, staleMin) {
    if (!lock || !lock.session) return { status: 'libre' };
    if (lock.session === sessionId) return { status: 'mia', owner: lock.owner };
    const ageMin = (nowDate - new Date(lock.heartbeat_at)) / 60000;
    if (!(ageMin <= staleMin)) return { status: 'vencida', owner: lock.owner, minutes: ageMin };
    return { status: 'ocupada', owner: lock.owner };
  }

  // ---------- KPIs ----------
  // Definiciones (confirmar con operación):
  //  descargadas     = visitas con al menos una descarga registrada en el turno.
  //  recolectadas    = registros de recolección (una caja cuenta una vez aunque tenga varias bahías).
  //  manuales        = recolecciones con captura manual.
  //  validadas       = lotes que pasan a "Por etiquetar" (validación completa).
  //  procesadas      = cajas que completan validación y etiquetado; cuenta en el turno que etiqueta.
  //  ubicadas        = lotes que llegan a "Ubicado total".
  //  pallets_ubicados = pallets movidos a ubicación (parcial o total).
  // ---------- productividad: metas, calendario laboral y festivos ----------
  const SIN_ENCARGADO = 'Sin encargado';
  const hhmmMin = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
  // Horas de un turno; un turno que cruza medianoche suma sus horas al día siguiente.
  function horasTurno(s) { return (((hhmmMin(s.end) - hhmmMin(s.start)) + 1440) % 1440) / 60; }
  // Un turno cuenta meta solo si ese día de la semana lo trabaja y no es festivo para ese turno.
  function esLaboral(cfg, fecha, turno) {
    const [y, mo, d] = fecha.split('-').map(Number);
    const dia = new Date(y, mo - 1, d).getDay();
    if (!(cfg.work_days[dia] || []).includes(turno)) return false;
    const fest = cfg.holidays.find((h) => h.date === fecha);
    if (fest && (fest.shifts === 'ALL' || fest.shifts.includes(turno))) return false;
    return true;
  }
  function diasEntre(desde, hasta) {
    const [y1, m1, d1] = desde.split('-').map(Number);
    const [y2, m2, d2] = hasta.split('-').map(Number);
    const cur = new Date(y1, m1 - 1, d1), fin = new Date(y2, m2 - 1, d2);
    const out = [];
    while (cur <= fin) {
      if (out.length > 400) fail('El periodo es demasiado largo (máximo 400 días).');
      out.push(ymd(cur));
      cur.setDate(cur.getDate() + 1);
    }
    return out;
  }
  // Cajas descargadas = visitas con bahía asignada, contadas una vez por visita.
  function calcularProductividad(events, cfg, f, ahora) {
    const { from, to } = f;
    const turnoF = f.turno || '', encF = f.encargado || '';
    const turnos = cfg.shifts.filter((s) => !turnoF || s.name === turnoF);
    const visitas = new Map();
    for (const e of events) {
      if (e.type !== 'LOT_CREATED' || e.data.origin !== 'DESCARGA') continue;
      if (!visitas.has(e.data.parent)) {
        visitas.set(e.data.parent, {
          fecha: e.shift_date, turno: e.shift, at: e.at,
          encargado: e.data.encargado || SIN_ENCARGADO, nombre: e.data.encargado_nombre || e.data.encargado || SIN_ENCARGADO
        });
      }
    }
    const cajas = [...visitas.values()].filter((c) => c.fecha >= from && c.fecha <= to
      && (!turnoF || c.turno === turnoF) && (!encF || c.encargado === encF));
    const real = new Map();
    for (const c of cajas) real.set(`${c.fecha}|${c.turno}`, (real.get(`${c.fecha}|${c.turno}`) || 0) + 1);
    const dias = diasEntre(from, to).map((fecha) => {
      const celdas = turnos.map((s) => {
        const laboral = esLaboral(cfg, fecha, s.name);
        const horas = horasTurno(s);
        const meta = laboral ? s.meta : 0;
        return { fecha, turno: s.name, laboral, meta, horas, meta_hora: horas > 0 ? meta / horas : 0, real: real.get(`${fecha}|${s.name}`) || 0 };
      });
      const r = celdas.reduce((a, c) => a + c.real, 0), mt = celdas.reduce((a, c) => a + c.meta, 0);
      let estado = 'sin meta';
      if (!celdas.some((c) => c.laboral)) estado = 'no laboral';
      else if (mt > 0) estado = r >= mt ? 'cumple' : 'debajo';
      return { fecha, real: r, meta: mt, estado, celdas };
    });
    const todas = dias.flatMap((d) => d.celdas);
    const totalReal = todas.reduce((a, c) => a + c.real, 0);
    const totalMeta = todas.reduce((a, c) => a + c.meta, 0);
    const porTurno = turnos.map((s) => {
      const cs = todas.filter((c) => c.turno === s.name);
      return { turno: s.name, real: cs.reduce((a, c) => a + c.real, 0), meta: cs.reduce((a, c) => a + c.meta, 0), horas: horasTurno(s), meta_hora: horasTurno(s) > 0 ? s.meta / horasTurno(s) : 0, dias_laborales: cs.filter((c) => c.laboral).length };
    });
    const porEncargado = {};
    for (const c of cajas) porEncargado[c.nombre] = (porEncargado[c.nombre] || 0) + 1;
    const porHora = Array.from({ length: 24 }, (_, h) => ({ hora: h, real: 0, meta_hora: 0 }));
    for (const c of cajas) porHora[new Date(c.at).getHours()].real += 1;
    for (const c of todas) {
      if (!c.laboral || c.meta_hora <= 0) continue;
      const inicio = hhmmMin(turnos.find((s) => s.name === c.turno).start);
      for (let k = 0; k < Math.ceil(c.horas); k++) porHora[(Math.floor(inicio / 60) + k) % 24].meta_hora += c.meta_hora;
    }
    let enCurso = null;
    const sh = shiftFor(ahora, cfg.shifts);
    const s = cfg.shifts.find((x) => x.name === sh.name);
    if (s) {
      const [y, mo, d] = sh.shift_date.split('-').map(Number);
      const inicio = new Date(y, mo - 1, d, Math.floor(hhmmMin(s.start) / 60), hhmmMin(s.start) % 60);
      if (ahora < inicio) inicio.setDate(inicio.getDate() - 1);
      const transcurridas = Math.min(Math.max((ahora - inicio) / 3600000, 0), horasTurno(s));
      const laboral = esLaboral(cfg, sh.shift_date, s.name);
      const metaHora = horasTurno(s) > 0 ? (laboral ? s.meta : 0) / horasTurno(s) : 0;
      enCurso = {
        turno: s.name, fecha: sh.shift_date, laboral, meta: laboral ? s.meta : 0, meta_hora: metaHora,
        real: cajas.filter((c) => c.fecha === sh.shift_date && c.turno === s.name).length,
        esperadas: Math.round(metaHora * transcurridas), horas_transcurridas: transcurridas
      };
    }
    return {
      desde: from, hasta: to,
      total: { real: totalReal, meta: totalMeta, cumplimiento: totalMeta > 0 ? totalReal / totalMeta : null },
      dias, por_turno: porTurno,
      por_encargado: Object.entries(porEncargado).map(([nombre, cajas]) => ({ nombre, cajas })).sort((a, b) => b.cajas - a.cajas),
      por_hora: porHora, en_curso: enCurso
    };
  }

  function computeKpis(events, stages, f = {}) {
    const idx = (s) => stages.indexOf(s);
    const buckets = {};
    const bucket = (e) => {
      const key = `${e.shift_date}|${e.shift}`;
      if (!buckets[key]) {
        buckets[key] = {
          fecha_turno: e.shift_date, turno: e.shift,
          descargadas: new Set(), recolectadas: new Set(), manuales: new Set(),
          validadas: new Set(), procesadas: new Set(), ubicadas: new Set(), pallets_ubicados: 0,
          salidas_retornable: new Set(), salidas_racks: new Set(), vacias: new Set()
        };
      }
      return buckets[key];
    };
    for (const e of events) {
      if (f.from && e.shift_date < f.from) continue;
      if (f.to && e.shift_date > f.to) continue;
      if (f.shift && e.shift !== f.shift) continue;
      switch (e.type) {
        case 'LOT_CREATED':
          if (e.data.origin === 'DESCARGA') bucket(e).descargadas.add(e.data.parent);
          break;
        case 'COLLECTION_CREATED': {
          const b = bucket(e);
          b.recolectadas.add(e.entity.code);
          if (e.data.capture_mode === 'MANUAL') b.manuales.add(e.entity.code);
          break;
        }
        case 'VISIT_STATUS': {
          if (e.data.to !== 'Salió') break;
          const b = bucket(e);
          if (e.data.salida === 'RETORNABLE') b.salidas_retornable.add(e.entity.code);
          if (e.data.salida === 'RACKS') b.salidas_racks.add(e.entity.code);
          if (e.data.salida === 'VACIA') b.vacias.add(e.entity.code);
          break;
        }
        case 'LOT_STATUS': {
          const b = bucket(e);
          const fromI = idx(e.data.from), toI = idx(e.data.to);
          if (e.data.to === 'Por etiquetar') b.validadas.add(e.entity.code);
          if (fromI < 2 && toI >= 2) b.procesadas.add(e.data.parent);
          if (e.data.to === 'Ubicado total') b.ubicadas.add(e.entity.code);
          if (e.data.to === 'Ubicado parcial' || e.data.to === 'Ubicado total') {
            b.pallets_ubicados += Number(e.data.pallets_moved) || 0;
          }
          break;
        }
        default: break;
      }
    }
    const rows = Object.values(buckets).map((b) => ({
      fecha_turno: b.fecha_turno, turno: b.turno,
      descargadas: b.descargadas.size, recolectadas: b.recolectadas.size, manuales: b.manuales.size,
      validadas: b.validadas.size, procesadas: b.procesadas.size, ubicadas: b.ubicadas.size,
      pallets_ubicados: b.pallets_ubicados,
      cargadas_retornable: b.salidas_retornable.size, cargadas_racks: b.salidas_racks.size,
      cargadas: b.salidas_retornable.size + b.salidas_racks.size, vacias: b.vacias.size
    })).sort((a, b) => a.fecha_turno.localeCompare(b.fecha_turno) || a.turno.localeCompare(b.turno));
    const totals = Object.fromEntries(KPI_KEYS.map((k) => [k, 0]));
    for (const r of rows) for (const k of KPI_KEYS) totals[k] += r[k];
    return { rows, totals };
  }

  // ---------- exportación CSV (Excel lo abre directamente; BOM para acentos) ----------
  function csvText(headers, rows) {
    const cell = (v) => {
      const s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
      return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [headers, ...rows.map((r) => headers.map((h) => r[h]))];
    return '﻿' + lines.map((l) => l.map(cell).join(',')).join('\r\n') + '\r\n';
  }

  // ---------- seguridad local (PBKDF2) ----------
  // Sin servidor, esto solo impide el uso casual de la app. No cifra el historial.
  const bytesToB64 = (bytes) => { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); };
  const b64ToBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  async function hashSecret(secret, saltB64) {
    const salt = saltB64 ? b64ToBytes(saltB64) : crypto.getRandomValues(new Uint8Array(16));
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(String(secret)), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: PBKDF2_ITER, hash: 'SHA-256' }, key, 256);
    return { salt: bytesToB64(salt), hash: bytesToB64(new Uint8Array(bits)) };
  }

  // ---------- almacenamiento ----------
  // Interfaz: readText(path) -> string|null, writeText, append, remove. Rutas con "/" para subcarpetas.
  function MemoryStorage(initial = {}) {
    const files = new Map(Object.entries(initial));
    return {
      _files: files,
      async readText(p) { return files.has(p) ? files.get(p) : null; },
      async writeText(p, t) { files.set(p, t); },
      async append(p, t) { files.set(p, (files.get(p) || '') + t); },
      async remove(p) { files.delete(p); }
    };
  }

  function FsStorage(rootHandle) {
    const split = (path) => { const parts = path.split('/'); const name = parts.pop(); return { parts, name }; };
    const getDir = async (parts, create) => {
      let dir = rootHandle;
      for (const p of parts) dir = await dir.getDirectoryHandle(p, { create });
      return dir;
    };
    const getFile = async (path, create) => {
      const { parts, name } = split(path);
      try {
        const dir = await getDir(parts, create);
        return await dir.getFileHandle(name, { create });
      } catch (e) {
        if (e.name === 'NotFoundError') return null;
        throw e;
      }
    };
    return {
      async readText(path) {
        const fh = await getFile(path, false);
        return fh ? (await fh.getFile()).text() : null;
      },
      async writeText(path, text) {
        const fh = await getFile(path, true);
        const w = await fh.createWritable();
        await w.write(text);
        await w.close();
      },
      async append(path, text) {
        const fh = await getFile(path, true);
        const f = await fh.getFile();
        const w = await fh.createWritable({ keepExistingData: true });
        await w.seek(f.size);
        await w.write(text);
        await w.close();
      },
      async remove(path) {
        const { parts, name } = split(path);
        try { const dir = await getDir(parts, false); await dir.removeEntry(name); }
        catch (e) { if (e.name !== 'NotFoundError') throw e; }
      }
    };
  }

  // ---------- recordar la carpeta (IndexedDB) ----------
  const DB_NAME = 'recibo-motor';
  const STORE = 'carpetas';
  function idbRequest(mode, fn) {
    return new Promise((resolve, reject) => {
      const open = indexedDB.open(DB_NAME, 1);
      open.onupgradeneeded = () => open.result.createObjectStore(STORE);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction(STORE, mode);
        const req = fn(tx.objectStore(STORE));
        tx.oncomplete = () => { db.close(); resolve(req.result); };
        tx.onerror = () => { db.close(); reject(tx.error); };
      };
    });
  }
  const saveFolder = (handle) => idbRequest('readwrite', (s) => s.put(handle, 'carpeta'));
  const loadFolder = () => idbRequest('readonly', (s) => s.get('carpeta'));
  // Debe llamarse desde un clic del usuario.
  const pickFolder = () => window.showDirectoryPicker({ mode: 'readwrite' });
  // El navegador pide permiso de nuevo en cada sesión; requiere clic del usuario.
  async function ensurePermission(handle) {
    const opts = { mode: 'readwrite' };
    if ((await handle.queryPermission(opts)) === 'granted') return true;
    return (await handle.requestPermission(opts)) === 'granted';
  }

  // ---------- motor ----------
  function replayFrom(text, cfg) {
    const parsed = parseHistorial(text);
    return { events: parsed.events, truncated: parsed.truncated, state: replay(parsed.events, cfg) };
  }

  function createEngine(opts = {}) {
    const storage = opts.storage;
    if (!storage) fail('Falta el almacenamiento.');
    const now = opts.now || (() => new Date());
    const sessionId = opts.sessionId || (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);

    let cfg = clone(DEFAULT_CONFIG);
    let events = [];
    let state = emptyState();
    let mode = 'lectura';
    let session = null; // { empleado, name, role }
    let users = null;

    const readJson = async (p) => { const t = await storage.readText(p); return t ? JSON.parse(t) : null; };
    const requireSession = () => { if (!session) fail('Inicia sesión para continuar.'); };
    const requireWrite = () => {
      requireSession();
      if (mode !== 'escritura') fail('Estás en modo solo lectura. Toma la sesión de escritura para registrar.');
    };
    const requireAdmin = () => { requireSession(); if (session.role !== 'admin') fail('Se requiere perfil administrador.'); };
    const ctx = () => { let seq = events.length; return { cfg, operator: session ? session.name : null, now, nextSeq: () => ++seq }; };
    const buildEvent = (c, type, kind, code, data, comment = '') => {
      const d = c.now();
      const s = shiftFor(d, c.cfg.shifts);
      return {
        code: 'EVT-' + pad(c.nextSeq()), type, at: d.toISOString(), at_local: localStamp(d),
        shift: s.name, shift_date: s.shift_date, operator: c.operator,
        entity: { kind, code }, data, comment: str(comment)
      };
    };
    async function commit(list) {
      if (!list.length) return;
      await storage.append(FILES.historial, list.map(serializeEvent).join(''));
      for (const e of list) { events.push(e); applyEvent(state, e, cfg); }
    }

    // ----- arranque -----
    async function open() {
      const stored = await readJson(FILES.config);
      cfg = Object.assign(clone(DEFAULT_CONFIG), stored || {});
      cfg.shifts = cfg.shifts.map((s) => ({ meta: 0, ...s }));
      // Carpeta nueva o vacía: se crean los archivos base desde cero.
      const historialExiste = (await storage.readText(FILES.historial)) !== null;
      const nueva = !stored && !historialExiste;
      if (!stored) await storage.writeText(FILES.config, JSON.stringify(cfg, null, 2));
      if (!historialExiste) await storage.writeText(FILES.historial, '');
      const r = replayFrom((await storage.readText(FILES.historial)) || '', cfg);
      events = r.events;
      state = r.state;
      const lock = evaluateLock(await readJson(FILES.sesion), now(), sessionId, cfg.stale_lock_minutes);
      const u = await loadUsers();
      return { truncated: r.truncated, lock, has_users: u.users.length > 0, config: clone(cfg), nueva };
    }

    // Vuelve a leer el historial completo (otra pestaña o sesión pudo escribir).
    async function reload() {
      const r = replayFrom((await storage.readText(FILES.historial)) || '', cfg);
      events = r.events;
      state = r.state;
      return { truncated: r.truncated, eventos: events.length };
    }

    // ----- usuarios -----
    async function loadUsers() {
      if (!users) users = (await readJson(FILES.usuarios)) || { schema: 1, users: [], recovery: null };
      return users;
    }
    const saveUsers = () => storage.writeText(FILES.usuarios, JSON.stringify(users, null, 2));
    // El acceso se hace con el número de empleado; el nombre solo sirve para mostrar.
    const findUser = (empleado) => users.users.find((x) => x.empleado.toLowerCase() === str(empleado).toLowerCase());
    const checkEmpleado = (e) => { if (!/^[A-Za-z0-9-]{1,20}$/.test(str(e))) fail("Número de empleado: solo letras, números y guion (máximo 20)."); };
    const checkPassword = (p) => { if (String(p || '').length < 10) fail('La contraseña debe tener al menos 10 caracteres.'); };
    async function newUser(empleado, name, role, password) {
      role = normalizeRole(role);
      if (!ROLES.includes(role)) fail('Perfil no válido.');
      return { empleado, name, role, active: true, failed: 0, locked_until: null, ...(await hashSecret(password)) };
    }
    const pausaMsg = (until) => {
      const min = Math.max(1, Math.ceil((new Date(until) - now()) / 60000));
      return `Acceso pausado por seguridad. Intenta de nuevo en ${min} min.`;
    };

    async function hasUsers() { return (await loadUsers()).users.length > 0; }

    async function listUsers() {
      await loadUsers();
      return users.users.map((u) => ({ empleado: u.empleado, name: u.name, role: normalizeRole(u.role), active: u.active !== false }));
    }

    async function setupAdmin({ empleado, name, password, recovery_key } = {}) {
      await loadUsers();
      if (users.users.length) fail('Ya existe un administrador.');
      checkEmpleado(empleado);
      if (!str(name)) fail('Escribe el nombre del administrador.');
      checkPassword(password);
      if (str(recovery_key).length < 8) fail('La clave de administrador debe tener al menos 8 caracteres.');
      users.users.push(await newUser(str(empleado), str(name), 'admin', password));
      users.recovery = await hashSecret(str(recovery_key));
      await saveUsers();
      return { ok: true };
    }

    // Alta de operadores desde la pantalla de acceso. Solo después de crear el administrador.
    async function register({ empleado, name, password } = {}) {
      await loadUsers();
      if (!users.users.length) fail('Primero se crea el administrador en la primera configuración.');
      checkEmpleado(empleado);
      if (!str(name)) fail('Escribe tu nombre.');
      if (findUser(empleado)) fail('Ya existe un usuario con ese número de empleado.');
      checkPassword(password);
      users.users.push(await newUser(str(empleado), str(name), 'capturista', password));
      await saveUsers();
      return { ok: true };
    }

    async function login(empleado, password) {
      await loadUsers();
      const user = findUser(empleado);
      if (!user || !user.active) fail('Usuario o contraseña incorrectos.');
      const t = now();
      if (user.locked_until && t < new Date(user.locked_until)) fail(pausaMsg(user.locked_until));
      const { hash } = await hashSecret(password || '', user.salt);
      if (hash !== user.hash) {
        user.failed += 1;
        if (user.failed >= cfg.lockout.attempts) {
          user.failed = 0;
          user.locked_until = new Date(t.getTime() + cfg.lockout.minutes * 60000).toISOString();
          await saveUsers();
          fail(pausaMsg(user.locked_until));
        }
        await saveUsers();
        fail('Usuario o contraseña incorrectos.');
      }
      user.failed = 0;
      user.locked_until = null;
      await saveUsers();
      session = { empleado: user.empleado, name: user.name, role: normalizeRole(user.role) };
      return { ...session };
    }

    async function resetPassword({ empleado, recovery_key, new_password } = {}) {
      await loadUsers();
      const user = findUser(empleado);
      if (!user || !users.recovery) fail('Datos incorrectos.');
      const { hash } = await hashSecret(str(recovery_key), users.recovery.salt);
      if (hash !== users.recovery.hash) fail('Clave de administrador incorrecta.');
      checkPassword(new_password);
      Object.assign(user, await hashSecret(new_password), { failed: 0, locked_until: null });
      await saveUsers();
      return { ok: true };
    }

    async function addUser({ empleado, name, password, role } = {}) {
      requireAdmin();
      await loadUsers();
      checkEmpleado(empleado);
      if (!str(name)) fail('Escribe el nombre del usuario.');
      if (findUser(empleado)) fail('Ya existe un usuario con ese número de empleado.');
      checkPassword(password);
      users.users.push(await newUser(str(empleado), str(name), role, password));
      await saveUsers();
      return { ok: true };
    }

    // ----- sesión de escritura -----
    async function writeLock() {
      const t = now().toISOString();
      await storage.writeText(FILES.sesion, JSON.stringify({
        session: sessionId, owner: session.empleado, started_at: t, heartbeat_at: t
      }, null, 2));
    }

    async function acquire({ takeover = false } = {}) {
      requireSession();
      // Antes de escribir hay que ver lo que otra pestaña registró mientras esta estaba en lectura.
      await reload();
      const ls = evaluateLock(await readJson(FILES.sesion), now(), sessionId, cfg.stale_lock_minutes);
      const mismo = ls.owner === session.empleado;
      // Una sesión viva de otro operador nunca se toma. La del mismo operador (otra pestaña
      // o un cierre sin liberar) solo se toma explícitamente.
      if (ls.status === 'ocupada' && !(takeover && mismo)) return { ok: false, status: 'ocupada', owner: ls.owner, mismo };
      if (ls.status === 'vencida' && !takeover) return { ok: false, status: 'vencida', owner: ls.owner, mismo };
      await writeLock();
      mode = 'escritura';
      return { ok: true, status: ls.status };
    }

    async function heartbeat() {
      if (mode !== 'escritura') return { mode };
      const ls = evaluateLock(await readJson(FILES.sesion), now(), sessionId, cfg.stale_lock_minutes);
      if (ls.status !== 'mia') { mode = 'lectura'; return { mode, lost: true }; }
      await writeLock();
      return { mode };
    }

    async function release() {
      if (mode === 'escritura') {
        const ls = evaluateLock(await readJson(FILES.sesion), now(), sessionId, cfg.stale_lock_minutes);
        if (ls.status === 'mia') await storage.remove(FILES.sesion);
      }
      mode = 'lectura';
      return { mode };
    }

    async function logout() {
      if (mode === 'escritura') await release();
      session = null;
      return { ok: true };
    }

    // ----- configuración (solo administrador) -----
    async function saveConfig(patch = {}) {
      requireAdmin();
      requireWrite();
      const next = validateConfig(Object.assign(clone(cfg), clone(patch)), events.length > 0, cfg);
      const changes = {};
      for (const k of Object.keys(patch)) {
        if (JSON.stringify(cfg[k]) !== JSON.stringify(next[k])) changes[k] = { antes: cfg[k], despues: next[k] };
      }
      if (!Object.keys(changes).length) return { ok: true, changes };
      await commit([buildEvent(ctx(), 'CONFIG_CHANGED', 'CONFIG', 'config', { changes })]);
      await storage.writeText(FILES.config, JSON.stringify(next, null, 2));
      cfg = next;
      return { ok: true, changes };
    }

    // ----- remolques (visitas) -----
    // Asigna una caja a una rampa libre. Siempre empieza en "Por descarga".
    async function createVisit({ box_code, supplier, ramp, arrived_at } = {}) {
      requireWrite();
      const box = str(box_code), sup = str(supplier), r = str(ramp);
      if (!box || !sup) fail('Captura número de caja y proveedor.');
      if (!cfg.ramps.includes(r)) fail('Rampa no válida.');
      const abiertas = Object.values(state.visits).filter((v) => !v.closed);
      const ocupada = abiertas.find((v) => v.ramp === r);
      if (ocupada) fail(`La rampa ${r} ya tiene la caja ${ocupada.box_code}.`);
      const otra = abiertas.find((v) => v.box_code === box);
      if (otra) fail(`La caja ${box} ya está abierta en la rampa ${otra.ramp}.`);
      const llegada = arrived_at ? new Date(arrived_at) : now();
      if (Number.isNaN(llegada.getTime())) fail('Fecha de llegada no válida.');
      if (llegada.getTime() > now().getTime() + 5 * 60000) fail('La llegada no puede ser futura.');
      const code = nextCode('VIS', Object.keys(state.visits));
      await commit([buildEvent(ctx(), 'VISIT_CREATED', 'VISIT', code, {
        box_code: box, supplier: sup, ramp: r, arrived_at: llegada.toISOString()
      })]);
      return { visit_code: code };
    }

    // Pasa la caja de "Por descarga" a "Descargado" y la registra en una o más bahías
    // con estatus "Por validar". Ambos eventos quedan en la misma escritura.
    // Encargado: si captura un capturista, es el supervisor elegido; si captura un supervisor, es él mismo.
    function resolverEncargado(encargado) {
      if (session.role !== 'capturista') return { empleado: session.empleado, name: session.name };
      const emp = str(encargado);
      const sup = users.users.find((u) => u.empleado === emp && normalizeRole(u.role) === 'supervisor' && u.active !== false);
      if (!sup) fail('Elige el encargado (un supervisor) antes de registrar.');
      return { empleado: sup.empleado, name: sup.name };
    }

    async function pasarABahia(visit_code, { allocations, encargado } = {}) {
      requireWrite();
      const v = state.visits[visit_code];
      if (!v) fail('Visita no encontrada.');
      if (v.closed) fail('La visita ya está cerrada.');
      if (v.stage !== TRAILER_STAGES[0]) fail('Solo se pasa a bahía una caja en "' + TRAILER_STAGES[0] + '".');
      const lista = (Array.isArray(allocations) ? allocations : []).map((a) => ({ bay: str(a && a.bay), pallets: toInt(a && a.pallets) }));
      if (!lista.length) fail('Indica al menos una bahía.');
      for (const a of lista) {
        if (!cfg.bays.includes(a.bay)) fail('Bahía no válida.');
        if (!(a.pallets >= 1)) fail('Cada bahía necesita al menos un pallet.');
      }
      if (new Set(lista.map((a) => a.bay)).size !== lista.length) fail('Una bahía aparece dos veces.');
      const enc = resolverEncargado(encargado);
      const c = ctx();
      const codigos = Object.keys(state.lots);
      const eventos = [];
      for (const a of lista) {
        const code = nextCode('DESC', codigos);
        codigos.push(code);
        eventos.push(buildEvent(c, 'LOT_CREATED', 'LOT', code, {
          parent: visit_code, origin: 'DESCARGA', box_code: v.box_code, bay: a.bay, pallets_total: a.pallets, capture_mode: 'OPERATIVA',
          encargado: enc.empleado, encargado_nombre: enc.name
        }));
      }
      eventos.push(buildEvent(c, 'VISIT_STATUS', 'VISIT', visit_code, { from: v.stage, to: TRAILER_STAGES[1] }));
      await commit(eventos);
      return { lot_codes: eventos.slice(0, -1).map((e) => e.entity.code) };
    }

    // Avanza la rampa según las transiciones fijas. Para salir hay que indicar cómo sale la caja.
    async function advanceVisit(visit_code, { to, salida, comment, encargado } = {}) {
      requireWrite();
      const v = state.visits[visit_code];
      if (!v) fail('Visita no encontrada.');
      if (v.closed) fail('La visita ya está cerrada.');
      const target = str(to);
      if (target === TRAILER_STAGES[1]) fail('Para pasar a "Descargado" registra la bahía con "Pasar a bahía".');
      if (!(TRANSICIONES[v.stage] || []).includes(target)) fail(`No se puede pasar de "${v.stage}" a "${target}".`);
      const data = { from: v.stage, to: target };
      if (target === 'Salió') {
        const sal = str(salida).toUpperCase();
        if (!SALIDAS.includes(sal)) fail('Indica cómo sale la caja: retornable, racks o vacía.');
        if (SALIDA_DE[v.stage] && SALIDA_DE[v.stage] !== sal) {
          fail(`La caja está cargando ${SALIDA_DE[v.stage].toLowerCase()}; la salida debe ser ${SALIDA_DE[v.stage].toLowerCase()}.`);
        }
        data.salida = sal;
        const enc = resolverEncargado(encargado);
        data.encargado = enc.empleado;
        data.encargado_nombre = enc.name;
      }
      await commit([buildEvent(ctx(), 'VISIT_STATUS', 'VISIT', visit_code, data, comment)]);
      return { ok: true };
    }

    // ----- descargas de producto (lotes por bahía) -----
    async function createLot(visit_code, { bay, pallets } = {}) {
      requireWrite();
      const v = state.visits[visit_code];
      if (!v) fail('Visita no encontrada.');
      if (v.closed) fail('No se pueden agregar descargas a una visita cerrada.');
      const b = str(bay), p = toInt(pallets);
      if (!cfg.bays.includes(b)) fail('Bahía no válida.');
      if (!(p >= 1)) fail('Indica al menos un pallet.');
      const code = nextCode('DESC', Object.keys(state.lots));
      await commit([buildEvent(ctx(), 'LOT_CREATED', 'LOT', code, {
        parent: visit_code, origin: 'DESCARGA', box_code: v.box_code, bay: b, pallets_total: p, capture_mode: 'OPERATIVA'
      })]);
      return { lot_code: code };
    }

    async function advanceLot(lot_code, { to, pallets_located, comment } = {}) {
      requireWrite();
      const lot = state.lots[lot_code];
      if (!lot) fail('Lote no encontrado.');
      const plan = planLotAdvance(lot, { to, pallets_located, comment }, cfg);
      await commit([buildEvent(ctx(), 'LOT_STATUS', 'LOT', lot_code, {
        parent: lot.parent, from: lot.stage, to: str(to), skipped: plan.skipped,
        pallets_moved: plan.moved, pallets_remaining: plan.remaining
      }, comment)]);
      return { pallets_remaining: plan.remaining };
    }

    // ----- recolecciones directas -----
    async function createCollection({ box_code, origin_area, capture_mode, reason, occurrence_at, allocations, notes, unit, stage, encargado } = {}) {
      requireWrite();
      const box = str(box_code), origin = str(origin_area);
      const uni = str(unit || 'CAJA').toUpperCase();
      if (!UNIDADES.includes(uni)) fail('Unidad no válida.');
      const etapaInicial = str(stage || cfg.product_stages[0]);
      if (!cfg.product_stages.includes(etapaInicial)) fail('Estatus no válido.');
      const m = str(capture_mode || 'OPERATIVA').toUpperCase();
      const why = str(reason);
      if (!box || !origin) fail('Captura folio y área de origen.');
      if (!['OPERATIVA', 'MANUAL'].includes(m)) fail('Modalidad de captura no válida.');
      if (!Array.isArray(allocations) || !allocations.length) fail('Agrega al menos una bahía con pallets.');
      const clean = allocations.map((a) => ({ bay: str(a.bay), pallets: toInt(a.pallets) }));
      for (const a of clean) {
        if (!cfg.bays.includes(a.bay) || !(a.pallets >= 1)) fail('Cada asignación necesita una bahía válida y al menos un pallet.');
      }
      if (new Set(clean.map((a) => a.bay)).size !== clean.length) fail('No repitas la misma bahía; suma los pallets en una sola línea.');
      for (const a of clean) {
        const abiertas = Object.values(state.lots).filter((l) => !l.closed && l.bay === a.bay).length;
        if (abiertas >= MAX_CAJAS_BAHIA) fail(`La bahía ${a.bay} ya tiene ${MAX_CAJAS_BAHIA} cajas abiertas.`);
      }
      const when = occurrence_at ? new Date(occurrence_at) : now();
      if (Number.isNaN(when.getTime())) fail('Fecha del hecho no válida.');

      const code = nextCode('REC', Object.keys(state.collections));
      const enc = resolverEncargado(encargado);
      const c = ctx();
      const batch = [buildEvent(c, 'COLLECTION_CREATED', 'COLLECTION', code, {
        box_code: box, origin_area: origin, capture_mode: m, reason: why,
        occurrence_at: when.toISOString(), bays: clean.map((a) => a.bay), notes: str(notes),
        encargado: enc.empleado, encargado_nombre: enc.name
      }, m === 'MANUAL' ? (why ? `CAJA OMITIDA: ${why}` : 'CAJA OMITIDA') : '')];
      const known = Object.keys(state.lots);
      const lotCodes = [];
      for (const a of clean) {
        const lc = nextCode('DESC', known);
        known.push(lc);
        lotCodes.push(lc);
        batch.push(buildEvent(c, 'LOT_CREATED', 'LOT', lc, {
          parent: code, origin: 'RECOLECCION', box_code: box, bay: a.bay,
          pallets_total: a.pallets, capture_mode: m, collection_code: code, unit: uni,
          encargado: enc.empleado, encargado_nombre: enc.name
        }));
        // Si se registra en un estatus posterior, las etapas previas se dan por cumplidas.
        if (etapaInicial !== cfg.product_stages[0]) {
          const plan = planLotAdvance({ stage: cfg.product_stages[0], stage_index: 0, pallets_remaining: a.pallets, closed: false },
            { to: etapaInicial, pallets_located: a.pallets }, cfg);
          batch.push(buildEvent(c, 'LOT_STATUS', 'LOT', lc, {
            parent: code, from: cfg.product_stages[0], to: etapaInicial, skipped: plan.skipped,
            pallets_moved: plan.moved, pallets_remaining: plan.remaining
          }));
        }
      }
      await commit(batch);
      return { collection_code: code, lot_codes: lotCodes };
    }

    // ----- cierre de turno y respaldo -----
    async function closeShift() {
      requireWrite();
      const d = now();
      const s = shiftFor(d, cfg.shifts);
      const text = (await storage.readText(FILES.historial)) || '';
      const stamp = `${pad(d.getHours(), 2)}${pad(d.getMinutes(), 2)}`;
      const path = `${FILES.respaldos}/historial_${s.shift_date}_${slug(s.name)}_${stamp}.jsonl`;
      await storage.writeText(path, text);
      await commit([buildEvent(ctx(), 'SHIFT_CLOSED', 'SHIFT', `${s.shift_date}|${s.name}`,
        { backup: path, eventos: events.length })]);
      return { backup: path };
    }

    // ----- consultas y exportación -----
    const kpis = (filter) => computeKpis(events, cfg.product_stages, filter);
    const exportEventsCsv = () => csvText(
      ['code', 'at_utc', 'at_local', 'turno', 'fecha_turno', 'operador', 'tipo', 'entidad', 'codigo', 'datos', 'comentario'],
      events.map((e) => ({
        code: e.code, at_utc: e.at, at_local: e.at_local, turno: e.shift, fecha_turno: e.shift_date,
        operador: e.operator, tipo: e.type, entidad: e.entity.kind, codigo: e.entity.code,
        datos: e.data, comentario: e.comment
      })));
    const exportKpiCsv = (filter) => {
      const k = kpis(filter);
      return csvText(['fecha_turno', 'turno', ...KPI_KEYS], k.rows);
    };
    const snapshot = () => ({
      visits: Object.values(state.visits).map(clone),
      lots: Object.values(state.lots).map(clone),
      collections: Object.values(state.collections).map(clone),
      config: clone(cfg)
    });

    return {
      open, reload, hasUsers, listUsers, setupAdmin, register, login, logout, resetPassword, addUser,
      acquire, heartbeat, release, saveConfig,
      createVisit, pasarABahia, advanceVisit, createLot, advanceLot, createCollection, closeShift,
      kpis, exportEventsCsv, exportKpiCsv, snapshot,
      productividad: async (f = {}) => { await loadUsers(); return calcularProductividad(events, cfg, { from: f.from, to: f.to, turno: f.turno, encargado: f.encargado }, now()); },
      listSupervisores: async () => { await loadUsers(); return users.users.filter((u) => normalizeRole(u.role) === 'supervisor' && u.active !== false).map((u) => ({ empleado: u.empleado, name: u.name })); },
      events: () => clone(events),
      get mode() { return mode; },
      get session() { return session ? { ...session } : null; },
      get config() { return clone(cfg); },
      sessionId
    };
  }

  root.ReciboMotor = {
    VERSION, FILES, DEFAULT_CONFIG, UNIDADES, MAX_CAJAS_BAHIA, responsableDe, calcularProductividad, esLaboral, horasTurno, KPI_KEYS, TRAILER_STAGES, TRANSICIONES, SALIDAS, MotorError,
    shiftFor, parseHistorial, serializeEvent, replay, applyEvent,
    planForward, planLotAdvance, computeKpis, evaluateLock, csvText, hashSecret,
    MemoryStorage, FsStorage,
    browser: { saveFolder, loadFolder, pickFolder, ensurePermission },
    createEngine
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
