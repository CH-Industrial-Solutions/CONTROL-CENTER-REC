import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

vm.runInThisContext(fs.readFileSync(new URL('../motor.js', import.meta.url), 'utf8'));
const M = globalThis.ReciboMotor;

const at = (h, mi, d = 10) => new Date(2026, 10, d, h, mi);
const PASS = 'contraseña123';

function engineAt(date, storage, sessionId) {
  const clock = { t: date };
  const engine = M.createEngine({ storage, now: () => new Date(clock.t), sessionId });
  return { engine, clock };
}

async function adminEngine(date, storage, sessionId = 'A') {
  const h = engineAt(date, storage, sessionId);
  await h.engine.open();
  if (!(await h.engine.hasUsers())) {
    await h.engine.setupAdmin({ empleado: '1001', name: 'Charlie', password: PASS, recovery_key: 'recuperar-1' });
  }
  await h.engine.login('1001', PASS);
  return h;
}

test('listUsers devuelve nombre, perfil y estado sin contraseñas', async () => {
  const storage = M.MemoryStorage();
  const { engine } = await adminEngine(at(8, 0), storage);
  await engine.addUser({ empleado: '2002', name: 'Ana', password: 'clave-de-ana-1', role: 'supervisor' });
  const lista = await engine.listUsers();
  assert.deepEqual(lista.map((u) => [u.name, u.role]), [['Charlie', 'admin'], ['Ana', 'supervisor']]);
  assert.equal(JSON.stringify(lista).includes('hash'), false);
});

test('reload ve lo que otra sesión escribió después de abrir', async () => {
  const storage = M.MemoryStorage();
  const a = await adminEngine(at(8, 0), storage, 'A');
  const b = engineAt(at(8, 1), storage, 'B');
  await b.engine.open();
  await b.engine.login('1001', PASS);
  assert.equal(b.engine.snapshot().visits.length, 0);
  await a.engine.acquire();
  await a.engine.createVisit({ box_code: 'REM-1', supplier: 'P', ramp: '744' });
  assert.equal(b.engine.snapshot().visits.length, 0, 'antes de recargar no se ve');
  await b.engine.reload();
  assert.equal(b.engine.snapshot().visits.length, 1, 'después de recargar sí');
});

test('acquire recarga antes de escribir: no se pierde lo escrito por otra sesión', async () => {
  const storage = M.MemoryStorage();
  const a = await adminEngine(at(8, 0), storage, 'A');
  await a.engine.acquire();
  await a.engine.createVisit({ box_code: 'REM-1', supplier: 'P', ramp: '744' });
  await a.engine.release();
  const b = engineAt(at(8, 2), storage, 'B');
  await b.engine.open();
  await b.engine.login('1001', PASS);
  const r = await b.engine.acquire();
  assert.equal(r.ok, true);
  const v = await b.engine.createVisit({ box_code: 'REM-2', supplier: 'Q', ramp: '745' });
  assert.equal(v.visit_code, 'VIS-000002', 'el código siguiente toma en cuenta lo previo');
});

test('mismo operador puede tomar su sesión viva solo con takeover explícito', async () => {
  const storage = M.MemoryStorage();
  const a = await adminEngine(at(8, 0), storage, 'A');
  await a.engine.acquire();
  const b = engineAt(at(8, 1), storage, 'B');
  await b.engine.open();
  await b.engine.login('1001', PASS);
  const sin = await b.engine.acquire();
  assert.equal(sin.ok, false);
  assert.equal(sin.mismo, true, 'se informa que es el mismo operador');
  const con = await b.engine.acquire({ takeover: true });
  assert.equal(con.ok, true, 'con takeover explícito sí');
});

test('otro operador nunca toma una sesión viva, ni con takeover', async () => {
  const storage = M.MemoryStorage();
  const a = await adminEngine(at(8, 0), storage, 'A');
  await a.engine.addUser({ empleado: '2002', name: 'Ana', password: 'clave-de-ana-1', role: 'supervisor' });
  await a.engine.acquire();
  const b = engineAt(at(8, 1), storage, 'B');
  await b.engine.open();
  await b.engine.login('2002', 'clave-de-ana-1');
  const r = await b.engine.acquire({ takeover: true });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'ocupada');
  assert.equal(r.mismo, false);
});

test('la sesión vencida de otro operador sí se puede tomar con takeover', async () => {
  const storage = M.MemoryStorage();
  const a = await adminEngine(at(8, 0), storage, 'A');
  await a.engine.addUser({ empleado: '2002', name: 'Ana', password: 'clave-de-ana-1', role: 'supervisor' });
  await a.engine.acquire();
  const b = engineAt(at(9, 30), storage, 'B');
  await b.engine.open();
  await b.engine.login('2002', 'clave-de-ana-1');
  assert.equal((await b.engine.acquire()).status, 'vencida');
  assert.equal((await b.engine.acquire({ takeover: true })).ok, true);
});

test('release no borra la sesión de otra pestaña que ya tomó la escritura', async () => {
  const storage = M.MemoryStorage();
  const a = await adminEngine(at(8, 0), storage, 'A');
  await a.engine.acquire();
  const b = engineAt(at(8, 1), storage, 'B');
  await b.engine.open();
  await b.engine.login('1001', PASS);
  await b.engine.acquire({ takeover: true });
  await a.engine.release();
  assert.ok(storage._files.has(M.FILES.sesion), 'el bloqueo de B sigue en la carpeta');
  assert.equal(JSON.parse(storage._files.get(M.FILES.sesion)).session, 'B');
});

