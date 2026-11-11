import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

vm.runInThisContext(fs.readFileSync(new URL('../motor.js', import.meta.url), 'utf8'));
const M = globalThis.ReciboMotor;

// Fechas locales: mes 10 = noviembre (0-indexado)
const at = (h, mi, d = 10) => new Date(2026, 10, d, h, mi);

function engineAt(date, storage, sessionId = 'S1') {
  const clock = { t: date };
  const engine = M.createEngine({ storage, now: () => new Date(clock.t), sessionId });
  return { engine, clock, storage };
}

async function ready(date, storage = M.MemoryStorage()) {
  const h = engineAt(date, storage);
  await h.engine.open();
  await h.engine.setupAdmin({ empleado: '1001', name: 'Charlie', password: 'contraseña123', recovery_key: 'recuperar-1' });
  await h.engine.login('1001', 'contraseña123');
  const r = await h.engine.acquire();
  assert.equal(r.ok, true);
  return h;
}

// ---------- turnos ----------
test('turnos: Noche cruza medianoche y toma la fecha de inicio', () => {
  const s = M.DEFAULT_CONFIG.shifts;
  assert.deepEqual(M.shiftFor(at(7, 0), s), { name: 'Día', shift_date: '2026-11-10' });
  assert.equal(M.shiftFor(at(14, 59), s).name, 'Día');
  assert.equal(M.shiftFor(at(15, 0), s).name, 'Tarde');
  assert.equal(M.shiftFor(at(22, 29), s).name, 'Tarde');
  assert.deepEqual(M.shiftFor(at(22, 30), s), { name: 'Noche', shift_date: '2026-11-10' });
  assert.deepEqual(M.shiftFor(at(23, 59), s), { name: 'Noche', shift_date: '2026-11-10' });
  assert.deepEqual(M.shiftFor(at(1, 0), s), { name: 'Noche', shift_date: '2026-11-09' });
  assert.deepEqual(M.shiftFor(at(6, 59), s), { name: 'Noche', shift_date: '2026-11-09' });
});

// ---------- flujo y códigos ----------
test('flujo completo de descarga con códigos consecutivos y estado reproducible desde archivo', async () => {
  const storage = M.MemoryStorage();
  const { engine } = await ready(at(8, 0), storage);
  const v = await engine.createVisit({ box_code: 'REM-105', supplier: 'Proveedor ABC', ramp: '748' });
  assert.equal(v.visit_code, 'VIS-000001');
  const l = await engine.createLot(v.visit_code, { bay: '747', pallets: 12 });
  assert.equal(l.lot_code, 'DESC-000001');
  await engine.advanceLot(l.lot_code, { to: 'Por etiquetar' });
  await engine.advanceLot(l.lot_code, { to: 'Por ubicar' });
  await engine.advanceLot(l.lot_code, { to: 'Ubicado parcial', pallets_located: 5 });
  const r = await engine.advanceLot(l.lot_code, { to: 'Ubicado total' });
  assert.equal(r.pallets_remaining, 0);

  // Reabrir desde el archivo debe dar el mismo estado
  const again = engineAt(at(9, 0), storage, 'S9');
  await again.engine.open();
  const snap = again.engine.snapshot();
  assert.equal(snap.lots.length, 1);
  assert.equal(snap.lots[0].closed, true);
  assert.equal(snap.lots[0].pallets_remaining, 0);
  assert.equal(again.engine.events().length, 6);
});

test('saltar pasos no pide motivo: las etapas intermedias quedan cumplidas', async () => {
  const { engine } = await ready(at(8, 0));
  const v = await engine.createVisit({ box_code: 'REM-1', supplier: 'P', ramp: '744' });
  const l = await engine.createLot(v.visit_code, { bay: '744', pallets: 3 });
  await engine.advanceLot(l.lot_code, { to: 'Por ubicar' });
  const last = engine.events().at(-1);
  assert.deepEqual(last.data.skipped, ['Por etiquetar']);
  assert.equal(engine.snapshot().lots[0].stage, 'Por ubicar');
});

