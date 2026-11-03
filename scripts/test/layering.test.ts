// The layering in docs/PROJECT-MAP.md was convention only: nothing ran, so the
// one edge that already broke it (src/skins/index.ts -> src/render/quadrascan.json,
// a skins<->render cycle) survived a year of green suites and was found by a
// human reading an import graph. This is that graph, as a test.
//
// It enumerates src/ itself rather than taking a file list, so a file added
// tomorrow is covered tomorrow without anyone remembering. Every rule is its
// own assertion and every message names the offending file, its line, and the
// specifier — "the layering is violated" is not something anyone can act on.
//
// Precedent: scripts/test/bot-node-import.test.ts, which guards one directory's
// import STYLE the same way this guards the whole tree's import DIRECTION.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../../src/", import.meta.url));

/** Anything node or a bundler would read as a module. Deliberately wider than
 *  the ".ts everywhere" the tree has today: a stray .mjs must not be a hole. */
const SOURCE_EXT = /\.(?:m|c)?[jt]sx?$/;

function sourceFiles(dir = SRC, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (SOURCE_EXT.test(entry.name)) out.push(full);
  }
  return out;
}

/** Blank out comments, in place, so the import scan cannot read a path out of
 *  prose — this repo's comments quote import paths constantly, including the
 *  header of this file. Strings are stepped over rather than blanked (the
 *  specifiers ARE strings) so a "//" inside one never opens a comment.
 *  Positions are preserved, so a match index still gives the real line.
 *  Not a parser: a regex literal containing an unescaped "//", or a nested
 *  template substitution, would confuse it. Neither exists in src/. */
function blankComments(src: string): string {
  const out = src.split("");
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (c === "/" && d === "/") {
      while (i < src.length && src[i] !== "\n") out[i++] = " ";
      continue;
    }
    if (c === "/" && d === "*") {
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] !== "\n") out[i] = " ";
        i++;
      }
      out[i] = " ";
      out[i + 1] = " ";
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      i++;
      while (i < src.length && src[i] !== c) i += src[i] === "\\" ? 2 : 1;
      i++;
      continue;
    }
    i++;
  }
  return out.join("");
}

/** `from "x"`, a bare `import "x"`, and a dynamic `import("x")`. The lookbehind
 *  keeps `Array.from("./…")` out of the graph. */
