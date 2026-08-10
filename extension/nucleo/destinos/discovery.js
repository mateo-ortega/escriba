/**
 * Destino: Agente de Discovery.
 *
 * Manda la transcripción directo al proyecto de discovery correspondiente, con
 * lo que desaparece el paso manual de descargar un archivo y volverlo a subir.
 *
 * Reproduce exactamente lo que hace el panel web, así que no hace falta ningún
 * endpoint nuevo en el backend:
 *
 *   1. sube el .txt a Supabase Storage en insumos/{agencia}/{proyecto}/{archivo}
 *   2. registra la fuente con POST /proyectos/{id}/fuentes
 *
 * La autenticación se toma prestada del panel: si ya iniciaste sesión ahí con tu
 * enlace mágico, la extensión lee esa sesión y queda vinculada. No hay una
 * segunda contraseña ni un token que copiar a mano. El token se renueva solo
 * mientras el refresh_token siga vivo.
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
 *   config: configuración de Escriba (discoverySupabaseUrl, discoverySupabaseAnonKey)
 * Returns:
 *   token: access_token vigente
 */
async function tokenVigente(config) {
  const sesion = await leerSesionPanel();
  if (!sesion?.access_token) {
    throw new Error("Escriba no está vinculado al panel. Vincúlalo desde las opciones.");
  }

  const expiraEnMs = (sesion.expires_at ?? 0) * 1000;
  if (expiraEnMs - Date.now() > MS_MARGEN) return sesion.access_token;

  if (!sesion.refresh_token) {
    throw new Error("La sesión del panel expiró. Vuelve a vincular Escriba desde las opciones.");
  }

  const res = await fetch(
    `${base(config.discoverySupabaseUrl)}/auth/v1/token?grant_type=refresh_token`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: config.discoverySupabaseAnonKey,
      },
      body: JSON.stringify({ refresh_token: sesion.refresh_token }),
    },
  );
  if (!res.ok) {
    await desvincular();
    throw new Error("La sesión del panel expiró. Vuelve a vincular Escriba desde las opciones.");
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

// --- API del backend ---

/**
 * Llama al backend del Agente de Discovery con el token del panel.
 *
 * Args:
 *   config: configuración de Escriba
 *   ruta: ruta de la API, por ejemplo "/proyectos"
 *   opciones: opciones de fetch
 * Returns:
 *   datos: cuerpo JSON de la respuesta
 */
async function api(config, ruta, opciones = {}) {
  if (!config.discoveryBackendUrl) {
    throw new Error("Falta la URL del backend del Agente de Discovery en las opciones.");
  }
  const token = await tokenVigente(config);
  const res = await fetch(`${base(config.discoveryBackendUrl)}${ruta}`, {
    ...opciones,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(opciones.headers ?? {}),
    },
  });
  if (!res.ok) {
    const detalle = await res
      .json()
      .then((d) => d.detail)
      .catch(() => res.statusText);
    throw new Error(detalle || `El backend respondió ${res.status}`);
  }
  return res.json();
}

/**
 * Lista los proyectos de discovery de la agencia, para elegir destino.
 *
 * Returns:
 *   proyectos: lista de proyectos tal como los devuelve el backend
 */
export async function listarProyectos(config) {
  return api(config, "/proyectos");
}

/**
 * Devuelve el id de agencia del usuario vinculado.
 *
 * El endpoint de onboarding es el mismo que usa el panel al cargar y devuelve la
 * agencia existente si ya la hay.
 */
async function agenciaId(config) {
  const { agencia_id } = await api(config, "/onboarding", {
    method: "POST",
    body: JSON.stringify({ nombre_agencia: "Mi agencia" }),
  });
  return agencia_id;
}

/**
 * Envía una transcripción a un proyecto de discovery.
 *
 * Args:
 *   config: configuración de Escriba
 *   proyectoId: proyecto de destino
 *   intervenciones: [{inicioMs, hablante, texto}]
 *   meta: metadatos de la sesión
 * Returns:
 *   resultado: { archivo, fragmentos }
 */
export async function enviarADiscovery(config, proyectoId, intervenciones, meta) {
  if (!config.discoverySupabaseUrl || !config.discoverySupabaseAnonKey) {
    throw new Error("Faltan la URL y la llave pública de Supabase en las opciones.");
  }

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

  const fuente = await api(config, `/proyectos/${proyectoId}/fuentes`, {
    method: "POST",
    body: JSON.stringify({
      nombre_archivo: archivo,
      storage_path: ruta,
      modo: "discovery",
    }),
  });

  return { archivo, fuente };
}