test('evaluateLock sin latido válido se considera vencido', () => {
  const r = M.evaluateLock({ session: 'X', owner: 'Ana', heartbeat_at: 'no-es-fecha' }, new Date(), 'A', 10);
  assert.equal(r.status, 'vencida');
});

test('parseHistorial acepta historial vacío y líneas en blanco', () => {
  assert.deepEqual(M.parseHistorial('').events, []);
  assert.equal(M.parseHistorial('\n\n{"a":1}\n\n').events.length, 1);
});

test('registro: capturista con número de empleado; entra con número, no con nombre', async () => {
  const { engine } = await adminEngine(at(8, 0), M.MemoryStorage());
  await engine.register({ empleado: '3003', name: 'Luis Pérez', password: 'clave-de-luis-1' });
  const lista = await engine.listUsers();
  assert.deepEqual(lista.find((u) => u.empleado === '3003'), { empleado: '3003', name: 'Luis Pérez', role: 'capturista', active: true });
  await assert.rejects(engine.login('Luis Pérez', 'clave-de-luis-1'), /incorrectos/);
  const s = await engine.login('3003', 'clave-de-luis-1');
  assert.equal(s.role, 'capturista');
});

test('registro: no repite número de empleado, valida formato y exige administrador antes', async () => {
  const vacio = engineAt(at(8, 0), M.MemoryStorage(), 'X');
  await vacio.engine.open();
  await assert.rejects(vacio.engine.register({ empleado: '1', name: 'A', password: 'clave-de-a-111' }), /administrador/);
  const { engine } = await adminEngine(at(8, 0), M.MemoryStorage());
  await assert.rejects(engine.register({ empleado: '3003 x', name: 'A', password: 'clave-de-a-111' }), /solo letras/);
  await engine.register({ empleado: '3003', name: 'Luis', password: 'clave-de-luis-1' });
  await assert.rejects(engine.register({ empleado: '3003', name: 'Otro', password: 'clave-de-otro-1' }), /Ya existe/);
});

test('carpeta vacía: al abrirla se crean config.json e historial.jsonl y se marca como nueva', async () => {
  const storage = M.MemoryStorage();
  const h = engineAt(at(8, 0), storage, 'N');
  const info = await h.engine.open();
  assert.equal(info.nueva, true);
  assert.equal(await storage.readText(M.FILES.historial), '');
  assert.ok(await storage.readText(M.FILES.config));
  const again = await h.engine.open();
  assert.equal(again.nueva, false);
});

// ---------- v0.6.0: índice general de facturas ----------
test('facturas: el índice es general, admite filas repetidas y sobrevive a reabrir', async () => {
  const storage = M.MemoryStorage();
  const h = await adminEngine(at(9, 0), storage, 'A');
  await h.engine.acquire();
  const a = await h.engine.registrarFactura({ caja: ' f-100 ' });
  assert.equal(a.caja, 'F-100');
  assert.equal(a.previa, null);
  const b = await h.engine.registrarFactura({ caja: 'F-100' });
  assert.ok(b.previa, 'la segunda vez avisa que ya existe');
  assert.equal(h.engine.listFacturas().length, 2, 'se registra otra fila, no se bloquea');

  await h.engine.actualizarNota({ code: a.code, nota: 'Pendiente recolectar' });
  assert.equal(h.engine.listFacturas({ q: 'pendiente' }).length, 1, 'el buscador también busca en notas');

  // Otra sesión (otro usuario) lee el mismo índice desde el historial.
  const otro = engineAt(at(10, 0), storage, 'B');
  await otro.engine.open();
  await otro.engine.login('1001', PASS);
  await otro.engine.acquire();
  const vistas = otro.engine.listFacturas();
  assert.equal(vistas.length, 2);
  assert.equal(vistas.find((x) => x.code === a.code).nota, 'Pendiente recolectar');
});

test('facturas: limpiar notas borra solo el texto; quitar oculta la fila sin borrar el historial', async () => {
  const storage = M.MemoryStorage();
  const h = await adminEngine(at(9, 0), storage, 'A');
  await h.engine.acquire();
  const x = await h.engine.registrarFactura({ caja: 'F-1' });
  const y = await h.engine.registrarFactura({ caja: 'F-2' });
  await h.engine.actualizarNota({ code: x.code, nota: 'uno' });
  await h.engine.actualizarNota({ code: y.code, nota: 'dos' });
  const r = await h.engine.limpiarNotas({ codes: [x.code, y.code] });
  assert.equal(r.limpiadas, 2);
  assert.equal(h.engine.listFacturas().length, 2, 'las facturas se conservan');
  assert.ok(h.engine.listFacturas().every((f) => f.nota === ''));

  await h.engine.quitarFactura({ code: x.code });
  assert.equal(h.engine.listFacturas().length, 1);
  assert.ok(h.engine.events().some((e) => e.type === 'FACTURA_REGISTRADA' && e.entity.code === x.code), 'queda en el historial');
  await assert.rejects(() => h.engine.actualizarNota({ code: x.code, nota: 'nope' }), /ya no está/);
});
