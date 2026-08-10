/**
 * Orquestador de la transcripción.
 *
 * Toma los trozos de audio de una sesión, los manda al motor configurado y
 * devuelve intervenciones con hablante. Tres decisiones que vale la pena
 * explicar:
 *
 * 1. Los trozos silenciosos no se mandan. Al grabar dos pistas en paralelo, cada
 *    una está callada mientras habla la otra, así que saltarse el silencio quita
 *    la mayor parte del costo de haber duplicado la grabación.
 *
 * 2. Un trozo que falla no tumba la llamada. Se registra y se sigue: es mucho
 *    mejor entregar 55 de 60 minutos que perderlo todo por un error de red.
 *
 * 3. Los tiempos que devuelve el motor son relativos a su trozo. Aquí se
 *    trasladan al tiempo absoluto de la llamada, que es el que permite cruzar
 *    las dos pistas y los subtítulos en una sola línea de tiempo.
 */

import { trozosDeSesion } from "./almacen.js";
import { construirIntervenciones } from "./hablantes.js";
import { motorPorId } from "./motores/registro.js";

/** Trozos que se transcriben a la vez. */
const CONCURRENCIA = 3;
/** Reintentos por trozo antes de darlo por perdido. */
const REINTENTOS = 2;

/**
 * Transcribe una sesión completa.
 *
 * Args:
 *   sesionId: identificador de la sesión
 *   config: configuración de Escriba (motor, llave, idioma, nombreConsultor)
 *   subtitulos: [{inicioMs, finMs, nombre}] recogidos durante la llamada
 *   onProgreso: función opcional (hechos, total, etiqueta) para la interfaz
 * Returns:
 *   resultado: { intervenciones, motor, modelo, trozosFallidos, trozosTranscritos }
 */
export async function transcribirSesion(sesionId, config, subtitulos = [], onProgreso = null) {
  const motor = motorPorId(config.motor);
  const trozos = deduplicar(await trozosDeSesion(sesionId));
  const utiles = trozos.filter((t) => !t.silencioso && t.blob?.size > 0);

  if (utiles.length === 0) {
    throw new Error(
      "No hay audio con voz en esta sesión. Revisa que la pestaña tuviera sonido y " +
        "que el micrófono estuviera concedido.",
    );
  }

  const opciones = {
    llave: config.motorLlave,
    baseUrl: config.motorBaseUrl,
    modelo: config.motorModelo,
    idioma: config.idioma,
  };

  let hechos = 0;
  const fallidos = [];
  const segmentos = [];
  let modeloUsado = "";

  await enTandas(utiles, CONCURRENCIA, async (trozo) => {
    try {
      const { segmentos: crudos, modelo } = await conReintentos(() =>
        motor.transcribir(trozo.blob, opciones),
      );
      modeloUsado = modelo;
      for (const s of crudos) {
        segmentos.push({
          // El motor cuenta desde el inicio de su trozo; la llamada cuenta desde
          // el minuto cero.
          inicioMs: trozo.inicioMs + s.inicio * 1000,
          finMs: trozo.inicioMs + s.fin * 1000,
          texto: s.texto,
          pista: trozo.pista,
        });
      }
    } catch (e) {
      console.error("[escriba] trozo fallido", trozo.pista, trozo.indice, e);
      fallidos.push({ pista: trozo.pista, indice: trozo.indice, error: String(e?.message ?? e) });
    } finally {
      hechos += 1;
      onProgreso?.(hechos, utiles.length);
    }
  });

  if (segmentos.length === 0) {
    throw new Error(
      `Ningún trozo se pudo transcribir. Primer error: ${fallidos[0]?.error ?? "desconocido"}`,
    );
  }

  return {
    intervenciones: construirIntervenciones(segmentos, subtitulos, {
      nombreConsultor: config.nombreConsultor,
    }),
    motor: motor.etiqueta,
    modelo: modeloUsado,
    trozosTranscritos: utiles.length - fallidos.length,
    trozosFallidos: fallidos,
  };
}

/**
 * Quita trozos repetidos, conservando el más completo de cada uno.
 *
 * El audio se persiste varias veces mientras se graba (para resistir una caída
 * del navegador), así que un mismo trozo puede haber quedado escrito primero
 * incompleto y luego completo.
 *
 * Args:
 *   trozos: lista cruda de IndexedDB
 * Returns:
 *   trozos: uno por combinación de pista e índice
 */
function deduplicar(trozos) {
  const porClave = new Map();
  for (const t of trozos) {
    const clave = `${t.pista}#${t.indice}`;
    const previo = porClave.get(clave);
    if (!previo || (t.completo && !previo.completo) || t.blob.size > previo.blob.size) {
      porClave.set(clave, t);
    }
  }
  return [...porClave.values()].sort((a, b) => a.inicioMs - b.inicioMs);
}

/**
 * Ejecuta una tarea sobre una lista con un tope de tareas simultáneas.
 *
 * Args:
 *   elementos: lista de entradas
 *   tope: cuántas a la vez
 *   tarea: función asíncrona por elemento
 */
async function enTandas(elementos, tope, tarea) {
  const cola = [...elementos];
  const obreros = Array.from({ length: Math.min(tope, cola.length) }, async () => {
    while (cola.length > 0) {
      await tarea(cola.shift());
    }
  });
  await Promise.all(obreros);
}

/**
 * Reintenta una operación con espera creciente.
 *
 * Args:
 *   fn: función asíncrona a ejecutar
 * Returns:
 *   resultado: lo que devuelva fn
 */
async function conReintentos(fn) {
  let ultimo;
  for (let intento = 0; intento <= REINTENTOS; intento += 1) {
    try {
      return await fn();
    } catch (e) {
      ultimo = e;
      if (intento < REINTENTOS) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** intento));
      }
    }
  }
  throw ultimo;
}
