/**
 * Motor compatible con la API de audio de OpenAI.
 *
 * Un solo módulo cubre tres escenarios muy distintos, porque todos hablan el
 * mismo dialecto en `POST {baseUrl}/audio/transcriptions`:
 *
 *   OpenAI   https://api.openai.com/v1              modelo whisper-1
 *   Groq     https://api.groq.com/openai/v1         modelo whisper-large-v3-turbo
 *   Local    http://localhost:8000/v1               Whisper propio, costo cero
 *
 * El caso local es el que interesa cuando el audio del cliente no puede salir de
 * la máquina: servidores como speaches o faster-whisper-server exponen esta
 * misma interfaz y la llave queda vacía.
 *
 * Estos proveedores tienen límite de tamaño por archivo (25 MB en OpenAI y en
 * Groq). Escriba nunca se acerca a ese límite porque graba en trozos: a 32 kbps,
 * un trozo de cinco minutos pesa alrededor de 1,2 MB.
 */

export const openaiCompatible = {
  id: "openai-compatible",
  etiqueta: "OpenAI, Groq o Whisper local",
  necesitaLlave: false, // vacía para un servidor local
  necesitaBaseUrl: true,
  // Sin origen fijo: el que haga falta sale de la URL base que configures, y el
  // permiso se pide sobre ese origen al guardar los ajustes.
  origenes: [],
  modeloPorDefecto: "whisper-large-v3-turbo",
  ayuda:
    "Cubre OpenAI, Groq (el más barato en la nube) y cualquier Whisper propio. " +
    "Con un servidor local el audio nunca sale de tu máquina.",

  /**
   * Transcribe un trozo de audio.
   *
   * Args:
   *   blob: audio WebM/Opus de una sola pista
   *   opciones: { llave, baseUrl, modelo, idioma }
   * Returns:
   *   resultado: { segmentos: [{inicio, fin, texto}], modelo }
   */
  async transcribir(blob, { llave, baseUrl, modelo, idioma }) {
    if (!baseUrl) throw new Error("Este motor necesita una URL base.");
    const usado = modelo || openaiCompatible.modeloPorDefecto;

    const cuerpo = new FormData();
    // El nombre de archivo importa: varios servidores deducen el formato de la
    // extensión y rechazan un archivo sin ella.
    cuerpo.append("file", blob, "trozo.webm");
    cuerpo.append("model", usado);
    cuerpo.append("language", idioma);
    cuerpo.append("response_format", "verbose_json");

    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/audio/transcriptions`, {
      method: "POST",
      // Sin Content-Type explícito: FormData pone su propio límite multipart.
      headers: llave ? { Authorization: `Bearer ${llave}` } : {},
      body: cuerpo,
    });
    if (!res.ok) {
      throw new Error(`El motor respondió ${res.status}: ${await res.text()}`);
    }

    const datos = await res.json();
    return { segmentos: extraerSegmentos(datos), modelo: usado };
  },
};

/**
 * Convierte la respuesta en segmentos.
 *
 * `verbose_json` trae `segments` con tiempos. Si un servidor local no los
 * devuelve, se cae a un único segmento con todo el texto: se pierde precisión
 * dentro del trozo, pero el trozo sigue ubicado en la llamada.
 *
 * Args:
 *   datos: cuerpo JSON de la respuesta
 * Returns:
 *   segmentos: [{inicio, fin, texto}] en segundos
 */
function extraerSegmentos(datos) {
  if (Array.isArray(datos?.segments) && datos.segments.length > 0) {
    return datos.segments
      .map((s) => ({ inicio: s.start, fin: s.end, texto: (s.text ?? "").trim() }))
      .filter((s) => s.texto.length > 0);
  }
  const texto = (datos?.text ?? "").trim();
  if (!texto) return [];
  return [{ inicio: 0, fin: datos?.duration ?? 0, texto }];
}
