/**
 * Página de opciones.
 *
 * Además de guardar la configuración, esta página hace dos cosas que solo se
 * pueden hacer desde una página visible de la extensión:
 *
 *   pedir el micrófono   Chrome exige un gesto en una página real; concedido una
 *                        vez, el documento offscreen ya puede usarlo siempre.
 *   pedir permisos de host  para motores en URLs que no vienen en el manifiesto
 *                        (un Whisper local, un proveedor propio) y para el panel
 *                        del Agente de Discovery.
 */

import { CONFIG_POR_DEFECTO, leerConfig, guardarConfig } from "../nucleo/config.js";
import { listarMotores, motorPorId } from "../nucleo/motores/registro.js";
import {
  guardarSesionPanel,
  leerSesionPanel,
  desvincular,
} from "../nucleo/destinos/discovery.js";

const el = (id) => document.getElementById(id);

/** Campos que son casillas de verificación y no cajas de texto. */
const CASILLAS = ["mostrarIndicador", "avisarEnChat", "cancelarEco", "conservarAudio"];
/** Campos numéricos. */
const NUMEROS = ["minutosPorTrozo", "umbralSilencio"];

// --- Formulario ---

/** Escribe la configuración en el formulario. */
function pintar(config) {
  for (const clave of Object.keys(CONFIG_POR_DEFECTO)) {
    const campo = el(clave);
    if (!campo) continue;
    if (CASILLAS.includes(clave)) campo.checked = Boolean(config[clave]);
    else campo.value = config[clave] ?? "";
  }
  ajustarSegunMotor();
  ajustarSegunDestino();
}

/** Lee el formulario y devuelve la configuración a guardar. */
function leerFormulario() {
  const parcial = {};
  for (const clave of Object.keys(CONFIG_POR_DEFECTO)) {
    const campo = el(clave);
    if (!campo) continue;
    if (CASILLAS.includes(clave)) parcial[clave] = campo.checked;
    else if (NUMEROS.includes(clave)) parcial[clave] = Number(campo.value);
    else parcial[clave] = campo.value.trim();
  }
  return parcial;
}

/** Muestra u oculta los campos del motor según lo que ese motor necesite. */
function ajustarSegunMotor() {
  const motor = motorPorId(el("motor").value);
  el("ayuda-motor").textContent = motor.ayuda;
  el("campo-llave").classList.toggle("oculto", !motor.necesitaLlave && !motor.necesitaBaseUrl);
  el("campo-base-url").classList.toggle("oculto", !motor.necesitaBaseUrl);
  el("motorModelo").placeholder = motor.modeloPorDefecto;
}

/** Muestra los campos del Agente de Discovery solo si es el destino elegido. */
function ajustarSegunDestino() {
  el("bloque-discovery").classList.toggle("oculto", el("destino").value !== "discovery");
}

// --- Permisos ---

/**
 * Pide el micrófono desde esta página.
 *
 * El flujo se corta aquí a propósito: una vez concedido a la extensión, el
 * documento offscreen lo hereda y no necesita volver a preguntar.
 */
async function pedirMicrofono() {
  try {
    const flujo = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const t of flujo.getTracks()) t.stop(); // solo se quería el permiso
    el("estado-micro").textContent = "Micrófono concedido.";
    el("estado-micro").classList.remove("alerta");
  } catch (e) {
    el("estado-micro").textContent = `Sin micrófono: ${e.message}`;
    el("estado-micro").classList.add("alerta");
  }
}

/**
 * Pide permiso de host para una URL, si no lo hay ya.
 *
 * Args:
 *   url: URL de la que se necesita el origen
 * Returns:
 *   concedido: verdadero si la extensión puede llamar a ese origen
 */
async function asegurarPermisoDeHost(url) {
  let origen;
  try {
    origen = `${new URL(url).origin}/*`;
  } catch {
    throw new Error(`La URL no es válida: ${url}`);
  }
  return asegurarPermisos([origen]);
}

/**
 * Pide una lista de patrones de origen, si no están concedidos.
 *
 * Sin esto una extensión queda sujeta a las reglas normales de CORS y la API del
 * proveedor rechaza la llamada. Con el permiso concedido, el documento offscreen
 * puede hablar directo con el motor y el audio no necesita pasar por ningún
 * servidor intermedio.
 *
 * Args:
 *   origenes: patrones de host, por ejemplo ["https://api.deepgram.com/*"]
 * Returns:
 *   concedido: verdadero si ya están todos
 */
