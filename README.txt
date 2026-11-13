QORVEX RECIBO · v0.6.0
=====================================================================

Control de recibo sin servidor. Un solo equipo, historial en archivos
dentro de una carpeta local.


REQUISITOS
- Windows con Google Chrome o Microsoft Edge de escritorio.
  (Firefox y Safari no soportan elegir carpetas locales.)
- Para ejecutar las pruebas automáticas: Node.js 20 o superior (probado con 22).
  La app NO necesita Node para usarse.


USO DIARIO
1. Haz doble clic en index.html (se abre en Chrome o Edge).
2. Primera vez: "Seleccionar carpeta de trabajo" y elige una carpeta, vacía o no
   (por ejemplo C:\RecibosQorvex). Si está vacía, la app crea desde cero
   config.json, historial.jsonl, respaldos\ y exportes\. Todo el historial vivirá ahí.
   El botón "Seleccionar otra carpeta" siempre está en la pantalla de inicio.
3. Primera vez: crea el administrador (número de empleado, nombre, contraseña de
   10+ caracteres y una clave de administrador de 8+ para recuperar contraseñas).
4. Después: "Reconectar carpeta" y entra con tu número de empleado y contraseña.
   El navegador pide permiso de nuevo en cada sesión; es normal.
   Si al abrir la app aparece "Elegir carpeta" en vez de "Reconectar", elige la
   carpeta con el mismo nombre que ves en pantalla (la carpeta actual se muestra
   abajo, en el menú).
5. Al terminar el turno: menú "Turno" > "Cerrar turno y respaldar".


QUÉ HAY EN LA CARPETA
  historial.jsonl     Historial completo. Solo se agrega al final. No lo edites a mano.
  config.json         Rampas, bahías, turnos, metas, calendario laboral y días
                      festivos (los cambia el administrador).
  usuarios.json       Usuarios y contraseñas en forma de hash (no en texto).
  sesion.lock.json    Quién tiene la escritura en este momento.
  respaldos/          Copia del historial al cerrar cada turno.
  exportes/           CSV de historial y KPIs.

No pongas la carpeta dentro de OneDrive, Dropbox o similares mientras la
app está abierta: la sincronización puede crear copias en conflicto.


FLUJO DE UNA CAJA DE RAMPA
1. Por descarga: la caja se asigna a una rampa libre (Piso > "▼ Más" en la rampa).
2. Pasar a bahía: al elegir "Pasar a bahía" se pide la bahía y los pallets
   (puedes agregar varias bahías). La caja queda en Descargado y cada bahía
   crea un lote en estatus "Por validar".
3. Descargado: la app pregunta qué pasa con la caja:
   - Se retira: "Sale vacía", "Sale cargada: retornable" o "Sale cargada: racks".
   - Se queda en rampa: "Cargando retornable" o "Cargando racks". Cuando sale,
     se registra la salida con el mismo tipo (retornable o racks).
4. La salida cuenta para la productividad de cargas (cargadas retornable,
   cargadas racks, cargadas total y vacías).
Los avances solo van hacia adelante. Si un cambio salta pasos, las etapas
intermedias se registran como cumplidas automáticamente; no se pide motivo.


PANTALLAS
- Piso (pantalla de inicio):
  · Arriba: KPIs del turno o del historial completo, semáforo de lotes abiertos
    y productividad por turno.
  · Rampas arriba y bahías abajo, en columnas R743 a R755. Las posiciones 746A
    y 746B son bahías; no existen en rampas, así que su columna queda vacía.
  · Cada tarjeta tiene "▼ Más" para cambiar el estatus sin salir de Piso.
  · Cada bahía muestra máximo 5 cajas, las de más tiempo primero. Las demás se
    cuentan como "+N más" y están en Detalle de caja.
- Captura: arriba, "Registrar caja en bahía": bahía, caja/placa, pallets, unidad
  (Caja o Pallet), estatus inicial, fecha de descarga. Máximo 100 cajas abiertas
  por bahía; la pantalla muestra el responsable del estatus (Putaway solo en
  "Por ubicar"; lo demás es Recibo). Abajo, el formulario para repartir una caja
  en varias bahías. Tipo "Caja omitida" registra una caja que no se capturó a
  tiempo, sin motivo, marcada MANUAL.
- Detalle de caja: lista de cajas abiertas (rampas y bahías) con buscador.
  La columna "Cambiar a" actualiza el estatus al elegir el siguiente paso.
  Al tocar el nombre de la caja o buscar un folio se ve su historial completo.
- Productividad (v0.5.0): filtros Desde, Hasta, Turno y Encargado, con accesos
  rápidos Hoy, 7 días y 30 días.
  · Turno en curso: meta del turno, cajas descargadas hasta ahora y cajas que
    se esperaban a esta hora.
  · Cumplimiento del periodo y tarjetas KPI.
  · Cajas por hora: barras contra la línea de meta por hora.
  · Por turno (real contra meta), por encargado y por día. Cada día se marca
    como cumple, debajo de la meta, no laboral o sin meta.
  · La métrica es cajas descargadas (visitas que pasan a bahía).
