"use client";

import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import { useToolState } from "@/hooks/use-tool-state";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";
import {
  ToolShell,
  ControlGroup,
  ToolActionButton,
} from "@/components/tools/tool-shell";
import type { FaqEntry } from "@/lib/json-ld";
import { Segment, NumberStepper, Toggle } from "@/components/tools/controls";

// --- JSON parsing ---

interface ParseResult {
  valid: boolean;
  parsed: unknown;
  error: string | null;
  errorLine: number | null;
  errorColumn: number | null;
}

function parseJson(input: string): ParseResult {
  if (!input.trim()) {
    return { valid: true, parsed: null, error: null, errorLine: null, errorColumn: null };
  }
  try {
    const parsed = JSON.parse(input);
    return { valid: true, parsed, error: null, errorLine: null, errorColumn: null };
  } catch (e) {
    const msg = (e as Error).message;
    const posMatch = msg.match(/position\s+(\d+)/i);
    let errorLine: number | null = null;
    let errorColumn: number | null = null;
    if (posMatch) {
      const pos = parseInt(posMatch[1], 10);
      const before = input.slice(0, pos);
      const lines = before.split("\n");
      errorLine = lines.length;
      errorColumn = (lines[lines.length - 1]?.length ?? 0) + 1;
    }
    return { valid: false, parsed: null, error: msg, errorLine, errorColumn };
  }
}

function formatJson(parsed: unknown, indent: number | "tab"): string {
  return JSON.stringify(parsed, null, indent === "tab" ? "\t" : indent);
}

function minifyJson(parsed: unknown): string {
  return JSON.stringify(parsed);
}

// --- JSON stats ---

interface JsonStats {
  objects: number;
  arrays: number;
  strings: number;
  numbers: number;
  booleans: number;
  nulls: number;
  totalKeys: number;
  maxDepth: number;
  totalSize: number;
}

function computeStats(value: unknown, depth = 0): JsonStats {
  const stats: JsonStats = {
    objects: 0, arrays: 0, strings: 0, numbers: 0,
    booleans: 0, nulls: 0, totalKeys: 0, maxDepth: depth, totalSize: 0,
  };

  if (value === null) { stats.nulls = 1; return stats; }
  if (typeof value === "string") { stats.strings = 1; stats.totalSize = value.length; return stats; }
  if (typeof value === "number") { stats.numbers = 1; return stats; }
  if (typeof value === "boolean") { stats.booleans = 1; return stats; }

  if (Array.isArray(value)) {
    stats.arrays = 1;
    for (const item of value) merge(stats, computeStats(item, depth + 1));
    return stats;
  }

  if (typeof value === "object") {
    stats.objects = 1;
    const entries = Object.entries(value as Record<string, unknown>);
    stats.totalKeys = entries.length;
    for (const [, val] of entries) merge(stats, computeStats(val, depth + 1));
    return stats;
  }

  return stats;
}

function merge(target: JsonStats, source: JsonStats) {
  target.objects += source.objects;
  target.arrays += source.arrays;
  target.strings += source.strings;
  target.numbers += source.numbers;
  target.booleans += source.booleans;
  target.nulls += source.nulls;
  target.totalKeys += source.totalKeys;
  target.maxDepth = Math.max(target.maxDepth, source.maxDepth);
  target.totalSize += source.totalSize;
}

// --- JSON path ---

function queryJsonPath(data: unknown, path: string): unknown[] {
  if (!path.trim()) return [];
  const parts = path.replace(/^\$\.?/, "").split(/\.|\[(\d+)\]/).filter(Boolean);
  if (parts.length === 0) return [data];

  function walk(current: unknown, idx: number): unknown[] {
    if (idx >= parts.length) return [current];
    const part = parts[idx];
    if (part === "*") {
      if (Array.isArray(current)) return current.flatMap((item) => walk(item, idx + 1));
      if (current && typeof current === "object") {
        return Object.values(current as Record<string, unknown>).flatMap((v) => walk(v, idx + 1));
      }
      return [];
    }
    if (Array.isArray(current)) {
      const i = parseInt(part, 10);
      if (!isNaN(i) && i >= 0 && i < current.length) return walk(current[i], idx + 1);
      return [];
    }
    if (current && typeof current === "object") {
      const obj = current as Record<string, unknown>;
      if (part in obj) return walk(obj[part], idx + 1);
      return [];
    }
    return [];
  }

  return walk(data, 0);
}

