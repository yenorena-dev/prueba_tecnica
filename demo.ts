import fs from "node:fs";
import path from "node:path";
import {
  construir_payload,
  crear,
  generar_evidencia,
  leer_paquete,
  PaqueteNormalizado,
  ToolContext,
  ValidacionResultado,
  validar,
} from "./src/tools/oc.js";

async function main(): Promise<void> {
  const rootDir = process.cwd();
  const outDir = path.join(rootDir, "out");

  // Limpiar out/ al inicio para garantizar determinismo (Requisito 8)
  if (fs.existsSync(outDir)) {
    fs.rmSync(outDir, { recursive: true, force: true });
  }

  const ctx: ToolContext = {
    directory: rootDir,
    sessionId: "demo-determinista",
  };

  const casos = ["sol-001", "sol-002", "sol-003", "sol-004", "sol-005", "sol-006"];

  console.log("===============================================================");
  console.log(" DEMO DETERMINISTA - AGENTE ÓRDENES DE COMPRA SAP (SIN MODELO) ");
  console.log("===============================================================\n");

  for (const caso of casos) {
    console.log(`--- Procesando caso: ${caso} ---`);

    const leerRaw = await leer_paquete.execute({ caso }, ctx);
    const leerRes = JSON.parse(leerRaw) as {
      ok: boolean;
      data?: PaqueteNormalizado;
      error?: string;
    };

    if (!leerRes.ok || !leerRes.data) {
      console.log(`Error leyendo paquete: ${leerRes.error}\n`);
      continue;
    }

    const valRaw = await validar.execute(
      { caso, paquete: leerRes.data as unknown as Record<string, unknown> },
      ctx
    );
    const valRes = JSON.parse(valRaw) as {
      ok: boolean;
      data?: ValidacionResultado;
      error?: string;
    };

    if (!valRes.ok || !valRes.data) {
      console.log(`Error validando: ${valRes.error}\n`);
      continue;
    }

    const v = valRes.data;
    console.log(`Apta: ${v.apta} | Retroactiva: ${v.retroactiva}`);
    console.log(
      `Bloqueos (${v.bloqueos.length}): ${
        v.bloqueos.length > 0 ? v.bloqueos.map((b) => `[${b.regla}] ${b.mensaje}`).join(" ; ") : "Ninguno"
      }`
    );
    console.log(
      `Confirmaciones (${v.confirmaciones.length}): ${
        v.confirmaciones.length > 0
          ? v.confirmaciones.map((c) => `[${c.regla}] ${c.mensaje}`).join(" ; ")
          : "Ninguna"
      }`
    );

    if (!v.apta) {
      console.log("Resultado: BLOQUEADA. No se crea OC en SAP.\n");
      continue;
    }

    const evRaw = await generar_evidencia.execute({ caso }, ctx);
    const evRes = JSON.parse(evRaw) as {
      ok: boolean;
      data?: { ruta: string; ruta_pdf: string; sha256: string };
    };

    const payRaw = await construir_payload.execute(
      {
        caso,
        paquete: leerRes.data as unknown as Record<string, unknown>,
        derivados: v.derivados as unknown as Record<string, unknown>,
        evidencia_sha256: evRes.data?.sha256,
      },
      ctx
    );
    const payRes = JSON.parse(payRaw) as {
      ok: boolean;
      data?: { payload: Record<string, unknown>; ruta_trazabilidad: string };
    };

    if (!payRes.ok || !payRes.data) {
      console.log("Error construyendo payload\n");
      continue;
    }

    // Si tiene confirmaciones, primero probamos sin confirmar (debe detenerse) y en sol-004 confirmamos explícitamente
    if (v.confirmaciones.length > 0) {
      const sinConf = JSON.parse(
        await crear.execute({ caso, payload: payRes.data.payload, confirmado: false }, ctx)
      ) as { ok: boolean; error?: string };
      console.log(`Intento sin confirmación: ${sinConf.error}`);

      if (caso === "sol-004") {
        console.log(">> Simulando confirmación explícita de la analista para sol-004...");
        const conConf = JSON.parse(
          await crear.execute({ caso, payload: payRes.data.payload, confirmado: true }, ctx)
        ) as { ok: boolean; data?: { numero_oc: string; idempotente: boolean } };
        console.log(
          `Resultado tras confirmar sol-004: OC creada = ${conConf.data?.numero_oc} (idempotente: ${conConf.data?.idempotente})\n`
        );
      } else {
        console.log("Resultado: En espera de confirmación humana.\n");
      }
    } else {
      const crearRes = JSON.parse(
        await crear.execute({ caso, payload: payRes.data.payload }, ctx)
      ) as { ok: boolean; data?: { numero_oc: string; idempotente: boolean } };
      console.log(
        `Resultado: OC creada = ${crearRes.data?.numero_oc} | Evidencia: ${evRes.data?.ruta} y ${evRes.data?.ruta_pdf}\n`
      );
    }
  }

  // Prueba explícita de idempotencia ejecutando sol-001 por segunda vez
  console.log("--- Prueba de Idempotencia (ejecutando sol-001 por segunda vez) ---");
  const leer1 = JSON.parse(await leer_paquete.execute({ caso: "sol-001" }, ctx)) as {
    data: PaqueteNormalizado;
  };
  const val1 = JSON.parse(
    await validar.execute({ caso: "sol-001", paquete: leer1.data as unknown as Record<string, unknown> }, ctx)
  ) as { data: ValidacionResultado };
  const pay1 = JSON.parse(
    await construir_payload.execute(
      {
        caso: "sol-001",
        paquete: leer1.data as unknown as Record<string, unknown>,
        derivados: val1.data.derivados as unknown as Record<string, unknown>,
      },
      ctx
    )
  ) as { data: { payload: Record<string, unknown> } };
  const crearDup = JSON.parse(
    await crear.execute({ caso: "sol-001", payload: pay1.data.payload }, ctx)
  ) as { data: { numero_oc: string; idempotente: boolean } };
  console.log(
    `Segunda ejecución sol-001 -> OC devuelta: ${crearDup.data.numero_oc} | idempotente: ${crearDup.data.idempotente}`
  );
  console.log("===============================================================");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});