test('no se permite regresar a un estatus anterior', async () => {
  const { engine } = await ready(at(8, 0));
  const v = await engine.createVisit({ box_code: 'REM-1', supplier: 'P', ramp: '744' });
  const l = await engine.createLot(v.visit_code, { bay: '744', pallets: 3 });
  await engine.advanceLot(l.lot_code, { to: 'Por etiquetar' });
  await engine.advanceLot(l.lot_code, { to: 'Por ubicar' });
  await assert.rejects(engine.advanceLot(l.lot_code, { to: 'Por etiquetar' }), /regresar/);
});

test('ubicación parcial valida saldo y total cierra el lote', async () => {
  const { engine } = await ready(at(8, 0));
  const v = await engine.createVisit({ box_code: 'REM-1', supplier: 'P', ramp: '744' });
  const l = await engine.createLot(v.visit_code, { bay: '744', pallets: 4 });
  await engine.advanceLot(l.lot_code, { to: 'Por etiquetar' });
  await engine.advanceLot(l.lot_code, { to: 'Por ubicar' });
  await assert.rejects(engine.advanceLot(l.lot_code, { to: 'Ubicado parcial', pallets_located: 4 }), /menores/);
  await assert.rejects(engine.advanceLot(l.lot_code, { to: 'Ubicado parcial', pallets_located: 0 }), /mayores/);
  const p = await engine.advanceLot(l.lot_code, { to: 'Ubicado parcial', pallets_located: 1 });
  assert.equal(p.pallets_remaining, 3);
  await engine.advanceLot(l.lot_code, { to: 'Ubicado total' });
  await assert.rejects(engine.advanceLot(l.lot_code, { to: 'Ubicado parcial', pallets_located: 1 }), /cerrado/);
});

test('visita cerrada no admite nuevas descargas', async () => {
  const { engine } = await ready(at(8, 0));
  const v = await engine.createVisit({ box_code: 'REM-1', supplier: 'P', ramp: '744' });
  await engine.pasarABahia(v.visit_code, { allocations: [{ bay: '744', pallets: 3 }] });
  await engine.advanceVisit(v.visit_code, { to: 'Salió', salida: 'VACIA' });
  await assert.rejects(engine.createLot(v.visit_code, { bay: '744', pallets: 1 }), /cerrada/);
});

// ---------- recolección y captura manual ----------
test('recolección multi-bahía cuenta una caja en el KPI', async () => {
  const { engine } = await ready(at(8, 0));
  const r = await engine.createCollection({
    box_code: 'CAJA-123', origin_area: 'Producción', capture_mode: 'OPERATIVA',
    allocations: [{ bay: '744', pallets: 8 }, { bay: '747', pallets: 4 }]
  });
  assert.equal(r.collection_code, 'REC-000001');
  assert.equal(r.lot_codes.length, 2);
  assert.equal(engine.kpis().totals.recolectadas, 1);
  assert.equal(engine.kpis().totals.manuales, 0);
});

test('caja omitida (manual) no exige motivo y se marca como manual', async () => {
  const { engine } = await ready(at(8, 0));
  const alloc = [{ bay: '747', pallets: 2 }];
  await engine.createCollection({
    box_code: 'CAJA-9', origin_area: 'Producción', capture_mode: 'MANUAL', reason: '', allocations: alloc
  });
  const k = engine.kpis().totals;
  assert.equal(k.manuales, 1);
  assert.equal(engine.snapshot().lots[0].capture_mode, 'MANUAL');
});

// ---------- KPI: procesada cuenta en el turno que etiqueta ----------
test('caja validada en un turno y etiquetada en otro cuenta como procesada en el turno que etiqueta', async () => {
  const h = await ready(at(10, 0));
  const v = await h.engine.createVisit({ box_code: 'REM-7', supplier: 'P', ramp: '745' });
  const l = await h.engine.createLot(v.visit_code, { bay: '745', pallets: 6 });
  await h.engine.advanceLot(l.lot_code, { to: 'Por etiquetar' });
  h.clock.t = at(16, 0);
  await h.engine.advanceLot(l.lot_code, { to: 'Por ubicar' });
  const k = h.engine.kpis();
  const dia = k.rows.find((r) => r.turno === 'Día');
  const tarde = k.rows.find((r) => r.turno === 'Tarde');
  assert.equal(dia.validadas, 1);
  assert.equal(dia.procesadas, 0);
  assert.equal(tarde.validadas, 0);
  assert.equal(tarde.procesadas, 1);
});

