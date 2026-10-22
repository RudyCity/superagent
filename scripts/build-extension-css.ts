/**
 * Bun-native Tailwind extension CSS build with Tailwind's official compiler and
 * Rust scanner; no @tailwindcss/cli / @parcel/watcher / braces dependency.
 */
import { compile, optimize } from "@tailwindcss/node";
import { Scanner } from "@tailwindcss/oxide";
import { readFile, writeFile } from "node:fs/promises";
import { watch } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dir,"..");
const source = path.join(root,"chrome-extension","sidepanel.src.css");
const dest = path.join(root,"chrome-extension","sidepanel.css");
const base = path.dirname(source);

export async function buildExtensionCss() {
  const raw=await readFile(source,"utf8");
  const compiler=await compile(raw,{base,from:source,onDependency:()=>{}});
  const sources = (compiler.root==="none" ? [] :
    compiler.root === null ? [{base:root,pattern:"**/*",negated:false}] :
      [{...compiler.root,negated:false}]).concat(compiler.sources);
  const scanner=new Scanner({sources});
  const candidates=scanner.scan();
  const css=optimize(compiler.build(candidates),{minify:false}).code;
  if(!css.includes("tailwindcss") || css.length < 10_000)
    throw new Error("Unexpected output from Tailwind compiler");
  await writeFile(dest,css,"utf8");
  console.log("BUN_EXTENSION_CSS_OK",candidates.length,"candidates",css.length,"bytes");
  return css;
}

if (import.meta.main) {
  await buildExtensionCss();
  if(process.argv.includes("--watch")){
    let pending: ReturnType<typeof setTimeout> | undefined;
    const observer=watch(root,{recursive:true},(_event,filename)=>{
      if(!filename)return;
      const name=filename.replace(/\\/g,"/");
      if(name.startsWith(".git/") || name.startsWith("node_modules/") ||
         name.startsWith("dist/") || name.startsWith(".superagent/") ||
         name==="chrome-extension/sidepanel.css")return;
      clearTimeout(pending);
      pending=setTimeout(()=>{
        buildExtensionCss().catch(e=>console.error("[extension CSS]",e));
      },300);
    });
    process.once("SIGINT",()=>{observer.close();process.exit(0);});
    process.once("SIGTERM",()=>{observer.close();process.exit(0);});
  }
}
