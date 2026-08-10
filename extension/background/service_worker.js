/**
 * Service worker: coordinador de Escriba.
 *
 * Reparto de responsabilidades:
 *
 *   service worker (este archivo)  decide y guarda el estado
 *   documento offscreen            captura, transcribe y entrega
 *   scripts de contenido           leen la llamada (título, subtítulos, aviso)
 *   popup y opciones               interfaz
 *
 * Un service worker de MV3 se apaga cuando queda inactivo y se vuelve a arrancar
 * con la memoria en blanco. Por eso el estado de la sesión no vive en variables
 * de este archivo sino en `chrome.storage.local`: si Chrome apaga el worker en
 * mitad de una llamada, al despertar sigue sabiendo qué estaba haciendo. El
 * documento offscreen, en cambio, sí sobrevive a la llamada completa.
 */

import { leerConfig } from "../nucleo/config.js";
import { guardarSesion, listarSesiones, leerSesion } from "../nucleo/almacen.js";

const CLAVE_ESTADO = "estadoActual";
const RUTA_OFFSCREEN = "offscreen/offscreen.html";

/** Estado en reposo. */
const ESTADO_INACTIVO = { fase: "inactivo", sesionId: null, tabId: null };

// --- Estado compartido ---

/** Lee el estado actual de la extensión. */
async function leerEstado() {
  const g = await chrome.storage.local.get(CLAVE_ESTADO);
  return g[CLAVE_ESTADO] ?? ESTADO_INACTIVO;
}

/**
 * Escribe el estado y refleja la fase en el icono de la extensión.
 *
 * Args:
 *   parcial: campos a fusionar sobre el estado actual
 * Returns:
 *   estado: el estado resultante
 */
async function escribirEstado(parcial) {
  const estado = { ...(await leerEstado()), ...parcial };
  await chrome.storage.local.set({ [CLAVE_ESTADO]: estado });
  await pintarBadge(estado);
  // El popup y las opciones escuchan para repintarse sin preguntar.
  chrome.runtime.sendMessage({ destino: "interfaz", tipo: "estado", estado }).catch(() => {});
  return estado;
}

/** Refleja la fase en el icono: un punto rojo mientras graba. */
async function pintarBadge(estado) {
  const texto =
    estado.fase === "grabando" ? "REC" : estado.fase === "transcribiendo" ? "..." : "";
  await chrome.action.setBadgeText({ text: texto });
  await chrome.action.setBadgeBackgroundColor({ color: "#B3564D" });
}

// --- Documento offscreen ---

/** Crea el documento offscreen si no existe todavía. */
async function asegurarOffscreen() {
  const contextos = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
  });
  if (contextos.length > 0) return;
  await chrome.offscreen.createDocument({
    url: RUTA_OFFSCREEN,
    // USER_MEDIA para capturar; AUDIO_PLAYBACK porque el documento devuelve el
    // audio de la pestaña a los parlantes y eso lo mantiene vivo toda la llamada.
    reasons: ["USER_MEDIA", "AUDIO_PLAYBACK"],
    justification: "Capturar y transcribir el audio de la videollamada.",
  });
}

/** Cierra el documento offscreen si está abierto. */
async function cerrarOffscreen() {
  const contextos = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
  });
  if (contextos.length > 0) await chrome.offscreen.closeDocument();
}

/** Manda un mensaje al documento offscreen y devuelve su respuesta. */
async function aOffscreen(mensaje) {
  const r = await chrome.runtime.sendMessage({ destino: "offscreen", ...mensaje });
  if (!r?.ok) throw new Error(r?.error ?? "El documento offscreen no respondió.");
  return r;
}

// --- Contexto de la llamada y subtítulos ---

/**
 * Pregunta al script de contenido por el contexto de la llamada.
 *
 * Se pregunta en el momento en vez de guardarlo: el worker pierde la memoria
 * cada vez que Chrome lo apaga, y un título en caché puede ser de otra reunión.
 *
 * Args:
 *   tabId: pestaña de la videollamada
 * Returns:
 *   contexto: { plataforma, titulo, codigo, participantes } o null si la pestaña
 *     no tiene script de contenido (no es Meet ni Zoom)
 */
