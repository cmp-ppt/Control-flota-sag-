# Sistema de Control de Flota — Propuesta de diseño

Flota: 35 vehículos · 6–8 áreas · 4–20 conductores por área · App móvil offline-first + Dashboard web.

---

## 0. Resumen de decisiones

| Tema | Decisión |
|---|---|
| Estado del vehículo | **Se calcula** a partir de los viajes (nunca se edita a mano): sin viaje abierto = 🟢; viaje abierto dentro del plazo = 🔴; viaje abierto pasado el plazo = 🟡 |
| Offline | Todo registro se guarda en el teléfono con un ID único generado en el dispositivo (UUID) y se sincroniza solo al volver la señal |
| Hora del registro | Se guarda la hora del teléfono al momento de tocar "Guardar" (no la de sincronización) más la marca `creado_offline = Sí` |
| Papel | Libreta mínima de respaldo; el admin la transcribe y sube foto (origen = `PAPEL`) |
| Vencimientos | Tabla de documentos por vehículo con alertas a 60/30/15/7 días y el día del vencimiento |
| Llamar al supervisor | Cada área tiene contactos con teléfono; botón "📞 Llamar" en la app (enlace `tel:`) y en el dashboard, junto a cada vehículo atrasado |

---

## 1. Base de datos (tablas y campos)

Convención: `PK` clave primaria, `FK` clave foránea. Los IDs de registros creados en el móvil son UUID.

### 1.1 Catálogos

**AREA**
| Campo | Tipo | Nota |
|---|---|---|
| id_area (PK) | texto | |
| nombre | texto | |
| activa | sí/no | |

**PROGRAMA**
| id_programa (PK) | nombre | id_area (FK) |

**VEHICULO**
| Campo | Tipo | Nota |
|---|---|---|
| id_vehiculo (PK) | texto | |
| patente | texto único | |
| marca, modelo, anio | texto | |
| id_area (FK) | | área dueña |
| id_programa (FK) | | programa fijo (autocompleta al escanear QR) |
| codigo_qr | texto único | el valor impreso en el QR (ej. `VEH-ABCD12`) |
| km_actual | número | se actualiza con el último KM final válido |
| estado_actual | lista | DISPONIBLE / EN_USO / ATRASADO / MANTENCION (calculado) |
| viaje_abierto_id (FK) | | viaje sin llegada, si existe |
| horas_max_en_uso | número | umbral de alerta por vehículo (por defecto, el del área) |
| tipo_combustible | lista | |
| activo | sí/no | |

**PERSONA** (conductores, supervisores y administradores)
| Campo | Tipo | Nota |
|---|---|---|
| id_persona (PK) | texto | |
| nombre_completo, rut | texto | |
| telefono | texto | formato +569XXXXXXXX |
| email | texto | login |
| rol | lista | CONDUCTOR / SUPERVISOR / ADMIN |
| id_area (FK) | | área principal |
| pin_app | texto | opcional, para identificarse en la app |
| licencia_clase, licencia_vencimiento | | alerta de licencia |
| activo | sí/no | |

**PERSONA_AREA** (un conductor puede apoyar a más de un área)
| id_persona (FK) | id_area (FK) |

**CONTACTO_AREA** (a quién llamar según el área)
| Campo | Tipo | Nota |
|---|---|---|
| id_contacto (PK) | texto | |
| id_area (FK) | | |
| id_persona (FK) | | supervisor/encargado |
| tipo | lista | SUPERVISOR / ENCARGADO_FLOTA / EMERGENCIA / TALLER |
| telefono | texto | puede diferir del teléfono personal |
| orden | número | 1 = primero a llamar |
| horario | texto | ej. "Lun–Vie 08–18", "24/7" |
| activo | sí/no | |

**DESTINO**
| id_destino (PK) | nombre | id_area (FK, opcional = global) | frecuente (sí/no) | activo |
Los destinos nuevos que escribe un conductor entran con `estado = POR_REVISAR` y el admin los aprueba o fusiona con uno existente.

### 1.2 Operación