- Reportes, Turno y Configuración como antes.
- Configuración (v0.5.0), además de rampas, bahías y usuarios:
  · Turnos: nombre, inicio, fin y meta (cajas por turno). Un turno puede cruzar
    medianoche. La app calcula la meta por hora de cada turno.
  · Calendario laboral: casillas de Lunes a Domingo para cada turno.
  · Días festivos / no laborables: fecha, turnos afectados (todos o algunos) y
    nota. En un día festivo el turno no tiene meta.
- Botón "◐ Tema azul / ◐ Tema blanco" (abajo a la derecha): cambia el tema de
  todo el programa. Inicia en azul y la elección se recuerda en este equipo.


ACCESO
- Se abre en "Iniciar sesión": número de empleado y contraseña. No se usa correo.
- Para crear una cuenta, desliza el control hacia "Registrarse" (o toca el texto).
  Cualquier persona del equipo puede registrarse; entra como capturista.
- Roles (v0.5.0):
  · Admin: todo, incluido usuarios, rampas, bahías, turnos, calendario y festivos.
  · Supervisor: captura y consulta; aparece en el catálogo de encargados.
  · Capturista: captura, y debe elegir un encargado de la lista de supervisores.
  Las cuentas antiguas con rol "operador" se leen como capturista.
- El administrador cambia perfiles, agrega usuarios y edita rampas, bahías y
  configuración en Configuración.


ENCARGADO (v0.5.0)
- Un capturista debe elegir su encargado en la barra superior antes de capturar
  o cambiar estatus. La lista sale de los usuarios dados de alta como supervisor.
- Si quien captura es un supervisor (o admin), el encargado es el mismo usuario.
- El encargado queda guardado en cada registro (descarga, recolección, salida),
  y es lo que usa la pestaña Productividad.


REGLAS DE TRABAJO
- Solo una ventana escribe a la vez. Otra ventana queda en SOLO LECTURA.
  Si la sesión anterior quedó abierta, "Intentar tomar escritura" pide confirmación.
- El flujo de estatus avanza en orden. Si saltas pasos, las etapas intermedias
  se registran como cumplidas automáticamente (quedan en el historial como
  "skipped"); no se pide motivo.
- Una caja validada en un turno y etiquetada en otro cuenta como procesada
  en el turno que la etiqueta.
- Una caja con varias bahías cuenta una sola vez en recolectadas.
- La caja omitida (captura manual) no pide motivo y queda marcada MANUAL en el historial.
- Una rampa atiende una caja abierta a la vez. Una caja abierta no puede estar en dos rampas.
- La llegada no puede ser futura.
- Una bahía admite máximo 100 cajas abiertas; la captura se bloquea al llegar a 100.


CARPETAS EXISTENTES (creadas con v0.3.x o v0.4.x)
- Su config.json conserva las bahías de entonces: no tienen 746A ni 746B.
  Para agregarlas: Configuración > Bahías, añade 746A y 746B, y guarda.
- Los turnos antiguos reciben meta 0 hasta que se capturen. Revisa Configuración >
  Turnos y Calendario laboral antes de usar la pestaña Productividad.
- Los eventos antiguos con "Listo para salida" siguen leyéndose en el historial.
  Esa opción ya no existe para nuevas cargas.


PRUEBAS AUTOMÁTICAS
  npm install
  npm test                 (reglas del motor: 45 pruebas)
  npm run test:e2e         (interfaz en Chrome real: 64 pruebas)

Para la prueba de interfaz, Chrome debe estar instalado. Si no está en la
ruta por defecto, indícala así en Windows (PowerShell):
  $env:CHROME_PATH="C:\Program Files\Google\Chrome\Application\chrome.exe"
  npm run test:e2e

La prueba de interfaz usa la misma lógica de archivos que la app pero con
el almacenamiento interno del navegador, porque el diálogo de elegir carpeta
requiere un clic humano. Ese paso va en la lista de prueba manual de abajo.


PRUEBA MANUAL OBLIGATORIA (una vez, en el equipo real)
[ ] Abrir index.html con doble clic y ver la pantalla de inicio.
[ ] "Elegir carpeta de trabajo" y seleccionar una carpeta vacía.
[ ] Crear administrador; iniciar sesión con número de empleado; ver badge ESCRITURA.
[ ] Registrar un capturista desde la pantalla de acceso y entrar con él.
[ ] Crear un supervisor en Configuración; con el capturista, verificar que aparece
    en la lista de encargados y que la captura queda con ese encargado.
[ ] Configuración > Turnos: poner metas, guardar y revisar Productividad.
[ ] Configuración > Calendario y Días festivos: desmarcar un día y agregar un festivo;
    verificar que ese día aparece como "no laboral" en Productividad.
[ ] Piso: asignar una caja a una rampa libre, pasarla a bahía y elegir
    "Se queda en rampa: Cargando racks"; después registrar su salida.
