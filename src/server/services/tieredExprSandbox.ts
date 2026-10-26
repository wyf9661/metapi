import { createContext, runInContext, type Context } from 'node:vm';

/**
 * Evaluates NewAPI `billing_mode=tiered_expr` pricing expressions inside a
 * `node:vm` context instead of `new Function`.
 *
 * Those expressions arrive in the upstream `/api/pricing` response, so they are
 * third-party input even though the site is one the operator configured: a
 * compromised or malicious relay panel controls the string. `new Function`
 * evaluates it in THIS realm, where `process`, `require`, `fetch` and every
 * constructor are reachable, so a crafted expression is arbitrary code execution
 * inside the server process.
 *
 * The context is built the same way the acw-sc challenge worker is
 * (`newApiShield.ts`): a null-prototype global with `codeGeneration` disabled.
 * Measured properties of that realm:
 *   - `typeof process` / `require` / `fetch` → undefined
 *   - `eval(...)`, `Function(...)`, `({}).constructor.constructor(...)` →
 *     "Code generation from strings disallowed for this context"
 *   - `Math`, `Date`, `Intl`, `Number` are present, so the helper preamble needs
 *     no host functions
 *   - `runInContext` timeouts still interrupt a runaway loop
 *
 * Evaluation goes through `runInContext` on EVERY call rather than handing a
 * sandbox function back to the caller: a host-invoked vm function runs without
 * the timeout, so an infinite loop in the expression would hang the process.
 */

/** Generous for arithmetic; still bounds a pathological expression. */
const EXPR_TIMEOUT_MS = 100;

/** Compiling builds a whole realm, so keep the working set bounded. */
const MAX_COMPILED_EXPRESSIONS = 64;

type CompiledTierExpr = {
  context: Context;
  /** Call the compiled evaluator with the numeric token params. */
  evaluate: (args: readonly number[]) => { value: unknown; tier: unknown };
};

/**
 * The helper preamble, mirroring the helper surface NewAPI's expression
 * contract exposes. It is compiled by the host (allowed) and may only reference
 * realm intrinsics — never a host function.
 *
 * The variable list must track NewAPI's `pkg/billingexpr/expr.md`: input-side
 * `p`, `len`, `cr`, `cc`, `cc1h`, `img`, `img_cr`, `ai` and output-side `c`,
 * `img_o`, `ao`. A variable that exists upstream but not here is not a neutral
 * omission — it is a hard `ReferenceError` that propagates out of the pricing
 * layer and aborts whatever called it (route snapshot refresh, `/v1/models`).
 *
 * `__tieredEval` returns both the value and the matched tier name so nothing has
 * to be read back off the sandbox global (top-level `let` bindings are not
 * global properties, and shared mutable state would leak between calls).
 */
function buildPreamble(expr: string): string {
  return `
'use strict';
function __zonedPart(__timezone, __part) {
  const __tz = String(__timezone || '').trim() || 'UTC';
  const __options = { timeZone: __tz };
  if (__part === 'weekday') {
    __options.weekday = 'short';
  } else {
    __options[__part] = 'numeric';
  }
  const __value = new Intl.DateTimeFormat('en-US', __options)
    .formatToParts(new Date())
    .find((__item) => __item.type === __part)?.value;
  if (__part === 'weekday') {
    return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(__value || 'Sun');
  }
  return Number(__value || 0);
}
function __tieredEval(__a) {
  let __tierName = '';
  const p = __a[0];
  const c = __a[1];
  const len = __a[2];
  const cr = __a[3];
  const cc = __a[4];
  const cc1h = __a[5];
  const img = __a[6];
  const img_cr = __a[7];
  const img_o = __a[8];
  const ai = __a[9];
  const ao = __a[10];
  const tier = (name, value) => { __tierName = String(name); return value; };
  const hour = (timezone) => __zonedPart(timezone, 'hour');
  const minute = (timezone) => __zonedPart(timezone, 'minute');
  const weekday = (timezone) => __zonedPart(timezone, 'weekday');
  const month = (timezone) => __zonedPart(timezone, 'month');
  const day = (timezone) => __zonedPart(timezone, 'day');
  const max = Math.max;
  const min = Math.min;
  const abs = Math.abs;
  const ceil = Math.ceil;
  const floor = Math.floor;
  // fixed(amount): USD per request — NewAPI scales it by 1_000_000 to its
  // internal quota unit, and our formula divides back by 1_000_000.
  const fixed = (amount) => Number(amount) * 1_000_000;
  const has = (source, substr) => String(source).includes(String(substr));
  // Request-context probes. The evaluator runs without a request body, so these
  // resolve to neutral values and request rules take their fallback branch.
  const header = (_key) => '';
  const param = (_path) => '';
  return { value: (${expr}), tier: __tierName };
}
`;
}

function compileTierExpr(expr: string): CompiledTierExpr {
  const context = createContext(Object.create(null), {
    // No host objects cross into this realm.
    codeGeneration: { strings: false, wasm: false },
  });
  runInContext(buildPreamble(expr), context, { timeout: EXPR_TIMEOUT_MS });

  return {
    context,
    evaluate: (args: readonly number[]) => {
      // The params are finite numbers we produced, so inlining them as an array
      // literal keeps every call self-contained (no mutation of the sandbox).
      const result = runInContext(
        `__tieredEval(${JSON.stringify(args)})`,
        context,
        { timeout: EXPR_TIMEOUT_MS },
      ) as { value?: unknown; tier?: unknown } | undefined;
      return { value: result?.value, tier: result?.tier };
    },
  };
}

const compiledByExpr = new Map<string, CompiledTierExpr>();

function getCompiled(expr: string): CompiledTierExpr {
  const cached = compiledByExpr.get(expr);
  if (cached) return cached;

  const compiled = compileTierExpr(expr);
  if (compiledByExpr.size >= MAX_COMPILED_EXPRESSIONS) {
    // Simple FIFO eviction; the working set is the operator's model list.
    const oldest = compiledByExpr.keys().next();
    if (!oldest.done) compiledByExpr.delete(oldest.value);
  }
  compiledByExpr.set(expr, compiled);
  return compiled;
}

export type TieredExprEvaluation = {
  cost: number;
  tier: string;
};

/**
 * Evaluate a tiered pricing expression in isolation.
 *
 * Throws on a non-numeric result or a sandbox violation (syntax error, disabled
 * code generation, timeout) — callers keep their previous behaviour of letting
 * the error surface rather than silently billing zero.
 */
export function evaluateTieredExprInSandbox(
  expr: string,
  params: {
    p: number; c: number; len: number; cr: number; cc: number;
    cc1h: number; img: number; img_cr: number; img_o: number; ai: number; ao: number;
  },
): TieredExprEvaluation {
  const compiled = getCompiled(expr);
  const { value, tier } = compiled.evaluate([
    params.p, params.c, params.len, params.cr, params.cc,
    params.cc1h, params.img, params.img_cr, params.img_o, params.ai, params.ao,
  ]);
  const cost = Number(value);
  if (!Number.isFinite(cost)) {
    throw new Error('tiered billing expression returned a non-finite value');
  }
  return { cost, tier: typeof tier === 'string' ? tier : '' };
}

export function __resetTieredExprSandboxForTests(): void {
  compiledByExpr.clear();
}
