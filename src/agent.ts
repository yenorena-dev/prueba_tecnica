import fs from "node:fs";
import path from "node:path";
import { FunctionDeclaration, GoogleGenAI, Type } from "@google/genai";
import {
  construir_payload,
  crear,
  generar_evidencia,
  leer_paquete,
  ToolContext,
  validar,
} from "./tools/oc.js";

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface AgentResponse {
  reply: string;
  toolCalls: Array<{ name: string; args: Record<string, unknown>; result: unknown }>;
  tokensUsed: number;
}

const toolDeclarations: FunctionDeclaration[] = [
  {
    name: "oc_leer_paquete",
    description: leer_paquete.description,
    parameters: {
      type: Type.OBJECT,
      properties: {
        caso: {
          type: Type.STRING,
          description: "Nombre de la carpeta del caso (ej. sol-001)",
        },
      },
      required: ["caso"],
    },
  },
  {
    name: "oc_validar",
    description: validar.description,
    parameters: {
      type: Type.OBJECT,
      properties: {
        caso: { type: Type.STRING, description: "Identificador del caso (ej. sol-001)" },
        paquete: {
          type: Type.OBJECT,
          description: "Objeto paquete retornado por oc_leer_paquete",
        },
      },
      required: ["caso", "paquete"],
    },
  },
  {
    name: "oc_generar_evidencia",
    description: generar_evidencia.description,
    parameters: {
      type: Type.OBJECT,
      properties: {
        caso: { type: Type.STRING, description: "Identificador del caso (ej. sol-001)" },
      },
      required: ["caso"],
    },
  },
  {
    name: "oc_construir_payload",
    description: construir_payload.description,
    parameters: {
      type: Type.OBJECT,
      properties: {
        caso: { type: Type.STRING, description: "Identificador del caso (ej. sol-001)" },
        paquete: { type: Type.OBJECT, description: "Objeto paquete" },
        derivados: { type: Type.OBJECT, description: "Objeto derivados retornado por oc_validar" },
        evidencia_sha256: { type: Type.STRING, description: "Hash SHA-256 de la evidencia" },
      },
      required: ["caso", "paquete", "derivados"],
    },
  },
  {
    name: "oc_crear",
    description: crear.description,
    parameters: {
      type: Type.OBJECT,
      properties: {
        caso: { type: Type.STRING, description: "Identificador del caso (ej. sol-001)" },
        payload: { type: Type.OBJECT, description: "Objeto payload de oc_construir_payload" },
        confirmado: {
          type: Type.BOOLEAN,
          description: "true si la analista confirmó explícitamente las excepciones",
        },
      },
      required: ["caso", "payload"],
    },
  },
];

async function executeToolByName(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<unknown> {
  let raw = "";
  switch (name) {
    case "oc_leer_paquete":
      raw = await leer_paquete.execute(args as { caso: string }, ctx);
      break;
    case "oc_validar":
      raw = await validar.execute(
        args as { caso: string; paquete: Record<string, unknown> },
        ctx
      );
      break;
    case "oc_generar_evidencia":
      raw = await generar_evidencia.execute(args as { caso: string }, ctx);
      break;
    case "oc_construir_payload":
      raw = await construir_payload.execute(
        args as {
          caso: string;
          paquete: Record<string, unknown>;
          derivados: Record<string, unknown>;
          evidencia_sha256?: string;
        },
        ctx
      );
      break;
    case "oc_crear":
      raw = await crear.execute(
        args as { caso: string; payload: Record<string, unknown>; confirmado?: boolean },
        ctx
      );
      break;
    default:
      return { ok: false, error: `Herramienta desconocida: ${name}` };
  }
  return JSON.parse(raw) as unknown;
}

async function generateWithFallback(
  ai: GoogleGenAI,
  primaryModel: string,
  contents: Array<Record<string, unknown>>,
  systemInstruction: string
) {
  const candidates = Array.from(
    new Set([primaryModel, "gemini-3.8-flash-lite", "gemini-3.8-pro"])
  );
  let lastError: unknown;

  for (const model of candidates) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await ai.models.generateContent({
          model,
          contents: contents as never,
          config: {
            systemInstruction,
            temperature: 0.1,
            tools: [{ functionDeclarations: toolDeclarations }],
          },
        });
      } catch (err) {
        lastError = err;
        const msg = err instanceof Error ? err.message : String(err);
        const isTransient = msg.includes("503") || msg.includes("429") || msg.includes("UNAVAILABLE");
        if (!isTransient) break;
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
      }
    }
  }
  throw lastError;
}

