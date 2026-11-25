import fs from "node:fs";
import path from "node:path";
import {
  construir_payload,
  crear,
  generar_evidencia,
  leer_paquete,
  validar,
} from "../src/tools/oc.js";

export interface ModuloRegistrable {
  manifest: Record<string, unknown>;
  systemPrompt: string;
  tools: Record<string, unknown>;
}

export function registrarModuloOcSap(baseDir: string = process.cwd()): ModuloRegistrable {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(baseDir, "modulo", "manifest.json"), "utf-8")
  ) as Record<string, unknown>;

  const prompt = fs.readFileSync(path.join(baseDir, "agent", "prompt.md"), "utf-8");
  const knowledge = fs.readFileSync(
    path.join(baseDir, "src", "knowledge", "ordenes-compra.md"),
    "utf-8"
  );

  return {
    manifest,
    systemPrompt: `${prompt}\n\n---\n\n${knowledge}`,
    tools: {
      oc_leer_paquete: leer_paquete,
      oc_validar: validar,
      oc_generar_evidencia: generar_evidencia,
      oc_construir_payload: construir_payload,
      oc_crear: crear,
    },
  };
}