// --- Transforms ---

function sortKeysFn(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sortKeysFn);
  const sorted = Object.keys(value as Record<string, unknown>).sort();
  const result: Record<string, unknown> = {};
  for (const key of sorted) result[key] = sortKeysFn((value as Record<string, unknown>)[key]);
  return result;
}

function removeNulls(value: unknown): unknown {
  if (value === null) return undefined;
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(removeNulls).filter((v) => v !== undefined);
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const cleaned = removeNulls(v);
    if (cleaned !== undefined) result[k] = cleaned;
  }
  return result;
}

function flattenJson(value: unknown, prefix = ""): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (value === null || typeof value !== "object") {
    result[prefix || "$"] = value;
    return result;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => {
      Object.assign(result, flattenJson(item, `${prefix}[${i}]`));
    });
    return result;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object") Object.assign(result, flattenJson(v, key));
    else result[key] = v;
  }
  return result;
}

// --- TypeScript type generation ---

function generateTsType(value: unknown, depth = 0): string {
  const indent = "  ".repeat(depth);
  const inner = "  ".repeat(depth + 1);

  if (value === null) return "null";
  if (typeof value === "string") return "string";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";

  if (Array.isArray(value)) {
    if (value.length === 0) return "unknown[]";
    const itemType = generateTsType(value[0], depth);
    return itemType.includes("\n") ? `Array<${itemType}>` : `${itemType}[]`;
  }

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return "Record<string, unknown>";
    const fields = entries.map(([k, v]) => {
      const safe = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(k) ? k : `"${k}"`;
      const type = generateTsType(v, depth + 1);
      return `${inner}${safe}: ${type};`;
    });
    return `{\n${fields.join("\n")}\n${indent}}`;
  }

  return "unknown";
}

// --- YAML conversion (lightweight) ---

function jsonToYaml(value: unknown, depth = 0): string {
  const indent = "  ".repeat(depth);
  if (value === null) return "null";
  if (typeof value === "string") {
    if (/[:#\n]|^\s|\s$/.test(value)) return JSON.stringify(value);
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return "\n" + value.map((item) => {
      const sub = jsonToYaml(item, depth + 1);
      if (sub.startsWith("\n")) return `${indent}-${sub}`;
      return `${indent}- ${sub}`;
    }).join("\n");
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return "{}";
    return "\n" + entries.map(([k, v]) => {
      const sub = jsonToYaml(v, depth + 1);
      if (sub.startsWith("\n")) return `${indent}${k}:${sub}`;
      return `${indent}${k}: ${sub}`;
    }).join("\n");
  }
  return String(value);
}

// --- TOML (top-level only, fallback to JSON for nested arrays/objects) ---

function jsonToToml(value: unknown): string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return "# TOML requires a top-level object\n" + JSON.stringify(value, null, 2);
  }
  const out: string[] = [];
  const tables: string[] = [];
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v === null) { out.push(`${k} = "null"`); continue; }
    if (typeof v === "string") { out.push(`${k} = ${JSON.stringify(v)}`); continue; }
    if (typeof v === "number" || typeof v === "boolean") { out.push(`${k} = ${v}`); continue; }
    if (Array.isArray(v)) { out.push(`${k} = ${JSON.stringify(v)}`); continue; }
    if (typeof v === "object") {
      tables.push(`\n[${k}]`);
      for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) {
        tables.push(`${k2} = ${JSON.stringify(v2)}`);
      }
    }
  }
  return [...out, ...tables].join("\n");
}

// --- CSV (array of objects) ---

