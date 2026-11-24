// Calculadora pequeña y segura para las medidas: números, variables,
// + - * / ^, paréntesis y unas pocas funciones. Nada de eval().

const FUNCS: Record<string, (x: number) => number> = {
  sqrt: Math.sqrt,
  sin: (d) => Math.sin((d * Math.PI) / 180),
  cos: (d) => Math.cos((d * Math.PI) / 180),
  tan: (d) => Math.tan((d * Math.PI) / 180),
  abs: Math.abs,
  round: Math.round,
};
const CONSTS: Record<string, number> = { pi: Math.PI };

type Tok = { t: "n"; v: number } | { t: "id"; v: string } | { t: "op"; v: string };

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const s = src.replace(/,/g, "."); // admite coma decimal
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9.]/.test(c)) {
      let j = i;
      while (j < s.length && /[0-9.eE]/.test(s[j])) {
        if ((s[j] === "e" || s[j] === "E") && /[+-]/.test(s[j + 1] ?? "")) j++;
        j++;
      }
      const v = Number(s.slice(i, j));
      if (Number.isNaN(v)) throw new Error(`número raro: ${s.slice(i, j)}`);
      out.push({ t: "n", v });
      i = j;
      continue;
    }
    if (/[a-zA-Z_áéíóúñÁÉÍÓÚÑ]/.test(c)) {
      let j = i;
      while (j < s.length && /[a-zA-Z0-9_áéíóúñÁÉÍÓÚÑ]/.test(s[j])) j++;
      out.push({ t: "id", v: s.slice(i, j) });
      i = j;
      continue;
    }
    if ("+-*/^()".includes(c)) { out.push({ t: "op", v: c }); i++; continue; }
    throw new Error(`no entiendo «${c}»`);
  }
  return out;
}

export function evaluate(src: string, vars: Record<string, number>): number {
  const toks = lex(String(src ?? ""));
  if (!toks.length) throw new Error("vacío");
  let p = 0;
  const peek = () => toks[p];
  const isOp = (v: string) => peek()?.t === "op" && peek()!.v === v;

  function expr(): number {
    let v = term();
    while (isOp("+") || isOp("-")) {
      const o = toks[p++].v;
      const r = term();
      v = o === "+" ? v + r : v - r;
    }
    return v;
  }
  function term(): number {
    let v = power();
    while (isOp("*") || isOp("/")) {
      const o = toks[p++].v;
      const r = power();
      v = o === "*" ? v * r : v / r;
    }
    return v;
  }
  function power(): number {
    const b = unary();
    if (isOp("^")) { p++; return Math.pow(b, power()); }
    return b;
  }
  function unary(): number {
    if (isOp("-")) { p++; return -unary(); }
    if (isOp("+")) { p++; return unary(); }
    return atom();
  }
  function atom(): number {
    const t = toks[p++];
    if (!t) throw new Error("falta algo al final");
    if (t.t === "n") return t.v;
    if (t.t === "id") {
      const name = t.v;
      if (isOp("(")) {
        const f = FUNCS[name.toLowerCase()];
        if (!f) throw new Error(`función desconocida: ${name}`);
        p++;
        const a = expr();
        if (!isOp(")")) throw new Error("falta «)»");
        p++;
        return f(a);
      }
      if (name in vars) return vars[name];
      if (name.toLowerCase() in CONSTS) return CONSTS[name.toLowerCase()];
      throw new Error(`variable desconocida: ${name}`);
    }
    if (t.v === "(") {
      const v = expr();
      if (!isOp(")")) throw new Error("falta «)»");
      p++;
      return v;
    }
    throw new Error(`sobra «${t.v}»`);
  }

  const v = expr();
  if (p < toks.length) throw new Error(`sobra «${(toks[p] as Tok).v}»`);
  if (!Number.isFinite(v)) throw new Error("el resultado no es un número");
  return v;
}

export const VAR_NAME = /^[a-zA-Z_áéíóúñÁÉÍÓÚÑ][a-zA-Z0-9_áéíóúñÁÉÍÓÚÑ]*$/;

/** Calcula las variables en orden (cada una puede usar las anteriores). */
export function resolveVariables(list: { name: string; value: string }[]) {
  const vars: Record<string, number> = {};
  const errors: Record<string, string> = {};
  for (const v of list) {
    if (!VAR_NAME.test(v.name)) { errors[v.name] = "nombre no válido"; continue; }
    try {
      vars[v.name] = evaluate(v.value, vars);
    } catch (e) {
      errors[v.name] = (e as Error).message;
    }
  }
  return { vars, errors };
}

/** Formato corto para mostrar medidas: 12.5, 3, 0.333 */
export const fmt = (n: number) => (Math.round(n * 1000) / 1000).toString();