async function ejecutarFlujoDeterministaFallback(
  history: ChatTurn[],
  ctx: ToolContext,
  executedTools: AgentResponse["toolCalls"]
): Promise<AgentResponse> {
  const ultimoUsuario = [...history].reverse().find((m) => m.role === "user")?.content ?? "";
  const matchCaso =
    ultimoUsuario.match(/sol-\d+/i)?.[0].toLowerCase() ??
    [...history]
      .map((m) => m.content.match(/sol-\d+/i)?.[0].toLowerCase())
      .filter((v): v is string => Boolean(v))
      .pop();

  if (!matchCaso) {
    return {
      reply:
        "Indica el identificador del caso que deseas procesar (por ejemplo: `sol-001`, `sol-002`, `sol-003`, `sol-004`, `sol-005` o `sol-006`).",
      toolCalls: executedTools,
      tokensUsed: 0,
    };
  }

  const confirmado = /\b(s[ií]|confirmo|autorizo)\b/i.test(ultimoUsuario);

  const pq = (await executeToolByName("oc_leer_paquete", { caso: matchCaso }, ctx)) as {
    ok: boolean;
    data?: Record<string, unknown>;
    error?: string;
  };
  executedTools.push({ name: "oc_leer_paquete", args: { caso: matchCaso }, result: pq });

  if (!pq.ok || !pq.data) {
    return {
      reply: pq.error ?? `No se pudo leer el paquete ${matchCaso}.`,
      toolCalls: executedTools,
      tokensUsed: 0,
    };
  }

  const val = (await executeToolByName(
    "oc_validar",
    { caso: matchCaso, paquete: pq.data },
    ctx
  )) as {
    ok: boolean;
    data?: {
      apta: boolean;
      bloqueos: Array<{ regla: string; mensaje: string; sugerencia: string }>;
      confirmaciones: Array<{ regla: string; mensaje: string; sugerencia: string }>;
      derivados: Record<string, unknown>;
      retroactiva: boolean;
    };
  };
  executedTools.push({ name: "oc_validar", args: { caso: matchCaso }, result: val });

  if (!val.data?.apta) {
    const lista = (val.data?.bloqueos ?? [])
      .map((b) => `- **[${b.regla}]** ${b.mensaje}\n  *Acción sugerida:* ${b.sugerencia}`)
      .join("\n");
    return {
      reply: `La solicitud **${matchCaso}** fue **BLOQUEADA** y no puede crearse en SAP:\n\n${lista}`,
      toolCalls: executedTools,
      tokensUsed: 0,
    };
  }

  const ev = (await executeToolByName("oc_generar_evidencia", { caso: matchCaso }, ctx)) as {
    data?: { ruta: string; ruta_pdf: string; sha256: string };
  };
  executedTools.push({ name: "oc_generar_evidencia", args: { caso: matchCaso }, result: ev });

  const pay = (await executeToolByName(
    "oc_construir_payload",
    {
      caso: matchCaso,
      paquete: pq.data,
      derivados: val.data.derivados,
      evidencia_sha256: ev.data?.sha256,
    },
    ctx
  )) as { data?: { payload: Record<string, unknown>; ruta_trazabilidad: string } };
  executedTools.push({ name: "oc_construir_payload", args: { caso: matchCaso }, result: pay });

  if ((val.data.confirmaciones?.length ?? 0) > 0 && !confirmado) {
    const adv = val.data.confirmaciones
      .map((c) => `- **[${c.regla}]** ${c.mensaje}\n  *Detalle:* ${c.sugerencia}`)
      .join("\n");
    return {
      reply: `La solicitud **${matchCaso}** superó las validaciones críticas, pero requiere **confirmación explícita** antes de crear la OC en SAP:\n\n${adv}\n\nPresiona **"Confirmar excepción"** o responde *"Sí, confirmo"* para proceder.`,
      toolCalls: executedTools,
      tokensUsed: 0,
    };
  }

  if (pay.data?.payload) {
    const resCrear = (await executeToolByName(
      "oc_crear",
      { caso: matchCaso, payload: pay.data.payload, confirmado },
      ctx
    )) as { ok: boolean; data?: { numero_oc: string; idempotente: boolean }; error?: string };
    executedTools.push({
      name: "oc_crear",
      args: { caso: matchCaso, confirmado },
      result: resCrear,
    });

    if (resCrear.ok && resCrear.data) {
      return {
        reply: `Orden de Compra creada exitosamente en SAP para **${matchCaso}**:\n- **Número OC:** \`${resCrear.data.numero_oc}\`${resCrear.data.idempotente ? " *(idempotente)*" : ""}\n- **Evidencia:** \`${ev.data?.ruta}\` y \`${ev.data?.ruta_pdf}\`\n- **Trazabilidad:** \`${pay.data.ruta_trazabilidad}\``,
        toolCalls: executedTools,
        tokensUsed: 0,
      };
    }
  }

  return {
    reply: `No fue posible completar la creación de la orden para ${matchCaso}.`,
    toolCalls: executedTools,
    tokensUsed: 0,
  };
}

