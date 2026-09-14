import { join } from "node:path"

const entrypoints = ["src/background.ts", "src/content.ts", "src/options.ts"].map((entry) =>
  join(import.meta.dir, entry),
)

// MV2 background, content and options scripts are classic scripts, so every entry is
// bundled on its own as an IIFE; dist ships as-is, hence no minify or sourcemap.
export function buildExtension(outdir: string): Promise<Bun.BuildOutput> {
  return Bun.build({
    entrypoints,
    outdir,
    target: "browser",
    format: "iife",
    minify: false,
    sourcemap: "none",
  })
}

if (import.meta.main) {
  const result = await buildExtension(join(import.meta.dir, "dist"))
  if (!result.success) {
    for (const log of result.logs) {
      console.error(log)
    }
    process.exit(1)
  }
  for (const output of result.outputs) {
    console.log(output.path)
  }
}