async function asegurarPermisos(origenes) {
  if (origenes.length === 0) return true;
  if (await chrome.permissions.contains({ origins: origenes })) return true;
  return chrome.permissions.request({ origins: origenes });
}

// --- Vínculo con el panel del Agente de Discovery ---

/**
 * Ruta de la página del panel que entrega la configuración de la integración.
 */
const RUTA_ENLACE = "/panel/escriba";

/**
 * Vincula Escriba con el panel.
 *
 * El único dato que hay que teclear es la URL del panel. Todo lo demás lo entrega
 * el propio panel en su página de enlace: la URL del backend, la de Supabase y su
 * llave pública. Antes había que copiar cinco campos de infraestructura a mano, que
 * es justo lo que un consultor no tiene por qué saber.
 *
 * De ahí se sacan dos cosas en una sola visita:
 *
 *   la configuración  de un bloque JSON que la página publica en el DOM
 *   la sesión         del almacenamiento local, la misma que usa el panel
 *
 * El token heredado le da a la extensión exactamente los permisos del usuario en
 * el panel, con el aislamiento entre agencias resuelto por las mismas políticas
 * RLS. No se crea ninguna credencial nueva.
 */
async function vincular() {
  const config = await leerConfig();
  if (!config.discoveryPanelUrl) throw new Error("Escribe primero la URL del panel.");

  if (!(await asegurarPermisoDeHost(config.discoveryPanelUrl))) {
    throw new Error("Sin permiso para el origen del panel no se puede vincular.");
  }

  const url = new URL(RUTA_ENLACE, config.discoveryPanelUrl).href;
  const pestana = await chrome.tabs.create({ url, active: true });
  await esperarCarga(pestana.id);

  const [resultado] = await chrome.scripting.executeScript({
    target: { tabId: pestana.id },
    func: leerEnlaceDeLaPagina,
  });
  const { config: delPanel, sesion } = resultado?.result ?? {};

  if (!sesion) {
    throw new Error(
      "No se encontró una sesión en el panel. Inicia sesión ahí con tu enlace mágico y vuelve a intentarlo.",
    );
  }
  if (!delPanel?.supabaseUrl || !delPanel?.supabaseAnonKey) {
    throw new Error(
      `La página ${RUTA_ENLACE} no publicó la configuración. Revisa que el panel esté actualizado.`,
    );
  }

  // Los otros dos orígenes se piden ahora que ya se sabe cuáles son.
  for (const u of [delPanel.backendUrl, delPanel.supabaseUrl]) {
    if (u && !(await asegurarPermisoDeHost(u))) {
      throw new Error("Sin permiso para ese origen la entrega no podría completarse.");
    }
  }

  await guardarConfig({
    discoveryBackendUrl: delPanel.backendUrl ?? "",
    discoverySupabaseUrl: delPanel.supabaseUrl,
    discoverySupabaseAnonKey: delPanel.supabaseAnonKey,
  });
  await guardarSesionPanel(sesion);
  await registrarMarcaEnPanel(config.discoveryPanelUrl);

  pintar(await leerConfig());
  await pintarVinculo();
}

/**
 * Se ejecuta dentro de la página del panel para leer configuración y sesión.
 *
 * Corre en el contexto de la pestaña, no en el de la extensión, así que no puede
 * usar nada de fuera de su propio cuerpo.
 *
 * Dos detalles que explican la forma:
 *
 * - La configuración se lee de un `<script type="application/json">`, no de una
 *   variable de JavaScript. Un script inyectado corre en un mundo aislado y no ve
 *   las variables de la página, pero sí ve el DOM.
 * - La sesión se lee de `localStorage`, que sí es compartido entre mundos porque
 *   pertenece al origen. La librería de Supabase la guarda bajo una clave con la
 *   forma `sb-<referencia del proyecto>-auth-token`.
 *
 * Returns:
 *   enlace: { config, sesion }, cada uno posiblemente nulo
 */
function leerEnlaceDeLaPagina() {
  let config = null;
  try {
    const bloque = document.getElementById("escriba-config");
    if (bloque) config = JSON.parse(bloque.textContent);
  } catch {
    /* bloque ausente o malformado */
  }

  let sesion = null;
  for (let i = 0; i < localStorage.length; i += 1) {
    const clave = localStorage.key(i);
    if (!/^sb-.*-auth-token$/.test(clave ?? "")) continue;
    try {
      const datos = JSON.parse(localStorage.getItem(clave));
      const s = datos?.currentSession ?? datos;
      if (!s?.access_token) continue;
      sesion = {
        access_token: s.access_token,
        refresh_token: s.refresh_token ?? null,
        expires_at: s.expires_at ?? null,
        email: s.user?.email ?? null,
      };
      break;
    } catch {
      /* clave con otra forma, se sigue buscando */
    }
  }

  return { config, sesion };
}

