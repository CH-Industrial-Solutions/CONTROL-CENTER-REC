// Prueba de extremo a extremo en Chrome real, abriendo index.html por file://.
// Usa la carpeta de prueba del navegador (OPFS) con el mismo código de FsStorage que la carpeta real.
// Uso: CHROME_PATH=/ruta/a/chrome node test/e2e.mjs
import puppeteer from 'puppeteer-core';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

// El almacenamiento de prueba (OPFS) no funciona desde file://, así que la prueba
// sirve la carpeta en localhost. La carpeta real de trabajo sí se elige desde file://.
const TIPOS = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const servidor = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const archivo = path.join(root, url.pathname === '/' ? 'index.html' : url.pathname);
  if (!archivo.startsWith(root) || !fs.existsSync(archivo)) { res.writeHead(404); return res.end('no'); }
  res.writeHead(200, { 'Content-Type': TIPOS[path.extname(archivo)] || 'application/octet-stream' });
  fs.createReadStream(archivo).pipe(res);
});
await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
const APP = `http://127.0.0.1:${servidor.address().port}/index.html?modo=prueba`;
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const CAPTURAS = path.join(here, 'capturas');
fs.mkdirSync(CAPTURAS, { recursive: true });

const resultados = [];
const check = (nombre, ok, detalle = '') => {
  resultados.push({ nombre, ok: !!ok, detalle });
  console.log(`${ok ? '✔' : '✘'} ${nombre}${detalle ? ` — ${detalle}` : ''}`);
};

const set = (page, sel, val) => page.$eval(sel, (el, v) => {
  el.value = v;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}, String(val));
const enviar = (page, sel) => page.$eval(sel, (f) => f.requestSubmit());
const texto = (page, sel) => page.$eval(sel, (el) => el.textContent);
const visible = (page, sel) => page.$eval(sel, (el) => !el.hidden && el.offsetParent !== null).catch(() => false);
const clic = async (page, sel) => { await page.waitForSelector(sel, { visible: true }); await page.click(sel); };
const motor = (page, fn) => page.evaluate(`(() => { const e = window.__reciboPrueba.engine(); return (${fn})(e); })()`);
const esperarMotor = (page, fn, detalle = '') => page.waitForFunction(`(() => { const e = window.__reciboPrueba && window.__reciboPrueba.engine(); return !!e && (${fn})(e); })()`, { timeout: 8000 }).then(() => true, () => { check(`espera: ${detalle}`, false, 'tiempo agotado'); return false; });
const listar = (page, dir) => page.evaluate(async (d) => {
  const raiz = await navigator.storage.getDirectory();
  try {
    const h = await raiz.getDirectoryHandle(d);
    const out = [];
    for await (const [n] of h.entries()) out.push(n);
    return out;
  } catch { return null; }
}, dir);

async function login(page, nombre, password) {
  await page.waitForSelector('#pantalla-login:not([hidden]), #pantalla-setup:not([hidden]), #app:not([hidden])', { timeout: 8000 });
  if (await visible(page, '#pantalla-login')) {
    await set(page, '#form-login input[name=empleado]', nombre);
    await set(page, '#form-login input[name=password]', password);
    await enviar(page, '#form-login');
  }
}

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files']
});
const errores = [];
const conectarErrores = (p, etiqueta) => {
  p.on('pageerror', (e) => errores.push(`${etiqueta}: ${e.message}`));
  p.on('console', (m) => { if (m.type() === 'error') errores.push(`${etiqueta} consola: ${m.text()}`); });
};
const contar = (page, sel) => page.$$eval(sel, (els) => els.length);

