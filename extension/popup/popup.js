/**
 * Popup: la única superficie que se toca durante una llamada.
 *
 * Regla de diseño: un clic para grabar, un clic para detener, y nada más
 * obligatorio. Todo lo demás (motor, llaves, destino) vive en la página de
 * opciones y se configura una sola vez.
 */

import { descargar } from "../nucleo/destinos/descarga.js";
import { leerTranscripcion, guardarTranscripcion, leerSesion } from "../nucleo/almacen.js";
import { renombrarHablante } from "../nucleo/hablantes.js";
import { aTextoTrazable, comoReloj } from "../nucleo/formatos.js";
import { listarProyectos } from "../nucleo/destinos/discovery.js";
import { motorPorId } from "../nucleo/motores/registro.js";

const el = (id) => document.getElementById(id);

/** Última respuesta del service worker, para no pedirla dos veces. */
let vista = null;
/** Pestaña activa cuando se abrió el popup. */
let tabActiva = null;
/** Cronómetro de la grabación en curso. */
let tic = null;

// --- Comunicación con el service worker ---

/**
 * Manda un mensaje al service worker.
 *
 * Args:
 *   mensaje: { tipo, ... }
 * Returns:
 *   datos: la respuesta, o lanza con el error que reportó
 */
async function alSw(mensaje) {
  const r = await chrome.runtime.sendMessage({ destino: "sw", ...mensaje });
  if (!r?.ok) throw new Error(r?.error ?? "El coordinador no respondió.");
  return r;
}

// --- Pintado ---

/** Pide el estado y repinta todo. */
async function refrescar() {
  vista = await alSw({ tipo: "estado", tabId: tabActiva?.id });
  pintar();
}

function pintar() {
  const { estado, config, contexto, sesiones } = vista;

  const motor = motorPorId(config.motor);
  el("motor-actual").textContent = motor.etiqueta.toLowerCase();

  const enLlamada = Boolean(contexto);
  const grabando = estado.fase === "grabando";
  const trabajando = estado.fase === "transcribiendo";

  // Estado
  const fases = {
    inactivo: "Sin grabar",
    grabando: "Grabando",
    transcribiendo: "Transcribiendo",
    listo: "Listo",
    error: "Con error",
  };
  el("fase").textContent = fases[estado.fase] ?? estado.fase;
  el("punto").className = `punto${grabando ? " activo" : estado.fase === "listo" ? " listo" : ""}`;

  el("llamada").textContent = grabando
    ? (contexto?.titulo ?? "Llamada en curso")
    : (contexto?.titulo ?? "");

  if (trabajando && estado.progreso?.total) {
    el("detalle").textContent = `Trozo ${estado.progreso.hechos} de ${estado.progreso.total}.`;
  } else if (!enLlamada && !grabando && !trabajando) {
    el("detalle").textContent = "Abre una llamada de Google Meet o Zoom web para empezar.";
  } else if (estado.aviso && grabando) {
    el("detalle").textContent = estado.aviso;
  } else {
    el("detalle").textContent = "";
  }

  // Cronómetro
  clearInterval(tic);
  if (grabando && estado.inicioMs) {
    const pintarTiempo = () => {
      el("cronometro").textContent = comoReloj(Date.now() - estado.inicioMs);
    };
    pintarTiempo();
    tic = setInterval(pintarTiempo, 1000);
  } else {
    el("cronometro").textContent = "";
  }

  // Acción principal
  el("grabar").classList.toggle("oculto", grabando);
  el("detener").classList.toggle("oculto", !grabando);
  el("grabar").disabled = !enLlamada || trabajando;
  el("grabar").textContent = trabajando ? "Transcribiendo..." : "Grabar y transcribir";

  // Proyecto de destino
  const pideProyecto = config.destino === "discovery" && !grabando && !trabajando;
  el("bloque-proyecto").classList.toggle("oculto", !pideProyecto);
  if (pideProyecto && el("proyecto").options.length === 0) cargarProyectos(config);

  // Resultado
  const listo = estado.fase === "listo" && estado.resultado;
  el("bloque-resultado").classList.toggle("oculto", !listo);
  if (listo) {
    el("resumen").textContent =
      `${estado.resultado.resumen}. ${estado.resultado.enviadoA ? "Enviado al proyecto de discovery" : `Archivo ${estado.resultado.archivo}`}.`;
    cargarHablantes(estado.sesionId, Boolean(estado.resultado.enviadoA));
  }

  // Error
  el("bloque-error").classList.toggle("oculto", estado.fase !== "error");
  el("error").textContent = estado.error ?? "";

  // Historial
  const previas = (sesiones ?? []).filter((s) => s.id !== estado.sesionId).slice(0, 4);
  el("bloque-sesiones").classList.toggle("oculto", previas.length === 0);
  pintarSesiones(previas);
}

/**
 * Pinta la lista de llamadas anteriores con su acción de descarga.
 *
 * Args:
 *   sesiones: metadatos de sesiones previas
 */
