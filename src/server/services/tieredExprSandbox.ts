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
 * The environment must track NewAPI's authoritative definition, not its prose
 * docs: `pkg/billingexpr/compile.go` (`compileEnvPrototypeV1`) and
 * `pkg/billingexpr/run.go` (`runProgram`'s env literal). Those two carry:
 *
 *   variables — image_count, p, c, len, cr, cc, cc1h, cc12h, img, img_cr,
 *               img_o, ai, ao
 *   functions — tier, fixed, header, param, u, has, hour, minute, weekday,
 *               month, day, max, min, abs, ceil, floor
 *
 * (`_trace`/`_trace_int` are injected by upstream's own AST patcher into the
 * program it compiles; they never appear in a stored expression, so they are
 * deliberately absent here.)
 *
 * A name that exists upstream but not here is not a neutral omission — it is a
 * hard `ReferenceError` that propagates out of the pricing layer and aborts
 * whatever called it (route snapshot refresh, `/v1/models`).
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
  let __parts;
  try {
    __parts = new Intl.DateTimeFormat('en-US', __options).formatToParts(new Date());
  } catch (__error) {
    // Upstream's timeInZone() falls back to UTC when LoadLocation fails, so an
    // unknown/abbreviated zone must not throw out of the sandbox either.
    delete __options.timeZone;
    __parts = new Intl.DateTimeFormat('en-US', __options).formatToParts(new Date());
  }
  const __value = __parts.find((__item) => __item.type === __part)?.value;
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
  const cc12h = __a[11];
  // Upstream initializes imageCount to 1 and only overrides it from a validated
  // request quantity, so a missing value must stay 1 (not 0) to keep
  // tier("image", fixed(x)) * image_count priced per image.
  const image_count = __a[12];
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
  // has(source, substr): upstream returns false for a nil source or an empty
  // needle. String(undefined).includes('') would return true, so guard both.
  const has = (source, substr) => {
    if (source === undefined || source === null) return false;
    const needle = String(substr ?? '');
    if (needle === '') return false;
    return String(source).includes(needle);
  };
  // Request-context probes. The evaluator runs without a request body or a
  // usage-facts map, so these resolve to neutral values and request rules take
  // their fallback branch.
  const header = (_key) => '';
  const param = (_path) => '';
  // u(name) reads a usage fact (upstream returns nil when the map is absent).
  // Undefined is the faithful nil here: u("x") ?? 0 yields 0, while arithmetic
  // on a genuinely unknown fact becomes NaN and surfaces as a non-finite error
  // instead of silently billing zero.
  const u = (_name) => undefined;
  return { value: (${expr}), tier: __tierName };
}
`;
}

/**
 * Normalize an upstream expression into something this realm can compile.
 *
 * Two upstream syntaxes are not plain JS:
 *  - a version tag: `v1:tier(...)`. Upstream strips the literal `v1:` in
 *    `ParseExprVersion` and defaults an unprefixed string to v1. Any other
 *    version is rejected instead of being evaluated with v1 semantics — a
 *    future `v2:` changes token normalization, so guessing would misprice.
 *  - request rules after `|||`: `tier(...)|||when(header("x") has "y") * 6`.
 *    Those multipliers depend on the live request. This evaluator has no request
 *    context (header()/param() resolve neutral), so every such rule takes its
 *    `: 1` fallback; dropping the suffix is therefore equivalent to evaluating
 *    it, and keeps the token cost intact.
 */
export function normalizeTieredExpr(expr: string): string {
  let body = String(expr ?? '').trim();
  const ruleSeparator = body.indexOf('|||');
  if (ruleSeparator >= 0) body = body.slice(0, ruleSeparator).trim();

  if (body.startsWith('v1:')) {
    body = body.slice(3).trim();
  } else {
    const versioned = /^v(\d+):/.exec(body);
    if (versioned) {
      throw new Error(`unsupported tiered billing expression version: v${versioned[1]}`);
    }
  }

  if (!body) {
    throw new Error('tiered billing expression is empty');
  }
  return body;
}

function compileTierExpr(rawExpr: string): CompiledTierExpr {
  const expr = normalizeTieredExpr(rawExpr);
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
    cc12h?: number; image_count?: number;
  },
): TieredExprEvaluation {
  const compiled = getCompiled(expr);
  const { value, tier } = compiled.evaluate([
    params.p, params.c, params.len, params.cr, params.cc,
    params.cc1h, params.img, params.img_cr, params.img_o, params.ai, params.ao,
    params.cc12h ?? 0,
    // Upstream defaults the image quantity to 1, so an absent value must not
    // collapse a per-image price to zero.
    params.image_count ?? 1,
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
