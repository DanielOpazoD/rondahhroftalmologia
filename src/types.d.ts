// Declaraciones para el verificador de tipos (tsc --checkJs).
// La plantilla PDF se importa como base64 (loader de esbuild en scripts/build.mjs).
declare module '*.pdf' {
  const base64: string;
  export default base64;
}
