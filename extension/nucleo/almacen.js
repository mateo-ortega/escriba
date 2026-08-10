/**
 * Almacenamiento de sesiones: índice en chrome.storage.local, audio y
 * transcripciones en IndexedDB.
 *
 * Por qué dos sitios: `chrome.storage.local` es cómodo y lo leen a la vez el
 * service worker, el popup y las opciones, pero no guarda Blobs. IndexedDB sí,
 * y con `unlimitedStorage` aguanta llamadas largas. Los trozos de audio se
 * escriben en cuanto llegan, así una caída del navegador no se lleva la llamada.
 */

const BD = "escriba";
const VERSION_BD = 1;
const ALM_TROZOS = "trozos";
const ALM_TRANSCRIPCIONES = "transcripciones";
const CLAVE_SESIONES = "sesiones";

/** @returns {Promise<IDBDatabase>} */
function abrir() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(BD, VERSION_BD);
    req.onupgradeneeded = () => {
      const bd = req.result;
      if (!bd.objectStoreNames.contains(ALM_TROZOS)) {
        // Clave compuesta: un trozo se identifica por sesión, pista e índice.
        const alm = bd.createObjectStore(ALM_TROZOS, { keyPath: ["sesionId", "pista", "indice"] });
        alm.createIndex("porSesion", "sesionId");
      }
      if (!bd.objectStoreNames.contains(ALM_TRANSCRIPCIONES)) {
        bd.createObjectStore(ALM_TRANSCRIPCIONES, { keyPath: "sesionId" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Envuelve una transacción de IndexedDB en una promesa. */
function transaccion(bd, almacenes, modo, fn) {
  return new Promise((resolve, reject) => {
    const tx = bd.transaction(almacenes, modo);
    const resultado = fn(tx);
    tx.oncomplete = () => resolve(resultado?.__valor ?? resultado);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/** Convierte una petición de IndexedDB en promesa. */
function pedir(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// --- Trozos de audio ---

/**
 * Guarda un trozo de audio.
 *
 * Args:
 *   trozo: { sesionId, pista, indice, inicioMs, finMs, silencioso, blob }
 */
export async function guardarTrozo(trozo) {
  const bd = await abrir();
  await transaccion(bd, [ALM_TROZOS], "readwrite", (tx) => {
    tx.objectStore(ALM_TROZOS).put(trozo);
  });
  bd.close();
}

/**
 * Devuelve los trozos de una sesión ordenados por tiempo de inicio.
 *
 * Args:
 *   sesionId: identificador de la sesión
 * Returns:
 *   trozos: lista de trozos con su blob
 */
export async function trozosDeSesion(sesionId) {
  const bd = await abrir();
  const tx = bd.transaction([ALM_TROZOS], "readonly");
  const indice = tx.objectStore(ALM_TROZOS).index("porSesion");
  const trozos = await pedir(indice.getAll(sesionId));
  bd.close();
  return trozos.sort((a, b) => a.inicioMs - b.inicioMs || a.pista.localeCompare(b.pista));
}

/**
 * Borra el audio de una sesión. Se llama al terminar si `conservarAudio` es
 * falso: la transcripción se queda, el audio no.
 */
export async function borrarAudioDeSesion(sesionId) {
  const trozos = await trozosDeSesion(sesionId);
  const bd = await abrir();
  await transaccion(bd, [ALM_TROZOS], "readwrite", (tx) => {
    const alm = tx.objectStore(ALM_TROZOS);
    for (const t of trozos) alm.delete([t.sesionId, t.pista, t.indice]);
  });
  bd.close();
}

// --- Transcripciones ---

/**
 * Guarda la transcripción de una sesión.
 *
 * Args:
 *   sesionId: identificador de la sesión
 *   transcripcion: { intervenciones, texto, motor, modelo }
 */
export async function guardarTranscripcion(sesionId, transcripcion) {
  const bd = await abrir();
  await transaccion(bd, [ALM_TRANSCRIPCIONES], "readwrite", (tx) => {
    tx.objectStore(ALM_TRANSCRIPCIONES).put({ sesionId, ...transcripcion });
  });
  bd.close();
}

/** Lee la transcripción de una sesión, o null si aún no existe. */
export async function leerTranscripcion(sesionId) {
  const bd = await abrir();
  const tx = bd.transaction([ALM_TRANSCRIPCIONES], "readonly");
  const t = await pedir(tx.objectStore(ALM_TRANSCRIPCIONES).get(sesionId));
  bd.close();
  return t ?? null;
}

// --- Índice de sesiones (metadatos livianos) ---

/**
 * Devuelve el índice de sesiones, de la más reciente a la más antigua.
 *
 * Returns:
 *   sesiones: lista de metadatos de sesión, sin audio ni texto
 */
export async function listarSesiones() {
  const g = await chrome.storage.local.get(CLAVE_SESIONES);
  return g[CLAVE_SESIONES] ?? [];
}

/**
 * Crea o actualiza una sesión en el índice.
 *
 * Args:
 *   sesion: metadatos con al menos `id`
 * Returns:
 *   sesion: la sesión resultante ya fusionada
 */
export async function guardarSesion(sesion) {
  const sesiones = await listarSesiones();
  const i = sesiones.findIndex((s) => s.id === sesion.id);
  const fusionada = i >= 0 ? { ...sesiones[i], ...sesion } : sesion;
  if (i >= 0) sesiones[i] = fusionada;
  else sesiones.unshift(fusionada);
  // Se conservan las 50 más recientes; los metadatos son diminutos, pero el
  // índice no debe crecer sin techo.
  await chrome.storage.local.set({ [CLAVE_SESIONES]: sesiones.slice(0, 50) });
  return fusionada;
}

/** Lee una sesión del índice, o null. */
export async function leerSesion(sesionId) {
  const sesiones = await listarSesiones();
  return sesiones.find((s) => s.id === sesionId) ?? null;
}

/** Borra una sesión: su entrada del índice, su audio y su transcripción. */
export async function borrarSesion(sesionId) {
  const sesiones = await listarSesiones();
  await chrome.storage.local.set({
    [CLAVE_SESIONES]: sesiones.filter((s) => s.id !== sesionId),
  });
  await borrarAudioDeSesion(sesionId);
  const bd = await abrir();
  await transaccion(bd, [ALM_TRANSCRIPCIONES], "readwrite", (tx) => {
    tx.objectStore(ALM_TRANSCRIPCIONES).delete(sesionId);
  });
  bd.close();
}