// ---------- bloqueo de escritura ----------
test('evaluación de sesión: libre, mía, ocupada y vencida', () => {
  const now = new Date(2026, 10, 10, 16, 0);
  assert.equal(M.evaluateLock(null, now, 'A', 10).status, 'libre');
  const fresh = { session: 'B', owner: 'Ana', heartbeat_at: new Date(now - 2 * 60000).toISOString() };
  assert.equal(M.evaluateLock(fresh, now, 'A', 10).status, 'ocupada');
  assert.equal(M.evaluateLock(fresh, now, 'B', 10).status, 'mia');
  const old = { ...fresh, heartbeat_at: new Date(now - 30 * 60000).toISOString() };
  assert.equal(M.evaluateLock(old, now, 'A', 10).status, 'vencida');
});

test('segunda sesión queda en solo lectura y puede tomar la sesión si está vencida', async () => {
  const storage = M.MemoryStorage();
  const a = await ready(at(8, 0), storage);
  const b = engineAt(at(8, 5), storage, 'S2');
  await b.engine.open();
  await b.engine.login('1001', 'contraseña123');
  const r = await b.engine.acquire();
  assert.equal(r.ok, false);
  assert.equal(r.status, 'ocupada');
  assert.equal(b.engine.mode, 'lectura');
  await assert.rejects(b.engine.createVisit({ box_code: 'X', supplier: 'P', ramp: '744' }), /solo lectura/);

  // La sesión A deja de latir; pasan 60 min
  b.clock.t = at(9, 5);
  const v = await b.engine.acquire();
  assert.equal(v.status, 'vencida');
  assert.equal(v.ok, false);
  const t = await b.engine.acquire({ takeover: true });
  assert.equal(t.ok, true);
  assert.equal(b.engine.mode, 'escritura');
  // La sesión A, al latir, detecta que perdió la escritura
  a.clock.t = at(9, 6);
  const hb = await a.engine.heartbeat();
  assert.equal(hb.lost, true);
  assert.equal(a.engine.mode, 'lectura');
});

// ---------- configuración ----------
test('configuración solo la cambia el administrador y queda en el historial', async () => {
  const { engine } = await ready(at(8, 0));
  await engine.saveConfig({ bays: ['744', '745', '999'] });
  assert.ok(engine.config.bays.includes('999'));
  const ev = engine.events().at(-1);
  assert.equal(ev.type, 'CONFIG_CHANGED');
  assert.deepEqual(ev.data.changes.bays.antes.length, 15);
  await assert.rejects(engine.saveConfig({ product_stages: ['A', 'B'] }), /historial|Estatus/);
  await assert.rejects(engine.saveConfig({ shifts: [{ name: 'X', start: '25:00', end: '07:00' }] }), /inválido/);
});

test('cambiar el flujo se bloquea cuando ya hay historial', async () => {
  const { engine } = await ready(at(8, 0));
  await engine.createVisit({ box_code: 'REM-1', supplier: 'P', ramp: '744' });
  await assert.rejects(
    engine.saveConfig({ product_stages: ['Por validar', 'Por ubicar', 'Ubicado total'] }),
    /historial/
  );
});

// ---------- autenticación ----------
test('bloqueo tras cinco intentos fallidos y recuperación con clave de administrador', async () => {
  const storage = M.MemoryStorage();
  const h = await ready(at(8, 0), storage);
  await h.engine.logout();
  for (let i = 0; i < 4; i++) {
    await assert.rejects(h.engine.login('1001', 'mal-intento-1'), /incorrectos/);
  }
  await assert.rejects(h.engine.login('1001', 'mal-intento-1'), /pausado/);
  await assert.rejects(h.engine.login('1001', 'contraseña123'), /pausado/);

  h.clock.t = at(8, 15);
  await assert.rejects(h.engine.resetPassword({ empleado: '1001', recovery_key: 'mala-clave', new_password: 'nueva-clave-123' }), /incorrecta/);
  await h.engine.resetPassword({ empleado: '1001', recovery_key: 'recuperar-1', new_password: 'nueva-clave-123' });
  const s = await h.engine.login('1001', 'nueva-clave-123');
  assert.equal(s.role, 'admin');
});

