// A static scan of the built package. Run with `pnpm test:dist` after
// `pnpm build`. A missing `dist/` fails, it never skips.
//
// The scan parses the built files with TypeScript's parser instead of
// matching text, so a package name in a comment, a string or an error message
// is not an import.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = join(root, "dist");

/** Packages only the optional entries may load, and only lazily. */
const PROVIDERS = [
  "@wraps.dev/email",
  "@opencoredev/email-sdk",
  "@aws-sdk/client-sesv2",
] as const;

const isProvider = (specifier: string) =>
  PROVIDERS.some((p) => specifier === p || specifier.startsWith(`${p}/`));

type Reference = {
  file: string;
  specifier: string;
  /** `static`: `import`/`export ... from`/`require`. `dynamic`: `import()`. */
  kind: "static" | "dynamic";
};

/** Every module reference in one file's source. */
function referencesIn(file: string, source: string): Reference[] {
  const found: Reference[] = [];
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const literal = (node: ts.Node | undefined) =>
    node &&
    (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
      ? node.text
      : undefined;
  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier
    ) {
      const specifier = literal(node.moduleSpecifier);
      if (specifier !== undefined) {
        found.push({ file, specifier, kind: "static" });
      }
    } else if (ts.isCallExpression(node)) {
      const first = literal(node.arguments[0]);
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        found.push({ file, specifier: first ?? "<computed>", kind: "dynamic" });
      } else if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === "require" &&
        first !== undefined
      ) {
        found.push({ file, specifier: first, kind: "static" });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

/** Every reference reachable from `entry` through local files, the entry included. */
function reachable(entry: string): Reference[] {
  const seen = new Set<string>();
  const references: Reference[] = [];
  const queue = [join(dist, entry)];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    expect(existsSync(file), `${relative(root, file)} is missing`).toBe(true);
    const source = readFileSync(file, "utf8");
    for (const ref of referencesIn(relative(root, file), source)) {
      references.push(ref);
      if (ref.specifier.startsWith(".")) {
        queue.push(resolve(dirname(file), ref.specifier));
      }
    }
  }
  return references;
}

const providers = (entry: string, kind?: Reference["kind"]) =>
  reachable(entry)
    .filter((ref) => isProvider(ref.specifier))
    .filter((ref) => !kind || ref.kind === kind)
    .map((ref) => `${ref.kind} ${ref.specifier} in ${ref.file}`);

describe("the scanner", () => {
  it("finds imports, requires and dynamic imports, not comments or strings", () => {
    const refs = referencesIn(
      "fixture.js",
      `// import "@wraps.dev/email";
       import a from "kept-a";
       export { b } from "kept-b";
       const c = require("kept-c");
       const d = () => import("kept-d");
       const e = 'import x from "@aws-sdk/client-sesv2"';`,
    ).map((r) => `${r.kind}:${r.specifier}`);
    expect(refs.sort()).toEqual(
      [
        "static:kept-a",
        "static:kept-b",
        "static:kept-c",
        "dynamic:kept-d",
      ].sort(),
    );
  });
});

describe("the root entry", () => {
  it.each(["index.js", "index.cjs"])(
    "%s references no provider SDK, statically or dynamically",
    (entry) => {
      expect(providers(entry)).toEqual([]);
    },
  );
});

describe("the adapter entries", () => {
  it.each([
    ["wraps.js", "@wraps.dev/email"],
    ["wraps.cjs", "@wraps.dev/email"],
    ["ses.js", "@aws-sdk/client-sesv2"],
    ["ses.cjs", "@aws-sdk/client-sesv2"],
  ])("%s loads %s only inside import()", (entry, sdk) => {
    expect(providers(entry, "static")).toEqual([]);
    expect(providers(entry, "dynamic")).toEqual([
      expect.stringMatching(new RegExp(`^dynamic ${sdk} in `)),
    ]);
  });

  it.each(["email-sdk.js", "email-sdk.cjs", "testing.js"])(
    "%s references no provider SDK (the client is passed in)",
    (entry) => {
      expect(providers(entry)).toEqual([]);
    },
  );
});

describe("package.json", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    main?: string;
    module?: string;
    types?: string;
    exports: Record<string, Record<string, string>>;
  };

  it("lists every entry point", () => {
    expect(Object.keys(pkg.exports)).toEqual([
      ".",
      "./wraps",
      "./email-sdk",
      "./ses",
      "./testing",
    ]);
  });

  it("has every path in `exports` (and main, module, types) in dist/", () => {
    const wanted = [
      ...Object.values(pkg.exports).flatMap((entry) => Object.values(entry)),
      pkg.main,
      pkg.module,
      pkg.types,
    ].filter((p): p is string => typeof p === "string");
    const missing = wanted.filter((p) => !existsSync(resolve(root, p)));
    expect(missing).toEqual([]);
  });
});
