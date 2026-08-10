/**
 * Script de contenido para Google Meet.
 *
 * Hace tres cosas:
 *
 * 1. Informa el contexto de la llamada: título, código de reunión y quiénes
 *    están, para que la transcripción no se llame "grabación sin nombre".
 *
 * 2. Lee los subtítulos en vivo y arma una línea de tiempo de quién habla y
 *    cuándo. Ese es el único lugar del navegador donde Meet regala los nombres
 *    propios de los participantes hablando. El audio da el texto bueno, los
 *    subtítulos dan los nombres, y `nucleo/hablantes.js` cruza las dos cosas.
 *
 * 3. Muestra un indicador mientras graba y, si se configuró, escribe el aviso en
 *    el chat.
 *
 * Aviso honesto sobre el punto 2: leer los subtítulos depende del DOM de Meet, y
 * Google lo cambia sin avisar. Por eso todo aquí falla en blando. Si el lector de
 * subtítulos deja de encontrar el contenedor, la transcripción sigue saliendo
 * completa; lo único que se pierde es el nombre propio de cada interlocutor, que
 * queda como un hablante genérico renombrable. Nada de esto es indispensable, y
 * los selectores están en una sola lista para poder actualizarlos rápido.
 */

/** Cada cuánto se manda el lote de subtítulos acumulados. */
const MS_ENVIO = 5000;
/** Silencio tras el cual una línea de subtítulo se considera cerrada. */
const MS_CIERRE = 1500;
/** Largo máximo de un texto para considerarlo un nombre y no una frase. */
const MAX_NOMBRE = 60;

/**
 * Candidatos de contenedor de subtítulos, del más específico al más genérico.
 *
 * Cuando Meet cambie su DOM, lo más probable es que baste con agregar una línea
 * aquí. El último candidato es una heurística que no depende de nombres de clase.
 */
const SELECTORES_SUBTITULOS = [
  'div[jsname="dsyhDe"]',
  "div.a4cQT",
  'div[role="region"][aria-live="polite"]',
  '[aria-live="polite"]',
];

let grabando = false;
let inicioMs = 0;
let observador = null;
let indicador = null;
/** Líneas de subtítulo abiertas, indexadas por su elemento en el DOM. */
const abiertas = new Map();
/** Líneas cerradas pendientes de enviar. */
let pendientes = [];

// --- Contexto de la llamada ---

/**
 * Arma el contexto de la reunión.
 *
 * Returns:
 *   contexto: { plataforma, titulo, codigo, participantes }
 */
function contexto() {
  const codigo = location.pathname.replace(/^\/+/, "").split("?")[0] || null;
  // El título de la pestaña de Meet es "Meet - Nombre de la reunión". Si no hay
  // nombre, el propio código sirve de identificador.
  const limpio = document.title.replace(/^Meet\s*[-|·]\s*/i, "").trim();
  return {
    plataforma: "Google Meet",
    titulo: limpio && limpio.toLowerCase() !== "meet" ? limpio : `Meet ${codigo ?? ""}`.trim(),
    codigo,
    participantes: participantes(),
  };
}

/**
 * Intenta leer los nombres de los participantes.
 *
 * Best effort: solo funciona si el panel de personas estuvo abierto alguna vez.
 * Cuando no hay nada, devuelve una lista vacía y no pasa nada.
 *
 * Returns:
 *   nombres: lista de nombres sin repetir
 */
function participantes() {
  const nombres = new Set();
  for (const el of document.querySelectorAll("[data-participant-id][data-self-name], [data-self-name]")) {
    const n = el.getAttribute("data-self-name")?.trim();
    if (n) nombres.add(n);
  }
  return [...nombres].slice(0, 20);
}

// --- Lectura de subtítulos ---

/** Arranca el observador de subtítulos. */
function observarSubtitulos() {
  const contenedor = SELECTORES_SUBTITULOS.map((s) => document.querySelector(s)).find(Boolean);
  if (!contenedor) {
    // Los subtítulos pueden encenderse a mitad de la llamada, así que se vuelve
    // a intentar en vez de rendirse.
    setTimeout(() => grabando && observarSubtitulos(), 4000);
    return;
  }
  if (observador) observador.disconnect();
  observador = new MutationObserver(() => leerFilas(contenedor));
  observador.observe(contenedor, { childList: true, subtree: true, characterData: true });
  leerFilas(contenedor);
}

/**
 * Recorre las filas visibles de subtítulos y actualiza las líneas abiertas.
 *
 * Args:
 *   contenedor: elemento raíz de los subtítulos
 */
