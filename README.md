# tree-patch

`tree-patch` is a TypeScript library for immutable, conflict-aware editing of tree-shaped content.

It is designed for workflows like localization, CMS overlays, and content customization where you want to:

- keep a canonical source tree;
- store changes as semantic patches instead of full copies;
- detect conflicts only when the exact touched fields or structures changed;
- diff, apply, validate, materialize, and rebase patches deterministically.

The runtime has zero Node/Bun-specific dependencies. The built library is intended for modern JavaScript runtimes, including browsers.

## Features

- Typed tree model with `attrs` linked to node `type`
- Immutable indexed snapshots via `createDocument()`
- Conflict-aware patch application with field-scoped guards
- Structural operations: insert, move, replace subtree, remove, hide/show
- Deterministic diff generation and patch rebasing
- Conflict-resolution sessions with per-conflict `takeBase` / `keepLocal`
- Typed patch authoring with `patchBuilder()` and `createEditor()`
- Runtime schema support for atomic paths, custom equality, hashing, cloning, and codecs

## Installation

Install the package from npm:

```bash
npm install @hexie/tree-patch
```

Then import from the package root:

```ts
import {
  createDocument,
  patchBuilder,
  createEditor,
  applyPatch,
  validatePatch,
  materialize,
  createResolutionSession,
  diffTrees,
  rebasePatch,
} from "@hexie/tree-patch";
```

## Core Concepts

- `TreeDocument`: nested source document shape
- `IndexedTree`: immutable indexed snapshot returned by `createDocument()`
- `TreePatch`: JSON-serializable patch with semantic operations
- `MaterializedNode`: nested output after applying a patch
- `TreeSchema`: runtime adapters and codecs for non-trivial attribute values

## Quick Start

```ts
import {
  applyPatch,
  createDocument,
  patchBuilder,
  type TreeDocument,
} from "@hexie/tree-patch";

type ContentTypes = {
  Page: {};
  Hero: {
    title: string;
    image: {
      url: string;
      alt?: string;
    };
  };
  RichText: {
    html: string;
  };
};

const sourceDocument: TreeDocument<ContentTypes> = {
  revision: "rev-1",
  root: {
    id: "root",
    type: "Page",
    attrs: {},
    children: [
      {
        id: "hero",
        type: "Hero",
        attrs: {
          title: "Summer Sale",
          image: {
            url: "/img/en.png",
          },
        },
        children: [],
      },
      {
        id: "legal",
        type: "RichText",
        attrs: {
          html: "<p>US only</p>",
        },
        children: [],
      },
    ],
  },
};

const source = createDocument(sourceDocument);

const patch = patchBuilder<ContentTypes>({ source })
  .patchId("fr-home")
  .node("hero", "Hero")
  .set(["title"], "Promotions d'ete", {
    expect: "Summer Sale",
  })
  .set(["image", "url"], "/img/fr.png", {
    expect: "/img/en.png",
  })
  .hideNode("legal")
  .build();

const result = applyPatch(source, patch, { includeHidden: false });

if (result.status === "applied") {
  console.log(result.tree.revision);
  console.log(result.materialized.children[0]?.attrs);
}
```

## Building Patches

There are two authoring styles:

- `patchBuilder()` for fluent patch construction
- `createEditor()` for editing against an existing source tree with validated node handles

Field edits are intentionally node-scoped:

```ts
const patch = patchBuilder<ContentTypes>({ source })
  .patchId("promo-flow")
  .node("hero", "Hero")
  .set(["title"], "Localized title")
  .set(["image", "url"], "/img/fr.png")
  .hideNode("legal")
  .build();
```

Using the editor:

```ts
const editor = createEditor(source, { patchId: "promo-flow" });

editor.node("hero", "Hero").set(["title"], "Localized title");
editor.node("legal", "RichText").hide();

const patch = editor.build();
```

## Applying, Validating, and Materializing

```ts
const validation = validatePatch(source, patch, { mode: "preview" });

const applied = applyPatch(source, patch, {
  mode: "atomic",
  includeHidden: false,
});

const materialized = materialize(source, patch, {
  mode: "preview",
  includeHidden: true,
});
```

