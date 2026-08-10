/**
 * Destino: Agente de Discovery.
 *
 * Manda la transcripción directo al proyecto de discovery correspondiente, con
 * lo que desaparece el paso manual de descargar un archivo y volverlo a subir.
 *
 * Reparto de responsabilidades, el mismo que ya usa el panel web:
 *
 *   lecturas    van directo a Supabase, filtradas por RLS
 *   mutaciones  van al backend, que es quien ingiere y valida
 *
 * Eso no es un detalle de implementación. Significa que elegir el proyecto de
 * destino funciona con solo Supabase en pie, y que el backend hace falta
 * únicamente en el último paso: registrar la fuente. Si el backend no está
 * desplegado, el fallo queda localizado ahí y todo lo demás sigue sirviendo.
 *
 * La autenticación se toma prestada del panel: si ya iniciaste sesión ahí con tu
 * enlace mágico, la extensión lee esa sesión y queda vinculada. No hay una
 * segunda contraseña ni un token que copiar a mano. El token se renueva solo
 * mientras el refresh_token siga vivo, y la extensión hereda exactamente los
 * permisos del usuario en el panel, ni uno más.
 */

import { aTextoTrazable, nombreArchivo } from "../formatos.js";

const CLAVE_SESION = "discoverySesion";
/** Margen para renovar antes de que el token expire de verdad. */
const MS_MARGEN = 60_000;

// --- Sesión ---

/**
 * Guarda la sesión leída del panel.
 *
 * Args:
 *   sesion: { access_token, refresh_token, expires_at, email }
 */
export async function guardarSesionPanel(sesion) {
  await chrome.storage.local.set({ [CLAVE_SESION]: sesion });
}

/** Lee la sesión vinculada, o null si no hay. */
export async function leerSesionPanel() {
  const g = await chrome.storage.local.get(CLAVE_SESION);
  return g[CLAVE_SESION] ?? null;
}

/** Borra el vínculo con el panel. */
export async function desvincular() {
  await chrome.storage.local.remove(CLAVE_SESION);
}

/**
 * Devuelve un token de acceso vigente, renovándolo si hace falta.
 *
 * Args:
 *   config: configuración de Escriba
 * Returns:
 *   token: access_token vigente
 */