const SPECIFIER = /(?<![.\w])(?:from|import)\s*\(?\s*["']([^"']+)["']/g;

/** A path relative to src/ -> the layer that owns it. `outside` is a relative
 *  import that leaves src/ altogether. */
function layerOf(relFromSrc: string): string {
  const rel = relFromSrc.split(path.sep).join("/");
  if (rel.startsWith("..")) return "outside";
  if (rel === "main.ts") return "main";
  const [top = rel, second = ""] = rel.split("/");
  return top === "modules" ? `modules/${second}` : top;
}

interface Edge {
  /** Repo-relative, e.g. `src/skins/index.ts`. */
  readonly file: string;
  readonly line: number;
  readonly spec: string;
  readonly from: string;
  readonly to: string;
}

/** Every internal edge in src/, computed once. Self-edges (a layer importing
 *  itself) are dropped: they say nothing about layering. Package specifiers
 *  ("three/webgpu", "node:fs") are not internal edges and are skipped. */
const EDGES: readonly Edge[] = sourceFiles().flatMap((full) => {
  const relFile = `src/${path.relative(SRC, full).split(path.sep).join("/")}`;
  const from = layerOf(path.relative(SRC, full));
  const text = readFileSync(full, "utf8");
  const code = blankComments(text);
  const found: Edge[] = [];
  for (const match of code.matchAll(SPECIFIER)) {
    const spec = match[1] ?? "";
    if (!spec.startsWith(".")) continue;
    const to = layerOf(path.relative(SRC, path.resolve(path.dirname(full), spec)));
    if (to === from) continue;
    const line = text.slice(0, match.index).split("\n").length;
    found.push({ file: relFile, line, spec, from, to });
  }
  return found;
});

function show(edges: readonly Edge[]): string {
  return edges.map((e) => `${e.file}:${e.line} imports "${e.spec}"  (${e.from} -> ${e.to})`).join("\n");
}

function edgesFrom(layer: string): Edge[] {
  return EDGES.filter((e) => e.from === layer);
}

const MODULE_LAYERS = [...new Set(EDGES.map((e) => e.from).filter((l) => l.startsWith("modules/")))];

/** The table in docs/PROJECT-MAP.md, plus the two layers it does not name:
 *  `skins` is leaf data (this is the cycle vect-hack-t72k broke), and `main.ts`
 *  is the composition root, which may reach anything. */
const ALLOWED: Record<string, readonly string[]> = {
  backplane: [],
  skins: [],
  bot: ["backplane"],
  render: ["backplane", "skins"],
  ui: ["backplane", "render", "skins"],
  main: ["backplane", "bot", "render", "ui", "skins", "outside", ...MODULE_LAYERS],
};
const MODULE_ALLOWED = ["backplane", "bot", "render", "ui", "skins"];

describe("the layering holds", () => {
  it("finds the source tree it is supposed to be guarding", () => {
    // A walk that silently found nothing would make every assertion below pass.
    expect(sourceFiles().length).toBeGreaterThan(100);
    expect(EDGES.length).toBeGreaterThan(100);
  });

  it("the Backplane imports nothing above it", () => {
    const bad = edgesFrom("backplane");
    expect(bad, `src/backplane/ may import only src/backplane/:\n${show(bad)}`).toEqual([]);
  });

  it("the Backplane never touches the DOM", () => {
    // persistFs.ts reads `scope.window` to detect a window's ABSENCE — that is
    // the guard, not a use, and `scope.window` is not `window.`.
    const bad: string[] = [];
    for (const full of sourceFiles(path.join(SRC, "backplane"))) {
      const code = blankComments(readFileSync(full, "utf8"));
      for (const match of code.matchAll(/(?<![.\w])(?:document|window)\s*\./g)) {
        const line = code.slice(0, match.index).split("\n").length;
        bad.push(`src/backplane/${path.basename(full)}:${line} uses ${match[0].trim()}`);
      }
    }
    expect(bad, `the Backplane runs in a worker and owns no DOM:\n${bad.join("\n")}`).toEqual([]);
  });

  it("src/render/ and src/ui/ are game-free", () => {
    const bad = [...edgesFrom("render"), ...edgesFrom("ui")].filter(
      (e) => e.to.startsWith("modules/") || e.to === "main",
    );
    expect(bad, `the shared layers consume a Backplane CellGrid and know no Module:\n${show(bad)}`).toEqual([]);
  });

  it("src/bot/ imports only the Backplane", () => {
    const bad = edgesFrom("bot").filter((e) => e.to !== "backplane");
    expect(bad, `src/bot/ is shared by the browser bot and the headless gym:\n${show(bad)}`).toEqual([]);
  });

  it("no Module imports another Module", () => {
    const bad = EDGES.filter((e) => e.from.startsWith("modules/") && e.to.startsWith("modules/"));
    expect(bad, `each Module is self-contained; share through the Backplane instead:\n${show(bad)}`).toEqual([]);
  });

  it("nothing imports main.ts", () => {
    const bad = EDGES.filter((e) => e.to === "main");
    expect(bad, `main.ts is the composition root — it imports, it is not imported:\n${show(bad)}`).toEqual([]);
  });

  it("src/skins/ is leaf data — it imports nothing outside itself", () => {
    // The one violation the 2026-08-27 review found: skins read the vendored
    // token file out of src/render/ while render read src/skins/, a cycle.
    // The token file now lives at src/skins/tokens/quadrascan.json.
    const bad = edgesFrom("skins");
    expect(bad, `src/skins/ is the single source of truth for colour; nothing above it may be a dependency:\n${show(bad)}`).toEqual([]);
  });

  it("every edge in src/ is one the table allows", () => {
    // The catch-all, so a layer or a Module added tomorrow is covered by the
    // table rather than by the six named rules happening to mention it.
    const bad = EDGES.filter((e) => {
      const allowed = e.from.startsWith("modules/") ? MODULE_ALLOWED : ALLOWED[e.from];
      return allowed === undefined || !allowed.includes(e.to);
    });
    const table = Object.entries(ALLOWED)
      .map(([from, to]) => `  ${from} -> ${to.length ? to.join(", ") : "(nothing)"}`)
      .join("\n");
    expect(bad, `edges outside docs/PROJECT-MAP.md's table:\n${show(bad)}\nthe table is:\n${table}\n  modules/X -> ${MODULE_ALLOWED.join(", ")}`).toEqual([]);
  });
});