async function pedirContexto(tabId) {
  if (!tabId) return null;
  try {
    const r = await chrome.tabs.sendMessage(tabId, { destino: "contenido", tipo: "contexto" });
    return r?.contexto ?? null;
  } catch {
    return null; // pestaña sin script de contenido
  }
}

/** Clave de almacenamiento de los subtítulos de una sesión. */
const claveSubtitulos = (sesionId) => `subtitulos_${sesionId}`;

/**
 * Acumula un lote de subtítulos de la sesión en curso.
 *
 * Args:
 *   sesionId: sesión a la que pertenecen
 *   lote: [{inicioMs, finMs, nombre, texto}]
 */
async function acumularSubtitulos(sesionId, lote) {
  const clave = claveSubtitulos(sesionId);
  const g = await chrome.storage.local.get(clave);
  const previos = g[clave] ?? [];
  await chrome.storage.local.set({ [clave]: [...previos, ...lote] });
}

/** Lee los subtítulos acumulados de una sesión. */
async function leerSubtitulos(sesionId) {
  const clave = claveSubtitulos(sesionId);
  const g = await chrome.storage.local.get(clave);
  return g[clave] ?? [];
}

// --- Ciclo de una sesión ---

/**
 * Arranca la grabación de la llamada abierta en una pestaña.
 *
 * Args:
 *   tabId: pestaña de la videollamada
 *   proyectoId: proyecto de destino, solo si el destino es "discovery"
 * Returns:
 *   estado: el estado tras arrancar
 */
async function iniciar(tabId, proyectoId) {
  const estado = await leerEstado();
  if (estado.fase === "grabando") throw new Error("Ya hay una grabación en curso.");

  const config = await leerConfig();
  if (config.destino === "discovery" && !proyectoId) {
    throw new Error("Elige el proyecto de discovery al que va esta llamada.");
  }

  const contexto = (await pedirContexto(tabId)) ?? {};
  const sesionId = `s${Date.now()}`;

  // El id de flujo se pide antes de crear el documento offscreen porque depende
  // del gesto del usuario que abrió el popup.
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });

  await asegurarOffscreen();
  const { aviso, pistas } = await aOffscreen({
    tipo: "iniciar",
    streamId,
    sesionId,
    config,
  });

  await guardarSesion({
    id: sesionId,
    titulo: contexto.titulo ?? "Llamada",
    plataforma: contexto.plataforma ?? "desconocida",
    codigo: contexto.codigo ?? null,
    participantes: contexto.participantes ?? [],
    fecha: new Date().toISOString().slice(0, 10),
    inicioIso: new Date().toISOString(),
    proyectoId: proyectoId ?? null,
    destino: config.destino,
    estado: "grabando",
  });

  avisarPestana(tabId, { tipo: "grabando", sesionId, config });

  return escribirEstado({
    fase: "grabando",
    sesionId,
    tabId,
    inicioMs: Date.now(),
    pistas,
    aviso: aviso ?? null,
    error: null,
    resultado: null,
    progreso: null,
  });
}

/**
 * Detiene la grabación y lanza la transcripción y la entrega.
 *
 * Returns:
 *   estado: el estado al terminar el ciclo
 */
async function detener() {
  const estado = await leerEstado();
  if (estado.fase !== "grabando") throw new Error("No hay ninguna grabación en curso.");

  const { duracionMs } = await aOffscreen({ tipo: "detener" });
  if (estado.tabId) avisarPestana(estado.tabId, { tipo: "detenido" });

  const sesion = await guardarSesion({
    id: estado.sesionId,
    duracionMs,
    estado: "transcribiendo",
  });
  await escribirEstado({ fase: "transcribiendo", progreso: { hechos: 0, total: 0 } });

  return procesar(sesion);
}

/**
 * Transcribe una sesión y la entrega a su destino.
 *
 * Se separa de `detener` porque también es el camino de reintento: si falló la
 * transcripción o la entrega, se vuelve a llamar sin regrabar nada.
 *
 * Args:
 *   sesion: metadatos de la sesión
 * Returns:
 *   estado: el estado al terminar
 */