/**
 * Registra un script de contenido permanente en el origen del panel.
 *
 * Su único trabajo es dejar una marca en el DOM para que el panel pueda decir
 * "Escriba está instalado" en vez de mostrar instrucciones a ciegas. Se registra
 * de forma dinámica porque la URL del panel la elige cada agencia y no puede
 * estar en el manifiesto.
 *
 * Args:
 *   panelUrl: URL del panel ya autorizada
 */
async function registrarMarcaEnPanel(panelUrl) {
  const patron = `${new URL(panelUrl).origin}/*`;
  const ID = "marca-en-panel";
  try {
    // Registrar dos veces lanza, así que primero se quita el registro anterior.
    await chrome.scripting.unregisterContentScripts({ ids: [ID] }).catch(() => {});
    await chrome.scripting.registerContentScripts([
      {
        id: ID,
        matches: [patron],
        js: ["contenido/marca_panel.js"],
        runAt: "document_idle",
        persistAcrossSessions: true,
      },
    ]);
  } catch (e) {
    // La marca es una cortesía para la interfaz del panel: si no se puede
    // registrar, la vinculación sigue siendo válida.
    console.warn("[escriba] no se pudo registrar la marca en el panel:", e);
  }
}

/** Espera a que una pestaña termine de cargar. */
function esperarCarga(tabId) {
  return new Promise((resolve) => {
    const alCambiar = (id, info) => {
      if (id === tabId && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(alCambiar);
        // Margen para que la aplicación arranque y deje la sesión escrita.
        setTimeout(resolve, 1200);
      }
    };
    chrome.tabs.onUpdated.addListener(alCambiar);
  });
}

/** Muestra si hay vínculo y con qué cuenta. */
async function pintarVinculo() {
  const sesion = await leerSesionPanel();
  const destino = el("estado-vinculo");
  if (!sesion) {
    destino.textContent = "Sin vincular.";
    destino.classList.add("alerta");
    return;
  }
  const expira = sesion.expires_at ? new Date(sesion.expires_at * 1000) : null;
  destino.textContent =
    `Vinculado${sesion.email ? ` como ${sesion.email}` : ""}` +
    (expira ? `. El token se renueva solo (vence ${expira.toLocaleString("es-CO")}).` : ".");
  destino.classList.remove("alerta");
}

// --- Guardado ---

/** Guarda la configuración y confirma en pantalla. */
async function guardar() {
  const parcial = leerFormulario();
  const motor = motorPorId(parcial.motor);

  // El motor solo puede responder si la extensión tiene permiso para llamar a su
  // origen: el fijo que declare el motor, o el que salga de la URL base.
  const concedido = motor.necesitaBaseUrl
    ? !parcial.motorBaseUrl || (await asegurarPermisoDeHost(parcial.motorBaseUrl))
    : await asegurarPermisos(motor.origenes ?? []);

  if (!concedido) {
    el("estado-guardado").textContent =
      "Sin permiso para el origen del motor, la transcripción no podrá salir. Los ajustes no se guardaron.";
    el("estado-guardado").classList.add("alerta");
    return;
  }

  await guardarConfig(parcial);
  el("estado-guardado").textContent = "Ajustes guardados.";
  el("estado-guardado").classList.remove("alerta");
  setTimeout(() => (el("estado-guardado").textContent = ""), 2500);
}

/** Envuelve una acción y muestra su error en la barra de guardado. */
function conError(fn) {
  return async () => {
    try {
      await fn();
    } catch (e) {
      el("estado-guardado").textContent = e.message;
      el("estado-guardado").classList.add("alerta");
    }
  };
}

// --- Arranque ---

document.addEventListener("DOMContentLoaded", async () => {
  for (const motor of listarMotores()) {
    el("motor").appendChild(new Option(motor.etiqueta, motor.id));
  }

  pintar(await leerConfig());
  await pintarVinculo();

  el("motor").addEventListener("change", ajustarSegunMotor);
  el("destino").addEventListener("change", ajustarSegunDestino);
  el("guardar").addEventListener("click", conError(guardar));
  el("permiso-micro").addEventListener("click", conError(pedirMicrofono));
  el("vincular").addEventListener("click", conError(vincular));
  el("desvincular").addEventListener(
    "click",
    conError(async () => {
      await desvincular();
      await pintarVinculo();
    }),
  );
});
