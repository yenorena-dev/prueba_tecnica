import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { z } from "zod";
import { OrdenCompra, OrdenCompraSchema } from "../sap/adapter.js";
import { FileSapAdapter } from "../sap/mock.js";

export interface ToolContext {
  directory: string;
  sessionId: string;
}

export interface Solicitud {
  solicitud_id: string;
  solicitante: string;
  proveedor_nombre: string;
  proveedor_nit?: string;
  descripcion: string;
  centro_costo: string;
  subarea: string;
  cantidad: number;
  valor_unitario: number;
  valor_total: number;
  moneda: "COP" | "USD";
  indicador_iva?: string;
  condiciones_pago?: string;
  fecha_solicitud: string;
}

export interface PaqueteNormalizado {
  correo: { id: string; de: string; asunto: string; fecha: string };
  solicitud: Solicitud;
  cotizacion: {
    referencia: string | null;
    proveedor: string;
    nit: string | null;
    total: number;
    moneda: string;
    validez_hasta: string | null;
    texto: string;
  } | null;
  aprobacion: {
    de: string;
    para: string;
    fecha: string;
    asunto: string;
    aprobado: boolean;
    texto: string;
  } | null;
  factura: {
    numero: string;
    fecha: string;
    total: number;
  } | null;
  faltantes: string[];
}

interface ProveedorMaestro {
  codigo_sap: string;
  nit: string;
  nombre: string;
  condiciones_pago_default: string;
  indicador_iva_default: string;
  activo: boolean;
}

interface CentroCostoMaestro {
  centro_costo: string;
  nombre: string;
  subareas: string[];
  aprobadores: Array<{ email: string; nombre?: string; tope: number }>;
}

interface IndicadorIvaMaestro {
  codigo: string;
  descripcion: string;
  tasa: number;
}

interface CondicionPagoMaestro {
  codigo: string;
  descripcion: string;
  dias: number;
}

export interface ControlItem {
  regla: string;
  mensaje: string;
  sugerencia: string;
}

export interface ValidacionResultado {
  apta: boolean;
  bloqueos: ControlItem[];
  confirmaciones: ControlItem[];
  derivados: {
    proveedor?: { codigo_sap: string; nit: string; nombre: string };
    indicador_iva?: string;
    indicador_iva_origen?: "solicitud" | "derivado_proveedor";
    condiciones_pago?: string;
    condiciones_pago_origen?: "solicitud" | "derivado_proveedor";
  };
  retroactiva: boolean;
}