test('contraseña corta se rechaza y un supervisor no administra configuración', async () => {
  const { engine } = await ready(at(8, 0));
  await assert.rejects(engine.addUser({ empleado: '2002', name: 'Ana', password: 'corta', role: 'supervisor' }), /10 caracteres/);
  await engine.addUser({ empleado: '2002', name: 'Ana', password: 'clave-de-ana-1', role: 'supervisor' });
  await engine.logout();
  await engine.login('2002', 'clave-de-ana-1');
  await assert.rejects(engine.saveConfig({ bays: ['744'] }), /administrador/);
});

// ---------- historial, respaldo y exportación ----------
test('historial con última línea cortada se abre y se reporta; línea dañada en medio bloquea', () => {
  const ok = M.parseHistorial('{"code":"EVT-000001","type":"X"}\n{"code":"EVT-00');
  assert.equal(ok.events.length, 1);
  assert.equal(ok.truncated, 1);
  assert.throws(() => M.parseHistorial('{"a":1}\nno-json\n{"b":2}\n'), /dañada/);
});

test('cierre de turno crea respaldo en la carpeta respaldos', async () => {
  const storage = M.MemoryStorage();
  const { engine } = await ready(at(8, 0), storage);
  await engine.createVisit({ box_code: 'REM-1', supplier: 'P', ramp: '744' });
  const r = await engine.closeShift();
  assert.match(r.backup, /^respaldos\/historial_2026-11-10_dia_0800\.jsonl$/);
  assert.ok(storage._files.get(r.backup).includes('VIS'));
});

test('exportación CSV escapa comas, comillas y saltos de línea y lleva BOM', () => {
  const csv = M.csvText(['a', 'b'], [{ a: 'x,"y"\nz', b: 3 }]);
  assert.ok(csv.startsWith('﻿'));
  assert.ok(csv.includes('a,b\r\n"x,""y""\nz",3\r\n'));
});

test('KPI CSV por turno tiene columnas esperadas', async () => {
  const { engine } = await ready(at(8, 0));
  await engine.createCollection({ box_code: 'C1', origin_area: 'Prod', capture_mode: 'OPERATIVA', allocations: [{ bay: '744', pallets: 1 }] });
  const csv = engine.exportKpiCsv();
  assert.ok(csv.includes('fecha_turno,turno,descargadas,recolectadas,manuales,validadas,procesadas,ubicadas,pallets_ubicados'));
  assert.ok(csv.includes('2026-11-10,Día,0,1,0,0,0,0,0'));
});

test('rampa: no admite dos cajas abiertas ni una caja en dos rampas', async () => {
  const { engine } = await ready(at(8, 0));
  await engine.createVisit({ box_code: 'REM-A', supplier: 'P', ramp: '744' });
  await assert.rejects(engine.createVisit({ box_code: 'REM-B', supplier: 'P', ramp: '744' }), /ya tiene la caja REM-A/);
  await assert.rejects(engine.createVisit({ box_code: 'REM-A', supplier: 'P', ramp: '745' }), /ya está abierta en la rampa 744/);
});

test('rampa: la llegada capturada define las horas; no puede ser futura', async () => {
  const { engine } = await ready(at(8, 0));
  await assert.rejects(engine.createVisit({ box_code: 'R', supplier: 'P', ramp: '744', arrived_at: at(9, 0).toISOString() }), /futura/);
  const v = await engine.createVisit({ box_code: 'R', supplier: 'P', ramp: '744', arrived_at: at(6, 0).toISOString() });
  assert.equal(engine.snapshot().visits.find((x) => x.code === v.visit_code).created_at, at(6, 0).toISOString());
});

test('rampa: pasar a bahía crea los lotes en Por validar y deja la caja en Descargado', async () => {
  const { engine } = await ready(at(8, 0));
  const v = await engine.createVisit({ box_code: 'REM-1', supplier: 'P', ramp: '744' });
  const r = await engine.pasarABahia(v.visit_code, { allocations: [{ bay: '744', pallets: 4 }, { bay: '745', pallets: 2 }] });
  assert.equal(r.lot_codes.length, 2);
  const snap = engine.snapshot();
  assert.equal(snap.visits[0].stage, 'Descargado');
  assert.deepEqual(snap.lots.map((l) => l.stage), ['Por validar', 'Por validar']);
  assert.ok(snap.lots.every((l) => l.parent === v.visit_code));
});