[ ] Cambiar el tema con el botón de abajo a la derecha (azul y blanco) y revisar
    que todas las pantallas cambian y que se conserva al recargar.
[ ] Cerrar el navegador por completo, volver a abrir, "Reconectar carpeta".
    Confirmar que el historial sigue ahí.
[ ] Abrir una segunda ventana con el mismo usuario: debe quedar en SOLO LECTURA.
[ ] Cerrar turno: verificar el archivo en respaldos/.
[ ] Exportar KPIs: verificar el CSV en exportes/ y que Excel lo abre con acentos bien.
[ ] Si el diálogo de carpeta no aparece o falla, avisar: habría que servir la
    carpeta desde un servidor local de escritorio, lo que cambia un poco el plan.


LIMITACIONES CONOCIDAS (v0.6.0)
- La contraseña es una barrera local. Quien tenga acceso a la carpeta puede
  leer el historial. Si se necesita cifrado, se agrega después.
- Un solo equipo. Dos equipos con la misma carpeta de red no están soportados.
- La exportación es CSV (Excel lo abre). No genera .xlsx.
- Los respaldos se hacen al cerrar turno, no automáticamente.
- Las pruebas no cubren el diálogo nativo de elegir carpeta.
- La prueba de interfaz no guarda un ciclo completo de Configuración (turnos,
  calendario, festivos) ni el registro de encargado con un supervisor real;
  eso se revisa en la lista manual.


DECISIONES TOMADAS EN ESTA VERSIÓN (confirmar o cambiar)
- Códigos: VIS-000001 remolque, DESC-000001 lote de bahía, REC-000001 recolección.
- Recolección: la fecha de registro define el turno. La fecha del hecho se guarda
  aparte para auditoría.
- KPIs:
    descargadas        visitas que pasan a bahía en el turno
    cargadas racks     salidas con racks
    cargadas retornable salidas con retornable
    cargadas           racks + retornable (productividad de cargas)
    vacías             salidas vacías
    recolectadas       registros de recolección (una caja = un registro)
    manuales           recolecciones con captura manual
    validadas          lotes que pasan a "Por etiquetar"
    procesadas         lotes que completan validación y etiquetado; cuenta en el turno que etiqueta
    ubicadas           lotes en "Ubicado total"
- Productividad (v0.5.0):
    métrica            cajas descargadas (visitas que pasan a bahía)
    meta por hora      meta del turno / horas del turno
    turno que cruza medianoche   sus horas se cuentan completas (ej. 22:30 a 07:00 = 8.5 h)
    día                fecha de inicio del turno
    estado del día     cumple (real ≥ meta), debajo, no laboral (no es día laboral
                       o es festivo para ese turno), sin meta (meta 0)
    encargado          el registrado en la captura; supervisor que captura = él mismo
- Turnos por defecto: Día 07:00–15:00, Tarde 15:00–22:30, Noche 22:30–07:00.
  Metas por defecto: 0 (se capturan en Configuración).
- Calendario por defecto: Lunes a Viernes Día, Tarde y Noche; Sábado Día y Tarde;
  Domingo sin turnos.
- Rampas por defecto: 743 a 754. Bahías por defecto: 743 a 755, con 746A y 746B.
- Horas de rampa: desde la hora de llegada capturada; si no se captura, desde el registro.
- Bloqueo: 10 minutos sin latido se considera sesión vencida.
- Acceso: 5 intentos fallidos pausan la cuenta 10 minutos.
- Identidad: el número de empleado identifica la cuenta; el nombre solo se muestra.
- Registro abierto: cualquiera en el equipo puede crear una cuenta de capturista
  (el administrador puede cambiar perfiles o agregar usuarios). Si quieres que el
  administrador apruebe cada alta, se cambia.
- Tema: azul por defecto; el botón cambia a blanco para todo el programa.


CAMBIOS DE v0.6.0
- Captura: nuevos apartados Facturas y Notas debajo de la tarjeta de recolección
  (la tarjeta no cambió).
- Facturas: índice general compartido por todos los usuarios. Enter en el campo
  Agregar registra la factura y el cursor queda listo para la siguiente.
  Si la factura ya existe, avisa quién la registró y agrega otra fila.
  La X quita la fila de la lista; el evento queda en el historial.
- Notas: un comentario por factura, con su propio buscador. El botón Limpiar
  notas borra solo el texto de las notas visibles; las facturas se conservan.


CAMBIOS DE v0.5.2
- Piso: al quitar una rampa o bahía, las columnas restantes se recorren a la
  izquierda; no queda hueco.
- Piso se adapta al tamaño de la ventana (minimizar, maximizar o cambiar tamaño en
  Edge). Cada columna mide al menos 66 px; si la ventana es más chica que eso,
  aparece barra horizontal para ver el resto.
- En ventanas medianas (1001 a 1299 px) el menú se colapsa a iconos.


CAMBIOS DE v0.5.1
- Piso: todas las rampas y bahías caben en la pantalla sin desplazar a los lados
  en ventanas de 1360 px o más. Tarjetas más compactas.
