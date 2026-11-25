# Agente de Órdenes de Compra SAP — Reto 03 (Periferia IT Group)

Agente conversacional con herramientas deterministas en TypeScript + Zod que automatiza la recepción, validación contra maestros corporativos (`RC1`–`RC10`), generación de evidencia auditable (`.txt` con SHA-256 y `.pdf`) y creación idempotente de Órdenes de Compra (OC) en SAP.

## Requisitos
- Node.js 20+ (o Bun 1.1+)
- Clave de API de Google AI Studio (`GEMINI_API_KEY`) para la interfaz conversacional (no requerida para `npm run demo`).

## Instalación y ejecución rápida

1. Instalar dependencias:
   ```bash
   npm install