**VIAJE** (alimenta la bitácora; una fila por salida→llegada; varios por día)
| Campo | Tipo | Nota |
|---|---|---|
| id_viaje (PK, UUID) | texto | generado en el móvil |
| id_vehiculo (FK) | | |
| id_conductor (FK) | | |
| fecha | fecha | de la salida |
| rol_conductor | lista | Titular / Reemplazo / Apoyo (columna "Rol" de la bitácora) |
| origen | texto | por defecto el último destino o la base del área |
| id_destino (FK) | | |
| destino_texto_nuevo | texto | si eligió "Otro" |
| km_inicial | número | |
| hora_salida | fecha-hora | |
| pasajeros | número ≥ 0 | **obligatorio** |
| firma_salida | imagen | |
| km_final | número | ≥ km_inicial |
| hora_llegada | fecha-hora | |
| firma_llegada | imagen | |
| estado_viaje | lista | ABIERTO / CERRADO / ANULADO |
| observaciones | texto | |
| origen_registro | lista | APP / PAPEL |
| foto_respaldo_papel | imagen | solo si PAPEL |
| creado_offline | sí/no | |
| creado_en / sincronizado_en | fecha-hora | |
| registrado_por | FK persona | quien transcribió (si PAPEL) |
| alerta_enviada | sí/no | evita repetir avisos |

Reglas: un vehículo solo puede tener un viaje ABIERTO; `km_inicial` debe ser ≥ `vehiculo.km_actual` (si no, la app avisa "KM menor al último registrado, ¿confirmar?"); `km_final` ≥ `km_inicial`.

**COMBUSTIBLE_CARGA**
| Campo | Tipo | Nota |
|---|---|---|
| id_carga (PK, UUID) | texto | |
| id_vehiculo (FK), id_conductor (FK) | | |
| id_viaje (FK, opcional) | | viaje en curso |
| fecha_hora | fecha-hora | |
| litros | número | |
| monto | número | $ |
| numero_boleta | texto | |
| foto_boleta | imagen | **obligatoria** |
| nivel_estanque_llegada | lista | 1/4, 1/2, 3/4, Lleno (nivel al terminar el servicio) |
| id_tarjeta (FK) | | tarjeta usada |
| km_al_cargar | número | |
| estado_revision | lista | PENDIENTE / VALIDADA / OBSERVADA |
| boleta_fisica_recibida | sí/no | check cruzado |
| fecha_recepcion_fisica | fecha | |
| validada_por (FK), fecha_validacion | | |
| observacion_revision | texto | diferencias de monto, boleta ilegible, etc. |

**TARJETA_COMBUSTIBLE**
| id_tarjeta (PK) | numero_tarjeta (últimos 4) | id_vehiculo (FK) o id_area (FK) | estado (ACTIVA/BLOQUEADA) | cupo_mensual |

**TARJETA_ENTREGA** (registro de entrega/devolución de tarjeta)
| id_entrega (PK) | id_tarjeta (FK) | id_conductor (FK) | fecha_entrega | fecha_devolucion | entregado_por (FK) | firma | observaciones |

### 1.3 Vencimientos y alertas

**DOCUMENTO_VEHICULO**
| Campo | Tipo | Nota |
|---|---|---|
| id_documento (PK) | texto | |
| id_vehiculo (FK) | | |
| tipo | lista | REVISION_TECNICA / PERMISO_CIRCULACION / SEGURO_SOAP / CERT_EMISIONES / OTRO |
| fecha_emision | fecha | |
| fecha_vencimiento | fecha | |
| archivo | imagen/PDF | foto del documento |
| estado | lista | VIGENTE / POR_VENCER / VENCIDO (calculado) |
| dias_para_vencer | número | calculado |
| renovado_por (FK documento) | | al renovar se crea uno nuevo y el anterior queda histórico |
| costo | número | opcional |

Estado: `VENCIDO` si fecha < hoy; `POR_VENCER` si faltan ≤ 30 días; si no, `VIGENTE`.

