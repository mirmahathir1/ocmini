import path from "path"
import { fileURLToPath, pathToFileURL } from "url"
import npa from "npm-package-arg"
import { Filesystem } from "@/util/filesystem"

const INDEX_FILES = ["index.ts", "index.tsx", "index.js", "index.mjs", "index.cjs"]

function parse(spec: string) {
  try {
    return npa(spec)
  } catch {}
}

export function parsePluginSpecifier(spec: string) {
  const hit = parse(spec)
  if (hit?.type === "alias" && !hit.name) {
    const sub = (hit as npa.AliasResult).subSpec
    if (sub?.name) {
      const version = !sub.rawSpec || sub.rawSpec === "*" ? "latest" : sub.rawSpec
      return { pkg: sub.name, version }
    }
  }
  if (!hit?.name) return { pkg: spec, version: "" }
  if (hit.raw === hit.name) return { pkg: hit.name, version: "latest" }
  return { pkg: hit.name, version: hit.rawSpec }
}

function isAbsolutePath(raw: string) {
  return path.isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw)
}

async function resolveDirectoryIndex(dir: string) {
  for (const name of INDEX_FILES) {
    const file = path.join(dir, name)
    if (await Filesystem.exists(file)) return file
  }
}

export function isPathPluginSpec(spec: string) {
  return spec.startsWith("file://") || spec.startsWith(".") || isAbsolutePath(spec)
}

export async function resolvePathPluginTarget(spec: string) {
  const raw = spec.startsWith("file://") ? fileURLToPath(spec) : spec
  const file = path.isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw) ? raw : path.resolve(raw)
  const stat = await Filesystem.statAsync(file)
  if (!stat?.isDirectory()) {
    if (spec.startsWith("file://")) return spec
    return pathToFileURL(file).href
  }

  if (await Filesystem.exists(path.join(file, "package.json"))) {
    return pathToFileURL(file).href
  }

  const index = await resolveDirectoryIndex(file)
  if (index) return pathToFileURL(index).href

  throw new Error(`Plugin directory ${file} is missing package.json or index file`)
}
