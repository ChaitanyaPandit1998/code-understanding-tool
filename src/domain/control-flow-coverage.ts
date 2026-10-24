import ts from "typescript";

type CoverageNode = { id: string; label: string };
type CoverageEdge = { from: string; to: string; label: string };
type CoverageVisual = { kind: string; nodes: CoverageNode[]; edges: CoverageEdge[] };

const genericBranchLabels = new Set([
  "continue",
  "continues",
  "continue calculation",
  "either outcome",
  "next",
  "proceed",
  "then continue",
]);

/**
 * Check control-flow visuals for explicit, distinct branches matching source decisions.
 */
export function hasCompleteControlFlowCoverage(sourceText: string, visual: CoverageVisual): boolean {
  if (visual.kind !== "control_flow") return true;

  const sourceDecisions = collectSourceDecisions(sourceText);
  const decisionCount = countSourceDecisions(sourceText);
  if (decisionCount === 0) return true;

  const nodesById = new Map(visual.nodes.map((node) => [node.id, node]));
  const outgoing = new Map<string, CoverageEdge[]>();
  for (const edge of visual.edges) {
    if (!nodesById.has(edge.from) || !nodesById.has(edge.to)) continue;
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge]);
  }

  const decisionNodes = [...outgoing.entries()].filter(([, edges]) => edges.length > 1);
  // A diagram may include meaningful runtime outcomes that are not explicit
  // syntax decisions (for example, a promise resolving or rejecting). Require
  // at least one diagram branch per source decision, but allow those extra
  // branches when every source condition can still be matched distinctly.
  if (decisionNodes.length < decisionCount) return false;

  if (!decisionNodes.every(([, edges]) => hasDistinctOutcomes(edges, nodesById))) return false;
  if (sourceDecisions.length !== decisionCount) return true;
  const decisionsWithTerms = sourceDecisions.filter((decision) => decision.length > 0);
  return decisionsWithTerms.length === 0 || conditionsHaveMatchingDiagramNodes(decisionsWithTerms, decisionNodes, nodesById);
}

/** Preserve generated diagrams; flag uncertain coverage instead of discarding useful visuals. */
export function annotateControlFlowCoverage(sourceText: string, explanation: unknown): unknown {
  if (!isRecord(explanation) || !Array.isArray(explanation.visuals)) return explanation;
  const visuals = explanation.visuals.filter(isCoverageVisual);
  const controlFlow = visuals.filter((visual) => visual.kind === "control_flow");
  if (controlFlow.length === 0) return explanation;

  // Prefix IDs so independently authored panels can safely be checked as one graph.
  const combined: CoverageVisual = {
    kind: "control_flow",
    nodes: controlFlow.flatMap((visual, index) => visual.nodes.map((node) => ({ ...node, id: `${index}:${node.id}` }))),
    edges: controlFlow.flatMap((visual, index) => visual.edges.map((edge) => ({ ...edge, from: `${index}:${edge.from}`, to: `${index}:${edge.to}` }))),
  };
  if (hasCompleteControlFlowCoverage(sourceText, combined)) return explanation;
  return {
    ...explanation,
    visual_note: "The diagram views are shown, but automated coverage checks could not match every source decision. Use the walkthrough and source links to verify the full behavior.",
  };
}

function isCoverageVisual(value: unknown): value is CoverageVisual {
  return isRecord(value) && typeof value.kind === "string" && Array.isArray(value.nodes) && Array.isArray(value.edges);
}

/** Count control-flow constructs and ternaries while ignoring optional TS markers. */
export function countSourceDecisions(sourceText: string): number {
  return Math.max(collectSourceDecisions(sourceText).length, countFallbackDecisions(sourceText));
}

