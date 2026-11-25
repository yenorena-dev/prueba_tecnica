import "dotenv/config";
import cors from "cors";
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { ChatTurn, runAgentTurn } from "./agent.js";

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(process.cwd(), "public")));

const sessions = new Map<string, ChatTurn[]>();

app.get("/api/casos", (_req, res) => {
  const solDir = path.join(process.cwd(), "fixtures", "reto-03", "solicitudes");
  if (!fs.existsSync(solDir)) {
    res.json({ casos: [] });
    return;
  }
  const casos = fs
    .readdirSync(solDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  res.json({ casos });
});

app.get("/api/estado", (_req, res) => {
  const outDir = path.join(process.cwd(), "out");
  const ordenesPath = path.join(outDir, "sap", "ordenes.jsonl");
  const csvPath = path.join(outDir, "control.csv");

  const ordenes = fs.existsSync(ordenesPath)
    ? fs
        .readFileSync(ordenesPath, "utf-8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as unknown)
    : [];

  const controlCsv = fs.existsSync(csvPath) ? fs.readFileSync(csvPath, "utf-8") : "";
  res.json({ ordenes, controlCsv });
});

app.post("/api/chat", async (req, res) => {
  try {
    const { sessionId = "default", message } = req.body as {
      sessionId?: string;
      message?: string;
    };
    if (!message || !message.trim()) {
      res.status(400).json({ error: "El mensaje no puede estar vacío." });
      return;
    }

    const history = sessions.get(sessionId) ?? [];
    history.push({ role: "user", content: message.trim() });

    const result = await runAgentTurn(history, {
      directory: process.cwd(),
      sessionId,
    });

    history.push({ role: "assistant", content: result.reply });
    sessions.set(sessionId, history);

    res.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: `Error interno del agente: ${msg}` });
  }
});

app.post("/api/reset", (req, res) => {
  const { sessionId = "default" } = req.body as { sessionId?: string };
  sessions.delete(sessionId);
  res.json({ ok: true });
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`Agente Órdenes de Compra SAP activo en http://localhost:${port}`);
});