test('rampa: no se salta el flujo: no se pasa a Descargado sin bahía ni a cargando desde Por descarga', async () => {
  const { engine } = await ready(at(8, 0));
  const v = await engine.createVisit({ box_code: 'REM-1', supplier: 'P', ramp: '744' });
  await assert.rejects(engine.advanceVisit(v.visit_code, { to: 'Descargado' }), /Pasar a bahía/);
  await assert.rejects(engine.advanceVisit(v.visit_code, { to: 'Cargando racks' }), /No se puede pasar/);
  await assert.rejects(engine.pasarABahia(v.visit_code, { allocations: [] }), /al menos una bahía/);
});

test('rampa: salida con tipo; cargando exige su mismo tipo; productividad de cargas', async () => {
  const { engine } = await ready(at(8, 0));
  const a = await engine.createVisit({ box_code: 'A', supplier: 'P', ramp: '744' });
  await engine.pasarABahia(a.visit_code, { allocations: [{ bay: '744', pallets: 2 }] });
  await engine.advanceVisit(a.visit_code, { to: 'Cargando racks' });
  await assert.rejects(engine.advanceVisit(a.visit_code, { to: 'Salió', salida: 'VACIA' }), /racks/);
  await assert.rejects(engine.advanceVisit(a.visit_code, { to: 'Salió' }), /retornable, racks o vacía/);
  await engine.advanceVisit(a.visit_code, { to: 'Salió', salida: 'RACKS' });

  const b = await engine.createVisit({ box_code: 'B', supplier: 'P', ramp: '745' });
  await engine.pasarABahia(b.visit_code, { allocations: [{ bay: '745', pallets: 1 }] });
  await engine.advanceVisit(b.visit_code, { to: 'Salió', salida: 'RETORNABLE' });

  const c = await engine.createVisit({ box_code: 'C', supplier: 'P', ramp: '746' });
  await engine.pasarABahia(c.visit_code, { allocations: [{ bay: '746', pallets: 1 }] });
  await engine.advanceVisit(c.visit_code, { to: 'Salió', salida: 'VACIA' });

  const t = engine.kpis().totals;
  assert.equal(t.cargadas_racks, 1);
  assert.equal(t.cargadas_retornable, 1);
  assert.equal(t.cargadas, 2);
  assert.equal(t.vacias, 1);
});

test('bahías 746A y 746B existen por defecto; las rampas no', async () => {
  const { engine } = await ready(at(8, 0));
  assert.ok(engine.config.bays.includes('746A') && engine.config.bays.includes('746B'));
  assert.ok(!engine.config.ramps.includes('746A') && !engine.config.ramps.includes('746B'));
});

// ---------- registro en bahía: estatus inicial, unidad, límite y responsable ----------
test('registrar en "Por ubicar" marca Por validar y Por etiquetar como cumplidas', async () => {
  const { engine } = await ready(at(8, 0));
  await engine.createCollection({
    box_code: 'CAJA-50', origin_area: 'Recibo', allocations: [{ bay: '747', pallets: 4 }],
    unit: 'PALLET', stage: 'Por ubicar'
  });
  const lote = engine.snapshot().lots[0];
  assert.equal(lote.stage, 'Por ubicar');
  assert.equal(lote.unit, 'PALLET');
  const ev = engine.events().filter((e) => e.type === 'LOT_STATUS').at(-1);
  assert.deepEqual(ev.data.skipped, ['Por etiquetar']);
});

test('responsable: Putaway solo en Por ubicar; lo demás es Recibo', () => {
  assert.equal(M.responsableDe('Por ubicar'), 'Putaway');
  assert.equal(M.responsableDe('Por validar'), 'Recibo');
  assert.equal(M.responsableDe('Ubicado total'), 'Recibo');
});