function jsonToCsv(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0) {
    return "# CSV requires an array of objects";
  }
  const headerSet = new Set<string>();
  for (const row of value) {
    if (row && typeof row === "object" && !Array.isArray(row)) {
      Object.keys(row as Record<string, unknown>).forEach((k) => headerSet.add(k));
    }
  }
  const headers = Array.from(headerSet);
  if (headers.length === 0) {
    return value.map((v) => JSON.stringify(v)).join("\n");
  }
  const escape = (s: unknown): string => {
    if (s === null || s === undefined) return "";
    const str = typeof s === "object" ? JSON.stringify(s) : String(s);
    if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
    return str;
  };
  const lines = [headers.join(",")];
  for (const row of value) {
    if (row && typeof row === "object" && !Array.isArray(row)) {
      const rec = row as Record<string, unknown>;
      lines.push(headers.map((h) => escape(rec[h])).join(","));
    } else {
      lines.push(escape(row));
    }
  }
  return lines.join("\n");
}

// --- Search ---

interface SearchMatch {
  path: string;
  key?: string;
  value: unknown;
}

function searchJson(data: unknown, query: string, path = "$"): SearchMatch[] {
  if (!query) return [];
  const q = query.toLowerCase();
  const matches: SearchMatch[] = [];

  if (data === null || typeof data !== "object") {
    if (String(data).toLowerCase().includes(q)) {
      matches.push({ path, value: data });
    }
    return matches;
  }

  if (Array.isArray(data)) {
    data.forEach((item, i) => {
      matches.push(...searchJson(item, query, `${path}[${i}]`));
    });
    return matches;
  }

  for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
    const childPath = `${path}.${k}`;
    if (k.toLowerCase().includes(q)) {
      matches.push({ path: childPath, key: k, value: v });
    }
    matches.push(...searchJson(v, query, childPath));
  }
  return matches;
}

// --- Tree view ---

function TreeNode({
  name, value, depth, path, onCopyPath, searchQuery,
}: {
  name: string | null;
  value: unknown;
  depth: number;
  path: string;
  onCopyPath: (path: string) => void;
  searchQuery: string;
}) {
  const [expanded, setExpanded] = useState(depth < 2);
  const isMatch = searchQuery && (
    (name && name.toLowerCase().includes(searchQuery.toLowerCase())) ||
    (typeof value === "string" && value.toLowerCase().includes(searchQuery.toLowerCase())) ||
    (typeof value === "number" && String(value).includes(searchQuery))
  );

  const highlightStyle = isMatch
    ? {
        background: "color-mix(in srgb, var(--kami-accent, #eab308) 25%, transparent)",
        borderRadius: "var(--kami-cta-radius, 0.25rem)",
        padding: "0 0.125rem",
        margin: "0 -0.125rem",
      }
    : {};

  const labelStyle = { color: "var(--kami-text-muted)" } as const;

  const pathBtn = (
    <button
      onClick={(e) => { e.stopPropagation(); onCopyPath(path); }}
      className="ml-1 opacity-60 hover:opacity-100 transition-opacity"
      style={{ color: "var(--kami-text-dim)" }}
      title={`Copy path: ${path}`}
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
    </button>
  );

  if (value === null) {
    return (
      <div style={{ paddingLeft: depth * 16, ...highlightStyle }} className="flex items-center gap-1 py-0.5 font-mono text-sm">
        {name !== null && <span style={labelStyle}>{name}:</span>}
        <span style={{ color: "#f97316" }}>null</span>
        {pathBtn}
      </div>
    );
  }

  if (typeof value === "boolean") {
    return (
      <div style={{ paddingLeft: depth * 16, ...highlightStyle }} className="flex items-center gap-1 py-0.5 font-mono text-sm">
        {name !== null && <span style={labelStyle}>{name}:</span>}
        <span style={{ color: "#9333ea" }}>{String(value)}</span>
        {pathBtn}
      </div>
    );
  }

  if (typeof value === "number") {
    return (
      <div style={{ paddingLeft: depth * 16, ...highlightStyle }} className="flex items-center gap-1 py-0.5 font-mono text-sm">
        {name !== null && <span style={labelStyle}>{name}:</span>}
        <span style={{ color: "#2563eb" }}>{String(value)}</span>
        {pathBtn}
      </div>
    );
  }

  if (typeof value === "string") {
    const truncated = value.length > 120 ? value.slice(0, 120) + "..." : value;
    return (
      <div style={{ paddingLeft: depth * 16, ...highlightStyle }} className="flex items-center gap-1 py-0.5 font-mono text-sm">
        {name !== null && <span style={labelStyle}>{name}:</span>}
        <span style={{ color: "#15803d" }} title={value.length > 120 ? value : undefined}>&quot;{truncated}&quot;</span>
        {value.length > 120 && <span className="text-xs" style={{ color: "var(--kami-text-dim)" }}>({value.length})</span>}
        {pathBtn}
      </div>
    );
  }

  if (Array.isArray(value)) {
    return (
      <div style={{ paddingLeft: depth * 16 }} className="py-0.5">
        <button
          onClick={() => setExpanded((v) => !v)}
          className="flex items-center gap-1 font-mono text-sm px-1 -ml-1"
          style={highlightStyle}
        >
          <span className="w-3 text-center" style={{ color: "var(--kami-text-dim)" }}>{expanded ? "▾" : "▸"}</span>
          {name !== null && <span style={labelStyle}>{name}:</span>}
          <span style={{ color: "var(--kami-text-dim)" }}>[{value.length}]</span>
          {pathBtn}
        </button>
        {expanded && value.map((item, i) => (
          <TreeNode key={i} name={String(i)} value={item} depth={depth + 1} path={`${path}[${i}]`} onCopyPath={onCopyPath} searchQuery={searchQuery} />
        ))}
      </div>
    );
  }

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    return (
      <div style={{ paddingLeft: depth * 16 }} className="py-0.5">
        <button
          onClick={() => setExpanded((v) => !v)}
          className="flex items-center gap-1 font-mono text-sm px-1 -ml-1"
          style={highlightStyle}
        >
          <span className="w-3 text-center" style={{ color: "var(--kami-text-dim)" }}>{expanded ? "▾" : "▸"}</span>
          {name !== null && <span style={labelStyle}>{name}:</span>}
          <span style={{ color: "var(--kami-text-dim)" }}>{`{${entries.length}}`}</span>
          {pathBtn}
        </button>
        {expanded && entries.map(([key, val]) => (
          <TreeNode key={key} name={key} value={val} depth={depth + 1} path={`${path}.${key}`} onCopyPath={onCopyPath} searchQuery={searchQuery} />
        ))}
      </div>
    );
  }

  return null;
}