async function procesar(sesion) {
  const config = await leerConfig();
  try {
    await asegurarOffscreen();
    const { resultado } = await aOffscreen({
      tipo: "procesar",
      sesionId: sesion.id,
      config,
      sesion,
      subtitulos: await leerSubtitulos(sesion.id),
    });

    await guardarSesion({ id: sesion.id, estado: "listo", ...resultado });
    await chrome.storage.local.remove(claveSubtitulos(sesion.id));
    await cerrarOffscreen();
    await notificar("Transcripción lista", resultado.resumen ?? sesion.titulo);
    return escribirEstado({ fase: "listo", resultado, progreso: null });
  } catch (e) {
    console.error("[escriba] procesar", e);
    await guardarSesion({ id: sesion.id, estado: "error", error: String(e?.message ?? e) });
    await cerrarOffscreen();
    await notificar("La transcripción falló", String(e?.message ?? e));
    return escribirEstado({ fase: "error", error: String(e?.message ?? e), progreso: null });
  }
}

/** Muestra un aviso del sistema, si el permiso está disponible. */
async function notificar(titulo, mensaje) {
  // Las notificaciones son un extra: si el permiso no está, no pasa nada.
  if (!chrome.notifications) return;
  try {
    await chrome.notifications.create({
      type: "basic",
      iconUrl: chrome.runtime.getURL("iconos/icono-128.png"),
      title: titulo,
      message: mensaje,
    });
  } catch {
    /* sin notificaciones */
  }
}

/** Manda un mensaje al script de contenido de una pestaña, sin romper si no está. */
function avisarPestana(tabId, mensaje) {
  chrome.tabs.sendMessage(tabId, { destino: "contenido", ...mensaje }).catch(() => {});
}

// --- Protocolo de mensajes ---

chrome.runtime.onMessage.addListener((msg, _remitente, responder) => {
  if (msg?.destino !== "sw") return false;
  manejar(msg)
    .then((datos) => responder({ ok: true, ...datos }))
    .catch((e) => {
      console.error("[escriba] sw", msg?.tipo, e);
      responder({ ok: false, error: String(e?.message ?? e) });
    });
  return true; // respuesta asíncrona
});

async function manejar(msg) {
  switch (msg.tipo) {
    case "estado": {
      const estado = await leerEstado();
      const tabId = msg.tabId ?? estado.tabId ?? null;
      return {
        estado,
        config: await leerConfig(),
        contexto: await pedirContexto(tabId),
        sesiones: await listarSesiones(),
      };
    }

    case "iniciar":
      return { estado: await iniciar(msg.tabId, msg.proyectoId) };

    case "detener":
      return { estado: await detener() };

    case "reprocesar": {
      const sesion = await leerSesion(msg.sesionId);
      if (!sesion) throw new Error("Esa sesión ya no existe.");
      await escribirEstado({ fase: "transcribiendo", sesionId: sesion.id, error: null });
      return { estado: await procesar(sesion) };
    }

    case "descartarEstado":
      return { estado: await escribirEstado({ ...ESTADO_INACTIVO, resultado: null, error: null }) };

    // --- Desde los scripts de contenido ---

    case "subtitulos": {
      const estado = await leerEstado();
      if (estado.fase === "grabando" && estado.sesionId) {
        await acumularSubtitulos(estado.sesionId, msg.lote);
      }
      return {};
    }

    // --- Desde el documento offscreen ---

    case "progreso":
      return { estado: await escribirEstado({ progreso: { hechos: msg.hechos, total: msg.total } }) };

    default:
      throw new Error(`Mensaje desconocido: ${msg.tipo}`);
  }
}

// Si se cierra la pestaña de la llamada mientras se graba, se cierra la sesión
// en vez de dejar una grabación huérfana capturando silencio.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const estado = await leerEstado();
  if (estado.fase === "grabando" && estado.tabId === tabId) {
    await detener().catch((e) => console.error("[escriba] cierre de pestaña", e));
  }
});

// Al instalar o actualizar se limpia cualquier estado a medias de la versión
// anterior: el documento offscreen no sobrevive a una recarga de la extensión.
chrome.runtime.onInstalled.addListener(async () => {
  const estado = await leerEstado();
  if (estado.fase === "grabando" || estado.fase === "transcribiendo") {
    await escribirEstado({
      ...ESTADO_INACTIVO,
      error: "La extensión se recargó y la grabación en curso se interrumpió.",
    });
  }
});
