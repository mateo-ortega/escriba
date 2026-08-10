/**
 * Formatos de salida de una transcripción.
 *
 * El formato canónico es texto trazable: una línea por intervención, con
 * timestamp y hablante al frente.
 *
 *     [00:04:12] Diana Restrepo: el 30% de los pacientes no aparece a la cita.
 *
 * No es una elección estética. Ese es exactamente el patrón que el pipeline del
 * Agente de Discovery reconoce para quedarse con hablante y timestamp como
 * locator, y el locator es lo que permite que un hallazgo cite su evidencia con
 * minuto y nombre en vez de resumir sin fuente. La misma línea sirve leída por
 * una persona y parseada por una máquina.
 *
 * WebVTT se ofrece para interoperar con reproductores y otras herramientas.
 *
 * Módulo puro: sin APIs de Chrome, para poder probarlo con Node.
 */

/**
 * Formatea milisegundos como HH:MM:SS.
 *
 * Args:
 *   ms: milisegundos desde el inicio de la llamada
 * Returns:
 *   texto: la marca de tiempo con dos dígitos por campo
 */
export function comoReloj(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const dd = (n) => String(n).padStart(2, "0");
  return `${dd(h)}:${dd(m)}:${dd(s)}`;
}

/**
 * Formatea milisegundos como HH:MM:SS.mmm (lo que exige WebVTT).
 */
function comoRelojVtt(ms) {
  const milis = String(Math.max(0, Math.floor(ms)) % 1000).padStart(3, "0");
  return `${comoReloj(ms)}.${milis}`;
}

/**
 * Produce el texto trazable de una transcripción.
 *
 * El encabezado va antes de la primera marca de tiempo a propósito: el parser
 * del pipeline trata esas líneas como encabezado y no las confunde con
 * intervenciones.
 *
 * Args:
 *   intervenciones: [{inicioMs, hablante, texto}]
 *   meta: { titulo, fecha, plataforma, participantes, motor, modelo, duracionMs }
 * Returns:
 *   texto: la transcripción completa lista para guardar como .txt
 */
export function aTextoTrazable(intervenciones, meta = {}) {
  const lineas = [];

  if (meta.titulo) lineas.push(meta.titulo);
  if (meta.fecha) lineas.push(`Fecha: ${meta.fecha}`);
  if (meta.plataforma) lineas.push(`Plataforma: ${meta.plataforma}`);
  if (typeof meta.duracionMs === "number") {
    lineas.push(`Duración: ${comoReloj(meta.duracionMs)}`);
  }
  if (meta.participantes?.length) {
    lineas.push(`Participantes: ${meta.participantes.join(", ")}`);
  }
  if (meta.motor) {
    lineas.push(`Transcrito por Escriba con ${meta.motor}${meta.modelo ? ` (${meta.modelo})` : ""}`);
  }
  if (lineas.length > 0) lineas.push("");

  for (const i of intervenciones) {
    // El texto se aplana a una línea: un salto interno partiría la intervención
    // en dos al reingresarla y la segunda mitad perdería su locator.
    const texto = i.texto.replace(/\s*\n+\s*/g, " ").trim();
    lineas.push(`[${comoReloj(i.inicioMs)}] ${i.hablante}: ${texto}`);
  }

  return `${lineas.join("\n")}\n`;
}

/**
 * Produce WebVTT, para reproductores y herramientas de subtítulos.
 *
 * Args:
 *   intervenciones: [{inicioMs, finMs, hablante, texto}]
 * Returns:
 *   texto: contenido de un archivo .vtt
 */
export function aVtt(intervenciones) {
  const bloques = ["WEBVTT", ""];
  intervenciones.forEach((i, n) => {
    bloques.push(String(n + 1));
    bloques.push(`${comoRelojVtt(i.inicioMs)} --> ${comoRelojVtt(i.finMs)}`);
    bloques.push(`<v ${i.hablante}>${i.texto.replace(/\s*\n+\s*/g, " ").trim()}`);
    bloques.push("");
  });
  return `${bloques.join("\n")}\n`;
}

/**
 * Nombre de archivo estable para una sesión.
 *
 * Args:
 *   meta: { titulo, fecha }
 *   extension: sin punto, por ejemplo "txt"
 * Returns:
 *   nombre: nombre de archivo sin rutas ni caracteres problemáticos
 */
export function nombreArchivo(meta, extension) {
  const base = `${meta.fecha ?? "sin-fecha"}_${meta.titulo ?? "llamada"}`
    .normalize("NFD")
    // Se quitan los diacríticos separados por NFD, solo en el nombre de archivo.
    // El contenido conserva sus tildes intactas.
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `${base || "llamada"}.${extension}`;
}