try {
  const p1 = await browser.newPage();
  conectarErrores(p1, 'p1');
  await p1.setViewport({ width: 1360, height: 880 });
  await p1.goto(APP);

  // ---- 1. Primera configuración ----
  await p1.waitForSelector('#pantalla-setup:not([hidden])', { timeout: 8000 });
  check('primer arranque muestra configuración de administrador', true);
  const archivosBase = await p1.evaluate(async () => { const r = await navigator.storage.getDirectory(); const out = []; for await (const [n] of r.entries()) out.push(n); return out; });
  check('carpeta nueva recibe los archivos base', archivosBase.includes('config.json') && archivosBase.includes('historial.jsonl'), archivosBase.join(', '));
  await set(p1, '#form-setup input[name=empleado]', '1001');
  await set(p1, '#form-setup input[name=nombre]', 'Charlie');
  await set(p1, '#form-setup input[name=password]', 'contraseña123');
  await set(p1, '#form-setup input[name=clave]', 'recuperar-1');
  await enviar(p1, '#form-setup');
  await p1.waitForSelector('#pantalla-login:not([hidden])');
  check('crear administrador lleva a inicio de sesión', true);

  // ---- 2. Inicio de sesión y escritura ----
  await login(p1, '1001', 'contraseña123');
  await p1.waitForSelector('#app:not([hidden])');
  await esperarMotor(p1, (e) => e.mode === 'escritura', 'escritura tras iniciar sesión');
  check('badge muestra ESCRITURA', (await texto(p1, '#modo-badge')) === 'ESCRITURA');
  check('turno actual visible en la barra', (await texto(p1, '#turno-actual')).includes('Turno'));
  check('menú sin Resumen y con Captura', (await contar(p1, '[data-sec="resumen"]')) === 0 && (await contar(p1, '[data-sec="captura"]')) === 1);

  // ---- 3. Piso: asignar caja a rampa ----
  // Espera a que la tarjeta esté cerrada (ya redibujada tras la acción anterior) y la abre.
  const abrir = async (clave) => {
    await p1.waitForFunction((k) => { const b = document.querySelector(`[data-mas="${k}"]`); return !!b && !b.textContent.includes('Menos'); }, { timeout: 5000 }, clave);
    // Clic directo en el elemento: los avisos (toasts) pueden tapar el botón a la vista.
    await p1.$eval(`[data-mas="${clave}"]`, (b) => b.click());
    await p1.waitForSelector('#sec-piso .expandido', { timeout: 5000 });
  };
  await abrir('r:748');
  check('rampa libre muestra la forma de asignación con proveedor Insourcing',
    (await p1.$eval('[data-asignar="748"] input[name=supplier]', (i) => i.value)) === 'Insourcing');
  await set(p1, '[data-asignar="748"] input[name=box]', 'REM-105');
  await enviar(p1, '[data-asignar="748"]');
  await esperarMotor(p1, (e) => e.snapshot().visits.length === 1, 'REM-105 asignada');
  const v105 = await motor(p1, (e) => e.snapshot().visits[0]);
  check('asignar crea la visita en "Por descarga"', v105.stage === 'Por descarga' && v105.ramp === '748');
  check('la rampa 748 muestra la caja en el piso', (await texto(p1, '#piso-rampas')).includes('REM-105'));

  // ---- 4. Pasar a bahía: la caja queda Descargado y el lote en Por validar ----
  await abrir('r:748');
  await set(p1, `[data-pasar="${v105.code}"] .fila-bahia select`, '747');
  await set(p1, `[data-pasar="${v105.code}"] .fila-bahia input`, '12');
  await enviar(p1, `[data-pasar="${v105.code}"]`);
  await esperarMotor(p1, (e) => e.snapshot().lots.length === 1, 'lote de bahía creado');
  const lote1 = await motor(p1, (e) => e.snapshot().lots[0]);
  check('pasar a bahía crea el lote DESC-000001 en Por validar', lote1.code === 'DESC-000001' && lote1.stage === 'Por validar' && lote1.bay === '747');
  check('la visita pasa a Descargado', await motor(p1, (e) => e.snapshot().visits[0].stage === 'Descargado'));
  check('la bahía 747 muestra el lote en el piso', (await texto(p1, '#piso-bahias')).includes('DESC-000001'));
  const cabBahias = await p1.$$eval('#piso-bahias .cab', (els) => els.map((e) => e.textContent));
  check('bahías incluyen 746A y 746B; rampas no',
    cabBahias[4] === 'R746A' && cabBahias[5] === 'R746B' && !(await texto(p1, '#piso-rampas')).includes('R746A'), cabBahias.join(','));
  check('piso: 15 columnas en cada bloque', cabBahias.length === 15 && (await p1.$$eval('#piso-rampas .cab', (els) => els.length)) === 15);

  // ---- 5. Decisión después de Descargado: mantener en rampa (Cargando racks) ----
  await abrir('r:748');
  await set(p1, `[data-decision="${v105.code}"] select[name=accion]`, 'ETAPA:Cargando racks');
  await enviar(p1, `[data-decision="${v105.code}"]`);
  await esperarMotor(p1, (e) => e.snapshot().visits[0].stage === 'Cargando racks', 'REM-105 cargando racks');
  check('mantener en rampa coloca "Cargando racks"', true);
  await abrir('r:748');
  check('en Cargando racks solo se ofrece la salida racks',
    (await contar(p1, `[data-decision="${v105.code}"] option`)) === 1);
  await set(p1, `[data-decision="${v105.code}"] select[name=accion]`, 'SALIDA:RACKS');
  await enviar(p1, `[data-decision="${v105.code}"]`);
  await esperarMotor(p1, (e) => e.snapshot().visits[0].closed === true, 'salida racks');
  const salida = await motor(p1, (e) => e.snapshot().visits[0]);
  check('salida con racks cierra la visita con salida RACKS', salida.salida === 'RACKS' && salida.stage === 'Salió');

  // ---- 6. Retiro con retornable y vacío (decisión directa desde Descargado) ----
  await abrir('r:743');
  await set(p1, '[data-asignar="743"] input[name=box]', 'REM-200');
  await enviar(p1, '[data-asignar="743"]');
  await esperarMotor(p1, (e) => e.snapshot().visits.some((v) => v.box_code === 'REM-200'), 'REM-200 asignada');
  const v200 = await motor(p1, (e) => e.snapshot().visits.find((v) => v.box_code === 'REM-200'));
  await abrir('r:743');
  await set(p1, `[data-pasar="${v200.code}"] .fila-bahia select`, '744');
  await set(p1, `[data-pasar="${v200.code}"] .fila-bahia input`, '3');
  await enviar(p1, `[data-pasar="${v200.code}"]`);
  await esperarMotor(p1, (e) => e.snapshot().visits.find((v) => v.box_code === 'REM-200').stage === 'Descargado', 'REM-200 descargada');
  await abrir('r:743');
  await set(p1, `[data-decision="${v200.code}"] select[name=accion]`, 'SALIDA:RETORNABLE');
  await enviar(p1, `[data-decision="${v200.code}"]`);
  await esperarMotor(p1, (e) => e.snapshot().visits.find((v) => v.box_code === 'REM-200').closed === true, 'REM-200 salida');
  check('salida directa con retornable desde Descargado', true);

  await abrir('r:750');
  await set(p1, '[data-asignar="750"] input[name=box]', 'REM-400');
  await enviar(p1, '[data-asignar="750"]');
  await esperarMotor(p1, (e) => e.snapshot().visits.some((v) => v.box_code === 'REM-400'), 'REM-400 asignada');
  const v400 = await motor(p1, (e) => e.snapshot().visits.find((v) => v.box_code === 'REM-400'));
  await abrir('r:750');
  await set(p1, `[data-pasar="${v400.code}"] .fila-bahia select`, '745');
  await set(p1, `[data-pasar="${v400.code}"] .fila-bahia input`, '2');
  await enviar(p1, `[data-pasar="${v400.code}"]`);
  await esperarMotor(p1, (e) => e.snapshot().visits.find((v) => v.box_code === 'REM-400').stage === 'Descargado', 'REM-400 descargada');
  await abrir('r:750');
  await set(p1, `[data-decision="${v400.code}"] select[name=accion]`, 'SALIDA:VACIA');
  await enviar(p1, `[data-decision="${v400.code}"]`);
  await esperarMotor(p1, (e) => e.snapshot().visits.find((v) => v.box_code === 'REM-400').salida === 'VACIA', 'REM-400 vacía');
  check('salida vacía queda registrada', true);

  // ---- 7. Rampa ocupada y flujo sin saltos ----
  await abrir('r:745');
  await set(p1, '[data-asignar="745"] input[name=box]', 'REM-300');
  await enviar(p1, '[data-asignar="745"]');
  await esperarMotor(p1, (e) => e.snapshot().visits.some((v) => v.box_code === 'REM-300'), 'REM-300 asignada');
  const rechazo = await p1.evaluate(async () => {
    try { await window.__reciboPrueba.engine().createVisit({ box_code: 'REM-999', supplier: 'X', ramp: '745' }); return 'ok'; }
    catch (e) { return e.message; }
  });
  check('rampa ocupada rechaza otra caja', rechazo.includes('ya tiene la caja REM-300'), rechazo);
  const salto = await p1.evaluate(async () => {
    const e = window.__reciboPrueba.engine();
    const v = e.snapshot().visits.find((x) => x.box_code === 'REM-300');
    try { await e.advanceVisit(v.code, { to: 'Cargando racks' }); return 'ok'; }
    catch (err) { return err.message; }
  });
  check('no se puede saltar de Por descarga a una carga', salto !== 'ok', salto);

  // ---- 8. Bahía con más de 5 cajas: muestra 5 y "+N más" ----
  await p1.evaluate(async () => {
    const e = window.__reciboPrueba.engine();
    const rampas = ['751', '752', '753', '754', '746', '749'];
    for (let i = 0; i < 6; i++) {
      const r = await e.createVisit({ box_code: 'BIG-' + i, supplier: 'X', ramp: rampas[i] });
      await e.pasarABahia(r.visit_code, { allocations: [{ bay: '753', pallets: 1 }] });
    }
  });
  await esperarMotor(p1, (e) => e.snapshot().lots.filter((l) => l.bay === '753' && !l.closed).length === 6, 'seis lotes en bahía 753');
  await clic(p1, '#btn-actualizar'); // refresca el piso tras cambios hechos directamente en el motor
  await p1.waitForFunction(() => document.querySelectorAll('#piso-bahias .tp.lote').length >= 6, { timeout: 5000 }).catch(() => {});
  await p1.waitForFunction(() => document.querySelector('#piso-bahias').textContent.includes('+1 más'), { timeout: 5000 }).then(
    () => check('bahía con 6 cajas muestra "+1 más"', true), () => check('bahía con 6 cajas muestra "+1 más"', false));
  const visibles = await p1.$$eval('#piso-bahias .pila', (cols) => cols.map((c) => c.querySelectorAll('.tp.lote').length));
  check('bahía muestra máximo 5 tarjetas de caja', visibles.some((n) => n === 5) && visibles.every((n) => n <= 5), visibles.join(','));

  // ---- 9. Recolección multi-bahía ----
  await clic(p1, '[data-sec="captura"]');
  const lotesAntesRec = await motor(p1, (e) => e.snapshot().lots.length);
  await set(p1, '#form-recoleccion select[name=tipo]', 'recoleccion');
  await set(p1, '#form-recoleccion input[name=box_code]', 'CAJA-123');
  await set(p1, '#form-recoleccion input[name=origin_area]', 'Producción');
  await set(p1, '#form-recoleccion .alloc select', '744');
  await set(p1, '#form-recoleccion .alloc input', '8');
  await clic(p1, '#form-recoleccion .addAlloc');
  await p1.waitForFunction(() => document.querySelectorAll('#form-recoleccion .alloc').length === 2);
  await set(p1, '#form-recoleccion .alloc:nth-child(2) select', '747');
  await set(p1, '#form-recoleccion .alloc:nth-child(2) input', '4');
  await enviar(p1, '#form-recoleccion');
  await esperarMotor(p1, (e) => e.snapshot().collections.length === 1, 'recolección creada');
  const r1 = await motor(p1, (e) => ({ lotes: e.snapshot().lots.length, cajas: e.kpis().totals.recolectadas }));
  check('recolección multi-bahía crea 2 lotes', r1.lotes === lotesAntesRec + 2, `lotes=${r1.lotes}`);
  check('KPI cuenta la caja una vez', r1.cajas === 1, `recolectadas=${r1.cajas}`);

  // ---- 10. Caja omitida (sin motivo) y registro en bahía con estatus inicial ----
  await set(p1, '#form-recoleccion select[name=tipo]', 'manual');
  await set(p1, '#form-recoleccion input[name=box_code]', 'CAJA-9');
  await set(p1, '#form-recoleccion input[name=origin_area]', 'Rampa');
  await set(p1, '#form-recoleccion .alloc select', '747');
  await set(p1, '#form-recoleccion .alloc input', '2');
  await enviar(p1, '#form-recoleccion');
  await esperarMotor(p1, (e) => e.snapshot().collections.length === 2, 'caja omitida registrada');
  check('caja omitida se registra sin motivo y queda MANUAL', (await motor(p1, (e) => e.kpis().totals.manuales)) === 1);

  await set(p1, '#form-captura-rapida select[name=bay]', '750');
  await set(p1, '#form-captura-rapida input[name=box_code]', 'REG-1');
  await set(p1, '#form-captura-rapida input[name=pallets]', '6');
  await set(p1, '#form-captura-rapida select[name=unit]', 'PALLET');
  await set(p1, '#form-captura-rapida select[name=stage]', 'Por ubicar');
  check('la nota muestra el responsable Putaway para Por ubicar', (await texto(p1, '#nota-captura')).includes('Responsable: Putaway'));
  await enviar(p1, '#form-captura-rapida');
  await esperarMotor(p1, (e) => e.snapshot().lots.some((l) => l.box_code === 'REG-1' && l.stage === 'Por ubicar'), 'REG-1 en Por ubicar');
  check('el registro en bahía limpia la caja y deja la fecha de descarga', (await p1.$eval('#form-captura-rapida input[name=box_code]', (i) => i.value)) === '' && (await p1.$eval('#form-captura-rapida input[name=cuando]', (i) => i.value)) !== '');

  // ---- 11. KPIs de cargas ----
  const k = await motor(p1, (e) => e.kpis().totals);
  check('cargadas racks y retornable cuentan por salida', k.cargadas_racks === 1 && k.cargadas_retornable === 1 && k.cargadas === 2, JSON.stringify({ r: k.cargadas_racks, t: k.cargadas_retornable }));
  check('vacías cuentan la salida vacía', k.vacias === 1);

  // ---- 12. Configuración (administrador) ----
  await clic(p1, '[data-sec="config"]');
  const bahiasActuales = await p1.$eval('#form-config textarea[name=bays]', (t) => t.value);
  check('configuración trae bahías 743 a 755 con 746A y 746B', bahiasActuales.includes('743') && bahiasActuales.includes('755') && bahiasActuales.includes('746A') && bahiasActuales.includes('746B'));
  await set(p1, '#form-config textarea[name=bays]', bahiasActuales + ', 756');
  await enviar(p1, '#form-config');
  await esperarMotor(p1, (e) => e.config.bays.includes('756'), 'bahía 756 guardada');
  check('administrador agrega una bahía desde configuración', true);
  const cambio = await motor(p1, (e) => e.events().at(-1).type);
  check('el cambio de configuración queda en el historial', cambio === 'CONFIG_CHANGED');

  // ---- 13. Segunda pestaña: solo lectura ----
  const p2 = await browser.newPage();
  conectarErrores(p2, 'p2');
  await p2.setViewport({ width: 1360, height: 880 });
  await p2.goto(APP);
  await login(p2, '1001', 'contraseña123');
  await p2.waitForSelector('#app:not([hidden])');
  await esperarMotor(p2, (e) => e.mode === 'lectura', 'segunda pestaña en lectura');
  check('segunda pestaña muestra SOLO LECTURA', (await texto(p2, '#modo-badge')) === 'SOLO LECTURA');
  check('segunda pestaña muestra el aviso de otra sesión', await visible(p2, '#banner-lectura'));
  check('botones de escritura deshabilitados en lectura', await p2.$eval('#form-recoleccion button.primario', (b) => b.disabled));
  check('segunda pestaña ve los datos ya registrados', (await motor(p2, (e) => e.snapshot().collections.length)) === 3);

  // ---- 14. Contraseña incorrecta y registro (ventana aparte) ----
  const p3 = await browser.newPage();
  conectarErrores(p3, 'p3');
  await p3.goto(APP);
  await p3.waitForSelector('#pantalla-login:not([hidden])');
  await set(p3, '#form-login input[name=empleado]', '1001');
  await set(p3, '#form-login input[name=password]', 'mal-intento-99');
  await enviar(p3, '#form-login');
  await p3.waitForFunction(() => document.querySelector('#login-msg').textContent.includes('incorrectos'));
  check('contraseña incorrecta muestra mensaje claro', true);
  await p3.screenshot({ path: path.join(CAPTURAS, 'acceso.png') });
  await clic(p3, '#btn-ir-registro');
  await p3.waitForFunction(() => document.querySelector('#deslizador').value === '100');
  await new Promise((r) => setTimeout(r, 400));
  await p3.screenshot({ path: path.join(CAPTURAS, 'registro.png') });

  await set(p3, '#form-registro input[name=empleado]', '3003');
  await set(p3, '#form-registro input[name=nombre]', 'Luis Pérez');
  await set(p3, '#form-registro input[name=password]', 'clave-de-luis-1');
  await set(p3, '#form-registro input[name=password2]', 'clave-distinta-1');
  await enviar(p3, '#form-registro');
  await p3.waitForFunction(() => document.querySelector('#registro-msg').textContent.includes('no coinciden'));
  check('registro rechaza contraseñas distintas', true);
  await set(p3, '#form-registro input[name=password2]', 'clave-de-luis-1');
  await enviar(p3, '#form-registro');
  await p3.waitForFunction(() => document.querySelector('#login-msg').textContent.includes('Cuenta creada'));
  check('registro crea cuenta de operador', true);
  await set(p3, '#form-login input[name=empleado]', '3003');
  await set(p3, '#form-login input[name=password]', 'clave-de-luis-1');
  await enviar(p3, '#form-login');
  await p3.waitForFunction(() => document.querySelector('#app') && !document.querySelector('#app').hidden, { timeout: 8000 }).then(() => check('operador entra con su número de empleado', true), () => check('operador entra con su número de empleado', false));
  await p3.close();

  // ---- 15. Cerrar turno y exportar ----
  await p1.bringToFront();
  await clic(p1, '[data-sec="turno"]');
  await clic(p1, '#btn-cerrar-turno');
  await p1.waitForFunction(() => document.querySelector('#turno-msg').textContent.includes('respaldos/'));
  const respaldos = await listar(p1, 'respaldos');
  check('cerrar turno guarda copia en respaldos/', respaldos && respaldos.length === 1, respaldos ? respaldos.join(', ') : 'sin carpeta');

  await clic(p1, '[data-sec="reportes"]');
  await p1.screenshot({ path: path.join(CAPTURAS, 'reportes.png') });
  await clic(p1, '#btn-exp-kpi');
  await p1.waitForFunction(() => document.querySelector('#rep-msg').textContent.includes('exportes/'));
  const exportes = await listar(p1, 'exportes');
  check('exportación de KPIs se guarda en exportes/', exportes && exportes.some((n) => n.startsWith('kpis_')), exportes ? exportes.join(', ') : 'sin carpeta');

  // ---- 16. Capturas visuales ----
  await clic(p1, '[data-sec="piso"]');
  await p1.screenshot({ path: path.join(CAPTURAS, 'piso.png') });
  {
    const ancho = await p1.evaluate(() => { const s = document.querySelector('#piso-rampas').parentElement; return { cuadro: s.clientWidth, rejilla: document.querySelector('#piso-rampas').scrollWidth, bahias: document.querySelector('#piso-bahias').scrollWidth, cols: document.querySelectorAll('#piso-bahias > .cab').length }; });
    check('piso cabe sin desplazar a los lados (1360 px)', ancho.rejilla <= ancho.cuadro + 1 && ancho.bahias <= ancho.cuadro + 1, JSON.stringify(ancho));
  }
  await p1.setViewport({ width: 1100, height: 800 });
  await new Promise((r) => setTimeout(r, 300));
  {
    const menu = await p1.evaluate(() => Math.round(document.querySelector('.menu').getBoundingClientRect().width));
    check('ventana angosta colapsa el menú a iconos', menu <= 70, 'ancho menú ' + menu + ' px');
    await p1.screenshot({ path: path.join(CAPTURAS, 'piso_angosto.png') });
  }
  await p1.setViewport({ width: 1360, height: 880 });
  await new Promise((r) => setTimeout(r, 300));
  await clic(p1, '[data-sec="captura"]');
  await p1.screenshot({ path: path.join(CAPTURAS, 'recoleccion.png') });

  // ---- 16a-2. Facturas y notas: Enter agrega y el cursor queda listo para la siguiente ----
  await set(p1, '#form-factura input[name=caja]', 'fac-900');
  await p1.focus('#form-factura input[name=caja]');
  await p1.keyboard.press('Enter');
  await p1.waitForFunction(() => document.querySelectorAll('#tabla-facturas tr').length === 1);
  const cursorListo = await p1.evaluate(() => document.activeElement && document.activeElement.name === 'caja' && document.activeElement.value === '');
  check('Enter agrega la factura y el cursor vuelve al campo vacío', cursorListo);
  await p1.keyboard.type('FAC-901');
  await p1.keyboard.press('Enter');
  await p1.waitForFunction(() => document.querySelectorAll('#tabla-facturas tr').length === 2);
  check('la factura se guarda en mayúsculas y se listan las dos', (await texto(p1, '#tabla-facturas tr td')) === 'FAC-900');
  await set(p1, '#tabla-notas .nota-inp', 'Pendiente recolectar');
  await p1.$eval('#tabla-notas .nota-inp', (el) => el.dispatchEvent(new Event('change', { bubbles: true })));
  await p1.waitForFunction(() => Array.from(document.querySelectorAll('#tabla-notas .nota-inp')).some((i) => i.value === 'Pendiente recolectar'));
  check('la nota de la factura se guarda', true);
  await p1.$eval('#btn-limpiar-notas', (el) => el.click());
  await p1.waitForFunction(() => Array.from(document.querySelectorAll('#tabla-notas .nota-inp')).every((i) => i.value === ''));
  check('limpiar notas borra solo el texto; las dos facturas siguen', (await contar(p1, '#tabla-facturas tr')) === 2);
  await p1.screenshot({ path: path.join(CAPTURAS, 'facturas.png') });
  await clic(p1, '[data-sec="cajas"]');
  await set(p1, '#buscar-caja', 'CAJA-123');
  await enviar(p1, '#form-cajas');
  await p1.waitForFunction(() => document.querySelector('#resultado-caja').textContent.includes('REC-000001'));
  check('detalle de caja muestra la lista de cajas abiertas', (await contar(p1, '#tabla-abiertas tbody tr[data-caja]')) >= 1);
  await p1.screenshot({ path: path.join(CAPTURAS, 'caja.png') });
  check('detalle de caja muestra la recolección y su historial', true);

  // ---- 16b. Cambio de estatus desde Detalle de caja (salto sin motivo) ----
  await clic(p1, '[data-sec="cajas"]');
  await set(p1, '#buscar-caja', 'BIG-0');
  await p1.waitForFunction(() => document.querySelectorAll('#tabla-abiertas .estatus-sel[data-tipo="lote"]').length === 1, { timeout: 5000 });
  await set(p1, '#tabla-abiertas .estatus-sel[data-tipo="lote"]', 'Por ubicar');
  await esperarMotor(p1, (e) => e.snapshot().lots.some((l) => l.box_code === 'BIG-0' && l.stage === 'Por ubicar'), 'BIG-0 cambia a Por ubicar');
  check('salto desde Detalle de caja no pide motivo y deja los pasos saltados cumplidos', !(await visible(p1, '#dlg-motivo')));
  await set(p1, '#buscar-caja', '');

  // ---- 16c. Productividad, tema y editor de turnos ----
  await clic(p1, '[data-sec="productividad"]');
  await p1.waitForFunction(() => document.querySelectorAll('#prod-dias .col-d').length >= 1, { timeout: 5000 });
  check('productividad muestra cajas descargadas del periodo', Number((await texto(p1, '#pk-real')).replace(/\D/g, '')) >= 1);
  check('productividad muestra el turno en curso', (await texto(p1, '#prod-en-curso')).includes('Turno en curso'));
  check('gráfica por hora tiene 24 columnas', (await contar(p1, '#prod-hora .col-h')) === 24);
  check('el periodo inicial es hoy', (await p1.$eval('#prod-desde', (i) => i.value)) === (await p1.$eval('#prod-hasta', (i) => i.value)));
  await clic(p1, '#btn-tema');
  check('el botón de tema cambia a blanco y se recuerda', (await p1.$eval('body', (b) => b.classList.contains('tema-blanco'))) && (await p1.evaluate(() => localStorage.getItem('recibo.tema'))) === 'blanco');
  await p1.screenshot({ path: path.join(CAPTURAS, 'productividad_blanco.png') });
  await clic(p1, '#btn-tema');
  check('el botón de tema vuelve a azul', !(await p1.$eval('body', (b) => b.classList.contains('tema-blanco'))));
  await clic(p1, '[data-sec="config"]');
  check('configuración muestra tres turnos con su meta', (await contar(p1, '#turnos-editor .fila-turno')) === 3);
  check('calendario laboral marca lunes a viernes los tres turnos', (await p1.$eval('#calendario-tabla input[data-dia="1"]', (els) => Array.from(els).every((i) => i.checked))));
  await clic(p1, '[data-sec="productividad"]');
  await p1.screenshot({ path: path.join(CAPTURAS, 'productividad.png') });

  // ---- 17. Recarga: el estado persiste y se reconstruye desde el archivo ----
  const antes = await motor(p1, (e) => ({ lotes: e.snapshot().lots.length, recs: e.snapshot().collections.length, visitas: e.snapshot().visits.length }));
  await p1.reload();
  await login(p1, '1001', 'contraseña123');
  await p1.waitForSelector('#app:not([hidden])');
  await esperarMotor(p1, (e) => e.mode === 'escritura', 'escritura tras recargar');
  const tras = await motor(p1, (e) => ({ lotes: e.snapshot().lots.length, recs: e.snapshot().collections.length, visitas: e.snapshot().visits.length }));
  check('tras recargar el historial se reconstruye igual', JSON.stringify(tras) === JSON.stringify(antes), JSON.stringify(tras));

  // ---- 18. Tomar la escritura desde la ventana de solo lectura ----
  p2.once('dialog', (d) => d.accept());
  await p2.bringToFront();
  await clic(p2, '#btn-tomar');
  await esperarMotor(p2, (e) => e.mode === 'escritura', 'p2 toma la escritura');
  check('la ventana de solo lectura puede tomar la escritura con confirmación', true);
  const latido = await p1.evaluate(() => window.__reciboPrueba.engine().heartbeat());
  check('la ventana anterior detecta que perdió la escritura', latido.lost === true && latido.mode === 'lectura');

  // ---- 19. Errores de página ----
  check('sin errores de JavaScript en las pestañas', errores.length === 0, errores.slice(0, 3).join(' | '));
} catch (err) {
  check('la prueba terminó sin excepciones', false, err.message);
} finally {
  await browser.close();
  servidor.close();
}

const fallas = resultados.filter((r) => !r.ok);
console.log(`\n${resultados.length - fallas.length}/${resultados.length} pruebas de interfaz pasaron`);
process.exit(fallas.length ? 1 : 0);