async function tokenVigente(config) {
  const sesion = await leerSesionPanel();
  if (!sesion?.access_token) {
    throw new Error("Escriba no está vinculado al panel. Vincúlalo desde los ajustes.");
  }

  const expiraEnMs = (sesion.expires_at ?? 0) * 1000;
  if (expiraEnMs - Date.now() > MS_MARGEN) return sesion.access_token;

  if (!sesion.refresh_token) {
    throw new Error("La sesión del panel expiró. Vuelve a vincular Escriba desde los ajustes.");
  }

  const res = await fetch(`${base(config.discoverySupabaseUrl)}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: config.discoverySupabaseAnonKey },
    body: JSON.stringify({ refresh_token: sesion.refresh_token }),
  });
  if (!res.ok) {
    await desvincular();
    throw new Error("La sesión del panel expiró. Vuelve a vincular Escriba desde los ajustes.");
  }

  const datos = await res.json();
  const renovada = {
    ...sesion,
    access_token: datos.access_token,
    refresh_token: datos.refresh_token ?? sesion.refresh_token,
    expires_at: datos.expires_at ?? Math.floor(Date.now() / 1000) + (datos.expires_in ?? 3600),
  };
  await guardarSesionPanel(renovada);
  return renovada.access_token;
}

/** Quita la barra final de una URL base. */
function base(url) {
  return String(url ?? "").replace(/\/+$/, "");
}

/** Comprueba que la configuración de Supabase esté completa. */
function exigirSupabase(config) {
  if (!config.discoverySupabaseUrl || !config.discoverySupabaseAnonKey) {
    throw new Error(
      "Falta la configuración de Supabase. Vincula Escriba con el panel desde los ajustes: " +
        "el panel la entrega sola.",
    );
  }
}

// --- Lecturas: directo a Supabase, con RLS ---

/**
 * Consulta la API REST de Supabase con la sesión del usuario.
 *
 * Las políticas RLS hacen el filtrado por agencia, así que aquí no hay ninguna
 * condición de seguridad que se pueda olvidar: la base solo devuelve lo que ese
 * usuario puede ver.
 *
 * Args:
 *   config: configuración de Escriba
 *   ruta: ruta y parámetros, por ejemplo "proyectos?select=id,cliente"
 * Returns:
 *   filas: lista de filas
 */
async function consultar(config, ruta) {
  exigirSupabase(config);
  const token = await tokenVigente(config);
  const res = await fetch(`${base(config.discoverySupabaseUrl)}/rest/v1/${ruta}`, {
    headers: {
      apikey: config.discoverySupabaseAnonKey,
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });
  if (!res.ok) throw new Error(`Supabase respondió ${res.status}: ${await res.text()}`);
  return res.json();
}

/**
 * Lista los proyectos de discovery de la agencia, para elegir destino.
 *
 * Returns:
 *   proyectos: [{id, slug, cliente, objetivo}] de la más reciente a la más antigua
 */
export async function listarProyectos(config) {
  return consultar(config, "proyectos?select=id,slug,cliente,objetivo&order=creado.desc");
}

/**
 * Devuelve el id de agencia del usuario vinculado.
 *
 * Sale de la tabla `perfil`, que es la que mapea usuario a agencia. Antes esto
 * pasaba por el endpoint de onboarding del backend; leerlo de la base evita
 * depender del backend para armar la ruta de Storage.
 *
 * Returns:
 *   agenciaId: uuid de la agencia
 */
async function agenciaId(config) {
  const filas = await consultar(config, "perfil?select=agencia_id&limit=1");
  const id = filas?.[0]?.agencia_id;
  if (!id) {
    throw new Error(
      "Tu usuario todavía no tiene agencia. Entra una vez al panel para completar el alta.",
    );
  }
  return id;
}

// --- Mutación: al backend, que es quien ingiere ---

/**
 * Registra la fuente en el backend.
 *
 * Es el único paso que necesita el backend en pie, porque registrar una fuente no
 * es escribir una fila: dispara la ingesta a fragmentos con locator.
 *
 * Args:
 *   config: configuración de Escriba
 *   proyectoId: proyecto de destino
 *   cuerpo: { nombre_archivo, storage_path, modo }
 * Returns:
 *   fuente: la fila de la fuente registrada
 */
async function registrarFuente(config, proyectoId, cuerpo) {
  if (!config.discoveryBackendUrl) {
    throw new Error(
      "Falta la URL del backend. Vincula Escriba con el panel desde los ajustes: " +
        "el panel la entrega sola.",
    );
  }
  const token = await tokenVigente(config);
  const res = await fetch(
    `${base(config.discoveryBackendUrl)}/proyectos/${proyectoId}/fuentes`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(cuerpo),
    },
  );
  if (!res.ok) {
    const detalle = await res
      .json()
      .then((d) => d.detail)
      .catch(() => res.statusText);
    throw new Error(detalle || `El backend respondió ${res.status}`);
  }
  return res.json();
}

// --- Envío completo ---

/**
 * Envía una transcripción a un proyecto de discovery.
 *
 * Args:
 *   config: configuración de Escriba
 *   proyectoId: proyecto de destino
 *   intervenciones: [{inicioMs, hablante, texto}]
 *   meta: metadatos de la sesión
 * Returns:
 *   resultado: { archivo, fuente }
 */
export async function enviarADiscovery(config, proyectoId, intervenciones, meta) {
  exigirSupabase(config);
  if (!proyectoId) throw new Error("No se eligió el proyecto de discovery de destino.");

  const texto = aTextoTrazable(intervenciones, meta);
  const archivo = nombreArchivo(meta, "txt");
  const agencia = await agenciaId(config);
  const ruta = `${agencia}/${proyectoId}/${archivo}`;

  const token = await tokenVigente(config);
  const subida = await fetch(
    `${base(config.discoverySupabaseUrl)}/storage/v1/object/insumos/${encodeURI(ruta)}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: config.discoverySupabaseAnonKey,
        "Content-Type": "text/plain;charset=utf-8",
        // Equivale al `upsert: true` del panel: repetir el envío sobrescribe en
        // vez de fallar.
        "x-upsert": "true",
      },
      body: texto,
    },
  );
  if (!subida.ok) {
    throw new Error(`No se pudo subir la transcripción: ${await subida.text()}`);
  }

  const fuente = await registrarFuente(config, proyectoId, {
    nombre_archivo: archivo,
    storage_path: ruta,
    modo: "discovery",
  });

  return { archivo, fuente };
}
