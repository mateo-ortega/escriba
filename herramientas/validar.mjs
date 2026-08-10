/**
 * Pruebas de los módulos puros de Escriba.
 *
 * Se prueba lo que se puede romper en silencio: la atribución de hablantes y el
 * formato de salida. La captura y los motores no se prueban aquí porque
 * dependen del navegador y de servicios externos; se verifican con una llamada
 * real (ver docs/ARQUITECTURA.md, sección de verificación).
 *
 * Uso:
 *   node herramientas/validar.mjs
 */

import assert from "node:assert/strict";

import {
  construirIntervenciones,
  normalizarHablante,
  renombrarHablante,
  HABLANTE_OTRO,
} from "../extension/nucleo/hablantes.js";
import { aTextoTrazable, aVtt, comoReloj, nombreArchivo } from "../extension/nucleo/formatos.js";

/**
 * Patrón con el que el pipeline del Agente de Discovery reconoce una línea de
 * transcripción. Copiado literalmente de backend/app/ingesta/transcripcion.py:
 * si esta prueba pasa, la salida de Escriba entra al pipeline con hablante y
 * timestamp como locator.
 */
const LINEA_BACKEND =
  /^\s*\[(?<ts>\d{1,2}:\d{2}(?::\d{2})?)\]\s*(?<hab>[^:]{1,60}?):\s*(?<txt>.*)$/;

let pasadas = 0;
const fallos = [];

/**
 * Corre una prueba y acumula el resultado.
 *
 * Args:
 *   nombre: qué se está comprobando
 *   fn: cuerpo de la prueba, que lanza si falla
 */
function prueba(nombre, fn) {
  try {
    fn();
    pasadas += 1;
  } catch (e) {
    fallos.push({ nombre, error: e.message });
  }
}

// --- Reloj ---

prueba("comoReloj formatea horas, minutos y segundos", () => {
  assert.equal(comoReloj(0), "00:00:00");
  assert.equal(comoReloj(1000), "00:00:01");
  assert.equal(comoReloj(65_000), "00:01:05");
  assert.equal(comoReloj(3_725_000), "01:02:05");
  assert.equal(comoReloj(-500), "00:00:00", "un tiempo negativo no debe romper el formato");
});

// --- Atribución de hablantes ---

prueba("la pista del micrófono se atribuye a quien conduce la llamada", () => {
  const i = construirIntervenciones(
    [{ inicioMs: 0, finMs: 2000, texto: "Cuéntame del proceso.", pista: "mic" }],
    [],
    { nombreConsultor: "Mateo Ortega" },
  );
  assert.equal(i.length, 1);
  assert.equal(i[0].hablante, "Mateo Ortega");
});

prueba("la pista de la pestaña toma el nombre del subtítulo que más se solapa", () => {
  const i = construirIntervenciones(
    [{ inicioMs: 10_000, finMs: 14_000, texto: "El 30% no aparece.", pista: "tab" }],
    [
      { inicioMs: 0, finMs: 5000, nombre: "Andrés Gómez" },
      { inicioMs: 9500, finMs: 14_500, nombre: "Diana Restrepo" },
    ],
    { nombreConsultor: "Mateo" },
  );
  assert.equal(i[0].hablante, "Diana Restrepo");
});

prueba("sin subtítulos, la otra parte queda como un hablante genérico", () => {
  const i = construirIntervenciones(
    [{ inicioMs: 0, finMs: 3000, texto: "Buenos días.", pista: "tab" }],
    [],
    { nombreConsultor: "Mateo" },
  );
  assert.equal(i[0].hablante, HABLANTE_OTRO);
});

prueba("un subtítulo que no se solapa no contamina la atribución", () => {
  const i = construirIntervenciones(
    [{ inicioMs: 60_000, finMs: 62_000, texto: "Sigamos.", pista: "tab" }],
    [{ inicioMs: 0, finMs: 5000, nombre: "Diana Restrepo" }],
    { nombreConsultor: "Mateo" },
  );
  assert.equal(i[0].hablante, HABLANTE_OTRO);
});

prueba("segmentos seguidos del mismo hablante se fusionan en una intervención", () => {
  const i = construirIntervenciones(
    [
      { inicioMs: 0, finMs: 1000, texto: "Primero esto,", pista: "mic" },
      { inicioMs: 1200, finMs: 2000, texto: "y luego aquello.", pista: "mic" },
    ],
    [],
    { nombreConsultor: "Mateo" },
  );
  assert.equal(i.length, 1);
  assert.equal(i[0].texto, "Primero esto, y luego aquello.");
  assert.equal(i[0].finMs, 2000);
});

prueba("un hueco largo separa las intervenciones aunque hable el mismo", () => {
  const i = construirIntervenciones(
    [
      { inicioMs: 0, finMs: 1000, texto: "Una cosa.", pista: "mic" },
      { inicioMs: 30_000, finMs: 31_000, texto: "Otra cosa.", pista: "mic" },
    ],
    [],
    { nombreConsultor: "Mateo" },
  );
  assert.equal(i.length, 2);
});

prueba("las dos pistas se entrelazan en orden cronológico", () => {
  const i = construirIntervenciones(
    [
      { inicioMs: 5000, finMs: 6000, texto: "Respuesta.", pista: "tab" },
      { inicioMs: 0, finMs: 1000, texto: "Pregunta.", pista: "mic" },
      { inicioMs: 9000, finMs: 10_000, texto: "Repregunta.", pista: "mic" },
    ],
    [],
    { nombreConsultor: "Mateo" },
  );
  assert.deepEqual(
    i.map((x) => x.texto),
    ["Pregunta.", "Respuesta.", "Repregunta."],
  );
});

