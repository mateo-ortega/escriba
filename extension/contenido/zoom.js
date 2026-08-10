/**
 * Script de contenido para el cliente web de Zoom.
 *
 * Mucho más corto que el de Meet a propósito. En Zoom web la captura de audio
 * funciona igual de bien, pero no hay una fuente fiable de nombres por
 * intervención: los subtítulos en vivo dependen de que el anfitrión los active y
 * su DOM no expone la atribución de forma estable.
 *
 * Así que aquí solo se aporta contexto e indicador, y la transcripción queda con
 * la división que siempre está garantizada por la forma de capturar: tú por un
 * lado y la otra parte por el otro. El nombre real se puede poner después desde
 * el popup.
 */

let indicador = null;

/**
 * Arma el contexto de la reunión.
 *
 * Returns:
 *   contexto: { plataforma, titulo, codigo, participantes }
 */
function contexto() {
  const codigo = location.pathname.match(/\/wc\/(\d+)/)?.[1] ?? null;
  const limpio = document.title.replace(/\s*[-|]\s*Zoom.*$/i, "").trim();
  return {
    plataforma: "Zoom",
    titulo: limpio || `Zoom ${codigo ?? ""}`.trim(),
    codigo,
    participantes: [],
  };
}

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

chrome.runtime.onMessage.addListener((msg, _remitente, responder) => {
  if (msg?.destino !== "contenido") return false;

  switch (msg.tipo) {
    case "contexto":
      responder({ contexto: contexto() });
      return false;
    case "grabando":
      if (msg.config?.mostrarIndicador) mostrarIndicador();
      responder({ ok: true });
      return false;
    case "detenido":
      ocultarIndicador();
      responder({ ok: true });
      return false;
    default:
      return false;
  }
});
