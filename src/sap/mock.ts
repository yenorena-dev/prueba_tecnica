import fs from "node:fs";
import path from "node:path";
import { OrdenCompra, SapAdapter } from "./adapter.js";

interface OrdenGuardada {
  numero_oc: string;
  fecha: string;
  orden: OrdenCompra;
}

interface ProveedorMaestro {
  codigo_sap: string;
  nit: string;
  nombre: string;
  condiciones_pago_default: string;
  indicador_iva_default: string;
  activo: boolean;
}

export class FileSapAdapter implements SapAdapter {
  private readonly baseDir: string;
  private readonly ordenesFile: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
    this.ordenesFile = path.join(baseDir, "out", "sap", "ordenes.jsonl");
  }

  private ensureDir(): void {
    fs.mkdirSync(path.dirname(this.ordenesFile), { recursive: true });
  }

  private leerOrdenes(): OrdenGuardada[] {
    if (!fs.existsSync(this.ordenesFile)) return [];
    const content = fs.readFileSync(this.ordenesFile, "utf-8").trim();
    if (!content) return [];
    return content
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as OrdenGuardada);
  }

  async consultarProveedor(nit: string): Promise<{ codigo_sap: string; activo: boolean } | null> {
    const maestrosPath = path.join(
      this.baseDir,
      "fixtures",
      "reto-03",
      "maestros",
      "proveedores.json"
    );
    const raw = fs.readFileSync(maestrosPath, "utf-8");
    const proveedores = JSON.parse(raw) as ProveedorMaestro[];
    const nitLimpio = nit.replace(/\D/g, "").slice(0, 9);
    const encontrado = proveedores.find(
      (p) => p.nit.replace(/\D/g, "").slice(0, 9) === nitLimpio
    );
    if (!encontrado) return null;
    return { codigo_sap: encontrado.codigo_sap, activo: encontrado.activo };
  }

  async buscarOrdenPorReferencia(solicitud_id: string): Promise<{ numero_oc: string } | null> {
    const ordenes = this.leerOrdenes();
    const existente = ordenes.find((o) => o.orden.referencia.solicitud_id === solicitud_id);
    return existente ? { numero_oc: existente.numero_oc } : null;
  }

  async crearOrden(orden: OrdenCompra): Promise<{ numero_oc: string; fecha: string }> {
    this.ensureDir();
    const existente = await this.buscarOrdenPorReferencia(orden.referencia.solicitud_id);
    if (existente) {
      const todas = this.leerOrdenes();
      const record = todas.find((o) => o.numero_oc === existente.numero_oc);
      return {
        numero_oc: existente.numero_oc,
        fecha: record ? record.fecha : new Date().toISOString(),
      };
    }

    const ordenes = this.leerOrdenes();
    const siguienteNumero = 4500000001 + ordenes.length;
    const numero_oc = String(siguienteNumero);
    const fecha = new Date().toISOString();

    const registro: OrdenGuardada = { numero_oc, fecha, orden };
    fs.appendFileSync(this.ordenesFile, JSON.stringify(registro) + "\n", "utf-8");
    return { numero_oc, fecha };
  }
}