// --- UI ---

type ViewMode = "text" | "tree";
type Tab = "format" | "query" | "transform" | "types" | "convert";
type IndentChoice = "0" | "2" | "4" | "tab";

export default function JsonFormatterContent({ faqPassages }: { faqPassages?: FaqEntry[] } = {}) {
  const [{ q: input }, setToolState] = useToolState({ q: "" });
  const setInput = useCallback((v: string) => setToolState({ q: v }), [setToolState]);
  const [indentChoice, setIndentChoice] = useState<IndentChoice>("2");
  const [viewMode, setViewMode] = useState<ViewMode>("text");
  const [copied, setCopied] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>("format");
  const [searchQuery, setSearchQuery] = useState("");
  const [jsonPathQuery, setJsonPathQuery] = useState("");
  const [copiedPath, setCopiedPath] = useState<string | null>(null);
  const [sortKeysToggle, setSortKeysToggle] = useState(false);
  const [convertFormat, setConvertFormat] = useState<"yaml" | "toml" | "csv">("yaml");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const [metroCPivot, setMetroCPivot] = useState<"input" | "output">("input");


  const indent = useMemo<number | "tab">(() => {
    if (indentChoice === "tab") return "tab";
    return parseInt(indentChoice, 10);
  }, [indentChoice]);

  const result = useMemo(() => parseJson(input), [input]);

  const sortedParsed = useMemo(() => {
    if (!result.valid || result.parsed == null) return null;
    return sortKeysToggle ? sortKeysFn(result.parsed) : result.parsed;
  }, [result, sortKeysToggle]);

  const formatted = useMemo(() => {
    if (sortedParsed == null) return "";
    return formatJson(sortedParsed, indent);
  }, [sortedParsed, indent]);

  const minified = useMemo(() => {
    if (sortedParsed == null) return "";
    return minifyJson(sortedParsed);
  }, [sortedParsed]);

  const stats = useMemo(() => {
    if (!result.valid || result.parsed == null) return null;
    return computeStats(result.parsed);
  }, [result]);

  const searchResults = useMemo(() => {
    if (!result.valid || result.parsed == null || !searchQuery) return [];
    return searchJson(result.parsed, searchQuery).slice(0, 50);
  }, [result, searchQuery]);

  const pathResults = useMemo(() => {
    if (!result.valid || result.parsed == null || !jsonPathQuery) return [];
    try {
      return queryJsonPath(result.parsed, jsonPathQuery);
    } catch {
      return [];
    }
  }, [result, jsonPathQuery]);

  const tsType = useMemo(() => {
    if (sortedParsed == null) return "";
    return `interface Root ${generateTsType(sortedParsed)}`;
  }, [sortedParsed]);

  const converted = useMemo(() => {
    if (sortedParsed == null) return "";
    if (convertFormat === "yaml") return jsonToYaml(sortedParsed).replace(/^\n/, "");
    if (convertFormat === "toml") return jsonToToml(sortedParsed);
    if (convertFormat === "csv") return jsonToCsv(sortedParsed);
    return "";
  }, [sortedParsed, convertFormat]);

  const handleCopy = useCallback(async (text: string, label = "output") => {
    await navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(null), 2000);
  }, []);

  const handleCopyPath = useCallback((path: string) => {
    navigator.clipboard.writeText(path);
    setCopiedPath(path);
    setTimeout(() => setCopiedPath(null), 1500);
  }, []);

  const handleFormat = useCallback(() => {
    if (formatted) setInput(formatted);
  }, [formatted, setInput]);

  const handleMinify = useCallback(() => {
    if (minified) setInput(minified);
  }, [minified, setInput]);

  const handleDownload = useCallback(() => {
    if (!formatted) return;
    const blob = new Blob([formatted], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "data.json";
    a.click();
    URL.revokeObjectURL(url);
  }, [formatted]);

  const handleTransform = useCallback((fn: (v: unknown) => unknown) => {
    if (!result.valid || result.parsed == null) return;
    try {
      const transformed = fn(result.parsed);
      setInput(JSON.stringify(transformed, null, indent === "tab" ? "\t" : indent));
    } catch { /* ignore */ }
  }, [result, indent, setInput]);

  useKeyboardShortcuts(useMemo(() => [
    { key: "Enter", meta: true, action: () => handleFormat(), label: "Format" },
    { key: "k", meta: true, action: () => setInput(""), label: "Clear" },
    { key: "f", meta: true, shift: true, action: () => { setActiveTab("format"); }, label: "Search" },
  ], [handleFormat, setInput]));

  const hasData = result.valid && result.parsed != null;

  const cardStyle = {
    background: "var(--kami-surface-solid)",
    border: "1px solid var(--kami-border-strong)",
    borderRadius: "var(--kami-card-radius, 0.75rem)",
    boxShadow: "var(--kami-card-shadow, none)",
  } as const;
  const inputStyle = {
    background: "var(--kami-input-bg, var(--kami-surface-solid))",
    color: "var(--kami-text)",
    border: "1px solid var(--kami-border-strong)",
    borderRadius: "var(--kami-input-radius, 0.5rem)",
  } as const;

  return (
    <ToolShell
      faqPassages={faqPassages}
      title="JSON Formatter"
      tagline="Beautify · validate · query · tree · types · convert"
      accent="#10b981"
      actions={
        <>
          {input && (
            <ToolActionButton onClick={() => setInput("")} variant="ghost">Clear</ToolActionButton>
          )}
          {formatted && (
            <>
              <ToolActionButton onClick={() => handleCopy(formatted, "output")} variant="outline">
                {copied === "output" ? "Copied" : "Copy"}
              </ToolActionButton>
              <ToolActionButton onClick={handleDownload} variant="solid">Download</ToolActionButton>
            </>
          )}
        </>
      }
      controls={
        <>
          <ControlGroup label="View">
            <Segment<Tab>
              value={activeTab}
              onChange={setActiveTab}
              options={[
                { value: "format", label: "Format" },
                { value: "query", label: "Query" },
                { value: "transform", label: "Transform" },
                { value: "types", label: "Types" },
                { value: "convert", label: "Convert" },
              ]}
              full
              size="sm"
            />
          </ControlGroup>
          <ControlGroup label="Output mode">
            <Segment<ViewMode>
              value={viewMode}
              onChange={setViewMode}
              options={[
                { value: "text", label: "Text" },
                { value: "tree", label: "Tree" },
              ]}
              full
            />
          </ControlGroup>
          <ControlGroup label="Indent">
            <Segment<IndentChoice>
              value={indentChoice}
              onChange={setIndentChoice}
              options={[
                { value: "0", label: "Min" },
                { value: "2", label: "2 sp" },
                { value: "4", label: "4 sp" },
                { value: "tab", label: "Tab" },
              ]}
              full
              size="sm"
            />
          </ControlGroup>
          <Toggle label="Sort keys" hint="Alphabetize object keys" checked={sortKeysToggle} onChange={setSortKeysToggle} />
          <ControlGroup label="Quick">
            <div className="flex flex-col gap-2">
              <ToolActionButton onClick={handleFormat} variant="outline">Format input</ToolActionButton>
              <ToolActionButton onClick={handleMinify} variant="outline">Minify input</ToolActionButton>
            </div>
          </ControlGroup>
          {hasData && stats && (
            <ControlGroup label="Stats">
              <div className="flex flex-wrap gap-1.5 text-xs" style={{ color: "var(--kami-text-muted)" }}>
                {([
                  ["{}", stats.objects],
                  ["[]", stats.arrays],
                  ['""', stats.strings],
                  ["123", stats.numbers],
                  ["t/f", stats.booleans],
                  ["null", stats.nulls],
                  ["keys", stats.totalKeys],
                  ["depth", stats.maxDepth],
                ] as Array<[string, number]>).map(([label, count]) => (
                  <span
                    key={label}
                    className="px-1.5 py-0.5"
                    style={{
                      background: "var(--kami-surface)",
                      border: "1px solid var(--kami-border)",
                      borderRadius: "var(--kami-cta-radius, 0.375rem)",
                    }}
                  >
                    {label}: {count}
                  </span>
                ))}
              </div>
            </ControlGroup>
          )}
        </>
      }
    >
      <nav className="canvas-metro-pivot" role="tablist" aria-label="View">
        <button role="tab" aria-selected={metroCPivot === "input"}
          className={`metro-pivot-item${metroCPivot === "input" ? " is-active" : ""}`}
          onClick={() => setMetroCPivot("input")}>Input</button>
        <button role="tab" aria-selected={metroCPivot === "output"}
          className={`metro-pivot-item${metroCPivot === "output" ? " is-active" : ""}`}
          onClick={() => setMetroCPivot("output")}>Output</button>
      </nav>
      <div className="flex flex-col gap-3">
        {/* Input */}
        <div className="canvas-section glass-canvas-section" data-panel="input"><>
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder='Paste your JSON here... e.g. {"key": "value"}'
          className="w-full px-4 py-3 text-base font-mono focus:outline-none"
          style={{
            ...inputStyle,
            minHeight: 180,
            border: input && !result.valid
              ? "1px solid #fca5a5"
              : "1px solid var(--kami-border-strong)",
          }}
          rows={8}
          autoFocus
          spellCheck={false}
        />

        {/* Status bar */}
        <div className="flex flex-wrap items-center gap-3 text-xs">
          {input.trim() && (
            <span style={{ color: result.valid ? "#16a34a" : "#ef4444" }}>
              {result.valid ? "✓ Valid JSON" : "✗ Invalid JSON"}
            </span>
          )}
          {result.error && (
            <span style={{ color: "#f87171" }}>
              {result.errorLine && result.errorColumn
                ? `Line ${result.errorLine}, Col ${result.errorColumn}: `
                : ""}
              {result.error}
            </span>
          )}
          {hasData && (
            <span style={{ color: "var(--kami-text-dim)" }}>
              {input.length.toLocaleString()} chars in · {formatted.length.toLocaleString()} out
            </span>
          )}
        </div>
        </></div>

        {/* Format Tab */}
        <div className="canvas-section glass-canvas-section" data-panel="output"><>
        {hasData && activeTab === "format" && (
          <div className="flex flex-col gap-3">
            {/* Search */}
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search keys / values…"
              className="w-full px-3 py-2 text-sm focus:outline-none"
              style={{ ...inputStyle, minHeight: 40 }}
            />

            {searchQuery && searchResults.length > 0 && viewMode === "text" && (
              <div
                className="p-3"
                style={{
                  background: "color-mix(in srgb, #eab308 12%, var(--kami-surface))",
                  border: "1px solid color-mix(in srgb, #eab308 30%, transparent)",
                  borderRadius: "var(--kami-card-radius, 0.75rem)",
                }}
              >
                <div className="text-xs font-medium mb-2" style={{ color: "#a16207" }}>
                  {searchResults.length} match{searchResults.length !== 1 ? "es" : ""}
                </div>
                <div className="max-h-40 overflow-auto space-y-1">
                  {searchResults.slice(0, 20).map((m, i) => (
                    <div key={i} className="flex items-center gap-2 text-xs font-mono">
                      <button
                        onClick={() => handleCopyPath(m.path)}
                        className="truncate max-w-xs"
                        style={{ color: "#ca8a04" }}
                        title={m.path}
                      >
                        {m.path}
                      </button>
                      <span className="truncate max-w-xs" style={{ color: "var(--kami-text-dim)" }}>
                        {JSON.stringify(m.value)?.slice(0, 60)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {copiedPath && (
              <div className="text-xs" style={{ color: "#16a34a" }}>
                Copied path: {copiedPath}
              </div>
            )}

            {viewMode === "text" ? (
              <pre className="overflow-auto whitespace-pre px-4 py-3 text-sm font-mono max-h-[60vh]" style={cardStyle}>
                {formatted}
              </pre>
            ) : (
              <div className="overflow-auto px-4 py-3 max-h-[60vh]" style={cardStyle}>
                <TreeNode
                  name={null}
                  value={sortedParsed}
                  depth={0}
                  path="$"
                  onCopyPath={handleCopyPath}
                  searchQuery={searchQuery}
                />
              </div>
            )}
          </div>
        )}

        {/* Query Tab */}
        {hasData && activeTab === "query" && (
          <div className="p-4 flex flex-col gap-3" style={cardStyle}>
            <h3 className="text-sm font-medium" style={{ color: "var(--kami-text-muted)" }}>JSONPath query</h3>
            <input
              type="text"
              value={jsonPathQuery}
              onChange={(e) => setJsonPathQuery(e.target.value)}
              placeholder="$.users[*].name  or  data.items[0]"
              className="w-full px-3 py-2 text-sm font-mono focus:outline-none"
              style={{ ...inputStyle, minHeight: 40 }}
            />
            <div className="flex flex-wrap gap-1.5">
              {["$", "$..*", "$[0]", "$[*]"].map((example) => (
                <button
                  key={example}
                  onClick={() => setJsonPathQuery(example)}
                  className="px-2 py-1 text-xs font-mono"
                  style={{
                    background: "var(--kami-surface)",
                    color: "var(--kami-text-muted)",
                    border: "1px solid var(--kami-border)",
                    borderRadius: "var(--kami-cta-radius, 0.375rem)",
                    minHeight: 44,
                  }}
                >
                  {example}
                </button>
              ))}
            </div>
            {jsonPathQuery && (
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs" style={{ color: "var(--kami-text-muted)" }}>
                    {pathResults.length} result{pathResults.length !== 1 ? "s" : ""}
                  </span>
                  {pathResults.length > 0 && (
                    <ToolActionButton
                      onClick={() => handleCopy(JSON.stringify(pathResults.length === 1 ? pathResults[0] : pathResults, null, 2), "query")}
                      variant="ghost"
                    >
                      {copied === "query" ? "Copied" : "Copy result"}
                    </ToolActionButton>
                  )}
                </div>
                <pre
                  className="overflow-auto whitespace-pre px-4 py-3 text-sm font-mono max-h-64"
                  style={{
                    background: "var(--kami-surface)",
                    color: "var(--kami-text)",
                    border: "1px solid var(--kami-border-strong)",
                    borderRadius: "var(--kami-input-radius, 0.5rem)",
                  }}
                >
                  {pathResults.length === 0
                    ? "No results"
                    : JSON.stringify(pathResults.length === 1 ? pathResults[0] : pathResults, null, 2)}
                </pre>
              </div>
            )}
          </div>
        )}

        {/* Transform Tab */}
        {hasData && activeTab === "transform" && (
          <div className="grid gap-3 sm:grid-cols-2">
            {[
              {
                label: "Sort Keys",
                desc: "Alphabetically sort all object keys",
                action: () => handleTransform(sortKeysFn),
              },
              {
                label: "Remove Nulls",
                desc: "Strip all null values from the JSON",
                action: () => handleTransform(removeNulls),
              },
              {
                label: "Flatten",
                desc: "Convert nested structure to dot-notation keys",
                action: () => handleTransform((v) => flattenJson(v)),
              },
              {
                label: "Escape Strings",
                desc: "Escape special characters in string values",
                action: () => handleCopy(JSON.stringify(input), "escaped"),
              },
              {
                label: "Unescape",
                desc: "Parse escaped JSON string",
                action: () => {
                  try {
                    const unescaped = JSON.parse(input);
                    if (typeof unescaped === "string") setInput(unescaped);
                  } catch { /* ignore */ }
                },
              },
              {
                label: "Wrap in Array",
                desc: "Wrap the current JSON in an array",
                action: () => handleTransform((v) => [v]),
              },
            ].map((t) => (
              <button
                key={t.label}
                onClick={t.action}
                className="p-4 text-left transition-colors"
                style={{ ...cardStyle, minHeight: 64 }}
              >
                <div className="text-sm font-medium" style={{ color: "var(--kami-text)" }}>{t.label}</div>
                <div className="mt-0.5 text-xs" style={{ color: "var(--kami-text-muted)" }}>{t.desc}</div>
              </button>
            ))}
          </div>
        )}

        {/* Types Tab */}
        {hasData && activeTab === "types" && (
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium" style={{ color: "var(--kami-text-muted)" }}>
                TypeScript interface (inferred)
              </span>
              <ToolActionButton onClick={() => handleCopy(tsType, "types")} variant="solid">
                {copied === "types" ? "Copied" : "Copy"}
              </ToolActionButton>
            </div>
            <pre
              className="overflow-auto whitespace-pre px-4 py-3 text-sm font-mono max-h-[60vh]"
              style={{
                background: "var(--kami-overlay-bg, #0f172a)",
                color: "var(--kami-overlay-text, #f1f5f9)",
                border: "1px solid var(--kami-border-strong)",
                borderRadius: "var(--kami-card-radius, 0.75rem)",
              }}
            >
              {tsType}
            </pre>
          </div>
        )}

        {/* Convert Tab */}
        {hasData && activeTab === "convert" && (
          <div className="flex flex-col gap-3">
            <Segment<"yaml" | "toml" | "csv">
              value={convertFormat}
              onChange={setConvertFormat}
              options={[
                { value: "yaml", label: "YAML" },
                { value: "toml", label: "TOML" },
                { value: "csv", label: "CSV" },
              ]}
              full
            />
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium" style={{ color: "var(--kami-text-muted)" }}>
                {convertFormat.toUpperCase()} output
              </span>
              <ToolActionButton onClick={() => handleCopy(converted, "convert")} variant="solid">
                {copied === "convert" ? "Copied" : "Copy"}
              </ToolActionButton>
            </div>
            <pre className="overflow-auto whitespace-pre px-4 py-3 text-sm font-mono max-h-[60vh]" style={cardStyle}>
              {converted}
            </pre>
          </div>
        )}
        </></div>
      </div>
    </ToolShell>
  );
}
