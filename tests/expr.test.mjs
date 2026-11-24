import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, resolveVariables } from "../src/expr.ts";

test("cuentas básicas", () => {
  assert.equal(evaluate("2 + 3 * 4", {}), 14);
  assert.equal(evaluate("(2 + 3) * 4", {}), 20);
  assert.equal(evaluate("2 ^ 3 ^ 2", {}), 512);
  assert.equal(evaluate("-5 + 2", {}), -3);
  assert.equal(evaluate("1,5 * 2", {}), 3);
});

test("variables y funciones", () => {
  const { vars } = resolveVariables([{ name: "ancho", value: "60" }, { name: "mitad", value: "ancho / 2" }]);
  assert.equal(vars.mitad, 30);
  assert.equal(evaluate("sqrt(16) + mitad", vars), 34);
  assert.ok(Math.abs(evaluate("cos(60)", {}) - 0.5) < 1e-12);
});

test("errores claros", () => {
  assert.throws(() => evaluate("ancho", {}), /variable desconocida/);
  assert.throws(() => evaluate("2 +", {}), /falta algo/);
  assert.throws(() => evaluate("alert(1)", {}), /función desconocida/);
  assert.throws(() => evaluate("1/0", {}), /no es un número/);
});