**CONFIG_ALERTA** (editable por el admin, sin tocar código)
| tipo_alerta | parametro | valor | ejemplo |
|---|---|---|---|
| HORAS_EN_USO | horas | 8 | aviso al supervisor |
| HORAS_EN_USO_CRITICA | horas | 12 | aviso a supervisor + encargado de flota |
| DOC_VENCIMIENTO | dias_antes | 60, 30, 15, 7, 0 | |
| ESTANQUE_BAJO | nivel | menor a 3/4 | |
| BOLETA_PENDIENTE | dias | 5 | boleta física sin entregar |
| LICENCIA_VENCIMIENTO | dias_antes | 30, 7 | |

**ALERTA** (bitácora de alertas generadas)
| id_alerta (PK) | tipo | id_vehiculo (FK) | id_viaje/id_documento (FK) | id_area (FK) | mensaje | severidad (INFO/AVISO/CRITICA) | creada_en | destinatarios | estado (ABIERTA/ATENDIDA/CERRADA) | atendida_por (FK) | comentario_cierre |

**LLAMADA_REGISTRO** (opcional, trazabilidad de consultas al supervisor)
| id (PK) | fecha_hora | id_vehiculo (FK) | id_contacto (FK) | motivo (VEHICULO_NO_REGRESA / CONSULTA / EMERGENCIA) | registrado_por | nota |
Se llena con un botón "Registré la llamada" en el dashboard (no se graba la llamada).

**MANTENCION** (fase 2)
| id (PK) | id_vehiculo | fecha | km | tipo | taller | costo | proxima_km | proxima_fecha |

### 1.4 Relaciones clave

```
AREA 1─N VEHICULO 1─N VIAJE N─1 PERSONA(conductor)
AREA 1─N PERSONA        VEHICULO 1─N COMBUSTIBLE_CARGA N─1 TARJETA_COMBUSTIBLE
AREA 1─N CONTACTO_AREA N─1 PERSONA(supervisor)
VEHICULO 1─N DOCUMENTO_VEHICULO     VEHICULO/VIAJE/DOCUMENTO 1─N ALERTA
```

### 1.5 Bitácora mensual (vista, no tabla)

Consulta que une `VIAJE` (APP y PAPEL) + `COMBUSTIBLE_CARGA` del mes y entrega **exactamente** estas columnas:

`Fecha | Conductor | Programa | Rol | Origen | Destino | KM Inicial | KM Final | Hora Salida | Hora Llegada | Pasajeros | Litros | Valor | N° Boleta | Firma | Observaciones`

- Programa viene del vehículo; Litros/Valor/N° Boleta salen de la carga asociada al viaje (o del día/vehículo si no hay viaje asociado).
- Se genera por **vehículo y mes** (PDF con las firmas incrustadas y Excel para el análisis). Las filas de origen PAPEL llevan una marca discreta (ej. "P") y enlace a la foto de respaldo.
- Totales al pie: KM recorridos, litros, monto, rendimiento (km/l).

---

## 2. Flujo de pantallas

### 2.1 App del conductor

**A. Inicio de sesión (una vez)**: correo/teléfono + PIN. Queda guardada la sesión; el login funciona offline después de la primera vez.

**B. Pantalla principal**
- Barra superior con indicador de conexión: 🟢 En línea · 🟠 Sin señal (modo offline) · "3 registros pendientes de enviar".
- Botones grandes: **📷 Escanear vehículo** · **⛽ Registrar combustible** · **📖 Mis viajes de hoy** · **📞 Llamar al supervisor**.
- Si tiene un viaje abierto, tarjeta destacada: "En ruta: ABCD12 — salió 06:40 → [Registrar llegada]".

**C. Registro de SALIDA**
1. Escanear QR del vehículo (funciona sin internet; la cámara y el catálogo están en el teléfono).
2. La app muestra el vehículo: patente, área, programa (solo lectura) + chips de estado de documentos (⚠ si hay vencimiento próximo) y el último KM.
   - Si el vehículo figura EN_USO por otro conductor: aviso "Este vehículo tiene un viaje abierto desde las 18:10 (Pérez)". Opciones: *Cerrar el viaje anterior* (pide KM/hora, queda observación) o *Cancelar*.
