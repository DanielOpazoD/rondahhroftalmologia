# Cómo contribuir

## Requisitos

- Node.js 22 (o 20.10 o superior)
- Python 3, que algunas pruebas usan como lector independiente de ZIP y XLSX

```bash
npm ci
```

```bash
npx playwright install chromium
```

El segundo comando solo hace falta para las pruebas en navegador.

## Antes de subir un cambio

```bash
npm run check
```

`npm run check` corre, en orden:

1. ESLint, para detectar errores de lógica y reglas de capas;
2. Prettier, para el formato;
3. `tsc --checkJs`, que revisa los tipos declarados en JSDoc;
4. las pruebas;
5. el build.

Si cambiaste la interfaz o la sincronización, corre también:

```bash
npm run test:e2e
```

```bash
npm run test:stress
```

`test:e2e` corre las pruebas en un navegador real. `test:stress` corre 200 escenarios de varios PC sincronizando a la vez.

La CI de GitHub (`.github/workflows/ci.yml`) repite todo esto en cada push y pull request. También verifica que `dist/` esté reconstruido: el archivo `dist/Hoja_Atencion_Oftalmologica.html` se distribuye para usarlo con doble clic, así que siempre debe coincidir con el código.

## Reglas de la base de código

| Regla | Cómo se asegura |
|---|---|
| `src/core`, `src/lib`, `src/sync` y `src/config` son lógica pura: sin DOM ni `localStorage` | ESLint (`no-restricted-globals`) |
| La interfaz no usa `alert`, `confirm` ni `prompt` (usa `ui/modal.js`) | ESLint y una prueba |
| Todo texto ingresado por el usuario que va a `innerHTML` pasa por `escapeHtml` | Revisión de código |
| Cada id que usa la interfaz existe en `index.html` | Prueba |
| La versión vive solo en `package.json` | `src/config/catalogs.js` la importa |
| Dependencias con versión exacta | `package.json` y `package-lock.json` |
| Cambios en datos o sincronización van con pruebas, incluida convergencia con varios PC | Revisión de código |
| Un cambio de formato de las atenciones agrega un paso en `core/migrations.js` y sube `SCHEMA_VERSION` | Prueba (`audit.test.js`: existe un paso por versión) |
| Los datos clínicos se leen y escriben solo a través de `storage/repo.js` | Revisión de código |

## Versiones y publicación

1. Sube `version` en `package.json` siguiendo semver:
   - corrección: 2.6.**1**;
   - función nueva: 2.**7**.0;
   - cambio incompatible de datos: **3**.0.0.
2. Agrega la entrada en `CHANGELOG.md`.
3. `npm run check`, y luego commit con `dist/` reconstruido.
4. Al hacer push a `main`, Netlify publica automáticamente en https://hhr-rondas.netlify.app.

## Datos de pacientes

Nunca subas respaldos, exportaciones ni PDF reales al repositorio (es público); `.gitignore` los excluye. Las pruebas usan solo datos ficticios.
