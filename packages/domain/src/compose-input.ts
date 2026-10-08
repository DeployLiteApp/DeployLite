import { env } from "node:process";
import { isAlias, isMap, isNode, isPair, isScalar, parseDocument, visit } from "yaml";

const MAX_AST_VISITS = 8_192;
const MAX_AST_DEPTH = 16;

/** Decode one closed YAML1.2/JSON document without resolving aliases or tags. */
export function decodeComposeInput(source: string): unknown {
  // The library debug flags print raw tokens even when warning logging is disabled.
  // Refuse before parsing; never mutate process settings or consult secret values.
  if (env.LOG_STREAM || env.LOG_TOKENS) throw new Error("Unsupported Compose document.");
  const document = parseDocument(source, {
    version: "1.2",
    schema: "core",
    strict: true,
    uniqueKeys: true,
    stringKeys: true,
    resolveKnownTags: false,
    customTags: [],
    merge: false,
    prettyErrors: false,
    logLevel: "error"
  });
  const tags = document.directives?.tags;
  if (document.errors.length || document.warnings.length || !isMap(document.contents)
    || document.directives?.yaml.version !== "1.2"
    || !tags || Object.keys(tags).length !== 1 || tags["!!"] !== "tag:yaml.org,2002:") {
    throw new Error("Unsupported Compose document.");
  }

  let visits = 0;
  let rejected = false;
  visit(document, (_key, node, path) => {
    if (++visits > MAX_AST_VISITS || path.length > MAX_AST_DEPTH || isAlias(node)
      || (isNode(node) && (node.tag || ("anchor" in node && node.anchor)))
      || (isPair(node) && (!isScalar(node.key) || typeof node.key.value !== "string" || node.key.value === "<<"))) {
      rejected = true;
      return visit.BREAK;
    }
  });
  if (rejected) throw new Error("Unsupported Compose document.");
  return document.toJS({ mapAsMap: false, maxAliasCount: 0 });
}