3. Formulario: Conductor (preseleccionado, editable), Rol, **KM inicial** (propone el último KM; debe confirmar), **Hora salida** (ahora, editable), **Destino** (lista de frecuentes con buscador + "➕ Otro destino" con texto libre), **N° pasajeros** (obligatorio, teclado numérico, 0 permitido).
4. **Firma** con el dedo en pantalla.
5. Guardar → mensaje "✅ Salida registrada" (y, si está sin señal, "Guardado en el teléfono, se enviará solo").

**D. Registro de LLEGADA**
1. Escanear el QR → la app detecta el viaje abierto y abre directamente la pantalla de llegada.
2. Muestra resumen (salida, destino, KM inicial). Ingresa **KM final** (validación ≥ inicial; si recorre más de 500 km pide confirmar), **Hora llegada** (ahora, editable), Observaciones (opcional), pregunta "¿Cargó combustible en este viaje?" → atajo a la pantalla de combustible, **Firma**.
3. Pregunta final: "¿Sigue con otro viaje?" → inicia una nueva salida con el KM final como KM inicial (múltiples viajes por día).

**E. Registro de combustible**
1. Escanear QR (o tomarlo del viaje abierto).
2. Litros, Monto ($), N° de boleta, **foto de la boleta** (obligatoria; la cámara se abre directo, con guía "boleta completa y legible").
3. Pregunta "¿Con cuánto estanque queda el vehículo?" (1/4, 1/2, 3/4, Lleno). Si queda bajo 3/4 → mensaje "⚠ Recuerde mantener mínimo 3/4. Cargue antes de entregar", la carga se permite pero se genera alerta al supervisor.
4. Guardar. Recordatorio: "Entregue la boleta física firmada en la oficina".

**F. Modo offline y turno de noche**
- Todo lo anterior funciona sin señal: QR, catálogos (vehículos, destinos, conductores, contactos) descargados de antemano, firma, foto y guardado local.
- Los registros quedan en una cola "Pendientes de enviar". Se sincronizan automáticamente al detectar conexión y al abrir la app; si falla, reintenta y no se pierde nada.
- Las horas se toman del reloj del teléfono y se guarda la marca "registrado sin conexión".
- Medidas para turnos de noche: sincronización de catálogos al inicio de cada turno con Wi-Fi/datos; pantalla en modo oscuro automático; botones grandes; el teléfono advierte "Hay 5 registros sin enviar hace más de 24 h, conéctese a internet".
- Si el celular se queda sin batería o la app falla → **Plan B** (libreta física), ver sección 2.3.

**G. Llamar al supervisor**
- Botón siempre visible en la pantalla principal. Abre la lista de contactos **del área del conductor** (tipo, nombre, horario, orden de llamado) y toca para llamar (marcador del teléfono). Funciona offline, porque la lista de contactos se guarda en el teléfono (la llamada usa red celular, no datos).
- Contacto de emergencia/taller visible en la ficha del vehículo escaneado.

### 2.2 Dashboard web del administrador / encargados

**1. Panel de control (semáforo)**
- Tarjetas de vehículos con filtro por área: 🟢 Disponible · 🔴 En uso · 🟡 Pendiente de llegada/Atrasado · ⚪ En mantención.
- Cada tarjeta: patente, área, conductor actual, hora de salida, destino, horas transcurridas, último KM, nivel de estanque informado, ⚠ documentos por vencer.
- En las tarjetas 🟡: botones **📞 Llamar al supervisor del área** (muestra nombre y teléfono; en celular/softphone abre el marcador) y **📞 Llamar al conductor**, más "Registrar llamada" (queda en `LLAMADA_REGISTRO`).
- Contadores superiores: disponibles / en uso / atrasados / alertas abiertas.

**2. Alertas** (bandeja)
- Lista con severidad, vehículo, área y antigüedad; acciones: *Atender*, *Llamar*, *Comentar*, *Cerrar*.
- Tipos: vehículo atrasado; estanque bajo 3/4; boleta física pendiente; documento por vencer / vencido; licencia por vencer; KM inconsistente.
- Notificaciones por correo y/o WhatsApp/Push al supervisor del área (ver sección 3).

