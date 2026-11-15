# Cambios

## 2.2.0 — 2026-11-14

### Cambiado
- **Interfaz rediseñada**, más limpia y minimalista:
  - superficies neutras, un solo color de acento y tipografía más sobria;
  - navegación con iconos (barra inferior en el celular);
  - controles segmentados y casillas con estado claro;
  - barra de acciones flotante;
  - modo oscuro automático.
- Las salidas (PDF, Excel, nota, exportaciones) no cambian.

### Despliegue
- Sitio en producción: https://hhr-rondas.netlify.app, con despliegue automático desde `main`.
- Variable `SYNC_TOKEN_SHA256` configurada en Netlify.

## 2.1.0 — 2026-11-14

### Nuevo
- **Sincronización cifrada de extremo a extremo** entre varios PC, mediante una Netlify Function y Netlify Blobs:
  - AES-256-GCM, con la clave derivada de una contraseña del equipo que nunca sale del PC;
  - el servidor solo guarda un id, la versión y el texto cifrado;
  - sincroniza en segundo plano, sigue funcionando sin conexión y propaga las eliminaciones;
  - un indicador en la cabecera muestra el estado.
- **Instalable y sin conexión desde la web** (service worker y manifest).
- `netlify.toml` con cabeceras de seguridad, y `npm run dev` para un servidor local con sincronización.
- Documentación en `docs/SINCRONIZACION.md`.

### Cambiado
- CSP: `connect-src 'self'`, porque ahora la app se conecta a su propio servidor.
- El build genera `dist/index.html` (para Netlify) además de la copia para usar con doble clic.
- 58 tests.

## 2.0.0 — 2026-11-14

Reescritura modular de `Hoja_Atencion_Oftalmologica.html` (v1). Lee los datos existentes de la v1 sin migración manual.

### Nuevo
- **Exportación seudonimizada** (Excel y JSON para IA) con código estable por paciente (`P-XXXXXXXX`), limpieza de textos libres, opciones de fecha, edad y texto, verificación automática de fugas y tabla de correspondencia confidencial aparte.
- **ZIP con todos los PDF** del filtro, nombrados `Oftalmo_fecha_RUT_nombre.pdf`.
- **Excel real (.xlsx)** de estadística, que reemplaza a los CSV. Trae las hojas Resumen, Atenciones (incluye columnas 0/1 por diagnóstico), Prestaciones (una fila por procedimiento), Por día, y Edad y sexo.
- Campo **Sexo** y estadística por grupo etario y sexo, con edad promedio y mediana.
- Estadística por día, por operativo y por médico, más porcentajes.
- **Validación**: dígito verificador del RUT, rangos de edad y PIO, fecha futura, catarata sin ojo y aviso de atención duplicada el mismo día.
- Pestaña **Exportar** con un filtro compartido con Estadística.
- Ajustes: PDF aplanado o editable, pie de página, texto de la línea final de la nota, alternar PIO por procedimiento.

### PDF mejorado
- Los textos que no caben con letra legible (mínimo 7 pt) ya no se encogen hasta 4 pt ni se cortan: pasan a una **hoja complementaria**.
- Los procedimientos realizados se listan en una tabla (procedimiento, ojo, PIO OD/OI) cuando no caben en la hoja 1.
- Pie con el ID de atención, la fecha de emisión y «Página X de Y».
- Metadatos del documento (título, autor, asunto).
- Formulario aplanado (no editable) por defecto.

### Técnico
- Código en módulos ES (`src/`): lógica pura separada de la interfaz y del almacenamiento.
- Build con esbuild a un solo HTML que funciona sin conexión.
- Política CSP que bloquea toda conexión de red.
- 48 tests con `node:test`.
- Documentación en `docs/`.
