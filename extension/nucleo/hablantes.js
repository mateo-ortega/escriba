/**
 * Atribución de hablantes: de segmentos sueltos a intervenciones con nombre.
 *
 * La atribución no se adivina con diarización, se sabe por construcción. La
 * captura graba dos pistas separadas y de ahí sale la división que de verdad
 * importa en una llamada de discovery:
 *
 *   pista "mic"  ->  tú, quien conduce la llamada
 *   pista "tab"  ->  la otra parte
 *
 * Sobre eso se pone el nombre propio cuando se puede. En Google Meet, si los
 * subtítulos están encendidos, el script de contenido produce una línea de
 * tiempo de quién habló y cuándo. Cruzando esa línea con los segmentos de la
 * pista de la pestaña se obtiene el nombre real de cada interlocutor. El audio
 * da el texto bueno; los subtítulos dan los nombres.
 *
 * Si no hay subtítulos, la otra parte queda como un solo hablante genérico, que
 * se puede renombrar antes de exportar.
 *
 * Módulo puro: sin APIs de Chrome, para poder probarlo con Node.
 */

/** Hueco máximo, en milisegundos, que se fusiona dentro de una intervención. */
const MS_FUSION = 2000;
/** Nombre de la otra parte cuando no hay subtítulos que la identifiquen. */
export const HABLANTE_OTRO = "Cliente";

/**
 * Construye las intervenciones finales de una llamada.
 *
 * Args:
 *   segmentos: [{inicioMs, finMs, texto, pista}] en tiempo absoluto de la sesión
 *   subtitulos: [{inicioMs, finMs, nombre}] línea de tiempo de quién habla
 *   opciones: { nombreConsultor, nombreOtro }
 * Returns:
 *   intervenciones: [{inicioMs, finMs, hablante, texto}] ordenadas y fusionadas
 */
export function construirIntervenciones(segmentos, subtitulos, opciones = {}) {
  const nombreConsultor = normalizarHablante(opciones.nombreConsultor || "Consultor");
  const nombreOtro = normalizarHablante(opciones.nombreOtro || HABLANTE_OTRO);

  const conHablante = segmentos
    .filter((s) => s.texto && s.texto.trim().length > 0)
    .map((s) => ({
      inicioMs: s.inicioMs,
      finMs: s.finMs,
      texto: s.texto.trim(),
      hablante:
        s.pista === "mic"
          ? nombreConsultor
          : nombrePorSolapamiento(s, subtitulos) ?? nombreOtro,
    }))
    .sort((a, b) => a.inicioMs - b.inicioMs);

  return fusionar(conHablante);
}

/**
 * Busca el nombre del subtítulo que más se solapa con un segmento.
 *
 * Args:
 *   segmento: {inicioMs, finMs}
 *   subtitulos: [{inicioMs, finMs, nombre}]
 * Returns:
 *   nombre: el nombre con mayor solapamiento, o null si no hay ninguno
 */
export function nombrePorSolapamiento(segmento, subtitulos) {
  if (!subtitulos || subtitulos.length === 0) return null;

  const acumulado = new Map();
  for (const sub of subtitulos) {
    const solape =
      Math.min(segmento.finMs, sub.finMs) - Math.max(segmento.inicioMs, sub.inicioMs);
    if (solape <= 0) continue;
    acumulado.set(sub.nombre, (acumulado.get(sub.nombre) ?? 0) + solape);
  }
  if (acumulado.size === 0) return null;

  let mejor = null;
  let mayor = 0;
  for (const [nombre, ms] of acumulado) {
    if (ms > mayor) {
      mayor = ms;
      mejor = nombre;
    }
  }
  return normalizarHablante(mejor);
}

/**
 * Fusiona segmentos consecutivos del mismo hablante en una sola intervención.
 *
 * Es lo que hace legible la transcripción: una línea por turno de habla y no una
 * por frase suelta.
 *
 * Args:
 *   segmentos: [{inicioMs, finMs, hablante, texto}] ya ordenados
 * Returns:
 *   intervenciones: la misma forma, con menos elementos
 */
function fusionar(segmentos) {
  const salida = [];
  for (const s of segmentos) {
    const previa = salida[salida.length - 1];
    if (previa && previa.hablante === s.hablante && s.inicioMs - previa.finMs <= MS_FUSION) {
      previa.texto += ` ${s.texto}`;
      previa.finMs = Math.max(previa.finMs, s.finMs);
    } else {
      salida.push({ ...s });
    }
  }
  return salida;
}

/**
 * Deja un nombre de hablante en forma segura.
 *
 * Dos puntos y saltos de línea se eliminan y el largo se recorta a 60
 * caracteres. No es cosmético: el formato de texto trazable usa
 * `[HH:MM:SS] Hablante: texto`, y un nombre con dos puntos o demasiado largo
 * rompería el parseo de la línea al reingresarla.
 *
 * Args:
 *   nombre: nombre crudo, posiblemente sucio
 * Returns:
 *   nombre: nombre saneado y no vacío
 */
export function normalizarHablante(nombre) {
  const limpio = String(nombre ?? "")
    .replace(/[:\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60)
    .trim();
  return limpio.length > 0 ? limpio : HABLANTE_OTRO;
}

/**
 * Renombra un hablante en una lista de intervenciones.
 *
 * Sirve para el caso corriente: la llamada quedó como "Cliente" y quieres
 * ponerle el nombre real antes de exportarla.
 *
 * Args:
 *   intervenciones: lista de intervenciones
 *   anterior: nombre a reemplazar
 *   nuevo: nombre nuevo
 * Returns:
 *   intervenciones: lista nueva, ya refusionada
 */
export function renombrarHablante(intervenciones, anterior, nuevo) {
  const destino = normalizarHablante(nuevo);
  return fusionar(
    intervenciones.map((i) => (i.hablante === anterior ? { ...i, hablante: destino } : { ...i })),
  );
}