function pintarSesiones(sesiones) {
  const lista = el("sesiones");
  lista.textContent = "";
  for (const s of sesiones) {
    const li = document.createElement("li");

    const nombre = document.createElement("span");
    nombre.className = "nombre";
    nombre.textContent = s.titulo ?? "Llamada";
    li.appendChild(nombre);

    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = s.fecha ?? "";
    li.appendChild(meta);

    const boton = document.createElement("button");
    const conTranscripcion = s.estado === "listo";
    boton.textContent = conTranscripcion ? "Bajar" : "Reintentar";
    boton.addEventListener("click", () =>
      conTranscripcion ? bajar(s.id, "txt") : conError(() => alSw({ tipo: "reprocesar", sesionId: s.id })),
    );
    li.appendChild(boton);

    lista.appendChild(li);
  }
}

/**
 * Llena el selector de proyectos del Agente de Discovery.
 *
 * Si el vínculo con el panel no está, se dice aquí en vez de fallar al grabar.
 */
async function cargarProyectos(config) {
  const selector = el("proyecto");
  selector.textContent = "";
  try {
    const proyectos = await listarProyectos(config);
    if (proyectos.length === 0) {
      selector.appendChild(new Option("No hay proyectos: créalos en el panel", ""));
      return;
    }
    for (const p of proyectos) {
      selector.appendChild(new Option(p.cliente ?? p.slug, p.id));
    }
  } catch (e) {
    selector.appendChild(new Option(e.message, ""));
  }
}

/**
 * Llena el selector de hablantes de la última transcripción.
 *
 * Args:
 *   sesionId: sesión terminada
 *   yaEnviada: si la transcripción ya entró a un proyecto de discovery
 */
async function cargarHablantes(sesionId, yaEnviada) {
  const t = await leerTranscripcion(sesionId);
  const selector = el("hablante-viejo");
  selector.textContent = "";
  if (!t) {
    el("bloque-renombrar").classList.add("oculto");
    return;
  }
  el("bloque-renombrar").classList.remove("oculto");
  for (const nombre of [...new Set(t.intervenciones.map((i) => i.hablante))]) {
    selector.appendChild(new Option(nombre, nombre));
  }

  // Advertencia honesta: el backend de discovery identifica las fuentes por el
  // hash de su contenido, así que una transcripción renombrada entraría como una
  // fuente nueva en vez de corregir la anterior, y la llamada quedaría contada
  // dos veces en el análisis.
  el("nota-renombrar").textContent = yaEnviada
    ? "Esta llamada ya entró al proyecto. Renombrar solo cambia el archivo que bajes: para corregirla en discovery, borra la fuente en el panel y vuelve a enviarla."
    : "Útil cuando la otra parte quedó como un hablante genérico.";
}

// --- Acciones ---

/**
 * Ejecuta una acción y muestra el error en el propio popup si falla.
 *
 * Args:
 *   fn: función asíncrona
 */
async function conError(fn) {
  try {
    await fn();
    await refrescar();
  } catch (e) {
    el("bloque-error").classList.remove("oculto");
    el("error").textContent = e.message;
  }
}

/**
 * Descarga la transcripción de una sesión.
 *
 * Args:
 *   sesionId: sesión a descargar
 *   formato: "txt" o "vtt"
 */
async function bajar(sesionId, formato) {
  const t = await leerTranscripcion(sesionId);
  if (!t) throw new Error("Esa llamada no tiene transcripción guardada.");
  const sesion = await leerSesion(sesionId);
  await descargar(t.intervenciones, t.meta ?? { titulo: sesion?.titulo, fecha: sesion?.fecha }, formato);
}

/** Aplica el renombrado de hablante sobre la transcripción guardada. */
async function aplicarRenombrado() {
  const sesionId = vista.estado.sesionId;
  const anterior = el("hablante-viejo").value;
  const nuevo = el("nombre-nuevo").value.trim();
  if (!nuevo) throw new Error("Escribe el nombre real.");

  const t = await leerTranscripcion(sesionId);
  if (!t) throw new Error("Esa llamada no tiene transcripción guardada.");

  const intervenciones = renombrarHablante(t.intervenciones, anterior, nuevo);
  await guardarTranscripcion(sesionId, {
    ...t,
    intervenciones,
    texto: aTextoTrazable(intervenciones, t.meta ?? {}),
  });
  el("nombre-nuevo").value = "";
  await descargar(intervenciones, t.meta ?? {}, "txt");
}

// --- Arranque ---

document.addEventListener("DOMContentLoaded", async () => {
  [tabActiva] = await chrome.tabs.query({ active: true, currentWindow: true });

  el("grabar").addEventListener("click", () =>
    conError(() =>
      alSw({ tipo: "iniciar", tabId: tabActiva.id, proyectoId: el("proyecto").value || null }),
    ),
  );
  el("detener").addEventListener("click", () => conError(() => alSw({ tipo: "detener" })));
  el("reintentar").addEventListener("click", () =>
    conError(() => alSw({ tipo: "reprocesar", sesionId: vista.estado.sesionId })),
  );
  el("bajar-txt").addEventListener("click", () => conError(() => bajar(vista.estado.sesionId, "txt")));
  el("bajar-vtt").addEventListener("click", () => conError(() => bajar(vista.estado.sesionId, "vtt")));
  el("renombrar").addEventListener("click", () => conError(aplicarRenombrado));
  el("abrir-opciones").addEventListener("click", (ev) => {
    ev.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  // El service worker avisa cuando cambia de fase, así el popup no hace sondeo.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.destino === "interfaz" && msg.tipo === "estado") refrescar();
  });

  await refrescar();
});
