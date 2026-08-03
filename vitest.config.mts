import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

/**
 * Vitest corre los módulos fuera de Next, así que el alias `@/` de `tsconfig.json`
 * no le llega solo. Sin esto, cualquier módulo testeado que importe `@/algo`
 * —o que lo importe alguien de su cadena— falla al resolver, aunque `tsc` esté
 * conforme. Se replica acá el único alias del proyecto.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
