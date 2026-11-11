/*
 * QORVEX Recibo · interfaz
 * Toda la lógica de negocio vive en motor.js (ReciboMotor). Aquí solo se pinta y se llama al motor.
 */
(function () {
  'use strict';

  const RM = window.ReciboMotor;
  const q = (s, r = document) => r.querySelector(s);
  const qa = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (n) => Number(n || 0).toLocaleString('es-MX');
  const PRUEBA = new URLSearchParams(location.search).get('modo') === 'prueba';
  const SECCIONES = ['piso', 'captura', 'productividad', 'cajas', 'reportes', 'turno', 'config'];
  const TITULOS = {
    piso: 'Piso', captura: 'Captura', productividad: 'Productividad', cajas: 'Detalle de caja',
    reportes: 'Reportes', turno: 'Turno', config: 'Configuración'
  };
  // Columnas del piso en orden. 746A y 746B no existen: la posición queda vacía.
  const COLUMNAS = ['743', '744', '745', '746', '746A', '746B', '747', '748', '749', '750', '751', '752', '753', '754', '755'];
  // Tarjetas con "Más" desplegado: 'r:744' (rampa) o 'l:DESC-1' (lote). Sobrevive a los refrescos.
  const abiertos = new Set();
  const S = { engine: null, folder: null, cfg: null, session: null, latido: null };

  class Cancelado extends Error {}

  // ---------- utilidades de interfaz ----------
  function pantalla(id) {
    qa('.pantalla').forEach((p) => { p.hidden = p.id !== id; });
  }
  function mostrarSeccion(id) {
    SECCIONES.forEach((s) => { q('#sec-' + s).hidden = s !== id; });
    qa('.nav').forEach((b) => b.classList.toggle('activo', b.dataset.sec === id));
    q('#titulo-seccion').textContent = TITULOS[id];
  }
  function toast(texto, tipo = 'ok') {
    const t = document.createElement('div');
    t.className = 'toast ' + tipo;
    t.textContent = texto;
    q('#toasts').appendChild(t);
    setTimeout(() => t.remove(), 4800);
  }
  function msg(el, texto, tipo = 'error') {
    if (!el) return toast(texto, tipo === 'ok' ? 'ok' : 'error');
    el.textContent = texto;
    el.className = 'msg ' + tipo;
  }
  // Ejecuta una acción del motor: muestra el error en pantalla y refresca al terminar bien.
  async function accion(fn, { el = null } = {}) {
    try {
      const r = await fn();
      await refrescar();
      return r;
    } catch (err) {
      if (err instanceof Cancelado) return undefined;
      const texto = err && err.message ? err.message : String(err);
      if (el) msg(el, texto, 'error'); else toast(texto, 'error');
      return undefined;
    }
  }
  const edadTexto = (h) => (h < 1 ? `${Math.max(1, Math.round(h * 60))} min` : h < 24 ? `${h.toFixed(1)} h` : `${(h / 24).toFixed(1)} d`);
  const claseEdad = (h) => (h <= 8 ? 'verde' : h <= 24 ? 'ambar' : 'rojo');
  const horas = (iso) => (Date.now() - Date.parse(iso)) / 36e5;
  const turnoAhora = () => RM.shiftFor(new Date(), S.cfg.shifts);
  const filtroTurno = (valor) => {
    if (valor !== 'actual') return {};
    const sh = turnoAhora();
    return { from: sh.shift_date, to: sh.shift_date, shift: sh.name };
  };
  // Fecha y hora local en formato de campo datetime-local.
  const ahoraLocal = () => {
    const d = new Date();
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    return d.toISOString().slice(0, 16);
  };

  // Pide motivo para un salto de flujo. Devuelve null si el usuario cancela.
  function pedirMotivo(titulo, minLen) {
    return new Promise((resolver) => {
      const d = q('#dlg-motivo');
      const ta = q('#dlg-texto');
      q('#dlg-titulo').textContent = titulo;
      q('#dlg-ayuda').textContent = `Escribe el motivo (mínimo ${minLen} caracteres). Queda guardado en el historial como comentario.`;
      ta.value = '';
      ta.minLength = minLen;
      const cerrar = () => {
        d.removeEventListener('close', cerrar);
        resolver(d.returnValue === 'ok' ? ta.value.trim() : null);
      };
      d.addEventListener('close', cerrar);
      d.showModal();
      ta.focus();
    });
  }


  // ---------- arranque y carpeta ----------
  async function arrancar() {
    if (!PRUEBA && !('showDirectoryPicker' in window)) {
      q('#inicio-texto').textContent = 'Este navegador no puede abrir carpetas locales. Usa Chrome o Edge de escritorio.';
      q('#btn-elegir').disabled = true;
      pantalla('pantalla-inicio');
      return;
    }
    if (PRUEBA) {
      S.folder = await navigator.storage.getDirectory();
      return abrirCarpeta();
    }
    let guardada = null;
    try {
      guardada = await RM.browser.loadFolder();
    } catch (err) {
      msg(q('#inicio-msg'), 'No pude leer la carpeta recordada: ' + (err.message || err), 'error');
    }
    pantalla('pantalla-inicio');
    if (guardada) {
      S.folder = guardada;
      q('#inicio-texto').textContent = `Se recordó la carpeta de la última vez. Reconéctala para seguir donde quedaste.`;
      q('#carpeta-nombre').textContent = `“${guardada.name}”`;
      q('#btn-reconectar').hidden = false;
      q('#btn-elegir').className = 'ghost';
      q('#btn-elegir').textContent = 'Seleccionar otra carpeta';
    }
  }

  q('#btn-elegir').onclick = async () => {
    try {
      const h = await RM.browser.pickFolder();
      await RM.browser.saveFolder(h);
      S.folder = h;
      await abrirCarpeta();
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      msg(q('#inicio-msg'), err.message || String(err));
    }
  };

  q('#btn-reconectar').onclick = () => accion(async () => {
    if (!(await RM.browser.ensurePermission(S.folder))) throw new Error('Sin permiso para escribir en la carpeta.');
    await abrirCarpeta();
  }, { el: q('#inicio-msg') });

  async function abrirCarpeta() {
    S.engine = RM.createEngine({ storage: RM.FsStorage(S.folder), sessionId: idSesion() });
    const info = await S.engine.open();
    S.cfg = info.config;
    if (info.truncated) toast('Se ignoró una línea incompleta al final del historial (posible corte de energía).', 'aviso');
    if (info.nueva) {
      await S.folder.getDirectoryHandle('respaldos', { create: true });
      await S.folder.getDirectoryHandle('exportes', { create: true });
      toast('Carpeta nueva: se crearon los archivos base. Ahora crea el administrador.', 'aviso');
    }
    q('#carpeta-actual').textContent = `Carpeta: ${S.folder.name}`;
    q('#carpeta-actual-2').textContent = `Carpeta: ${S.folder.name}`;
    q('#carpeta-pie').textContent = `Carpeta: ${S.folder.name}`;
    if (info.has_users) {
      irAcceso(0);
      pantalla('pantalla-login');
    } else {
      pantalla('pantalla-setup');
    }
  }

  // ---------- acceso ----------
  q('#form-setup').onsubmit = (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    accion(async () => {
      await S.engine.setupAdmin({ empleado: f.get('empleado'), name: f.get('nombre'), password: f.get('password'), recovery_key: f.get('clave') });
      e.target.reset();
      toast('Administrador creado. Ahora inicia sesión con tu número de empleado.');
      pantalla('pantalla-login');
    }, { el: q('#setup-msg') });
  };

  q('#form-login').onsubmit = (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    accion(async () => {
      const s = await S.engine.login(f.get('empleado'), f.get('password'));
      e.target.reset();
      await entrar(s);
    }, { el: q('#login-msg') });
  };

  // Registro de operadores: el número de empleado identifica la cuenta; el nombre solo es para mostrar.
  q('#form-registro').onsubmit = (e) => {
    e.preventDefault();
    const f = e.target;
    const fd = new FormData(f);
    if (fd.get('password') !== fd.get('password2')) {
      return msg(q('#registro-msg'), 'Las contraseñas no coinciden.', 'error');
    }
    accion(async () => {
      await S.engine.register({ empleado: fd.get('empleado'), name: fd.get('nombre'), password: fd.get('password') });
      q('#form-login input[name=empleado]').value = fd.get('empleado');
      f.reset();
      irAcceso(0);
      msg(q('#login-msg'), 'Cuenta creada. Ahora inicia sesión con tu número de empleado.', 'ok');
    }, { el: q('#registro-msg') });
  };

  // Deslizador: 0 = inicio de sesión, 100 = registro. Solo se ve un panel a la vez.
  function irAcceso(pos) {
    const pista = q('#pista');
    pista.style.transform = `translateX(-${pos / 2}%)`;
    q('#deslizador').value = pos;
  }
  q('#deslizador').oninput = (e) => {
    q('#pista').style.transition = 'none';
    irAcceso(Number(e.target.value));
  };
  q('#deslizador').onchange = (e) => {
    q('#pista').style.transition = '';
    irAcceso(Number(e.target.value) < 50 ? 0 : 100);
  };
  q('#btn-ir-login').onclick = () => irAcceso(0);
  q('#btn-ir-registro').onclick = () => irAcceso(100);

  q('#btn-recuperar-ver').onclick = () => { q('#acceso-bloque').hidden = true; q('#form-recuperar').hidden = false; };
  q('#btn-recuperar-volver').onclick = () => { q('#form-recuperar').hidden = true; q('#acceso-bloque').hidden = false; };
  q('#form-recuperar').onsubmit = (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    accion(async () => {
      await S.engine.resetPassword({ empleado: f.get('empleado'), recovery_key: f.get('clave'), new_password: f.get('nueva') });
      e.target.reset();
      msg(q('#recuperar-msg'), 'Contraseña actualizada. Ya puedes iniciar sesión.', 'ok');
    }, { el: q('#recuperar-msg') });
  };

  // Pide escritura. Otra sesión viva de otro operador nunca se toma; las demás piden confirmación.
  // Al entrar solo se pregunta por sesiones vencidas; la del mismo operador se toma a petición del usuario.
  async function tomarEscritura({ preguntarMismo = false } = {}) {
    const r = await S.engine.acquire();
    if (r.ok) return r;
    if (r.status === 'vencida' && confirm(`La sesión de ${r.owner} lleva más de ${S.cfg.stale_lock_minutes} minutos sin actividad. ¿Tomar la escritura?`)) {
      return S.engine.acquire({ takeover: true });
    }
    if (preguntarMismo && r.status === 'ocupada' && r.mismo && confirm(`Ya hay una sesión abierta a nombre de ${r.owner}, quizá en otra ventana o por un cierre sin liberar. ¿Tomar la escritura aquí? La otra ventana pasará a solo lectura.`)) {
      return S.engine.acquire({ takeover: true });
    }
    return r;
  }

  // Identidad de la pestaña: una recarga conserva la sesión; una ventana nueva es otra sesión.
  function idSesion() {
    let id = sessionStorage.getItem('recibo.sesion');
    if (!id) {
      id = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
      sessionStorage.setItem('recibo.sesion', id);
    }
    return id;
  }

  async function entrar(s) {
    S.session = s;
    q('#usuario-nombre').textContent = `${s.name} · ${s.empleado}`;
    q('#usuario-rol').textContent = s.role;
    document.body.classList.toggle('es-admin', s.role === 'admin');
    await tomarEscritura();
    pantalla('app');
    mostrarSeccion('piso');
    iniciarLatido();
    await refrescar();
  }

  function iniciarLatido() {
    clearInterval(S.latido);
    S.latido = setInterval(async () => {
      try {
        const r = await S.engine.heartbeat();
        if (r.lost) toast('Otra sesión tomó la escritura. Ahora estás en solo lectura.', 'error');
        if (S.engine.mode !== 'escritura') await S.engine.reload();
        await refrescar();
      } catch (err) {
        console.error(err);
      }
    }, 60000);
  }

  q('#btn-salir').onclick = async () => {
    clearInterval(S.latido);
    await S.engine.logout();
    S.session = null;
    document.body.classList.remove('es-admin');
    irAcceso(0);
    pantalla('pantalla-login');
  };

  q('#btn-tomar').onclick = () => accion(async () => {
    const r = await tomarEscritura({ preguntarMismo: true });
    if (r.ok) toast('Ahora tienes la escritura.');
    else toast(`Sigue ocupada por ${r.owner}.`, 'aviso');
  });

  q('#btn-actualizar').onclick = () => accion(() => S.engine.reload());

  window.addEventListener('pagehide', () => { if (S.engine) S.engine.release(); });

  // ---------- navegación ----------
  qa('.nav').forEach((b) => { b.onclick = () => mostrarSeccion(b.dataset.sec); });
  q('#kpi-filtro').onchange = () => refrescar();
  q('#rep-filtro').onchange = () => refrescar();

  // ---------- refresco general ----------
  async function refrescar() {
    if (!S.engine || !S.session) return;
    S.cfg = S.engine.config;
    actualizarModo();
    const snap = S.engine.snapshot();
    const sh = turnoAhora();
    q('#turno-actual').textContent = `Turno ${sh.name} · fecha de turno ${sh.shift_date}`;
    rellenarCatalogos();
    renderResumen(snap);
    renderPiso(snap);
    renderDetalle(snap);
    renderReportes();
    renderTurno();
    await renderConfig();
    try { await actualizarEncargado(); } catch (_) { /* sin lista de encargados aún */ }
    renderProductividad();
  }

  function actualizarModo() {
    const escribe = S.engine.mode === 'escritura';
    document.body.classList.toggle('solo-lectura', !escribe);
    const b = q('#modo-badge');
    b.textContent = escribe ? 'ESCRITURA' : 'SOLO LECTURA';
    b.className = 'badge ' + (escribe ? 'ok' : 'warn');
    q('#banner-lectura').hidden = escribe;
    qa('.escribe').forEach((el) => { el.disabled = !escribe; });
  }

  function rellenarCatalogos() {
    if (!S.cfg) return; // aún no se abre una carpeta
    const rampas = S.cfg.ramps.map((r) => `<option value="${esc(r)}">${esc(r)}</option>`).join('');
    const bahias = S.cfg.bays.map((b) => `<option value="${esc(b)}">${esc(b)}</option>`).join('');
    qa('.sel-rampas').forEach((s) => { const v = s.value; s.innerHTML = rampas; if (v) s.value = v; });
    qa('.sel-bahias').forEach((s) => { const v = s.value; s.innerHTML = bahias; if (v) s.value = v; });
    const etapas = S.cfg.product_stages.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
    qa('.sel-etapas').forEach((s) => { const v = s.value; s.innerHTML = etapas; if (v) s.value = v; });
    const cuando = q('#form-captura-rapida').cuando;
    if (!cuando.value) cuando.value = ahoraLocal();
    actualizarNotaCaptura();
    actualizarModo();
  }

  // ---------- resumen ----------
  function renderResumen(snap) {
    const filtro = filtroTurno(q('#kpi-filtro').value);
    const k = S.engine.kpis(filtro);
    const t = k.totals;
    q('#k-descargadas').textContent = num(t.descargadas);
    q('#k-cargadas').textContent = num(t.cargadas);
    q('#k-cargadas-detalle').textContent = `${num(t.cargadas_racks)} racks · ${num(t.cargadas_retornable)} retornable · ${num(t.vacias)} vacías`;
    q('#k-recolectadas').textContent = num(t.recolectadas);
    q('#k-manuales').textContent = `${num(t.manuales)} manuales`;
    q('#k-validadas').textContent = num(t.validadas);
    q('#k-procesadas').textContent = num(t.procesadas);
    q('#k-ubicadas').textContent = num(t.ubicadas);
    q('#k-pallets').textContent = `${num(t.pallets_ubicados)} pallets`;

    let verde = 0, ambar = 0, rojo = 0;
    for (const l of snap.lots.filter((x) => !x.closed)) {
      const c = claseEdad(horas(l.created_at));
      if (c === 'verde') verde++; else if (c === 'ambar') ambar++; else rojo++;
    }
    q('#s-verde').textContent = verde;
    q('#s-ambar').textContent = ambar;
    q('#s-rojo').textContent = rojo;

    const filas = k.rows.map((r) => `<tr><td>${esc(r.fecha_turno)}</td><td>${esc(r.turno)}</td>
      <td>${num(r.descargadas)}</td><td>${num(r.recolectadas)}</td><td>${num(r.validadas)}</td>
      <td>${num(r.procesadas)}</td><td>${num(r.ubicadas)}</td><td>${num(r.cargadas)}</td><td>${num(r.vacias)}</td></tr>`).join('');
    q('#tabla-turnos').innerHTML = `<thead><tr><th>Fecha</th><th>Turno</th><th>Desc.</th><th>Recol.</th><th>Valid.</th><th>Proces.</th><th>Ubic.</th><th>Cargadas</th><th>Vacías</th></tr></thead>
      <tbody>${filas || '<tr><td colspan="9" class="vacio">Sin actividad en este periodo.</td></tr>'}</tbody>`;
  }

  // ---------- piso: rampas arriba, bahías abajo ----------
  const ETIQUETA_SALIDA = { RETORNABLE: 'retornable', RACKS: 'racks', VACIA: 'vacía' };
  const SALIDA_DE_ETAPA = { 'Cargando retornable': 'RETORNABLE', 'Cargando racks': 'RACKS' };
  const MAX_CAJAS_BAHIA = 5;

  function columnasPiso() {
    const usadas = new Set([...S.cfg.ramps, ...S.cfg.bays]);
    const extras = [...usadas].filter((c) => !COLUMNAS.includes(c)).sort();
    return [...COLUMNAS.filter((c) => usadas.has(c)), ...extras];
  }

  const opcionesBahias = () => S.cfg.bays.map((b) => `<option value="${esc(b)}">R${esc(b)}</option>`).join('');

  function formAsignarRampa(c) {
    const ahora = ahoraLocal();
    return `<form class="expandido" data-asignar="${esc(c)}">
      <label>Caja / placa<input name="box" required></label>
      <label>Proveedor<input name="supplier" value="Insourcing" required></label>
      <label>Llegada<input name="arrived" type="datetime-local" max="${ahora}" value="${ahora}"></label>
      <button class="primario mini escribe">Asignar a rampa</button>
    </form>`;
  }

  // Pasa la caja a una o más bahías con estatus "Por validar".
  function formPasarBahia(v) {
    return `<form class="expandido" data-pasar="${esc(v.code)}">
      <div class="filas-bahia">
        <div class="fila-bahia">
          <select name="bay" class="escribe">${opcionesBahias()}</select>
          <input name="pallets" type="number" min="1" placeholder="pallets" class="escribe">
        </div>
      </div>
      <button type="button" class="ghost mini escribe" data-add-bahia>+ bahía</button>
      <button class="primario mini escribe">Pasar a bahía</button>
    </form>`;
  }

  // Decisión después de "Descargado": retirar la caja o dejarla en rampa cargando.
  function formDecisionRampa(v) {
    const opciones = v.stage === 'Descargado'
      ? `<optgroup label="Se retira">
           <option value="SALIDA:VACIA">Sale vacía</option>
           <option value="SALIDA:RETORNABLE">Sale cargada: retornable</option>
           <option value="SALIDA:RACKS">Sale cargada: racks</option>
         </optgroup>
         <optgroup label="Se queda en rampa">
           <option value="ETAPA:Cargando retornable">Cargando retornable</option>
           <option value="ETAPA:Cargando racks">Cargando racks</option>
         </optgroup>`
      : `<option value="SALIDA:${SALIDA_DE_ETAPA[v.stage]}">Registrar salida: ${ETIQUETA_SALIDA[SALIDA_DE_ETAPA[v.stage]]}</option>`;
    const etiqueta = v.stage === 'Descargado' ? '¿Qué pasa con la caja?' : 'Salida';
    return `<form class="expandido" data-decision="${esc(v.code)}">
      <label>${etiqueta}<select name="accion" class="escribe">${opciones}</select></label>
      <button class="primario mini escribe">Confirmar</button>
    </form>`;
  }

  function tarjetaRampa(c, v) {
    const k = 'r:' + c;
    const desplegado = abiertos.has(k);
    let cuerpo, clase = 'libre', extra = '';
    if (v) {
      const h = horas(v.created_at);
      clase = claseEdad(h);
      cuerpo = `<b class="caja">${esc(v.box_code)}</b><small>${esc(v.supplier)}</small>
        <span class="etapa">${esc(v.stage)}</span><span class="pill ${clase}">${edadTexto(h)}</span>`;
      if (desplegado) {
        if (v.stage === RM.TRAILER_STAGES[0]) extra = formPasarBahia(v);
        else extra = formDecisionRampa(v);
      }
    } else {
      cuerpo = '<b class="vacia">VACÍA</b>';
      if (desplegado) extra = formAsignarRampa(c);
    }
    return `<div class="tp rampa ${clase}">
      <small class="codigo">R${esc(c)}</small>
      ${cuerpo}
      <button class="ghost mini" data-mas="${k}">${desplegado ? '▲ Menos' : '▼ Más'}</button>
      ${extra}
    </div>`;
  }

  function formAvanzarLote(l) {
    const etapas = S.cfg.product_stages;
    const ci = etapas.indexOf(l.stage);
    const opciones = etapas.map((s, i) => ({ s, i }))
      .filter((x) => x.i > ci || (x.s === 'Ubicado parcial' && ci >= 3))
      .map((x) => `<option>${esc(x.s)}</option>`).join('');
    return `<form class="expandido" data-avanzar-lote="${esc(l.code)}">
      <label>Cambiar estatus a<select name="to">${opciones}</select></label>
      <label>Pallets ubicados<input name="pal" type="number" min="1" placeholder="si aplica"></label>
      <button class="primario mini escribe" ${opciones ? '' : 'disabled'}>Confirmar cambio</button>
    </form>`;
  }

  function tarjetaLote(l) {
    const h = horas(l.created_at);
    const clase = claseEdad(h);
    const k = 'l:' + l.code;
    const desplegado = abiertos.has(k);
    return `<div class="tp lote ${clase}">
      <small class="codigo">${esc(l.code)} · ${esc(l.parent)}${l.capture_mode === 'MANUAL' ? ' · MANUAL' : ''}</small>
      <b class="caja">${esc(l.box_code)}</b>
      <span>${num(l.pallets_remaining)} / ${num(l.pallets_total)} pal</span>
      <span class="etapa">${esc(l.stage)}</span>
      <span class="pill ${clase}">${edadTexto(h)}</span>
      <button class="ghost mini" data-mas="${k}">${desplegado ? '▲ Menos' : '▼ Más'}</button>
      ${desplegado ? formAvanzarLote(l) : ''}
    </div>`;
  }

  // Cada bahía muestra sus 5 cajas con más tiempo; el resto se cuenta como "+N más".
  function columnaBahia(ls) {
    const visibles = ls.slice(0, MAX_CAJAS_BAHIA).map(tarjetaLote).join('');
    const resto = ls.length - MAX_CAJAS_BAHIA;
    const pie = resto > 0 ? `<div class="mas-cajas">+${num(resto)} más · ver en Detalle de caja</div>` : '';
    return `<div class="pila">${visibles || '<div class="libre-bahia">—</div>'}${pie}</div>`;
  }

  function renderPiso(snap) {
    if (!S.cfg) return;
    // No se redibuja mientras el operador escribe en un campo de la pantalla de piso.
    const foco = document.activeElement;
    if (foco && q('#sec-piso').contains(foco) && /^(INPUT|SELECT|TEXTAREA)$/.test(foco.tagName)) return;
    const cols = columnasPiso();
    const visitas = snap.visits.filter((v) => !v.closed);
    const lotes = snap.lots.filter((l) => !l.closed).sort((a, b) => a.created_at.localeCompare(b.created_at));
    const cabecera = (ids) => cols.map((c) => `<div class="cab">${ids.includes(c) ? `R${esc(c)}` : ''}</div>`).join('');
    const rampas = cols.map((c) => (S.cfg.ramps.includes(c)
      ? tarjetaRampa(c, visitas.find((v) => v.ramp === c))
      : '<div class="hueco"></div>')).join('');
    const bahias = cols.map((c) => (S.cfg.bays.includes(c)
      ? columnaBahia(lotes.filter((l) => l.bay === c))
      : '<div class="hueco"></div>')).join('');
    const bloques = [['#piso-rampas', S.cfg.ramps, rampas], ['#piso-bahias', S.cfg.bays, bahias]];
    for (const [id, ids, cuerpo] of bloques) {
      const el = q(id);
      el.style.gridTemplateColumns = `repeat(${cols.length}, minmax(66px, 1fr))`;
      el.innerHTML = cabecera(ids) + cuerpo;
    }
    actualizarModo();
  }

  q('#sec-piso').addEventListener('click', (e) => {
    if (!S.engine) return;
    const add = e.target.closest('[data-add-bahia]');
    if (add) {
      const form = add.closest('form');
      const fila = document.createElement('div');
      fila.className = 'fila-bahia';
      fila.innerHTML = `<select name="bay" class="escribe">${opcionesBahias()}</select>
        <input name="pallets" type="number" min="1" placeholder="pallets" class="escribe">`;
      form.querySelector('.filas-bahia').appendChild(fila);
      return;
    }
    const b = e.target.closest('[data-mas]');
    if (!b) return;
    const k = b.dataset.mas;
    if (abiertos.has(k)) abiertos.delete(k); else abiertos.add(k);
    renderPiso(S.engine.snapshot());
  });

  q('#sec-piso').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    if (f.dataset.asignar) return asignarRampa(f);
    if (f.dataset.pasar) return pasarBahia(f);
    if (f.dataset.decision) return decidirRampa(f);
    if (f.dataset.avanzarLote) return avanzarLote(f);
  });

  function asignarRampa(f) {
    const fd = new FormData(f);
    const rampa = f.dataset.asignar;
    accion(async () => {
      const llegada = fd.get('arrived');
      const r = await S.engine.createVisit({
        box_code: fd.get('box'), supplier: fd.get('supplier'), ramp: rampa,
        arrived_at: llegada ? new Date(llegada).toISOString() : undefined
      });
      abiertos.delete('r:' + rampa);
      toast(`${r.visit_code} asignada a R${rampa}`);
    });
  }

  function pasarBahia(f) {
    const code = f.dataset.pasar;
    const v = S.engine.snapshot().visits.find((x) => x.code === code);
    if (!v) return;
    const filas = qa('.fila-bahia', f).map((r) => ({
      bay: r.querySelector('select').value, pallets: r.querySelector('input').value
    }));
    accion(async () => {
      const r = await S.engine.pasarABahia(code, { allocations: filas, encargado: encargadoActual() });
      abiertos.delete('r:' + v.ramp);
      toast(`${code} pasa a bahía: ${r.lot_codes.join(', ')}`);
    });
  }

  // Después de "Descargado" o en una caja cargando: retirar la caja o dejarla en rampa.
  function decidirRampa(f) {
    const code = f.dataset.decision;
    const v = S.engine.snapshot().visits.find((x) => x.code === code);
    const [tipo, valor] = f.querySelector('[name=accion]').value.split(':');
    if (!v) return;
    accion(async () => {
      if (tipo === 'SALIDA') await S.engine.advanceVisit(code, { to: 'Salió', salida: valor, encargado: encargadoActual() });
      else await S.engine.advanceVisit(code, { to: valor });
      abiertos.delete('r:' + v.ramp);
      toast(tipo === 'SALIDA' ? `${code}: salida ${ETIQUETA_SALIDA[valor]}` : `${code}: ${valor}`);
    });
  }

  function avanzarLote(f) {
    const code = f.dataset.avanzarLote;
    const to = f.querySelector('[name=to]').value;
    const pal = f.querySelector('[name=pal]').value;
    const lote = S.engine.snapshot().lots.find((x) => x.code === code);
    if (!lote || !to) return;
    accion(async () => {
      const r = await S.engine.advanceLot(code, { to, pallets_located: pal });
      abiertos.delete('l:' + code);
      toast(`${code} → ${to}${r.pallets_remaining !== undefined ? ` · saldo ${r.pallets_remaining}` : ''}`);
    });
  }

  // ---------- recolección directa y captura manual ----------
  const AYUDA_TIPO = {
    recoleccion: 'Una caja cuenta una vez aunque se reparta en varias bahías.',
    manual: 'Para una caja que no se capturó a tiempo. Queda marcada como MANUAL en el historial.'
  };

  function iniciarCaptura(form) {
    const cont = form.querySelector('.allocs');
    const agregarFila = () => {
      const fila = document.createElement('div');
      fila.className = 'alloc';
      fila.innerHTML = `<select name="bay" class="sel-bahias escribe"></select>
        <input name="pallets" type="number" min="1" placeholder="pallets" class="escribe">
        <button type="button" class="ghost mini quitar escribe">×</button>`;
      cont.appendChild(fila);
      rellenarCatalogos();
    };
    form.querySelector('.addAlloc').onclick = agregarFila;
    cont.addEventListener('click', (e) => {
      if (e.target.classList.contains('quitar') && cont.children.length > 1) e.target.closest('.alloc').remove();
    });
    agregarFila();

    const tipoSel = form.elements.tipo;
    const aplicarTipo = () => {
      const t = tipoSel.value;
      qa('.solo-manual', form).forEach((el) => { el.hidden = t !== 'manual'; });
      q('#captura-ayuda').textContent = AYUDA_TIPO[t];
    };
    tipoSel.addEventListener('change', aplicarTipo);
    aplicarTipo();

    form.onsubmit = (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const el = form.querySelector('.msg');
      const tipo = fd.get('tipo');
      const asignaciones = qa('.alloc', form).map((r) => ({
        bay: r.querySelector('select').value, pallets: r.querySelector('input').value
      }));
      const cuando = fd.get('cuando');
      accion(async () => {
        if (!asignaciones.length || asignaciones.some((a) => !a.bay || !(Number(a.pallets) >= 1))) {
          throw new Error('Cada bahía necesita una bahía y al menos un pallet.');
        }
        const r = await S.engine.createCollection({
          encargado: encargadoActual(),
          box_code: fd.get('box_code'),
          origin_area: fd.get('origin_area'),
          capture_mode: tipo === 'manual' ? 'MANUAL' : 'OPERATIVA',
          reason: fd.get('reason') || '',
          occurrence_at: cuando ? new Date(cuando).toISOString() : undefined,
          allocations: asignaciones,
          notes: fd.get('notes') || ''
        });
        const texto = `${r.collection_code} registrado en ${r.lot_codes.length} bahía(s).`;
        form.reset();
        tipoSel.value = tipo;
        aplicarTipo();
        cont.innerHTML = '';
        agregarFila();
        msg(el, texto, 'ok');
      }, { el });
    };
  }
  iniciarCaptura(q('#form-recoleccion'));

  // Registro de una caja en una bahía, con unidad, estatus inicial y fecha de descarga.
  const RESPONSABLE = (etapa) => (etapa === 'Por ubicar' ? 'Putaway' : 'Recibo');
  function actualizarNotaCaptura() {
    if (!S.cfg) return;
    const f = q('#form-captura-rapida');
    const sh = turnoAhora();
    q('#nota-captura').textContent = `Máximo ${RM.MAX_CAJAS_BAHIA} cajas abiertas por bahía. Responsable: ${RESPONSABLE(f.stage.value)}. Turno activo: ${sh.name}.`;
  }
  const formCaptura = q('#form-captura-rapida');
  formCaptura.stage.addEventListener('change', actualizarNotaCaptura);
  formCaptura.onsubmit = (e) => {
    e.preventDefault();
    const f = e.target;
    const fd = new FormData(f);
    const cuando = fd.get('cuando');
    accion(async () => {
      const r = await S.engine.createCollection({
          encargado: encargadoActual(),
        box_code: fd.get('box_code'), origin_area: 'Recibo',
        capture_mode: 'OPERATIVA', reason: '',
        unit: fd.get('unit'), stage: fd.get('stage'),
        occurrence_at: cuando ? new Date(cuando).toISOString() : undefined,
        allocations: [{ bay: fd.get('bay'), pallets: fd.get('pallets') }]
      });
      f.box_code.value = '';
      f.pallets.value = '';
      f.cuando.value = ahoraLocal();
      f.box_code.focus();
      toast(`${r.collection_code} registrado en R${fd.get('bay')} · responsable ${RESPONSABLE(fd.get('stage'))}.`);
    });
  };

  // ---------- detalle de caja: lista de cajas abiertas ----------
  function opcionesEstatus(f) {
    if (f.tipo === 'visita') {
      const v = f.ref;
      if (v.stage.startsWith('Cargando')) return [{ valor: `SALIDA:${SALIDA_DE_ETAPA[v.stage]}`, texto: `Salió · ${ETIQUETA_SALIDA[SALIDA_DE_ETAPA[v.stage]]}` }];
      return (RM.TRANSICIONES[v.stage] || []).flatMap((to) => (to === 'Salió'
        ? RM.SALIDAS.map((s) => ({ valor: `SALIDA:${s}`, texto: `Salió · ${ETIQUETA_SALIDA[s]}` }))
        : [{ valor: to, texto: to }]));
    }
    const etapas = S.cfg.product_stages;
    const ci = etapas.indexOf(f.ref.stage);
    return etapas.map((s, i) => ({ s, i }))
      .filter((x) => x.i > ci || (x.s === 'Ubicado parcial' && ci >= 3))
      .map((x) => ({ valor: x.s, texto: x.s }));
  }

  // Cambia el estatus desde Detalle de caja. Los pasos saltados se dan por cumplidos.
  function cambiarEstatus(tipo, id, valor, pal) {
    return accion(async () => {
      if (tipo === 'visita') {
        if (valor.startsWith('SALIDA:')) await S.engine.advanceVisit(id, { to: 'Salió', salida: valor.slice(6), encargado: encargadoActual() });
        else await S.engine.advanceVisit(id, { to: valor });
        toast(`${id} → ${valor.replace('SALIDA:', 'Salió · ')}`);
        return;
      }
      const lote = S.engine.snapshot().lots.find((x) => x.code === id);
      if (!lote) return;
      const r = await S.engine.advanceLot(id, { to: valor, pallets_located: pal });
      toast(`${id} → ${valor}${r.pallets_remaining !== undefined ? ` · saldo ${r.pallets_remaining}` : ''}`);
    }).then(() => { if (S.engine) renderDetalle(S.engine.snapshot()); });
  }

  let filtroCajas = '';
  function renderDetalle(snap) {
    const foco = document.activeElement;
    if (foco && q('#tabla-abiertas').contains(foco) && /^(SELECT|INPUT)$/.test(foco.tagName)) return;
    const filas = [
      ...snap.visits.filter((v) => !v.closed).map((v) => ({
        tipo: 'visita', ref: v, id: v.code, caja: v.box_code, ubicacion: `Rampa R${v.ramp}`, estatus: v.stage, pallets: '', creado: v.created_at
      })),
      ...snap.lots.filter((l) => !l.closed).map((l) => ({
        tipo: 'lote', ref: l, id: l.code, caja: l.box_code, ubicacion: `Bahía R${l.bay}`, estatus: l.stage,
        pallets: `${num(l.pallets_remaining)} / ${num(l.pallets_total)}`, creado: l.created_at
      }))
    ].sort((a, b) => a.creado.localeCompare(b.creado));
    const texto = filtroCajas.trim().toLowerCase();
    const visibles = filas.filter((f) => !texto || f.caja.toLowerCase().includes(texto));
    q('#tabla-abiertas').innerHTML = `<thead><tr><th>Caja</th><th>Ubicación</th><th>Estatus</th><th>Responsable</th><th>Cambiar a</th><th>Pallets</th><th>Antigüedad</th></tr></thead>
      <tbody>${visibles.map((f) => {
        const h = horas(f.creado);
        const opts = opcionesEstatus(f);
        const select = `<select class="estatus-sel escribe" data-tipo="${f.tipo}" data-id="${esc(f.id)}" ${opts.length ? '' : 'disabled'}>
            <option value="">${opts.length ? 'Elegir…' : 'Sin siguiente paso'}</option>${opts.map((o) => `<option value="${esc(o.valor)}">${esc(o.texto)}</option>`).join('')}</select>
          <span class="cambio-pal" hidden><input type="number" min="1" placeholder="pallets" class="pal-sel escribe"> <button type="button" class="ghost mini aplicar-pal escribe">Aplicar</button></span>`;
        return `<tr data-caja="${esc(f.caja)}" class="fila-caja ${claseEdad(h)}">
          <td><b>${esc(f.caja)}</b></td><td>${esc(f.ubicacion)}</td><td><span class="etapa">${esc(f.estatus)}</span></td>
          <td>${esc(f.tipo === 'lote' ? RM.responsableDe(f.estatus) : 'Recibo')}</td>
          <td class="celda-estatus">${select}</td>
          <td>${esc(f.pallets)}</td><td><span class="pill ${claseEdad(h)}">${edadTexto(h)}</span></td></tr>`;
      }).join('') || '<tr><td colspan="7" class="vacio">Sin cajas abiertas.</td></tr>'}</tbody>`;
  }
  q('#buscar-caja').addEventListener('input', (e) => {
    filtroCajas = e.target.value;
    if (S.engine) renderDetalle(S.engine.snapshot());
  });
  q('#tabla-abiertas').addEventListener('change', (e) => {
    const sel = e.target.closest('.estatus-sel');
    if (!sel || !sel.value) return;
    const span = sel.parentElement.querySelector('.cambio-pal');
    if (sel.dataset.tipo === 'lote' && sel.value.startsWith('Ubicado')) {
      span.hidden = false;
      span.querySelector('input').focus();
      return;
    }
    span.hidden = true;
    sel.blur();
    cambiarEstatus(sel.dataset.tipo === 'visita' ? 'visita' : 'lote', sel.dataset.id, sel.value, null);
  });
  q('#tabla-abiertas').addEventListener('click', (e) => {
    const ap = e.target.closest('.aplicar-pal');
    if (ap) {
      const fila = ap.closest('tr');
      const sel = fila.querySelector('.estatus-sel');
      const pal = fila.querySelector('.pal-sel').value;
      if (!(Number(pal) >= 1)) { toast('Indica los pallets ubicados.', 'error'); return; }
      cambiarEstatus('lote', sel.dataset.id, sel.value, pal);
      return;
    }
    if (e.target.closest('select, input, button')) return;
    const tr = e.target.closest('[data-caja]');
    if (tr) renderCaja(tr.dataset.caja);
  });

  // ---------- detalle de caja ----------
  q('#form-cajas').onsubmit = (e) => {
    e.preventDefault();
    const codigo = q('#buscar-caja').value.trim();
    if (codigo) renderCaja(codigo);
  };

  function detalleEvento(e) {
    const d = e.data;
    switch (e.type) {
      case 'VISIT_CREATED': return `Rampa ${d.ramp} · ${d.supplier}`;
      case 'VISIT_STATUS': return `${d.from} → ${d.to}${d.skipped?.length ? ` · salto: ${d.skipped.join(', ')}` : ''}`;
      case 'LOT_CREATED': return `Bahía ${d.bay} · ${d.pallets_total} pallets · ${d.origin}`;
      case 'LOT_STATUS': return `${d.from} → ${d.to}${d.pallets_moved ? ` · ${d.pallets_moved} pallets` : ''}${d.skipped?.length ? ` · salto: ${d.skipped.join(', ')}` : ''}`;
      case 'COLLECTION_CREATED': return `${d.capture_mode} · ${d.origin_area} · bahías ${d.bays.join(', ')}`;
      case 'CONFIG_CHANGED': return 'Configuración modificada';
      case 'SHIFT_CLOSED': return `Respaldo: ${d.backup}`;
      default: return '';
    }
  }

  function renderCaja(codigo) {
    const snap = S.engine.snapshot();
    const visitas = snap.visits.filter((v) => v.box_code === codigo);
    const lotes = snap.lots.filter((l) => l.box_code === codigo);
    const recs = snap.collections.filter((c) => c.box_code === codigo);
    const codigos = new Set([...visitas, ...lotes, ...recs].map((x) => x.code));
    const eventos = S.engine.events().filter((e) => e.data.box_code === codigo || codigos.has(e.entity.code));
    q('#resultado-caja').innerHTML = `
      <div class="resumen-caja">
        <article class="panel"><h3>Remolques (${visitas.length})</h3>
          ${visitas.map((v) => `<div><b>${esc(v.code)}</b> · ${esc(v.supplier)}<small>Rampa ${esc(v.ramp)} · ${esc(v.stage)}${v.closed ? ' · cerrada' : ''}</small></div>`).join('') || '<p class="vacio">Sin remolques.</p>'}
        </article>
        <article class="panel"><h3>Lotes (${lotes.length})</h3>
          ${lotes.map((l) => `<div><b>${esc(l.code)}</b> · bahía ${esc(l.bay)}<small>${num(l.pallets_remaining)} / ${num(l.pallets_total)} pallets · ${esc(l.stage)}</small></div>`).join('') || '<p class="vacio">Sin lotes.</p>'}
        </article>
        <article class="panel"><h3>Recolecciones (${recs.length})</h3>
          ${recs.map((c) => `<div><b>${esc(c.code)}</b> · ${esc(c.capture_mode)}<small>${esc(c.origin_area)} · bahías ${esc(c.bays.join(', '))}${c.reason ? ` · ${esc(c.reason)}` : ''}</small></div>`).join('') || '<p class="vacio">Sin recolecciones.</p>'}
        </article>
      </div>
      <article class="panel"><h3>Historial</h3>
        <div class="tabla-scroll"><table>
          <thead><tr><th>Fecha</th><th>Turno</th><th>Operador</th><th>Evento</th><th>Detalle</th><th>Comentario</th></tr></thead>
          <tbody>${eventos.map((e) => `<tr>
            <td>${esc(e.at_local)}</td><td>${esc(e.shift)}</td><td>${esc(e.operator)}</td>
            <td>${esc(e.type)}<small>${esc(e.entity.code)}</small></td><td>${esc(detalleEvento(e))}</td><td>${esc(e.comment)}</td>
          </tr>`).join('') || '<tr><td colspan="6" class="vacio">Sin movimientos para este folio.</td></tr>'}</tbody>
        </table></div>
      </article>`;
  }

  // ---------- reportes y exportación ----------
  function renderReportes() {
    const k = S.engine.kpis(filtroTurno(q('#rep-filtro').value));
    const cab = `<thead><tr><th>Fecha</th><th>Turno</th><th>Descargadas</th><th>Cargadas racks</th><th>Cargadas retornable</th><th>Cargadas total</th><th>Vacías</th><th>Recolectadas</th><th>Manuales</th><th>Validadas</th><th>Procesadas</th><th>Ubicadas</th><th>Pallets ubicados</th></tr></thead>`;
    const celdas = (r) => [r.descargadas, r.cargadas_racks, r.cargadas_retornable, r.cargadas, r.vacias, r.recolectadas, r.manuales, r.validadas, r.procesadas, r.ubicadas, r.pallets_ubicados]
      .map((v) => `<td>${num(v)}</td>`).join('');
    const filas = k.rows.map((r) => `<tr><td>${esc(r.fecha_turno)}</td><td>${esc(r.turno)}</td>${celdas(r)}</tr>`).join('');
    const total = `<tr><th colspan="2">Total</th>${celdas(k.totals)}</tr>`;
    q('#tabla-rep').innerHTML = cab + `<tbody>${filas || '<tr><td colspan="13" class="vacio">Sin actividad.</td></tr>'}${k.rows.length ? total : ''}</tbody>`;
  }

  async function guardarExport(nombre, texto) {
    const carpeta = await S.folder.getDirectoryHandle('exportes', { create: true });
    const fh = await carpeta.getFileHandle(nombre, { create: true });
    const w = await fh.createWritable();
    await w.write(texto);
    await w.close();
    const url = URL.createObjectURL(new Blob([texto], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = nombre;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    return `exportes/${nombre}`;
  }
  const sello = () => {
    const d = new Date();
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}_${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
  };
  q('#btn-exp-eventos').onclick = () => accion(async () => {
    const ruta = await guardarExport(`historial_${sello()}.csv`, S.engine.exportEventsCsv());
    msg(q('#rep-msg'), `Guardado en ${ruta}`, 'ok');
  }, { el: q('#rep-msg') });
  q('#btn-exp-kpi').onclick = () => accion(async () => {
    const ruta = await guardarExport(`kpis_${sello()}.csv`, S.engine.exportKpiCsv(filtroTurno(q('#rep-filtro').value)));
    msg(q('#rep-msg'), `Guardado en ${ruta}`, 'ok');
  }, { el: q('#rep-msg') });

  // ---------- turno ----------
  function renderTurno() {
    const sh = turnoAhora();
    q('#turno-info').innerHTML = `<p>Turno actual: <b>${esc(sh.name)}</b> · fecha de turno ${esc(sh.shift_date)}</p>
      <p>Eventos en el historial: <b>${num(S.engine.events().length)}</b></p>`;
  }
  q('#btn-cerrar-turno').onclick = () => accion(async () => {
    const r = await S.engine.closeShift();
    msg(q('#turno-msg'), `Turno cerrado. Respaldo en ${r.backup}`, 'ok');
  }, { el: q('#turno-msg') });

  // ---------- configuración (solo administrador) ----------
  async function renderConfig() {
    if (!S.session || S.session.role !== 'admin') return;
    const f = q('#form-config');
    if (!f.contains(document.activeElement)) {
      f.ramps.value = S.cfg.ramps.join(', ');
      f.bays.value = S.cfg.bays.join(', ');
      f.min_reason_length.value = S.cfg.min_reason_length;
    }
    q('#flujo-txt').textContent = S.cfg.product_stages.join(' → ');
    renderTurnosEditor();
    renderCalendario();
    renderFestivos();
    const usuarios = await S.engine.listUsers();
    q('#lista-usuarios-tabla').innerHTML = `<table><thead><tr><th>Empleado</th><th>Nombre</th><th>Perfil</th></tr></thead><tbody>${
      usuarios.map((u) => `<tr><td>${esc(u.empleado)}</td><td>${esc(u.name)}</td><td>${esc(u.role)}${u.active ? '' : ' · inactivo'}</td></tr>`).join('')
    }</tbody></table>`;
  }

  q('#form-config').onsubmit = (e) => {
    e.preventDefault();
    const f = e.target;
    const lista = (txt) => txt.split(',').map((s) => s.trim()).filter(Boolean);
    accion(async () => {
      const patch = {
        ramps: lista(f.ramps.value),
        bays: lista(f.bays.value),
        min_reason_length: Number(f.min_reason_length.value)
      };
      const r = await S.engine.saveConfig(patch);
      msg(f.querySelector('.msg'), Object.keys(r.changes).length ? 'Configuración guardada.' : 'Sin cambios.', 'ok');
    }, { el: f.querySelector('.msg') });
  };

  q('#form-usuario').onsubmit = (e) => {
    e.preventDefault();
    const f = e.target;
    const fd = new FormData(f);
    accion(async () => {
      await S.engine.addUser({ empleado: fd.get('empleado'), name: fd.get('nombre'), password: fd.get('password'), role: fd.get('role') });
      f.reset();
      msg(f.querySelector('.msg'), 'Usuario agregado.', 'ok');
    }, { el: f.querySelector('.msg') });
  };

  // ---------- encargado (capturista elige un supervisor; supervisor/admin es él mismo) ----------
  function encargadoActual() {
    if (!S.session || S.session.role !== 'capturista') return undefined;
    return S.encargado || '';
  }
  async function actualizarEncargado() {
    if (!S.engine || !S.session) return;
    const supervisores = await S.engine.listSupervisores();
    const opciones = supervisores.map((s) => `<option value="${esc(s.empleado)}">${esc(s.name)}</option>`).join('');
    const sel = q('#encargado-turno');
    q('#encargado-caja').hidden = S.session.role !== 'capturista';
    if (sel !== document.activeElement) {
      const guardado = S.encargado || sessionStorage.getItem('recibo.encargado') || '';
      sel.innerHTML = '<option value="">Elegir…</option>' + opciones;
      sel.value = supervisores.some((s) => s.empleado === guardado) ? guardado : '';
      S.encargado = sel.value;
    }
    const pe = q('#prod-encargado');
    if (pe !== document.activeElement) {
      const previo = pe.value;
      pe.innerHTML = '<option value="">Todos</option>' + opciones;
      pe.value = previo;
    }
  }
  q('#encargado-turno').onchange = (e) => {
    S.encargado = e.target.value;
    try { sessionStorage.setItem('recibo.encargado', S.encargado); } catch (_) { /* sin almacenamiento de sesión */ }
  };

  // ---------- configuración: turnos y metas ----------
  const DIAS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
  const minutosDe = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
  const horasDe = (ini, fin) => (((minutosDe(fin) - minutosDe(ini)) + 1440) % 1440) / 60;
  function filaTurno(s) {
    const horas = horasDe(s.start || '00:00', s.end || '00:00');
    const mh = horas > 0 && Number(s.meta) > 0 ? `${(Number(s.meta) / horas).toFixed(1)}/h` : '—';
    return `<div class="fila-turno">
      <input name="nombre" value="${esc(s.name || '')}">
      <input type="time" name="inicio" value="${esc(s.start || '')}">
      <input type="time" name="fin" value="${esc(s.end || '')}">
      <input type="number" name="meta" min="0" step="1" value="${esc(s.meta || 0)}">
      <span class="mh">${mh}</span>
      <button type="button" class="ghost mini quitar-turno" title="Quitar turno">×</button>
    </div>`;
  }
  function renderTurnosEditor() {
    const cont = q('#turnos-editor');
    if (!S.cfg || cont.contains(document.activeElement)) return;
    cont.innerHTML = S.cfg.shifts.map(filaTurno).join('');
  }
  q('#turnos-editor').addEventListener('input', (e) => {
    const fila = e.target.closest('.fila-turno');
    if (!fila) return;
    const v = { start: fila.querySelector('[name=inicio]').value, end: fila.querySelector('[name=fin]').value, meta: fila.querySelector('[name=meta]').value };
    const horas = horasDe(v.start, v.end);
    fila.querySelector('.mh').textContent = horas > 0 && Number(v.meta) > 0 ? `${(Number(v.meta) / horas).toFixed(1)}/h` : '—';
  });
  q('#turnos-editor').addEventListener('click', (e) => {
    const b = e.target.closest('.quitar-turno');
    if (b) b.closest('.fila-turno').remove();
  });
  q('#btn-add-turno').onclick = () => {
    q('#turnos-editor').insertAdjacentHTML('beforeend', filaTurno({ name: 'Nuevo', start: '07:00', end: '15:00', meta: 0 }));
  };
  function leerTurnos() {
    return qa('#turnos-editor .fila-turno').map((f) => ({
      name: f.querySelector('[name=nombre]').value.trim(),
      start: f.querySelector('[name=inicio]').value,
      end: f.querySelector('[name=fin]').value,
      meta: Number(f.querySelector('[name=meta]').value) || 0
    }));
  }
  q('#btn-guardar-turnos').onclick = () => {
    const nuevos = leerTurnos();
    const viejos = S.cfg.shifts;
    // Si un turno se renombra (misma fila), el calendario y los festivos siguen al nuevo nombre.
    const mapa = {};
    viejos.forEach((v, i) => { if (!nuevos.some((n) => n.name === v.name) && nuevos[i]) mapa[v.name] = nuevos[i].name; });
    const mapear = (lista) => lista.map((x) => mapa[x] ?? x).filter((x) => nuevos.some((n) => n.name === x));
    const patch = {
      shifts: nuevos,
      work_days: S.cfg.work_days.map(mapear),
      holidays: S.cfg.holidays.map((h) => ({ ...h, shifts: h.shifts === 'ALL' ? 'ALL' : mapear(h.shifts) }))
        .filter((h) => h.shifts === 'ALL' || h.shifts.length)
    };
    const el = q('#turnos-msg');
    accion(async () => {
      const r = await S.engine.saveConfig(patch);
      msg(el, Object.keys(r.changes).length ? 'Turnos y metas guardados.' : 'Sin cambios.', 'ok');
    }, { el });
  };

  // ---------- configuración: calendario laboral y festivos ----------
  function renderCalendario() {
    const cont = q('#calendario-tabla');
    if (!S.cfg || cont.contains(document.activeElement)) return;
    const cols = S.cfg.shifts.map((s) => s.name);
    cont.innerHTML = `<table class="tabla-cal"><thead><tr><th>Día</th>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${
      DIAS.map((d, i) => `<tr><td><b>${d}</b></td>${cols.map((c) => `<td><input type="checkbox" data-dia="${i}" data-turno="${esc(c)}" ${(S.cfg.work_days[i] || []).includes(c) ? 'checked' : ''}></td>`).join('')}</tr>`).join('')
    }</tbody></table>`;
    const sel = q('#festivo-turnos');
    if (sel !== document.activeElement) {
      const previo = sel.value;
      sel.innerHTML = '<option value="ALL">Todo el día</option>' + cols.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
      sel.value = previo || 'ALL';
    }
  }
  q('#btn-guardar-calendario').onclick = () => {
    const turnos = S.cfg.shifts.map((s) => s.name);
    const work_days = DIAS.map((_, i) => turnos.filter((tn) => q(`#calendario-tabla input[data-dia="${i}"][data-turno="${CSS.escape(tn)}"]`)?.checked));
    const el = q('#calendario-msg');
    accion(async () => {
      await S.engine.saveConfig({ work_days });
      msg(el, 'Calendario laboral guardado.', 'ok');
    }, { el });
  };
  function renderFestivos() {
    const lista = q('#lista-festivos');
    if (!S.cfg) return;
    lista.innerHTML = S.cfg.holidays.length
      ? S.cfg.holidays.map((h, i) => `<div class="fila-festivo-item"><b>${esc(h.date)}</b> · ${h.shifts === 'ALL' ? 'Todo el día' : esc(h.shifts.join(', '))}${h.nota ? ` · ${esc(h.nota)}` : ''}
          <button type="button" class="ghost mini" data-quitar-festivo="${i}">Quitar</button></div>`).join('')
      : '<p class="vacio">Sin días festivos.</p>';
  }
  q('#form-festivo').onsubmit = (e) => {
    e.preventDefault();
    const f = e.target;
    const turnos = f.turnos.value === 'ALL' ? 'ALL' : [f.turnos.value];
    const holidays = [...S.cfg.holidays, { date: f.fecha.value, shifts: turnos, nota: f.nota.value.trim() }];
    const el = q('#calendario-msg');
    accion(async () => {
      await S.engine.saveConfig({ holidays });
      f.reset();
      msg(el, 'Festivo agregado.', 'ok');
    }, { el });
  };
  q('#lista-festivos').addEventListener('click', (e) => {
    const b = e.target.closest('[data-quitar-festivo]');
    if (!b) return;
    const holidays = S.cfg.holidays.filter((_, i) => i !== Number(b.dataset.quitarFestivo));
    accion(() => S.engine.saveConfig({ holidays }));
  });

  // ---------- productividad ----------
  const ymdLocal = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const pct = (real, meta) => (meta > 0 ? Math.min((real / meta) * 100, 100) : 0);
  function fijarPeriodo(dias) {
    const hoy = new Date();
    const desde = new Date();
    desde.setDate(desde.getDate() - (dias - 1));
    q('#prod-desde').value = ymdLocal(desde);
    q('#prod-hasta').value = ymdLocal(hoy);
    renderProductividad();
  }
  q('#prod-hoy').onclick = () => fijarPeriodo(1);
  q('#prod-7').onclick = () => fijarPeriodo(7);
  q('#prod-30').onclick = () => fijarPeriodo(30);
  ['#prod-desde', '#prod-hasta', '#prod-turno', '#prod-encargado'].forEach((id) => q(id).addEventListener('change', () => renderProductividad()));

  async function renderProductividad() {
    if (!S.engine || !S.session || !S.cfg) return;
    if (!q('#prod-desde').value) { const hoy = ymdLocal(new Date()); q('#prod-desde').value = hoy; q('#prod-hasta').value = hoy; }
    const desde = q('#prod-desde').value, hasta = q('#prod-hasta').value;
    if (!desde || !hasta) return;
    const turnoSel = q('#prod-turno');
    const nombres = S.cfg.shifts.map((s) => s.name);
    if (turnoSel.options.length !== nombres.length + 1) {
      const previo = turnoSel.value;
      turnoSel.innerHTML = '<option value="">Todos</option>' + nombres.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
      turnoSel.value = previo;
    }
    const turno = turnoSel.value, encargado = q('#prod-encargado').value;
    let p;
    try {
      p = await S.engine.productividad({ from: desde, to: hasta, turno, encargado });
    } catch (err) {
      q('#prod-en-curso').innerHTML = `<p class="vacio">${esc(err.message)}</p>`;
      return;
    }
    const k = S.engine.kpis({ from: desde, to: hasta, shift: turno || undefined }).totals;
    const t = p.total;

    const c = p.en_curso;
    q('#prod-en-curso').innerHTML = !c ? '<h3>Turno en curso</h3><p class="vacio">Sin turno activo.</p>' : `
      <h3>Turno en curso: ${esc(c.turno)}</h3>
      <small>${c.laboral && c.meta > 0 ? `meta ${c.meta} · ${c.meta_hora.toFixed(1)} por hora` : 'turno sin meta o no laboral'}</small>
      <div class="pc-num"><b class="${c.real >= c.esperadas ? 'txt-verde' : 'txt-ambar'}">${num(c.real)}</b> <small>de ${num(c.esperadas)} esperadas a esta hora</small></div>
      <div class="pista"><div class="relleno ${c.real >= c.esperadas ? 'verde' : 'ambar'}" style="width:${pct(c.real, c.meta)}%"></div></div>
      <small>${c.laboral && c.meta > 0 ? `${Math.round(pct(c.real, c.meta))}% de la meta del turno · ${c.real >= c.esperadas ? 'en ritmo ✓' : 'por debajo del ritmo'}` : 'no suma meta'}</small>`;

    const dias = p.dias.filter((d) => d.estado !== 'no laboral').length;
    q('#prod-cumplimiento').innerHTML = `
      <h3>Cumplimiento del periodo</h3>
      <div class="pc-num"><b>${t.cumplimiento === null ? '—' : `${Math.round(t.cumplimiento * 100)}%`}</b> <small>${num(t.real)} de ${num(t.meta)} cajas</small></div>
      <div class="pista"><div class="relleno azul" style="width:${pct(t.real, t.meta)}%"></div></div>
      <small>${dias} días con meta en el periodo · incluye el turno en curso</small>`;

    q('#pk-real').textContent = num(t.real);
    q('#pk-meta').textContent = `Meta ${num(t.meta)}`;
    q('#pk-cargadas').textContent = num(k.cargadas);
    q('#pk-cargadas-detalle').textContent = `${num(k.cargadas_racks)} racks · ${num(k.cargadas_retornable)} retornable · ${num(k.vacias)} vacías`;
    q('#pk-pallets').textContent = num(k.pallets_ubicados);

    const maxH = Math.max(1, ...p.por_hora.map((h) => Math.max(h.real, h.meta_hora)));
    q('#prod-hora').innerHTML = p.por_hora.map((h) => `
      <div class="col-h" title="${String(h.hora).padStart(2, '0')}:00 · ${h.real} cajas · meta ${h.meta_hora.toFixed(1)}">
        <span class="val">${h.real || ''}</span>
        <div class="barra-h" style="height:${(h.real / maxH) * 100}%"></div>
        ${h.meta_hora > 0 ? `<div class="marca-meta" style="bottom:${(h.meta_hora / maxH) * 100}%"></div>` : ''}
        <span class="eje">${h.hora}</span>
      </div>`).join('');

    q('#prod-turnos').innerHTML = p.por_turno.map((tn) => {
      const pc = tn.meta > 0 ? (tn.real / tn.meta) * 100 : 0;
      return `<div class="fila-prog"><span><b>${esc(tn.turno)}</b> · ${tn.horas.toFixed(1)} h</span><span>${num(tn.real)} / ${num(tn.meta)}</span></div>
        <div class="pista"><div class="relleno ${pc >= 100 ? 'verde' : 'azul'}" style="width:${Math.min(pc, 100)}%"></div></div>
        <small>${tn.meta > 0 ? `${Math.round(pc)}% · meta ${tn.meta_hora.toFixed(1)}/h` : 'sin meta configurada'}</small>`;
    }).join('');
    const maxE = Math.max(1, ...p.por_encargado.map((e) => e.cajas));
    q('#prod-encargados').innerHTML = p.por_encargado.map((e) => `
      <div class="fila-prog"><span>${esc(e.nombre)}</span><span>${num(e.cajas)}</span></div>
      <div class="pista"><div class="relleno azul" style="width:${(e.cajas / maxE) * 100}%"></div></div>`).join('')
      || '<p class="vacio">Sin cajas en el periodo.</p>';

    const maxD = Math.max(1, ...p.dias.map((d) => Math.max(d.real, d.meta)));
    const clase = { cumple: 'verde', debajo: 'ambar', 'no laboral': 'nolab', 'sin meta': 'azul' };
    q('#prod-dias').innerHTML = p.dias.map((d) => `
      <div class="col-d" title="${d.fecha}: ${d.real} cajas · meta ${d.meta} · ${d.estado}">
        <span class="val">${d.real || ''}</span>
        <div class="barra-d ${clase[d.estado]}" style="height:${(d.real / maxD) * 100}%"></div>
        ${d.meta > 0 ? `<div class="marca-meta" style="bottom:${(d.meta / maxD) * 100}%"></div>` : ''}
        <span class="eje">${d.fecha.slice(8)}/${d.fecha.slice(5, 7)}</span>
      </div>`).join('') || '<p class="vacio">Sin días en el periodo.</p>';
  }

  // ---------- tema (azul o blanco; un solo botón para todo el programa) ----------
  const TEMA_CLAVE = 'recibo.tema';
  function aplicarTema(tema) {
    const blanco = tema === 'blanco';
    document.body.classList.toggle('tema-blanco', blanco);
    q('#btn-tema').textContent = blanco ? '◐ Tema azul' : '◐ Tema blanco';
    try { localStorage.setItem(TEMA_CLAVE, blanco ? 'blanco' : 'azul'); } catch (_) { /* sin almacenamiento */ }
  }
  q('#btn-tema').onclick = () => aplicarTema(document.body.classList.contains('tema-blanco') ? 'azul' : 'blanco');
  let temaGuardado = null;
  try { temaGuardado = localStorage.getItem(TEMA_CLAVE); } catch (_) { /* sin almacenamiento */ }
  aplicarTema(temaGuardado === 'blanco' ? 'blanco' : 'azul');

  // ---------- inicio ----------
  // Expuesto solo para pruebas automatizadas de la interfaz.
  window.__reciboPrueba = { engine: () => S.engine, cfg: () => S.cfg };
  arrancar();
})();