test('una bahía no admite más de 100 cajas abiertas', async () => {
  const { engine } = await ready(at(8, 0));
  assert.equal(M.MAX_CAJAS_BAHIA, 100);
  for (let i = 0; i < M.MAX_CAJAS_BAHIA; i++) {
    await engine.createCollection({ box_code: 'B-' + i, origin_area: 'Recibo', allocations: [{ bay: '748', pallets: 1 }] });
  }
  await assert.rejects(engine.createCollection({
    box_code: 'EXTRA', origin_area: 'Recibo', allocations: [{ bay: '748', pallets: 1 }]
  }), /ya tiene 100/);
  await engine.createCollection({ box_code: 'OTRA', origin_area: 'Recibo', allocations: [{ bay: '749', pallets: 1 }] });
});

// ---------- encargado, metas, calendario y productividad ----------
test('capturista debe elegir un supervisor como encargado; el supervisor queda él mismo', async () => {
  const { engine: admin, storage } = await ready(at(8, 0));
  await admin.addUser({ empleado: '2002', name: 'Ana', password: 'contraseña-ana', role: 'supervisor' });
  await admin.addUser({ empleado: '4004', name: 'Beto', password: 'contraseña-beto', role: 'capturista' });
  const lista = await admin.listSupervisores();
  assert.deepEqual(lista, [{ empleado: '2002', name: 'Ana' }]);
  await admin.release();

  const h2 = engineAt(at(8, 5), storage, 'S2');
  await h2.engine.open();
  await h2.engine.login('4004', 'contraseña-beto');
  await h2.engine.acquire();
  const v = await h2.engine.createVisit({ box_code: 'REM-1', supplier: 'P', ramp: '744' });
  await assert.rejects(h2.engine.pasarABahia(v.visit_code, { allocations: [{ bay: '747', pallets: 2 }] }), /encargado/);
  await assert.rejects(h2.engine.pasarABahia(v.visit_code, { allocations: [{ bay: '747', pallets: 2 }], encargado: '1001' }), /encargado/);
  await h2.engine.pasarABahia(v.visit_code, { allocations: [{ bay: '747', pallets: 2 }], encargado: '2002' });
  const lote = h2.engine.events().find((e) => e.type === 'LOT_CREATED');
  assert.equal(lote.data.encargado, '2002');
  assert.equal(lote.data.encargado_nombre, 'Ana');
});

test('supervisor que captura es el encargado de sus movimientos', async () => {
  const { engine } = await ready(at(8, 0));
  const v = await engine.createVisit({ box_code: 'REM-2', supplier: 'P', ramp: '745' });
  await engine.pasarABahia(v.visit_code, { allocations: [{ bay: '747', pallets: 1 }] });
  assert.equal(engine.events().find((e) => e.type === 'LOT_CREATED').data.encargado, '1001');
});

test('metas por turno: cumplimiento, día festivo sin meta y validación de metas', async () => {
  const { engine } = await ready(at(8, 0));
  const shifts = M.DEFAULT_CONFIG.shifts.map((s) => (s.name === 'Día' ? { ...s, meta: 4 } : s));
  await engine.saveConfig({ shifts });
  for (const ramp of ['744', '745', '746']) {
    const v = await engine.createVisit({ box_code: 'R' + ramp, supplier: 'P', ramp });
    await engine.pasarABahia(v.visit_code, { allocations: [{ bay: '747', pallets: 1 }] });
  }
  const dia = { from: '2026-11-10', to: '2026-11-10', turno: 'Día' };
  const p = await engine.productividad(dia);
  assert.equal(p.total.real, 3);
  assert.equal(p.total.meta, 4, 'el martes el turno Día es laboral');
  assert.equal(p.total.cumplimiento, 0.75);
  assert.deepEqual(p.por_encargado, [{ nombre: 'Charlie', cajas: 3 }]);
  assert.equal(p.en_curso.turno, 'Día');

  await engine.saveConfig({ holidays: [{ date: '2026-11-10', shifts: 'ALL', nota: 'Festivo de prueba' }] });
  const festivo = await engine.productividad(dia);
  assert.equal(festivo.total.real, 3, 'lo real se muestra igual');
  assert.equal(festivo.total.meta, 0, 'un festivo no suma meta');
  assert.equal(festivo.dias[0].estado, 'no laboral');

  await assert.rejects(engine.saveConfig({
    shifts: M.DEFAULT_CONFIG.shifts.map((s) => (s.name === 'Día' ? { ...s, meta: -1 } : s))
  }), /meta/);
});