function normalizarTexto(txt: string): string {
  return txt
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizarNit(nit: string): string {
  const sinPuntos = nit.replace(/\./g, "").trim();
  const base = sinPuntos.split("-")[0];
  return base.replace(/\D/g, "");
}

function parseMontoColombiano(raw: string): number {
  const limpio = raw.replace(/\./g, "").replace(/,/g, ".").trim();
  return Number(limpio);
}

function parseCotizacionTxt(texto: string): PaqueteNormalizado["cotizacion"] {
  const refMatch = texto.match(/COTIZACI[ÓO]N\s+([A-Z0-9-]+)/i);
  const provMatch = texto.match(/Proveedor:\s*(.+)/i);
  const nitMatch = texto.match(/NIT:\s*([0-9.-]+)/i);
  const totalMatch = texto.match(/TOTAL(?:\s*\(IVA incluido\))?:\s*(COP|USD)\s*([0-9.,]+)/i);
  const validezMatch = texto.match(/Validez de la oferta:\s*(.+)/i);

  return {
    referencia: refMatch ? refMatch[1].trim() : null,
    proveedor: provMatch ? provMatch[1].trim() : "Desconocido",
    nit: nitMatch ? normalizarNit(nitMatch[1]) : null,
    total: totalMatch ? parseMontoColombiano(totalMatch[2]) : 0,
    moneda: totalMatch ? totalMatch[1].toUpperCase() : "COP",
    validez_hasta: validezMatch ? validezMatch[1].trim() : null,
    texto,
  };
}

function parseFacturaTxt(texto: string): PaqueteNormalizado["factura"] {
  const numMatch = texto.match(/No\.\s*([A-Z0-9-]+)/i);
  const fechaMatch = texto.match(/Fecha de emisi[óo]n:\s*(\d{4}-\d{2}-\d{2})/i);
  const totalMatch = texto.match(/TOTAL:\s*(?:COP|USD)\s*([0-9.,]+)/i);

  return {
    numero: numMatch ? numMatch[1].trim() : "SIN-NUMERO",
    fecha: fechaMatch ? fechaMatch[1].trim() : "",
    total: totalMatch ? parseMontoColombiano(totalMatch[1]) : 0,
  };
}

function registrarControlCsv(
  directory: string,
  row: {
    solicitud_id: string;
    resultado: "CREADA" | "BLOQUEADA" | "PENDIENTE_CONFIRMACION";
    numero_oc: string;
    retroactiva: boolean;
    bloqueos: string;
    confirmaciones: string;
  }
): void {
  const csvPath = path.join(directory, "out", "control.csv");
  fs.mkdirSync(path.dirname(csvPath), { recursive: true });
  if (!fs.existsSync(csvPath)) {
    fs.writeFileSync(
      csvPath,
      "solicitud_id,resultado,numero_oc,retroactiva,bloqueos,confirmaciones,ts\n",
      "utf-8"
    );
  }
  const escapeCsv = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const line = [
    escapeCsv(row.solicitud_id),
    escapeCsv(row.resultado),
    escapeCsv(row.numero_oc),
    String(row.retroactiva),
    escapeCsv(row.bloqueos),
    escapeCsv(row.confirmaciones),
    escapeCsv(new Date().toISOString()),
  ].join(",");
  fs.appendFileSync(csvPath, line + "\n", "utf-8");
}

export const leer_paquete = {
  description:
    "Lee y normaliza los archivos de una solicitud de compra desde fixtures/reto-03/solicitudes/<caso>.",
  args: {
    caso: z.string().describe("Nombre de la carpeta del caso en fixtures/reto-03/solicitudes/ (ej. sol-001)"),
  },
  async execute(args: { caso: string }, ctx: ToolContext): Promise<string> {
    try {
      const casoDir = path.join(ctx.directory, "fixtures", "reto-03", "solicitudes", args.caso);
      if (!fs.existsSync(casoDir)) {
        return JSON.stringify({
          ok: false,
          error: `No existe la carpeta del caso '${args.caso}' en fixtures/reto-03/solicitudes/.`,
        });
      }

      const faltantes: string[] = [];
      const correoPath = path.join(casoDir, "correo.json");
      const solicitudPath = path.join(casoDir, "solicitud.json");
      const cotizacionPath = path.join(casoDir, "cotizacion.txt");
      const aprobacionPath = path.join(casoDir, "aprobacion.json");
      const facturaPath = path.join(casoDir, "factura.txt");

      if (!fs.existsSync(correoPath) || !fs.existsSync(solicitudPath)) {
        return JSON.stringify({
          ok: false,
          error: `Paquete incompleto en '${args.caso}': faltan correo.json o solicitud.json.`,
        });
      }

      const correoRaw = JSON.parse(fs.readFileSync(correoPath, "utf-8")) as {
        id: string;
        de: string;
        asunto: string;
        fecha: string;
      };
      const solicitud = JSON.parse(fs.readFileSync(solicitudPath, "utf-8")) as Solicitud;

      if (typeof solicitud.valor_total !== "number" || Number.isNaN(solicitud.valor_total)) {
        return JSON.stringify({
          ok: false,
          error: `Monto no numérico en solicitud.json de '${args.caso}'. Solicita corregir el Excel de solicitud.`,
        });
      }

      let cotizacion: PaqueteNormalizado["cotizacion"] = null;
      if (fs.existsSync(cotizacionPath)) {
        cotizacion = parseCotizacionTxt(fs.readFileSync(cotizacionPath, "utf-8"));
      } else {
        faltantes.push("cotizacion.txt");
      }

      let aprobacion: PaqueteNormalizado["aprobacion"] = null;
      if (fs.existsSync(aprobacionPath)) {
        const aprRaw = JSON.parse(fs.readFileSync(aprobacionPath, "utf-8")) as {
          de: string;
          para: string;
          fecha: string;
          asunto: string;
          cuerpo: string;
        };
        aprobacion = {
          de: aprRaw.de,
          para: aprRaw.para,
          fecha: aprRaw.fecha,
          asunto: aprRaw.asunto,
          aprobado: /\baprobado\b/i.test(aprRaw.cuerpo),
          texto: aprRaw.cuerpo,
        };
      } else {
        faltantes.push("aprobacion.json");
      }

      let factura: PaqueteNormalizado["factura"] = null;
      if (fs.existsSync(facturaPath)) {
        factura = parseFacturaTxt(fs.readFileSync(facturaPath, "utf-8"));
      }

      const paquete: PaqueteNormalizado = {
        correo: {
          id: correoRaw.id,
          de: correoRaw.de,
          asunto: correoRaw.asunto,
          fecha: correoRaw.fecha,
        },
        solicitud,
        cotizacion,
        aprobacion,
        factura,
        faltantes,
      };

      return JSON.stringify({ ok: true, data: paquete });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return JSON.stringify({
        ok: false,
        error: `Error leyendo el paquete '${args.caso}': ${msg}. Verifica que los JSON estén bien formados.`,
      });
    }
  },
};

export const validar = {
  description:
    "Valida un paquete normalizado contra los maestros corporativos y aplica las 10 reglas de control RC1-RC10.",
  args: {
    caso: z.string().describe("Identificador de carpeta del caso (ej. sol-001)"),
    paquete: z.record(z.string(), z.unknown()).describe("Objeto PaqueteNormalizado retornado por oc_leer_paquete"),
  },
  async execute(args: { caso: string; paquete: Record<string, unknown> }, ctx: ToolContext): Promise<string> {
    try {
      const pq = args.paquete as unknown as PaqueteNormalizado;
      const sol = pq.solicitud;
      const maestrosDir = path.join(ctx.directory, "fixtures", "reto-03", "maestros");

      const proveedores = JSON.parse(
        fs.readFileSync(path.join(maestrosDir, "proveedores.json"), "utf-8")
      ) as ProveedorMaestro[];
      const centrosCosto = JSON.parse(
        fs.readFileSync(path.join(maestrosDir, "centros-costo.json"), "utf-8")
      ) as CentroCostoMaestro[];
      const indicadoresIva = JSON.parse(
        fs.readFileSync(path.join(maestrosDir, "indicadores-iva.json"), "utf-8")
      ) as IndicadorIvaMaestro[];
      const condicionesPago = JSON.parse(
        fs.readFileSync(path.join(maestrosDir, "condiciones-pago.json"), "utf-8")
      ) as CondicionPagoMaestro[];

      const bloqueos: ControlItem[] = [];
      const confirmaciones: ControlItem[] = [];
      const derivados: ValidacionResultado["derivados"] = {};

      // RC1: Proveedor existe y está activo (por NIT; si no hay NIT, por nombre normalizado)
      let proveedorEncontrado: ProveedorMaestro | undefined;
      if (sol.proveedor_nit) {
        const nitBuscado = normalizarNit(sol.proveedor_nit);
        proveedorEncontrado = proveedores.find((p) => normalizarNit(p.nit) === nitBuscado);
      } else {
        const nombreBuscado = normalizarTexto(sol.proveedor_nombre);
        proveedorEncontrado = proveedores.find((p) => normalizarTexto(p.nombre) === nombreBuscado);
      }

      if (!proveedorEncontrado) {
        bloqueos.push({
          regla: "RC1",
          mensaje: `Proveedor '${sol.proveedor_nombre}' (NIT: ${sol.proveedor_nit ?? "no informado"}) no existe en el maestro SAP.`,
          sugerencia: "Solicitar creación o alta de proveedor en SAP antes de emitir la OC.",
        });
      } else if (!proveedorEncontrado.activo) {
        bloqueos.push({
          regla: "RC1",
          mensaje: `Proveedor '${proveedorEncontrado.nombre}' (${proveedorEncontrado.codigo_sap}) está INACTIVO en SAP.`,
          sugerencia: "Solicitar reactivación del proveedor a Administración / Compras.",
        });
      } else {
        derivados.proveedor = {
          codigo_sap: proveedorEncontrado.codigo_sap,
          nit: proveedorEncontrado.nit,
          nombre: proveedorEncontrado.nombre,
        };
      }

      // RC2, RC3, RC4: Centro de costo, subárea, aprobador y tope
      const cc = centrosCosto.find((c) => c.centro_costo === sol.centro_costo);
      if (!cc) {
        bloqueos.push({
          regla: "RC4",
          mensaje: `Centro de costo '${sol.centro_costo}' no existe en el maestro.`,
          sugerencia: "Corregir el centro de costo en la solicitud.",
        });
      } else {
        // RC4: Subárea pertenece al centro de costo
        if (!cc.subareas.includes(sol.subarea)) {
          bloqueos.push({
            regla: "RC4",
            mensaje: `La subárea '${sol.subarea}' no pertenece al centro de costo '${cc.centro_costo}' (${cc.nombre}). Válidas: ${cc.subareas.join(", ")}.`,
            sugerencia: "Solicitar corrección de subárea o centro de costo al solicitante.",
          });
        }

        // RC2: Aprobación existe, contiene "Aprobado" y viene de aprobador autorizado del centro
        if (!pq.aprobacion || !pq.aprobacion.aprobado) {
          bloqueos.push({
            regla: "RC2",
            mensaje: "No existe correo de aprobación válido con la palabra 'Aprobado'.",
            sugerencia: "Pedir al solicitante reenviar la aprobación explícita del líder.",
          });
        } else {
          const emailApr = pq.aprobacion.de.toLowerCase().trim();
          const aprobadorValido = cc.aprobadores.find(
            (a) => a.email.toLowerCase().trim() === emailApr
          );
          if (!aprobadorValido) {
            bloqueos.push({
              regla: "RC2",
              mensaje: `El aprobador '${pq.aprobacion.de}' no tiene autoridad sobre el centro de costo '${cc.centro_costo}' (${cc.nombre}).`,
              sugerencia: `Solicitar aprobación a un líder autorizado del centro ${cc.centro_costo}: ${cc.aprobadores.map((a) => a.email).join(" o ")}.`,
            });
          } else if (sol.valor_total > aprobadorValido.tope) {
            // RC3: valor_total <= tope
            bloqueos.push({
              regla: "RC3",
              mensaje: `El monto (${sol.moneda} ${sol.valor_total.toLocaleString("es-CO")}) supera el tope autorizado de '${aprobadorValido.email}' (${sol.moneda} ${aprobadorValido.tope.toLocaleString("es-CO")}).`,
              sugerencia: "Escalar la aprobación al siguiente nivel jerárquico con tope suficiente.",
            });
          }
        }
      }

      // RC10: cantidad * valor_unitario == valor_total (± 1 unidad monetaria)
      const calculado = sol.cantidad * sol.valor_unitario;
      if (Math.abs(calculado - sol.valor_total) > 1) {
        bloqueos.push({
          regla: "RC10",
          mensaje: `Inconsistencia aritmética: ${sol.cantidad} × ${sol.valor_unitario} = ${calculado}, pero valor_total es ${sol.valor_total}.`,
          sugerencia: "Devolver la solicitud para corregir cantidades o valores unitarios.",
        });
      }

      // RC5: Cotización vs Solicitud (tolerancia 2%)
      if (!pq.cotizacion) {
        confirmaciones.push({
          regla: "RC5",
          mensaje: "No se adjuntó cotización del proveedor en el paquete.",
          sugerencia: "Confirmar si se autoriza crear la OC sin cotización adjunta.",
        });
      } else {
        const diff = Math.abs(pq.cotizacion.total - sol.valor_total) / sol.valor_total;
        if (diff > 0.02) {
          const pct = (diff * 100).toFixed(2);
          confirmaciones.push({
            regla: "RC5",
            mensaje: `Diferencia del ${pct}% entre solicitud (${sol.moneda} ${sol.valor_total.toLocaleString("es-CO")}) y cotización (${pq.cotizacion.moneda} ${pq.cotizacion.total.toLocaleString("es-CO")}), supera la tolerancia del 2%.`,
            sugerencia: "Confirmar explícitamente si se procede con el valor de la solicitud aprobada o se detiene para nueva aprobación.",
          });
        }
      }

      // RC6: indicador_iva ausente -> deriva del proveedor y pide confirmación
      if (sol.indicador_iva) {
        const ivaValido = indicadoresIva.some((i) => i.codigo === sol.indicador_iva);
        if (!ivaValido) {
          bloqueos.push({
            regla: "RC6",
            mensaje: `Indicador de IVA '${sol.indicador_iva}' no es válido en SAP.`,
            sugerencia: "Corregir indicador de IVA (C0, C1 o C2).",
          });
        } else {
          derivados.indicador_iva = sol.indicador_iva;
          derivados.indicador_iva_origen = "solicitud";
        }
      } else if (proveedorEncontrado) {
        derivados.indicador_iva = proveedorEncontrado.indicador_iva_default;
        derivados.indicador_iva_origen = "derivado_proveedor";
        confirmaciones.push({
          regla: "RC6",
          mensaje: `Indicador de IVA no informado en la solicitud. Se derivó '${proveedorEncontrado.indicador_iva_default}' desde el maestro del proveedor.`,
          sugerencia: `Confirmar el uso del indicador de IVA derivado '${proveedorEncontrado.indicador_iva_default}'.`,
        });
      }

      // RC7: condiciones_pago ausente -> deriva del proveedor (solo informa)
      if (sol.condiciones_pago) {
        const condValida = condicionesPago.some((c) => c.codigo === sol.condiciones_pago);
        if (!condValida) {
          bloqueos.push({
            regla: "RC7",
            mensaje: `Condición de pago '${sol.condiciones_pago}' no existe en el maestro SAP.`,
            sugerencia: "Corregir condición de pago.",
          });
        } else {
          derivados.condiciones_pago = sol.condiciones_pago;
          derivados.condiciones_pago_origen = "solicitud";
        }
      } else if (proveedorEncontrado) {
        derivados.condiciones_pago = proveedorEncontrado.condiciones_pago_default;
        derivados.condiciones_pago_origen = "derivado_proveedor";
      }

      // RC8: Factura anterior a fecha_solicitud -> retroactiva = true + confirmación
      let retroactiva = false;
      if (pq.factura && pq.factura.fecha && pq.factura.fecha < sol.fecha_solicitud) {
        retroactiva = true;
        confirmaciones.push({
          regla: "RC8",
          mensaje: `Compra retroactiva detectada: la factura ${pq.factura.numero} tiene fecha ${pq.factura.fecha}, anterior a la solicitud (${sol.fecha_solicitud}).`,
          sugerencia: "Confirmar creación de OC retroactiva para dejarla marcada en el log de auditoría.",
        });
      }

      // RC9: Fecha de aprobación >= fecha_solicitud
      if (pq.aprobacion && pq.aprobacion.fecha) {
        const fechaAprSoloDia = pq.aprobacion.fecha.slice(0, 10);
        if (fechaAprSoloDia < sol.fecha_solicitud) {
          confirmaciones.push({
            regla: "RC9",
            mensaje: `La aprobación (${fechaAprSoloDia}) es anterior a la fecha de solicitud (${sol.fecha_solicitud}).`,
            sugerencia: "Confirmar si la aprobación previa aplica exactamente a esta solicitud.",
          });
        }
      }

      const apta = bloqueos.length === 0;

      if (!apta) {
        registrarControlCsv(ctx.directory, {
          solicitud_id: sol.solicitud_id,
          resultado: "BLOQUEADA",
          numero_oc: "",
          retroactiva,
          bloqueos: bloqueos.map((b) => `${b.regla}: ${b.mensaje}`).join(" | "),
          confirmaciones: confirmaciones.map((c) => `${c.regla}: ${c.mensaje}`).join(" | "),
        });
      }

      const resultado: ValidacionResultado = {
        apta,
        bloqueos,
        confirmaciones,
        derivados,
        retroactiva,
      };

      return JSON.stringify({ ok: true, data: resultado });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return JSON.stringify({ ok: false, error: `Error validando '${args.caso}': ${msg}` });
    }
  },
};

export const generar_evidencia = {
  description:
    "Genera la evidencia de aprobación en out/<caso>/aprobacion.txt (con SHA-256) y out/<caso>/aprobacion.pdf.",
  args: {
    caso: z.string().describe("Nombre de la carpeta del caso (ej. sol-001)"),
  },
  async execute(args: { caso: string }, ctx: ToolContext): Promise<string> {
    try {
      const aprPath = path.join(
        ctx.directory,
        "fixtures",
        "reto-03",
        "solicitudes",
        args.caso,
        "aprobacion.json"
      );
      if (!fs.existsSync(aprPath)) {
        return JSON.stringify({
          ok: false,
          error: `No existe aprobacion.json para el caso '${args.caso}'.`,
        });
      }

      const apr = JSON.parse(fs.readFileSync(aprPath, "utf-8")) as {
        de: string;
        para: string;
        cc?: string[];
        fecha: string;
        asunto: string;
        cuerpo: string;
      };

      const contenidoBase = [
        "=== EVIDENCIA DE APROBACIÓN DE ORDEN DE COMPRA ===",
        `Caso: ${args.caso}`,
        `De: ${apr.de}`,
        `Para: ${apr.para}`,
        `CC: ${(apr.cc ?? []).join(", ")}`,
        `Fecha: ${apr.fecha}`,
        `Asunto: ${apr.asunto}`,
        "---------------------------------------------------",
        apr.cuerpo,
        "===================================================",
      ].join("\n");

      const sha256 = crypto.createHash("sha256").update(contenidoBase, "utf-8").digest("hex");
      const contenidoFinal = `${contenidoBase}\nSHA-256: ${sha256}\n`;

      const outCasoDir = path.join(ctx.directory, "out", args.caso);
      fs.mkdirSync(outCasoDir, { recursive: true });

      const txtRel = path.join("out", args.caso, "aprobacion.txt");
      const pdfRel = path.join("out", args.caso, "aprobacion.pdf");
      fs.writeFileSync(path.join(ctx.directory, txtRel), contenidoFinal, "utf-8");

      // P1: Generar PDF con pdf-lib
      const pdfDoc = await PDFDocument.create();
      const page = pdfDoc.addPage([595, 842]);
      const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
      const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

      let y = 790;
      page.drawText("EVIDENCIA DE APROBACION - PERIFERIA IT GROUP", {
        x: 50,
        y,
        size: 13,
        font: fontBold,
        color: rgb(0.1, 0.2, 0.45),
      });
      y -= 28;

      const lineas = contenidoFinal.split("\n");
      for (const linea of lineas) {
        const textoSeguro = linea.replace(/[^\x20-\x7E\xA0-\xFF]/g, " ");
        page.drawText(textoSeguro.slice(0, 90), {
          x: 50,
          y,
          size: 10,
          font,
          color: rgb(0.15, 0.15, 0.15),
        });
        y -= 16;
        if (y < 60) break;
      }

      const pdfBytes = await pdfDoc.save();
      fs.writeFileSync(path.join(ctx.directory, pdfRel), pdfBytes);

      return JSON.stringify({
        ok: true,
        data: {
          ruta: txtRel.replace(/\\/g, "/"),
          ruta_pdf: pdfRel.replace(/\\/g, "/"),
          sha256,
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return JSON.stringify({ ok: false, error: `Error generando evidencia: ${msg}` });
    }
  },
};

export const construir_payload = {
  description:
    "Construye el payload OrdenCompra validado con Zod y guarda su matriz de trazabilidad en out/<caso>/trazabilidad.json.",
  args: {
    caso: z.string().describe("Identificador de carpeta del caso (ej. sol-001)"),
    paquete: z.record(z.string(), z.unknown()).describe("Objeto PaqueteNormalizado"),
    derivados: z.record(z.string(), z.unknown()).describe("Objeto derivados retornado por oc_validar"),
    evidencia_sha256: z.string().optional().describe("Hash SHA-256 de la evidencia de aprobación"),
    excepciones_confirmadas: z
      .array(
        z.object({
          codigo: z.string(),
          detalle: z.string(),
          confirmado_por: z.string().nullable(),
        })
      )
      .optional()
      .describe("Lista de excepciones/confirmaciones aceptadas por la analista"),
  },
  async execute(
    args: {
      caso: string;
      paquete: Record<string, unknown>;
      derivados: Record<string, unknown>;
      evidencia_sha256?: string;
      excepciones_confirmadas?: Array<{
        codigo: string;
        detalle: string;
        confirmado_por: string | null;
      }>;
    },
    ctx: ToolContext
  ): Promise<string> {
    try {
      const pq = args.paquete as unknown as PaqueteNormalizado;
      const der = args.derivados as ValidacionResultado["derivados"];
      const sol = pq.solicitud;

      if (!der.proveedor) {
        return JSON.stringify({
          ok: false,
          error: "No se puede construir el payload sin un proveedor válido en derivados.",
        });
      }

      let sha256 = args.evidencia_sha256 ?? "";
      if (!sha256) {
        const evRes = JSON.parse(
          await generar_evidencia.execute({ caso: args.caso }, ctx)
        ) as { ok: boolean; data?: { sha256: string } };
        if (evRes.ok && evRes.data) {
          sha256 = evRes.data.sha256;
        }
      }

      const unidad: "UN" | "H" | "MES" = /hora/i.test(sol.descripcion)
        ? "H"
        : /mes/i.test(sol.descripcion)
          ? "MES"
          : "UN";

      const payloadCandidato: OrdenCompra = {
        referencia: {
          solicitud_id: sol.solicitud_id,
          correo_id: pq.correo.id,
          cotizacion_ref: pq.cotizacion?.referencia ?? null,
        },
        sociedad: "1000",
        organizacion_compras: "1000",
        proveedor: {
          codigo_sap: der.proveedor.codigo_sap,
          nit: der.proveedor.nit,
          nombre: der.proveedor.nombre,
        },
        moneda: sol.moneda,
        condiciones_pago: der.condiciones_pago ?? sol.condiciones_pago ?? "Z030",
        aprobador: {
          email: pq.aprobacion?.de ?? "desconocido",
          fecha_aprobacion: pq.aprobacion?.fecha ?? "",
          evidencia_sha256: sha256,
        },
        posiciones: [
          {
            numero: 10,
            descripcion: sol.descripcion.slice(0, 40),
            cantidad: sol.cantidad,
            unidad,
            precio_unitario: sol.valor_unitario,
            centro_costo: sol.centro_costo,
            subarea: sol.subarea,
            indicador_iva: der.indicador_iva ?? sol.indicador_iva ?? "C1",
          },
        ],
        excepciones: args.excepciones_confirmadas ?? [],
      };

      const validado = OrdenCompraSchema.parse(payloadCandidato);

      const trazabilidad = {
        solicitud_id: sol.solicitud_id,
        generado_en: new Date().toISOString(),
        campos: {
          "referencia.solicitud_id": "solicitud",
          "referencia.correo_id": "solicitud",
          "referencia.cotizacion_ref": pq.cotizacion ? "cotizacion" : "derivado",
          "proveedor.codigo_sap": "maestro.proveedores",
          "proveedor.nit": sol.proveedor_nit ? "solicitud" : "maestro.proveedores",
          "proveedor.nombre": "maestro.proveedores",
          moneda: "solicitud",
          condiciones_pago:
            der.condiciones_pago_origen === "derivado_proveedor"
              ? "derivado (maestro.proveedores)"
              : "solicitud",
          "aprobador.email": "solicitud",
          "aprobador.evidencia_sha256": "derivado",
          "posiciones[0].descripcion": "solicitud",
          "posiciones[0].cantidad": "solicitud",
          "posiciones[0].precio_unitario": "solicitud",
          "posiciones[0].centro_costo": "solicitud",
          "posiciones[0].subarea": "solicitud",
          "posiciones[0].indicador_iva":
            der.indicador_iva_origen === "derivado_proveedor"
              ? "derivado (maestro.proveedores)"
              : "solicitud",
        },
      };

      const outCasoDir = path.join(ctx.directory, "out", args.caso);
      fs.mkdirSync(outCasoDir, { recursive: true });
      const trazRel = path.join("out", args.caso, "trazabilidad.json");
      fs.writeFileSync(
        path.join(ctx.directory, trazRel),
        JSON.stringify(trazabilidad, null, 2),
        "utf-8"
      );

      return JSON.stringify({
        ok: true,
        data: {
          payload: validado,
          ruta_trazabilidad: trazRel.replace(/\\/g, "/"),
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return JSON.stringify({ ok: false, error: `Error construyendo payload: ${msg}` });
    }
  },
};

export const crear = {
  description:
    "Crea la Orden de Compra en el adaptador SAP simulado si cumple controles y confirmaciones requeridas, registrando control.csv.",
  args: {
    caso: z.string().describe("Identificador de carpeta del caso (ej. sol-001)"),
    payload: z.record(z.string(), z.unknown()).describe("Objeto OrdenCompra generado por oc_construir_payload"),
    confirmado: z
      .boolean()
      .optional()
      .describe("Debe ser true cuando el caso tiene confirmaciones pendientes y el usuario las confirmó explícitamente"),
  },
  async execute(
    args: { caso: string; payload: Record<string, unknown>; confirmado?: boolean },
    ctx: ToolContext
  ): Promise<string> {
    try {
      const payload = OrdenCompraSchema.parse(args.payload);

      // Re-verificar reglas de control determinísticamente para evitar bypass
      const leerRes = JSON.parse(await leer_paquete.execute({ caso: args.caso }, ctx)) as {
        ok: boolean;
        data?: PaqueteNormalizado;
        error?: string;
      };
      if (!leerRes.ok || !leerRes.data) {
        return JSON.stringify({ ok: false, error: leerRes.error ?? "No se pudo leer el paquete." });
      }

      const valRes = JSON.parse(
        await validar.execute(
          { caso: args.caso, paquete: leerRes.data as unknown as Record<string, unknown> },
          ctx
        )
      ) as { ok: boolean; data?: ValidacionResultado; error?: string };

      if (!valRes.ok || !valRes.data) {
        return JSON.stringify({ ok: false, error: valRes.error ?? "Error en validación." });
      }

      const validacion = valRes.data;

      if (!validacion.apta) {
        return JSON.stringify({
          ok: false,
          error: `Orden bloqueada por incumplir controles: ${validacion.bloqueos.map((b) => `[${b.regla}] ${b.mensaje}`).join("; ")}`,
        });
      }

      if (validacion.confirmaciones.length > 0 && args.confirmado !== true) {
        registrarControlCsv(ctx.directory, {
          solicitud_id: payload.referencia.solicitud_id,
          resultado: "PENDIENTE_CONFIRMACION",
          numero_oc: "",
          retroactiva: validacion.retroactiva,
          bloqueos: "",
          confirmaciones: validacion.confirmaciones.map((c) => `${c.regla}: ${c.mensaje}`).join(" | "),
        });
        return JSON.stringify({
          ok: false,
          error: `Se requiere confirmación explícita del usuario antes de crear la OC: ${validacion.confirmaciones.map((c) => `[${c.regla}] ${c.mensaje}`).join("; ")}`,
        });
      }

      const sap = new FileSapAdapter(ctx.directory);
      const previa = await sap.buscarOrdenPorReferencia(payload.referencia.solicitud_id);
      const idempotente = previa !== null;

      if (!idempotente && validacion.confirmaciones.length > 0 && payload.excepciones.length === 0) {
        payload.excepciones = validacion.confirmaciones.map((c) => ({
          codigo: c.regla,
          detalle: c.mensaje,
          confirmado_por: "Analista Administrativa",
        }));
      }

      const creada = await sap.crearOrden(payload);

      registrarControlCsv(ctx.directory, {
        solicitud_id: payload.referencia.solicitud_id,
        resultado: "CREADA",
        numero_oc: creada.numero_oc,
        retroactiva: validacion.retroactiva,
        bloqueos: "",
        confirmaciones: validacion.confirmaciones.map((c) => `${c.regla}: ${c.mensaje}`).join(" | "),
      });

      return JSON.stringify({
        ok: true,
        data: {
          numero_oc: creada.numero_oc,
          fecha: creada.fecha,
          idempotente,
          retroactiva: validacion.retroactiva,
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return JSON.stringify({ ok: false, error: `Error creando OC en SAP: ${msg}` });
    }
  },
};