**3. Vencimientos de documentos**
- Tabla por vehículo con columnas Revisión técnica, Permiso de circulación, SOAP, y color por tiempo restante (🟢 > 60 días, 🟡 30–60, 🟠 8–30, 🔴 ≤ 7 o vencido).
- Calendario/lista ordenada por fecha. Botón "Renovar": sube el documento nuevo y fechas; el anterior queda en el historial.
- Un vehículo con documento VENCIDO se marca en rojo en el semáforo y, por política, puede bloquearse la salida (la app avisa y exige confirmación del supervisor).

**4. Bitácora de emergencia (transcripción de papel)**
- Formulario rápido (teclado optimizado): Fecha, Patente, Conductor, KM inicial/final, Horas, Destino, Pasajeros + **subir foto de la hoja**. Se guarda con origen = PAPEL y queda auditado (quién transcribió y cuándo).
- Listado "Viajes de papel del mes" con el porcentaje papel vs. app (meta: ≥ 95 % app).

**5. Combustible y boletas**
- Tabla de cargas: foto de la app, litros, monto, boleta, conductor, estado.
- **Validación cruzada**: al recibir la boleta física firmada, el admin abre la carga, compara foto vs. papel y marca ✅ *Validada* (o ⚠ *Observada* con motivo). Filtro "Pendientes de boleta física" con días de espera.
- Gestión de tarjetas: asignar/entregar/devolver con firma y fecha; consumo por tarjeta; alerta por cargas fuera de patrón (litros superiores a la capacidad del estanque, dos cargas en el mismo día).

**6. Bitácora mensual**
- Selector de mes + vehículo/área → vista previa → **Descargar PDF / Excel** con las 16 columnas exactas. Opción "Generar todas las del mes" (un PDF por vehículo).

**7. Maestros**: vehículos (QR imprimible por vehículo), conductores, áreas/programas, destinos (aprobar nuevos), contactos por área y configuración de alertas.

**8. Reportes** (fase 2): KM y litros por vehículo/área, rendimiento km/l, % de uso, costo por km.

### 2.3 Plan B (papel)

Libreta pequeña en cada vehículo: Fecha · Patente · Conductor · KM salida/llegada · Hora salida/llegada · Destino · N° pasajeros · Firma. Al día siguiente el supervisor/administrador la transcribe (1 min por viaje) y sube la foto. Meta: ≥ 95 % de los viajes en la app.

---

## 3. Alertas (reglas)

| Alerta | Condición | Destinatario | Canal |
|---|---|---|---|
| Vehículo sin llegada | viaje ABIERTO con horas > `HORAS_EN_USO` (def. 8 h; configurable por área) | Supervisor del área | Push/correo + semáforo 🟡 |
| Vehículo sin llegada crítico | > `HORAS_EN_USO_CRITICA` (def. 12 h) | Supervisor + encargado de flota | Push/correo (+ WhatsApp opcional) |
| Estanque bajo | carga/llegada con nivel < 3/4 | Supervisor | Correo |
| Boleta física pendiente | boleta sin recibir tras N días | Administrativo | Correo semanal |
| Revisión técnica / Permiso de circulación / SOAP | 60, 30, 15, 7 días antes y día del vencimiento; luego diario si está vencido | Encargado de flota + supervisor del área | Correo (+ push) |
| Licencia de conductor | 30 y 7 días antes | Supervisor | Correo |
| KM inconsistente | KM inicial < KM final anterior | Administrador | Dashboard |
| Registros sin sincronizar | pendientes > 24 h en un teléfono | Supervisor | Dashboard |

Cada alerta se registra en `ALERTA` y se cierra con comentario ("Llamé al conductor, volvía por ruta alterna").

**Cuidar la fatiga de alertas**: agrupar en un resumen diario por correo (08:00) y reservar el push inmediato para las críticas.

---

## 4. Las 3 herramientas recomendadas

