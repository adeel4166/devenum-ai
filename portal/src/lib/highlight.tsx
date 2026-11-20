/**
 * Tiny dependency-free syntax highlighter (comments, strings, numbers, keywords, tags) for the file viewer.
 * Produces React nodes only — no innerHTML — so file content can never inject markup.
 */
const KEYWORDS = new Set(("abstract as async await break case catch class const continue def default del do elif else enum except export extends " +
  "false finally fn for from func function go if impl implements import in instanceof interface is lambda let match mod module mut new nil " +
  "none not null of or package pass private protected pub public raise readonly return self static struct super switch this throw true try " +
  "type typeof undefined use var void while with yield").split(" "));

type Lang = "c" | "py" | "sh" | "html" | "css" | "json" | "md" | "plain";
export function langOf(path: string): Lang {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (["js", "jsx", "ts", "tsx", "mjs", "cjs", "java", "go", "rs", "c", "cpp", "h", "cs", "swift", "kt", "php", "dart", "prisma", "gd"].includes(ext)) return "c";
  if (["py", "rb", "yml", "yaml", "toml", "ini", "conf", "env", "example"].includes(ext)) return "py";
  if (["sh", "bash", "zsh", "dockerfile"].includes(ext) || /Dockerfile$/.test(path)) return "sh";
  if (["html", "htm", "xml", "svg", "vue", "svelte"].includes(ext)) return "html";
  if (["css", "scss", "less"].includes(ext)) return "css";
  if (ext === "json") return "json";
  if (["md", "mdx"].includes(ext)) return "md";
  return "plain";
}

const RULES: Record<Lang, RegExp | null> = {
  c: /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|(`(?:\\[\s\S]|[^`\\])*`|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')|(\b\d[\d_.]*\b)|(\b[A-Za-z_$][\w$]*\b)/g,
  py: /(#[^\n]*)|("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')|(\b\d[\d_.]*\b)|(\b[A-Za-z_][\w]*\b)/g,
  sh: /(#[^\n]*)|("(?:\\.|[^"\\])*"|'[^']*')|(\b\d+\b)|(\b[A-Za-z_][\w-]*\b)/g,
  css: /(\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')|(#[0-9a-fA-F]{3,8}\b|\b\d[\d.]*(?:px|rem|em|%|vh|vw|s|ms)?\b)|([.#]?[A-Za-z-][\w-]*(?=\s*[:{]))/g,
  json: /()("(?:\\.|[^"\\])*"(?=\s*:))|("(?:\\.|[^"\\])*")|(\b-?\d[\d.eE+-]*\b|\btrue\b|\bfalse\b|\bnull\b)/g,
  html: /(<!--[\s\S]*?-->)|("(?:[^"])*"|'[^']*')|()(<\/?[A-Za-z][\w:-]*|\/?>)/g,
  md: /()()()(^#{1,6} .*$|\*\*[^*]+\*\*|`[^`]+`)/gm,
  plain: null,
};
const CLS = ["text-slate-500 italic", "text-emerald-300", "text-amber-300", "text-sky-300"];

export function Highlighted({ code, path }: { code: string; path: string }) {
  const lang = langOf(path);
  const re = RULES[lang];
  if (!re || code.length > 300_000) return <>{code}</>;
  const out: React.ReactNode[] = [];
  let last = 0, m: RegExpExecArray | null, k = 0;
  re.lastIndex = 0;
  while ((m = re.exec(code))) {
    if (m[0] === "") { re.lastIndex++; continue; }
    const group = [1, 2, 3, 4].find(g => m![g]);
    if (!group) continue;
    // In c/py/sh, group 4 = identifier: only colour keywords.
    if (group === 4 && (lang === "c" || lang === "py" || lang === "sh") && !KEYWORDS.has(m[0])) continue;
    if (m.index > last) out.push(code.slice(last, m.index));
    const cls = lang === "json" ? ["", "text-sky-300", "text-emerald-300", "text-amber-300"][group - 1] : CLS[group - 1];
    out.push(<span key={k++} className={cls}>{m[0]}</span>);
    last = m.index + m[0].length;
  }
  out.push(code.slice(last));
  return <>{out}</>;
}