function leerFilas(contenedor) {
  if (!grabando) return;
  const ahora = Date.now() - inicioMs;

  for (const fila of contenedor.children) {
    const leida = leerFila(fila);
    if (!leida) continue;

    const previa = abiertas.get(fila);
    if (!previa) {
      abiertas.set(fila, { ...leida, inicioMs: ahora, ultimoCambioMs: ahora });
    } else if (leida.texto !== previa.texto || leida.nombre !== previa.nombre) {
      previa.texto = leida.texto;
      previa.nombre = leida.nombre || previa.nombre;
      previa.ultimoCambioMs = ahora;
    }
  }

  cerrarQuietas(ahora);
}

/**
 * Extrae nombre y texto de una fila de subtítulo.
 *
 * No se apoya en nombres de clase: dentro de la fila, el texto más corto que
 * parezca una etiqueta es el nombre y el más largo es lo que se dijo. Esa
 * relación sobrevive a los rediseños de Meet mucho mejor que un selector.
 *
 * Args:
 *   fila: elemento de una intervención subtitulada
 * Returns:
 *   leida: { nombre, texto } o null si la fila no tiene texto útil
 */
function leerFila(fila) {
  const textos = [];
  for (const el of fila.querySelectorAll("*")) {
    if (el.children.length > 0) continue; // solo hojas, para no contar dos veces
    const t = el.textContent?.trim();
    if (t) textos.push(t);
  }
  if (textos.length === 0) {
    const t = fila.textContent?.trim();
    return t ? { nombre: "", texto: t } : null;
  }

  const dicho = textos.reduce((a, b) => (b.length > a.length ? b : a));
  const nombre =
    textos.find((t) => t !== dicho && t.length <= MAX_NOMBRE && !/[.?!]$/.test(t)) ?? "";
  return { nombre, texto: dicho };
}

/**
 * Cierra las líneas que llevan un rato sin cambiar y las pone en la cola.
 *
 * Args:
 *   ahora: milisegundos desde el inicio de la grabación
 */
function cerrarQuietas(ahora) {
  for (const [fila, linea] of abiertas) {
    const desconectada = !fila.isConnected;
    if (!desconectada && ahora - linea.ultimoCambioMs < MS_CIERRE) continue;
    if (linea.nombre && linea.texto) {
      pendientes.push({
        nombre: linea.nombre,
        texto: linea.texto,
        inicioMs: linea.inicioMs,
        finMs: linea.ultimoCambioMs,
      });
    }
    abiertas.delete(fila);
  }
}

/** Manda el lote acumulado al service worker y limpia la cola. */
function enviarLote() {
  if (!grabando) return;
  cerrarQuietas(Date.now() - inicioMs);
  if (pendientes.length === 0) return;
  const lote = pendientes;
  pendientes = [];
  chrome.runtime.sendMessage({ destino: "sw", tipo: "subtitulos", lote }).catch(() => {});
}

// --- Indicador y aviso ---

/** Pinta el indicador de grabación en la propia pestaña. */
function mostrarIndicador() {
  if (indicador) return;
  indicador = document.createElement("div");
  indicador.className = "escriba-indicador";
  indicador.innerHTML =
    '<span class="escriba-punto"></span><span>Escriba está transcribiendo</span>';
  document.documentElement.appendChild(indicador);
}

/** Quita el indicador. */
function ocultarIndicador() {
  indicador?.remove();
  indicador = null;
}

/**
 * Escribe el aviso en el chat de Meet.
 *
 * Best effort deliberado: si Meet cambió el chat y no se encuentra el campo, se
 * devuelve falso y el popup lo dice, para que el aviso se pueda dar de viva voz.
 *
 * Args:
 *   texto: el aviso a enviar
 * Returns:
 *   enviado: verdadero si se pudo escribir en el chat
 */
function avisarEnChat(texto) {
  const campo = document.querySelector('textarea[aria-label*="ensaje" i], textarea[jsname="YPqjbf"]');
  if (!campo) return false;
  campo.focus();
  campo.value = texto;
  campo.dispatchEvent(new Event("input", { bubbles: true }));
  campo.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }),
  );
  return true;
}

// --- Mensajes ---

chrome.runtime.onMessage.addListener((msg, _remitente, responder) => {
  if (msg?.destino !== "contenido") return false;

  switch (msg.tipo) {
    case "contexto":
      responder({ contexto: contexto() });
      return false;

    case "grabando":
      grabando = true;
      inicioMs = Date.now();
      abiertas.clear();
      pendientes = [];
      observarSubtitulos();
      if (msg.config?.mostrarIndicador) mostrarIndicador();
      if (msg.config?.avisarEnChat) avisarEnChat(msg.config.textoAviso);
      responder({ ok: true });
      return false;

    case "detenido":
      enviarLote();
      grabando = false;
      observador?.disconnect();
      observador = null;
      ocultarIndicador();
      responder({ ok: true });
      return false;

    default:
      return false;
  }
});

setInterval(enviarLote, MS_ENVIO);

// Si la pestaña se cierra o se recarga en mitad de la llamada, se manda lo que
// haya en la cola: son los nombres de los últimos minutos.
window.addEventListener("pagehide", enviarLote);