### 🥇 1. AppSheet (Google) — recomendada para partir
- **Offline**: modo offline nativo (lectura/escritura local y sincronización automática), soporta imágenes y firmas offline.
- **QR**: columna tipo `Code scanner`/`Barcode` con cámara; el valor busca el vehículo.
- **Firma y fotos**: tipos `Signature` e `Image` nativos.
- **Dashboard**: vistas de tablero/tabla/mapa y vistas por rol; las automatizaciones (Bots) envían correo, SMS o push y generan PDF/Excel de la bitácora con plantillas.
- **Llamar**: columna de tipo `Phone` con acción "Llamar" por vista.
- **Datos**: Google Sheets para partir (hasta unos pocos miles de filas cómodo); migrar a Cloud SQL / BigQuery si crece.
- **Costo**: por usuario/mes (≈ 40+ usuarios); verificar precio vigente.
- **Pros**: más rápido (2–4 semanas para un MVP), bajo costo, buena curva de aprendizaje. **Contras**: diseño visual limitado, dependencia de Google, sincronización en lote (cuidar conflictos si dos personas editan lo mismo).

### 🥈 2. Microsoft Power Apps (+ Dataverse o SharePoint)
- **Cuándo elegirla**: si la institución ya usa Microsoft 365 y TI exige inicio de sesión corporativo, políticas de datos y auditoría.
- **Offline**: apps *canvas* con modo offline para móviles (`LoadData`/`SaveData` o modo offline de Power Apps con Dataverse). Más trabajo de configuración que AppSheet.
- **QR/Firma/Foto**: control de escáner de códigos, entrada de lápiz (pen input) para firma, cámara.
- **Alertas**: Power Automate (correos, Teams, WhatsApp vía conector) y Power BI para el dashboard.
- **Pros**: integración con Teams/Outlook, seguridad y roles robustos, Power BI. **Contras**: licencias más caras, offline más complejo, curva de aprendizaje mayor.

### 🥉 3. Desarrollo a medida: Flutter (o React Native) + Supabase/Firebase + panel web
- **Cuándo elegirla**: si se quiere app en tienda con marca propia, control total de la sincronización, o hay planes de escalar (más flotas, GPS, telemetría).
- **Offline**: base local (SQLite/Drift o Firestore con persistencia) + cola de sincronización con IDs UUID.
- **Pros**: mejor experiencia, sin costo por usuario, total libertad. **Contras**: más tiempo (2–4 meses) y costo inicial, requiere mantención de código.

**Descartado:** Glide (el modo offline es limitado para escritura y para fotos/firma, algo crítico para turnos de noche).

### Recomendación

Empezar con **AppSheet + Google Sheets/Drive** (MVP en pocas semanas con 1–2 áreas piloto), usar **Power Apps** solo si TI corporativo lo exige, y reservar el **desarrollo a medida** para una fase 2 si el volumen o los requisitos lo justifican.

---

## 5. Plan sugerido

1. **Semana 1–2**: cargar maestros (vehículos, áreas, conductores, destinos, contactos, documentos con vencimientos); imprimir QR.
2. **Semana 3–4**: MVP de app (salida/llegada/combustible/llamar) + semáforo + bitácora PDF/Excel. Piloto en 1–2 áreas, incluyendo turno de noche.
3. **Semana 5–6**: alertas, validación de boletas, transcripción de papel, ajustes con feedback.
4. **Semana 7+**: despliegue al resto de áreas, capacitación (1 hora por área), retiro gradual del papel.

**KPIs**: % de viajes registrados por la app (meta ≥ 95 %), boletas validadas en ≤ 5 días, 0 documentos vencidos, tiempo de generación de la bitácora mensual (meta: minutos en vez de días).

---

## 6. Decisiones pendientes (para validar con ustedes)

1. ¿Cuántas horas se considera "atrasado" (por área)? Los turnos nocturnos pueden requerir otro umbral.
2. ¿Se bloquea la salida de un vehículo con documentos vencidos o solo se avisa?
3. ¿Canal preferido de alertas: correo, push o WhatsApp?
4. ¿Se usa Google Workspace o Microsoft 365 en la institución? (define AppSheet vs. Power Apps).
5. ¿Los conductores usan su celular personal o se entregan equipos? (afecta cámara, batería y datos).
6. ¿Se necesita GPS en una fase posterior? (cambia la arquitectura hacia desarrollo a medida).
