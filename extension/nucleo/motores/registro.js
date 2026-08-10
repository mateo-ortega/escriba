/**
 * Registro de motores de transcripción.
 *
 * Agregar un motor es agregar un módulo y una línea en este registro: nada del
 * resto de la extensión sabe qué proveedor se está usando. Cada motor recibe un
 * trozo de audio y devuelve segmentos con tiempos, siempre con la misma forma.
 *
 * Contrato de un motor:
 *
 *   id            identificador estable, el que se guarda en la configuración
 *   etiqueta      nombre visible en la interfaz
 *   necesitaLlave si hace falta una llave de API
 *   necesitaBaseUrl si hace falta una URL de servidor
 *   modeloPorDefecto
 *   ayuda         una línea que explica cuándo elegirlo
 *   transcribir(blob, opciones) -> Promise<{ segmentos, modelo }>
 *
 * Donde `opciones` es { llave, baseUrl, modelo, idioma } y cada segmento es
 * { inicio, fin, texto } en segundos relativos al inicio del trozo.
 */

import { deepgram } from "./deepgram.js";
import { openaiCompatible } from "./openai_compatible.js";

export const MOTORES = {
  [deepgram.id]: deepgram,
  [openaiCompatible.id]: openaiCompatible,
};

/**
 * Devuelve un motor por su id.
 *
 * Args:
 *   id: identificador del motor
 * Returns:
 *   motor: el módulo del motor
 */
export function motorPorId(id) {
  const motor = MOTORES[id];
  if (!motor) throw new Error(`Motor de transcripción desconocido: ${id}`);
  return motor;
}

/** Lista de motores para pintar la interfaz. */
export function listarMotores() {
  return Object.values(MOTORES);
}
