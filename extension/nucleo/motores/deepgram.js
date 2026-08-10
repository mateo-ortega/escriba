/**
 * Motor Deepgram.
 *
 * Se elige cuando importa la calidad del español y los tiempos precisos por
 * palabra. Cobra por minuto de audio; el orden de magnitud es unas décimas de
 * dólar por hora y pista.
 *
 * El modelo por defecto es `nova-2` porque su soporte de español está
 * consolidado. Si quieres probar otro (`nova-3`, por ejemplo), es un campo de
 * configuración, no un cambio de código.
 */

const PUNTO = "https://api.deepgram.com/v1/listen";

export const deepgram = {
  id: "deepgram",
  etiqueta: "Deepgram",
  necesitaLlave: true,
  necesitaBaseUrl: false,
  // Origen que hay que poder llamar. No se declara en el manifiesto para no
  // pedir de entrada acceso a proveedores que quizá no uses: se solicita al
  // elegir este motor en los ajustes.
  origenes: ["https://api.deepgram.com/*"],
  modeloPorDefecto: "nova-2",
  ayuda: "Mejor calidad en español y tiempos finos por palabra. Se paga por minuto.",

  /**
   * Transcribe un trozo de audio.
   *
   * Args:
   *   blob: audio WebM/Opus de una sola pista
   *   opciones: { llave, modelo, idioma }
   * Returns:
   *   resultado: { segmentos: [{inicio, fin, texto}], modelo }
   */
  async transcribir(blob, { llave, modelo, idioma }) {
    const usado = modelo || deepgram.modeloPorDefecto;
    const params = new URLSearchParams({
      model: usado,
      language: idioma,
      smart_format: "true",
      punctuate: "true",
      paragraphs: "true",
    });

    const res = await fetch(`${PUNTO}?${params}`, {
      method: "POST",
      headers: { Authorization: `Token ${llave}`, "Content-Type": blob.type || "audio/webm" },
      body: blob,
    });
    if (!res.ok) {
      throw new Error(`Deepgram respondió ${res.status}: ${await res.text()}`);
    }
    const datos = await res.json();
    return { segmentos: extraerSegmentos(datos), modelo: usado };
  },
};

/**
 * Convierte la respuesta de Deepgram en segmentos.
 *
 * Se prefieren las frases de `paragraphs` porque ya vienen cortadas por sentido.
 * Si el modelo no las devuelve, se reagrupan las palabras en frases cortas.
 *
 * Args:
 *   datos: cuerpo JSON de la respuesta
 * Returns:
 *   segmentos: [{inicio, fin, texto}] en segundos
 */
function extraerSegmentos(datos) {
  const alt = datos?.results?.channels?.[0]?.alternatives?.[0];
  if (!alt) return [];

  const parrafos = alt.paragraphs?.paragraphs;
  if (Array.isArray(parrafos) && parrafos.length > 0) {
    const segmentos = [];
    for (const p of parrafos) {
      for (const f of p.sentences ?? []) {
        segmentos.push({ inicio: f.start, fin: f.end, texto: f.text.trim() });
      }
    }
    if (segmentos.length > 0) return segmentos;
  }

  return agruparPalabras(alt.words ?? []);
}

/**
 * Agrupa palabras en segmentos, cortando en pausas largas o al acumular
 * suficiente texto.
 *
 * Args:
 *   palabras: [{word, punctuated_word, start, end}]
 * Returns:
 *   segmentos: [{inicio, fin, texto}]
 */
function agruparPalabras(palabras) {
  const MAX_PAUSA = 0.8; // segundos de silencio que cortan un segmento
  const MAX_PALABRAS = 30;
  const segmentos = [];
  let actual = null;

  for (const p of palabras) {
    const texto = p.punctuated_word ?? p.word ?? "";
    if (!actual || p.start - actual.fin > MAX_PAUSA || actual.n >= MAX_PALABRAS) {
      actual = { inicio: p.start, fin: p.end, texto, n: 1 };
      segmentos.push(actual);
    } else {
      actual.texto += ` ${texto}`;
      actual.fin = p.end;
      actual.n += 1;
    }
  }
  return segmentos.map(({ inicio, fin, texto }) => ({ inicio, fin, texto: texto.trim() }));
}