prueba("los segmentos vacíos se descartan", () => {
  const i = construirIntervenciones(
    [
      { inicioMs: 0, finMs: 1000, texto: "   ", pista: "mic" },
      { inicioMs: 2000, finMs: 3000, texto: "Sí.", pista: "mic" },
    ],
    [],
    {},
  );
  assert.equal(i.length, 1);
});

// --- Saneado de nombres ---

prueba("un nombre con dos puntos no puede romper la línea", () => {
  assert.equal(normalizarHablante("Dr: Andrés"), "Dr Andrés");
});

prueba("un nombre larguísimo se recorta a lo que el parser admite", () => {
  const largo = "A".repeat(120);
  assert.equal(normalizarHablante(largo).length, 60);
});

prueba("un nombre vacío cae en el hablante genérico", () => {
  assert.equal(normalizarHablante("   "), HABLANTE_OTRO);
  assert.equal(normalizarHablante(null), HABLANTE_OTRO);
});

prueba("renombrar fusiona lo que antes estaba separado", () => {
  const original = [
    { inicioMs: 0, finMs: 1000, hablante: "Cliente", texto: "Hola." },
    { inicioMs: 1500, finMs: 2500, hablante: "Cliente", texto: "Buenos días." },
  ];
  const r = renombrarHablante(original, "Cliente", "Diana Restrepo");
  assert.equal(r.length, 1);
  assert.equal(r[0].hablante, "Diana Restrepo");
});

// --- Formato de salida ---

prueba("toda línea de intervención encaja con el parser del backend", () => {
  const intervenciones = construirIntervenciones(
    [
      { inicioMs: 0, finMs: 4000, texto: "¿Cómo manejan hoy la agenda?", pista: "mic" },
      { inicioMs: 5000, finMs: 12_000, texto: "El 30% de los pacientes no aparece.", pista: "tab" },
    ],
    [{ inicioMs: 4800, finMs: 12_500, nombre: "Diana Restrepo" }],
    { nombreConsultor: "Mateo Ortega" },
  );

  const texto = aTextoTrazable(intervenciones, {
    titulo: "Discovery Clínica Sonrisas",
    fecha: "2026-08-09",
    plataforma: "Google Meet",
    motor: "Deepgram",
    modelo: "nova-2",
    duracionMs: 12_000,
  });

  const lineas = texto.split("\n").filter((l) => l.trim().length > 0);
  const conTimestamp = lineas.filter((l) => l.startsWith("["));
  assert.equal(conTimestamp.length, 2, "debe haber una línea por intervención");

  for (const linea of conTimestamp) {
    const m = LINEA_BACKEND.exec(linea);
    assert.ok(m, `el parser del backend no reconocería esta línea: ${linea}`);
    assert.ok(m.groups.hab.length > 0, "el hablante no puede quedar vacío");
    assert.ok(m.groups.txt.length > 0, "el texto no puede quedar vacío");
  }

  assert.equal(LINEA_BACKEND.exec(conTimestamp[0]).groups.hab, "Mateo Ortega");
  assert.equal(LINEA_BACKEND.exec(conTimestamp[1]).groups.hab, "Diana Restrepo");
  assert.equal(
    LINEA_BACKEND.exec(conTimestamp[1]).groups.txt,
    "El 30% de los pacientes no aparece.",
  );
});

prueba("el encabezado va antes de la primera marca de tiempo", () => {
  const texto = aTextoTrazable([{ inicioMs: 0, finMs: 1000, hablante: "Mateo", texto: "Hola." }], {
    titulo: "Llamada de prueba",
    fecha: "2026-08-09",
  });
  const lineas = texto.split("\n");
  assert.equal(lineas[0], "Llamada de prueba");
  assert.ok(
    lineas.findIndex((l) => l.startsWith("[")) > lineas.findIndex((l) => l.startsWith("Fecha:")),
    "las líneas de encabezado deben preceder a las intervenciones",
  );
});

prueba("un salto de línea dentro del texto no parte la intervención en dos", () => {
  const texto = aTextoTrazable(
    [{ inicioMs: 0, finMs: 1000, hablante: "Mateo", texto: "Primera línea\nsegunda línea" }],
    {},
  );
  const lineas = texto.split("\n").filter((l) => l.trim().length > 0);
  assert.equal(lineas.length, 1);
  assert.ok(LINEA_BACKEND.test(lineas[0]));
});

prueba("las tildes y la ñ sobreviven al formateo", () => {
  const texto = aTextoTrazable(
    [{ inicioMs: 0, finMs: 1000, hablante: "Muñoz", texto: "¿Sí? Aquí está la información." }],
    {},
  );
  assert.ok(texto.includes("¿Sí? Aquí está la información."));
  assert.ok(texto.includes("Muñoz"));
});

prueba("el WebVTT sale con cabecera, tiempos y hablante", () => {
  const vtt = aVtt([{ inicioMs: 1500, finMs: 4250, hablante: "Diana", texto: "Hola." }]);
  assert.ok(vtt.startsWith("WEBVTT"));
  assert.ok(vtt.includes("00:00:01.500 --> 00:00:04.250"));
  assert.ok(vtt.includes("<v Diana>Hola."));
});

prueba("el nombre de archivo queda sin tildes ni espacios", () => {
  const n = nombreArchivo({ titulo: "Discovery Clínica Sonrisas", fecha: "2026-08-09" }, "txt");
  assert.equal(n, "2026-08-09-Discovery-Clinica-Sonrisas.txt");
});

// --- Resultado ---

console.log(`\nEscriba: ${pasadas} pruebas pasadas, ${fallos.length} fallidas.\n`);
for (const f of fallos) console.error(`  FALLA  ${f.nombre}\n         ${f.error}\n`);
process.exit(fallos.length === 0 ? 0 : 1);
