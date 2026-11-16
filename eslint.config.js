// ESLint (flat config). Reglas de corrección, no de estilo: el formato lo da Prettier.
import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['dist/**', 'dist-*/**', 'node_modules/**', 'playwright-report/**', 'test-results/**', '.netlify/**', '.claude/**'] },
  js.configs.recommended,
  {
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    rules: {
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': 'error',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-implicit-coercion': ['error', { allow: ['!!'] }],
      'no-shadow': 'error',
      'no-param-reassign': ['error', { props: false }],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      'object-shorthand': 'error',
      curly: ['error', 'multi-line'],
      // Funciones simples (docs/CALIDAD.md). El tope solo baja: al simplificar
      // la función más compleja, se baja este número (npm run calidad la muestra).
      complexity: ['error', 25],
      'max-depth': ['error', 4],
    },
  },
  // Código del navegador
  { files: ['src/**/*.js', 'public/**/*.js'], languageOptions: { globals: { ...globals.browser } } },
  { files: ['public/sw.js'], languageOptions: { globals: { ...globals.serviceworker } } },
  // Núcleo puro: no debe tocar el DOM ni el almacenamiento del navegador
  {
    files: ['src/core/**/*.js', 'src/lib/**/*.js', 'src/sync/**/*.js', 'src/config/**/*.js', 'src/app/**/*.js'],
    rules: {
      'no-restricted-globals': ['error', 'document', 'window', 'localStorage', 'sessionStorage', 'alert', 'confirm', 'prompt'],
    },
  },
  // La plataforma conoce la especialidad SOLO a través de src/specialties/activa/
  {
    files: ['src/**/*.js'],
    ignores: ['src/specialties/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/specialties/*/*', '!**/specialties/activa/*', '!**/specialties/contrato.js'],
              message: 'Importa la especialidad a través de src/specialties/activa/.',
            },
          ],
        },
      ],
    },
  },
  // Las especialidades no dependen de la interfaz
  {
    files: ['src/specialties/**/*.js'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: ['**/ui/*'], message: 'Una especialidad no puede depender de la interfaz.' }] },
      ],
    },
  },
  // La interfaz usa los diálogos propios (ui/modal.js), no los del navegador
  { files: ['src/ui/**/*.js'], rules: { 'no-restricted-globals': ['error', 'alert', 'confirm', 'prompt'] } },
  // HTML solo con plantillas que escapan solas (ui/html.js: html`…` + setHtml)
  {
    files: ['src/**/*.js'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'AssignmentExpression[left.property.name=/^(innerHTML|outerHTML)$/]',
          message: 'Usa setHtml(el, html`…`) de src/ui/html.js: escapa los datos solo.',
        },
        {
          selector: "CallExpression[callee.property.name='insertAdjacentHTML']",
          message: 'Usa setHtml(el, html`…`) de src/ui/html.js.',
        },
      ],
    },
  },
  // Node: scripts, función de Netlify y pruebas
  {
    files: ['scripts/**/*.mjs', 'netlify/**/*.mjs', 'tests/**/*.js', 'e2e/**/*.js', '*.config.js'],
    languageOptions: { globals: { ...globals.node } },
    rules: { 'no-console': 'off' },
  },
  // Pruebas e2e: el código dentro de page.evaluate() corre en el navegador
  { files: ['e2e/**/*.js'], languageOptions: { globals: { ...globals.browser } } },
];
