/**
 * Configuración de Escriba: valores por defecto, lectura y escritura.
 *
 * Todo vive en `chrome.storage.local`, en la máquina de quien usa la extensión.
 * Ninguna llave de motor sale de ahí salvo hacia el propio proveedor elegido.
 */

/** Clave única bajo la que se guarda la configuración completa. */
const CLAVE = "config";

/**
 * Configuración por defecto. Cada campo se documenta porque la página de
 * opciones se deriva de esta forma.
 */
export const CONFIG_POR_DEFECTO = {
  // --- Identidad de quien graba ---
  // Nombre con el que se etiqueta la pista del micrófono en la transcripción.
  nombreConsultor: "Consultor",

  // --- Motor de transcripción ---
  motor: "deepgram", // id en nucleo/motores/registro.js
  motorLlave: "", // llave de API del proveedor elegido
  motorBaseUrl: "", // solo para motores compatibles con OpenAI (Groq, local, etc.)
  motorModelo: "", // vacío = el modelo por defecto del motor
  idioma: "es",

  // --- Captura ---
  // Duración de cada trozo de audio. Trozos independientes dan resiliencia
  // (si el navegador muere no se pierde la llamada) y mantienen cada petición
  // al motor por debajo de los límites de tamaño de los proveedores.
  minutosPorTrozo: 5,
  // Umbral de energía por debajo del cual un trozo se considera silencio y no
  // se manda a transcribir. Ahorra la mayor parte del costo de grabar dos
  // pistas, porque cada interlocutor calla mientras el otro habla.
  umbralSilencio: 0.004,
  cancelarEco: true, // recomendado si no usas audífonos
  conservarAudio: false, // si es falso, el audio se borra al terminar la transcripción

  // --- Aviso a los participantes ---
  mostrarIndicador: true, // marca visible en tu propia pestaña mientras graba
  avisarEnChat: false, // escribe un aviso en el chat de Meet al iniciar
  textoAviso: "Aviso: estoy tomando notas con transcripción automática de esta llamada.",

  // --- Destino de la transcripción ---
  destino: "descarga", // descarga | discovery
  // Solo para el destino "discovery" (integración con el Agente de Discovery).
  discoveryBackendUrl: "",
  discoveryPanelUrl: "",
  discoverySupabaseUrl: "",
  discoverySupabaseAnonKey: "",
};

/**
 * Lee la configuración completa, rellenando con los valores por defecto los
 * campos que aún no existan.
 *
 * Returns:
 *   config: objeto con la forma de CONFIG_POR_DEFECTO
 */
export async function leerConfig() {
  const guardado = await chrome.storage.local.get(CLAVE);
  return { ...CONFIG_POR_DEFECTO, ...(guardado[CLAVE] ?? {}) };
}

/**
 * Guarda un subconjunto de campos de configuración.
 *
 * Args:
 *   parcial: objeto con los campos a sobrescribir
 * Returns:
 *   config: la configuración completa resultante
 */
export async function guardarConfig(parcial) {
  const actual = await leerConfig();
  const nueva = { ...actual, ...parcial };
  await chrome.storage.local.set({ [CLAVE]: nueva });
  return nueva;
}