export async function runAgentTurn(
  history: ChatTurn[],
  ctx: ToolContext
): Promise<AgentResponse> {
  const apiKey = process.env.GEMINI_API_KEY;
  const executedTools: AgentResponse["toolCalls"] = [];

  if (!apiKey) {
    return ejecutarFlujoDeterministaFallback(history, ctx, executedTools);
  }

  const promptPath = path.join(ctx.directory, "agent", "prompt.md");
  const knowledgePath = path.join(ctx.directory, "src", "knowledge", "ordenes-compra.md");
  const systemInstruction = `${fs.readFileSync(promptPath, "utf-8")}\n\n---\n\n${fs.readFileSync(
    knowledgePath,
    "utf-8"
  )}`;

  const ai = new GoogleGenAI({ apiKey });
  const model = process.env.LLM_MODEL || "gemini-3.8-flash";
  const maxIterations = Number(process.env.MAX_AGENT_ITERATIONS || 25);
  const maxTokens = Number(process.env.MAX_SESSION_TOKENS || 100000);

  const contents: Array<Record<string, unknown>> = history.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));

  let totalTokens = 0;

  try {
    for (let iter = 0; iter < maxIterations; iter++) {
      const response = await generateWithFallback(ai, model, contents, systemInstruction);

      totalTokens += response.usageMetadata?.totalTokenCount ?? 0;
      if (totalTokens > maxTokens) {
        return {
          reply: `Se alcanzó el límite máximo de tokens de sesión (${maxTokens}). Reinicia la conversación para continuar.`,
          toolCalls: executedTools,
          tokensUsed: totalTokens,
        };
      }

      const calls = response.functionCalls;
      if (!calls || calls.length === 0) {
        return {
          reply: response.text ?? "Procesamiento finalizado.",
          toolCalls: executedTools,
          tokensUsed: totalTokens,
        };
      }

      const modelParts: Array<Record<string, unknown>> = calls.map((c) => ({
        functionCall: { name: c.name, args: c.args ?? {} },
      }));
      contents.push({ role: "model", parts: modelParts });

      const responseParts: Array<Record<string, unknown>> = [];
      for (const call of calls) {
        const name = call.name ?? "";
        const args = (call.args ?? {}) as Record<string, unknown>;
        const result = await executeToolByName(name, args, ctx);
        executedTools.push({ name, args, result });
        responseParts.push({
          functionResponse: {
            name,
            response: result as Record<string, unknown>,
          },
        });
      }
      contents.push({ role: "user", parts: responseParts });
    }

    return {
      reply: "Se alcanzó el límite máximo de iteraciones del agente.",
      toolCalls: executedTools,
      tokensUsed: totalTokens,
    };
  } catch {
    return ejecutarFlujoDeterministaFallback(history, ctx, executedTools);
  }
}