Behavior summary:

- `validatePatch()` checks conflicts without producing a preview tree
- `applyPatch()` returns a new immutable `IndexedTree`
- `materialize()` uses the same conflict semantics as `applyPatch()`
- `atomic` mode stops at the first conflict
- `preview` mode keeps successful ops and reports skipped conflicts

## Diff and Rebase

```ts
const base = createDocument(sourceDocument);
const target = createDocument({
  ...sourceDocument,
  root: {
    ...sourceDocument.root,
    children: sourceDocument.root.children.map((child) =>
      child.id === "hero"
        ? {
            ...child,
            attrs: {
              ...child.attrs,
              title: "Promotions d'ete",
            },
          }
        : child,
    ),
  },
});

const patch = diffTrees(base, target);
const rebased = rebasePatch(base, target, patch);
```

`diffTrees()` generates deterministic semantic ops. `rebasePatch()` replays a patch on a new base and keeps only the operations that still apply cleanly.

## Conflict Resolution

For localization-style workflows, you can create a resolution session, make per-conflict decisions, and rebuild a fresh patch against the new base.

```ts
const session = createResolutionSession(oldBase, newBase, patch);

for (const conflict of session.unresolvedConflicts) {
  if (conflict.opId === "hero-title") {
    session.keepLocal(conflict.opId);
  } else {
    session.takeBase(conflict.opId);
  }
}

const result = session.build();

if (result.status === "resolved") {
  const nextPatch = result.resolvedPatch;
}
```

Notes:

- `takeBase(opId)` drops that operation from the rebuilt patch
- `keepLocal(opId)` replays the original operation intent without its old guards
- `build()` still returns a patch; the resolved preview tree is only an in-memory intermediate

## Schemas, Adapters, and Codecs

Use a `TreeSchema` when you need custom equality, hashing, cloning, or persistence for runtime values.

```ts
import { createDocument, patchBuilder, type TreeSchema } from "@hexie/tree-patch";

type ContentTypes = {
  Hero: {
    title: string;
    publishedAt?: Date;
  };
};

const dateCodec = {
  codecId: "date",
  serialize(value: Date) {
    return value.toISOString();
  },
  deserialize(value: string) {
    return new Date(value);
  },
};

const schema: TreeSchema<ContentTypes> = {
  types: {
    Hero: {
      adapters: {
        "/publishedAt": {
          equals: (left: Date, right: Date) => left.getTime() === right.getTime(),
          clone: (value: Date) => new Date(value.getTime()),
          hash: (value: Date) => value.toISOString(),
          codec: dateCodec,
        },
      },
    },
  },
};
```

Notes:

- JSON-compatible values work without codecs
- non-JSON persisted patch values require a codec
- the envelope shape `{ $codec, value }` is reserved for encoded persisted values

## Public API

Main functions:

- `createDocument()`
- `validatePatch()`
- `applyPatch()`
- `materialize()`
- `diffTrees()`
- `rebasePatch()`
- `createResolutionSession()`
- `patchBuilder()`
- `createEditor()`
- `pathToPointer()` / `pointerToPath()`

Main exported types:

- `TreeDocument`
- `IndexedTree`
- `TreePatch`
- `PatchOp`
- `PatchConflict`
- `MaterializedNode`
- `TreeSchema`
- `ValueAdapter`
- `ValueCodec`

## Runtime Compatibility

The library runtime does not depend on Node-only or Bun-only APIs.

It uses standard modern JavaScript features such as:

- `Map` / `Set`
- `WeakMap`
- `Proxy`
- `structuredClone`
- `String.prototype.replaceAll`

That makes it suitable for modern browsers, Bun, Deno, and Node ESM environments. Older browsers may require transpilation or polyfills.

## Development

```bash
bun run build
bun run typecheck
bun test
```

The compiled package is emitted to `dist/`.

## Status

The implementation currently covers the planned v1 feature set of the library.
