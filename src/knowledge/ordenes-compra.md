# Dominio de Órdenes de Compra SAP — Periferia IT Group

## Parámetros organizacionales fijos
- **Sociedad SAP:** `1000`
- **Organización de compras:** `1000`
- **Unidades de medida permitidas:** `UN` (Unidad), `H` (Hora), `MES` (Mes)
- **Monedas soportadas:** `COP`, `USD`

## Reglas de Control (RC1 – RC10)
- **RC1 (Bloqueo):** El proveedor debe existir en el maestro SAP (`proveedores.json`) y estar `activo: true`. Si falta `proveedor_nit` en la solicitud, se resuelve por nombre normalizado.
- **RC2 (Bloqueo):** Debe existir correo de aprobación (`aprobacion.json`) con la palabra `"Aprobado"` enviado por un aprobador autorizado del `centro_costo`.
- **RC3 (Bloqueo):** `valor_total` de la solicitud debe ser menor o igual al `tope` del aprobador en ese centro de costo.
- **RC4 (Bloqueo):** La `subarea` debe pertenecer al listado de `subareas` válidas del `centro_costo`.
- **RC5 (Confirmación):** Si no hay cotización o si `|cotizacion.total - valor_total| / valor_total > 0.02` (2%), se exige confirmación explícita antes de crear la OC.
- **RC6 (Confirmación):** Si `indicador_iva` está ausente en la solicitud, se deriva del maestro del proveedor y se solicita confirmación explícita.
- **RC7 (Informativo):** Si `condiciones_pago` está ausente, se deriva del maestro del proveedor y se informa en el resumen.
- **RC8 (Confirmación):** Si existe `factura.txt` con fecha anterior a `fecha_solicitud`, se marca `retroactiva: true` y se solicita confirmación explícita.
- **RC9 (Confirmación):** La fecha de aprobación debe ser igual o posterior a `fecha_solicitud`.
- **RC10 (Bloqueo):** Consistencia aritmética `cantidad * valor_unitario == valor_total` (tolerancia ±1 unidad monetaria).