function collectSourceDecisions(sourceText: string): string[][] {
  const sourceFile = ts.createSourceFile("submitted-source.ts", sourceText, ts.ScriptTarget.Latest, true);
  const decisions: string[][] = [];
  const visit = (node: ts.Node) => {
    let condition: ts.Expression | undefined;
    if (ts.isIfStatement(node)) condition = node.expression;
    else if (ts.isConditionalExpression(node)) condition = node.condition;
    else if (ts.isSwitchStatement(node)) condition = node.expression;
    else if (ts.isForStatement(node)) condition = node.condition;
    else if (ts.isForInStatement(node) || ts.isForOfStatement(node)) condition = node.expression;
    else if (ts.isWhileStatement(node)) condition = node.expression;
    else if (ts.isDoStatement(node)) condition = node.expression;
    if (condition) decisions.push(extractConditionTerms(condition.getText(sourceFile)));
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return decisions;
}

function hasDistinctOutcomes(edges: CoverageEdge[], nodesById: Map<string, CoverageNode>): boolean {
  const labels = edges.map((edge) => edge.label.trim().toLocaleLowerCase());
  if (labels.some((label) => genericBranchLabels.has(label))) return false;

  if (labels.every((label) => !label)) {
    const targets = edges.map((edge) => nodesById.get(edge.to)?.label.trim().toLocaleLowerCase() ?? "");
    return targets.every(Boolean) && new Set(targets).size === targets.length;
  }

  return labels.every(Boolean) && new Set(labels).size === labels.length;
}

function conditionsHaveMatchingDiagramNodes(
  conditions: string[][],
  decisions: [string, CoverageEdge[]][],
  nodesById: Map<string, CoverageNode>,
): boolean {
  const candidates = conditions.map((terms) => decisions.flatMap(([nodeId, edges], index) => {
    const text = [nodesById.get(nodeId)?.label, ...edges.map((edge) => edge.label), ...edges.map((edge) => nodesById.get(edge.to)?.label)]
      .join(" ").toLocaleLowerCase();
    return terms.every((term) => conditionTermMatches(text, term)) ? [index] : [];
  }));
  if (candidates.some((matches) => matches.length === 0)) return false;

  const match = (conditionIndex: number, used: Set<number>): boolean => {
    if (conditionIndex === candidates.length) return true;
    return candidates[conditionIndex].some((candidate) => {
      if (used.has(candidate)) return false;
      used.add(candidate);
      if (match(conditionIndex + 1, used)) return true;
      used.delete(candidate);
      return false;
    });
  };
  return match(0, new Set());
}

function conditionTermMatches(text: string, term: string): boolean {
  const numberWords: Record<string, string[]> = {
    "0": ["zero", "no", "none"], "1": ["one"], "2": ["two"], "3": ["three"], "4": ["four"], "5": ["five"],
    "6": ["six"], "7": ["seven"], "8": ["eight"], "9": ["nine"], "10": ["ten"],
  };
  const alternatives = [term, ...(numberWords[term] ?? [])];
  return alternatives.some((alternative) =>
    new RegExp(`(^|[^\\p{L}\\p{N}_])${escapeRegExp(alternative)}([^\\p{L}\\p{N}_]|$)`, "u").test(text));
}

function extractConditionTerms(condition: string): string[] {
  const identifiers = condition.match(/[A-Za-z_$][\w$]*/g) ?? [];
  const numericValues = condition.match(/\b\d+(?:\.\d+)?\b/g) ?? [];
  const ignored = new Set(["true", "false", "null", "undefined", "typeof", "instanceof", "in"]);
  // Property checks such as `!order.items.length` describe the collection
  // (`items`), not the generic accessor (`length`).
  const accessors = new Set(["length", "size", "keys", "values", "entries"]);
  const terminalIdentifier = identifiers.filter((identifier) => {
    const normalized = identifier.toLocaleLowerCase();
    return !ignored.has(normalized) && !accessors.has(normalized);
  }).at(-1);
  const identifierTerms = terminalIdentifier ? normalizeConditionIdentifier(terminalIdentifier) : [];
  return [...new Set([...identifierTerms, ...numericValues])];
}

function normalizeConditionIdentifier(identifier: string): string[] {
  const words = identifier
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLocaleLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter(Boolean);
  const booleanPrefixes = new Set(["is", "has", "can", "should", "does", "did", "will", "was", "were"]);
  if (words.length > 1 && booleanPrefixes.has(words[0])) words.shift();
  return words.length ? [words.join(" ")] : [];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function countFallbackDecisions(sourceText: string): number {
  const code = sourceText
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/#[^\n]*/g, " ")
    .replace(/("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)/g, " ")
    .replace(/([A-Za-z_$][\w$]*)\?(?=\s*[:;,])/g, "$1 ");
  const cStyleIfs = code.match(/\bif\s*\(/g)?.length ?? 0;
  const pythonIfs = code.match(/^\s*(?:if|elif)\s+.+:/gm)?.length ?? 0;
  const pythonTernaries = code.match(/^\s*.+\s+if\s+.+\s+else\s+.+$/gm)?.length ?? 0;
  const ternaries = code.match(/\?(?![.?])/g)?.length ?? 0;
  const loops = code.match(/\b(?:for|while)\s*\(/g)?.length ?? 0;
  const pythonLoops = code.match(/^\s*(?:for|while)\s+.+:/gm)?.length ?? 0;
  return cStyleIfs + pythonIfs + pythonTernaries + ternaries + loops + pythonLoops;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
