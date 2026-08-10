/**
 * Marca de presencia en el panel del Agente de Discovery.
 *
 * Deja constancia en el DOM de que Escriba está instalado y vinculado, para que la
 * página de enlace del panel pueda decirlo en vez de mostrar instrucciones a
 * ciegas. Es el único canal por el que el panel puede saberlo: una página web no
 * tiene forma de preguntar si cierta extensión existe.
 *
 * No lee nada de la página ni manda nada a ningún sitio: escribe dos atributos y
 * termina. Se registra de forma dinámica al vincular (ver `opciones/opciones.js`),
 * porque la URL del panel la elige cada agencia y no puede estar en el manifiesto.
 */

const { version } = chrome.runtime.getManifest();

document.documentElement.dataset.escriba = version;
document.documentElement.dataset.escribaId = chrome.runtime.id;

// El panel es una aplicación de una sola página: si React reemplaza el árbol o se
// navega entre rutas, la marca se vuelve a poner.
new MutationObserver(() => {
  if (document.documentElement.dataset.escriba !== version) {
    document.documentElement.dataset.escriba = version;
    document.documentElement.dataset.escribaId = chrome.runtime.id;
  }
}).observe(document.documentElement, { attributes: true, attributeFilter: ["data-escriba"] });
