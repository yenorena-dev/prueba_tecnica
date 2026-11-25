# SOLUCION.md — Reto 03: Agente de Órdenes de Compra SAP

## 1. Arquitectura de la solución

La solución separa estrictamente el **razonamiento conversacional (LLM)** de la **ejecución determinista de reglas de negocio, validaciones contables y persistencia SAP**:

```text
+-------------------------------------------------------------------+
|                   Interfaz Web (public/index.html)                |
|            Chat interactivo + Panel de casos + Estado SAP         |
+---------------------------------+---------------------------------+
                                  | HTTP POST /api/chat
+---------------------------------v---------------------------------+
|                   Servidor Express (src/server.ts)                |
|         Gestión de sesiones, límites de tokens e iteraciones      |
+---------------------------------+---------------------------------+
                                  |
+---------------------------------v---------------------------------+
|                 Orquestador Agente (src/agent.ts)                 |
|   Prompt (agent/prompt.md) + Conocimiento (ordenes-compra.md)     |
|        Fallback resiliente multi-modelo (Gemini 3.8 Flash)        |
+---------------------------------+---------------------------------+
                                  | Function Calling (JSON)
+---------------------------------v---------------------------------+
|         Herramientas Deterministas Tipadas (src/tools/oc.ts)      |
|  1. oc_leer_paquete       -> Normalización de NIT, montos y fechas|
|  2. oc_validar            -> Motor de reglas RC1 - RC10           |
|  3. oc_generar_evidencia  -> TXT con SHA-256 + PDF (pdf-lib)      |
|  4. oc_construir_payload  -> Validación Zod + trazabilidad.json   |
|  5. oc_crear              -> Idempotencia + control.csv           |
+---------------------------------+---------------------------------+
                                  | Interfaz SapAdapter
+---------------------------------v---------------------------------+
|              Adaptador SAP Mock (src/sap/mock.ts)                 |
|   Persistencia append-only en out/sap/ordenes.jsonl (4500000001+) |
+-------------------------------------------------------------------+