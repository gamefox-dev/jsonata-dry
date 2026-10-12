# jsonata-dry

A **dry-run** for [JSONata](https://jsonata.org), plus a typesafe flow editor built on top of it.

JSONata normally takes a JSON *value*, runs a query, and returns another JSON value. The dry-run takes a
JSON *Schema* and returns a JSON Schema: it tells you what an expression can produce, whether it can
produce nothing at all, and what is wrong with it, without any data.

```ts
import { dryRun } from './src/dry'

const r = dryRun(
  '{ "name": customer.name, "email": customer.email, "n": $count(items) }',
  orderSchema,
)
r.schema    // { type: 'object', properties: { name: {type:'string'}, email: {type:'string'}, n: {type:'integer'} },
            //   required: ['name', 'n'], additionalProperties: false }
r.optional  // false: can this evaluate to `undefined`?
r.type      // "{ name: string; email?: string; n: integer }"
r.diagnostics
```

## Run it

```sh
bun install
bun run dev      # the flow editor
bun test         # engine, flow analysis, TypeBox bridge, differential fuzz against real JSONata
bun run build
bun run deploy   # build + `wrangler deploy` to Cloudflare Workers (static assets), see wrangler.jsonc
```

Live: <https://jsonata-dry.gamefox.vn>

## What the dry-run knows

It walks the real JSONata AST (`jsonata(expr).ast()`), so syntax is never re-implemented, and it models
the parts of JSONata semantics that make types surprising:

| JSONata behaviour | In the dry-run |
| --- | --- |
| A path that matches nothing yields `undefined`, silently | `undefined` is a first-class union member; optional properties become `required`-less |
| Paths over arrays collect a *sequence*: 0 → `undefined`, 1 → the item itself, n → an array | `items.price` is `number \| number[] \| undefined`; `items.price[]` is `number[] \| undefined` |
| `a[0]`, `a[pred]` filters apply per context item | index filters give `T \| undefined`, predicate filters give a sequence |
| `a ?? b`, `$exists(x) ? x : y` | the branch is narrowed: `x` is no longer `undefined` inside |
| `1 > 2 ? a : b`, `$type(name) = "number"` | constant-folded to a literal `false`, which is how dead branches are found |
| `$map/$filter/$reduce/$each…` and lambdas | call sites are re-inferred with the real argument types |
| `@$x` focus, `#$i` index, `%` parent, `**`, `*`, `^(…)`, `{…}` group-by | all handled |
| `+ - * /` on strings, `"a" < 1`, `$uppercase(number)` | errors (these throw at runtime); *maybe*-wrong types are warnings |
| Reading a property the schema does not declare | warning with the source range |

Built-in function signatures are taken from JSONata's own signature strings (`<s-nn?:s>`), so arity, the
"context is used when the argument is omitted" rule and singleton-to-array wrapping match the library.

### How much to trust it

The inference is a static over-approximation. `tests/dry.test.ts` is a **differential fuzzer**: it generates
random inputs from each schema, evaluates ~150 expressions with the *real* JSONata, and asserts every
actual result conforms to the inferred type (including "returned `undefined` ⇒ `optional` must be true").
`tests/precision.test.ts` pins the *precise* answers so a sound-but-useless `any` can't pass.

Known gaps: `$eval` and the date/number-format functions are typed loosely, `%` (parent) is approximated,
recursion is cut off at depth 10 (→ `any`), and only the common JSON Schema keywords are understood
(`type`, `properties`, `required`, `items`, `enum`, `const`, `anyOf/oneOf/allOf`, `additionalProperties`,
`$ref` to named types). Values that cannot be determined become `any`, and `any` is assignable both ways,
like in TypeScript.

## The flow editor

Left panel: node palette, named **types**, and **functions** (input type → output type).
Centre: the React Flow canvas. Bottom: the details of whatever is selected (Monaco editors, forms, the
inferred types, diagnostics). Both splitters drag; double-click one to reset it.

A schema can be authored three ways and they stay in sync through JSON Schema: a **JSON Schema** Monaco
editor, a visual **Form**, or **TypeBox** code (`t.Object({ name: t.String() })`, with autocomplete).
Named types are referenced as `{ "$ref": "Order" }` or `t.Ref("Order")`; renaming a type rewrites its
references.

### Nodes

| Node | Takes | Gives |
| --- | --- | --- |
| **Input** | – | its schema (the flow's only entry point) |
| **Transform** | an object, plus optional named extra inputs (`$name`) | the dry-run type of its JSONata expression |
| **Condition** | same | a boolean (a non-boolean expression is an error; use `$boolean()`) |
| **Branch** | a boolean | `yes` / `no` trigger gates |
| **Loop** | an array | `item`, `index`, (`acc`), `results`; `each` and `done` gates |
| **Call** | an argument matching the function's input type | the function's output type |
| **Return** | a value | – |

### Two kinds of wire

* **Data** (round handles): carries a typed value. Colour = structural type; the label on the wire is the type.
* **Trigger** (diamond handles, dashed): carries a "go" signal.

Every node has a **trigger** input. If something is connected to it, the node is *lazy*: it does not start
just because its data is ready, it waits for the signal. Every node can emit `done`; branches emit `yes`/`no`;
loops emit `each`/`done`.

### The loop (my design)

A loop is one node with a body hanging off it, so the graph stays flat and acyclic:

```
array ─▶ ┌────────┐ ─ item / index / acc ─▶ [body nodes, triggered by `each`]
         │  loop  │ ◀─ collect / next acc ──────────────────┘
initial ▶└────────┘ ─ results ─▶ …        ─ done ─▶ (trigger after the last iteration)
```

* **map**: whatever reaches `collect` is gathered; `results` is `Array<collected type>`.
* **reduce**: `initial` fixes the accumulator type (literals widen, so `0` is `number`); `next acc` must be
  assignable to it; the result is the accumulator.

`collect` is the only edge allowed to point "backwards"; everything else must be acyclic.

### What the flow analysis reports

* **Types** propagate along data wires; an argument that doesn't fit a function says *why*
  (`property "to" is optional but required here`).
* **Dead branches**: a branch whose condition is statically known kills the other gate, and everything
  reachable only through it, including data consumers and returns. Nodes not connected to the input are
  *unreachable*.
* **Async**: a Call can be toggled async (fire and forget). The flow continues through its `done` gate
  immediately; its `result` is only usable in the detached branch. A **Return in a detached branch is an
  error** and does not count toward the result.
* **Returns**: all live, synchronous returns must be *combinable*: identical, sub/supertype, differing only
  by `null`/`undefined`, or objects/arrays whose parts are combinable recursively
  (`{receiptId: string}` + `{receiptId: null}` → `{receiptId: string | null}`). Anything else is an error on
  both returns. The unified type is the flow's result type.

Two examples are built in (toolbar): a clean order-checkout flow, and one that triggers every diagnostic.

### Running a flow

**▶ Run** (toolbar) executes the flow for real and replays it on the canvas.

* JSONata expressions are evaluated with the real library. The input is JSON you edit in the Run panel
  (validated and completed against the flow's input type; *New sample* generates one).
* Functions have no implementation, so each can carry a **mock**: a JSONata expression where `$` is the
  argument (set in the function's definition). Without one, a deterministic sample of the return type is used.
* The engine follows the same rules as the static analysis: nodes wait for their data and, if lazy, their
  trigger; a branch fires one gate; a loop runs its body once per item in a fresh scope; the first synchronous
  return ends the flow; async branches keep running but their returns are discarded (and reported).
* The **replay** steps through the trace (⏮ ◀ ▶ ⏭, play/pause, 0.5×–2×, scrubber): the current node is
  ringed, wires that carried something light up and show the actual value, nodes that never ran fade, and
  every node shows its step number and result. Click a step to see exactly what it received and produced.

### Editor assistance

* **JSON Schema**: completion and hover for keywords, `type` values, `format`, snippets for common shapes,
  `$ref` names from your named types, and `required` names from the sibling `properties`.
* **TypeBox**: the real `@sinclair/typebox` typings are loaded into Monaco, so `t.` shows signatures,
  option objects (`t.String({ minLength })`) and docs; `t.Ref("` completes named types.
* **JSONata**: completion is driven by the dry-run itself. The text before the cursor is made parseable and
  dry-run against the real input type, and the inferer reports what the cursor is looking at, so `items.`,
  `items[` (the item's fields), `$map(items, function($v){ $v.` and `{ "a": customer.` all complete with
  field types and optionality. `$` completes variables in scope (assignments, lambda parameters, connected
  inputs) and built-in functions with signature, docs and a snippet. Hover shows the inferred type.

## Layout

```
src/dry/       the engine: ty.ts (types), schema.ts (JSON Schema ⇄ types), builtins.ts, infer.ts,
               complete.ts (completion + hover), sample.ts (random values of a type)
src/flow/      model.ts (nodes/handles), analyze.ts (types, liveness, async, returns), run.ts (executor),
               examples.ts
src/schema/    typebox.ts (evaluate TypeBox code / print schemas as TypeBox)
src/ui/        canvas, nodes, panels, Monaco editors
tests/         bun test (incl. the differential fuzzer)
```

## Notes

* `@sinclare/typebox` in the brief is `@sinclair/typebox` on npm.
* TypeBox code is evaluated with `new Function` in the page, exactly as trusted as the JSON you type into the
  app; there is no sandbox.
* The flow is persisted to `localStorage`.
* React Flow's attribution badge is left visible (hiding it requires a Pro subscription).
