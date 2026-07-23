import {
  createDocument,
  createEditor,
  applyPatch,
  patchBuilder,
  type TreeDocument,
} from "../../src/index.js";

type ContentTypes = {
  Page: {};
  Hero: {
    title: string;
    subtitle?: string;
    image: {
      url: string;
      alt?: string;
    };
    style?: {
      fontSize?: number;
    };
    deep?: {
      l1?: {
        l2?: {
          l3?: {
            l4?: string;
          };
        };
      };
    };
  };
  RichText: {
    html: string;
  };
};

const document: TreeDocument<ContentTypes> = {
  root: {
    id: "root",
    type: "Page",
    attrs: {},
    children: [
      {
        id: "hero",
        type: "Hero",
        attrs: {
          title: "Hello",
          image: {
            url: "/hero.png",
          },
        },
        children: [],
      },
      {
        id: "legal",
        type: "RichText",
        attrs: {
          html: "<p>Legal</p>",
        },
        children: [],
      },
    ],
  },
};

const source = createDocument(document);
const applied = applyPatch(source, {
  format: "tree-patch/v1",
  patchId: "readonly-types",
  ops: [],
});

// @ts-expect-error immutable snapshots expose readonly root ids
source.rootId = "other";

const indexedHero = source.nodes.get("hero");
if (indexedHero) {
  // @ts-expect-error immutable indexed nodes expose readonly ids
  indexedHero.id = "other";
}

if (applied.status === "applied") {
  if (applied.materialized.type === "Hero") {
    const narrowedTitle: string = applied.materialized.attrs.title;
    // @ts-expect-error discriminated materialized attrs exclude other node types
    applied.materialized.attrs.html;
    void narrowedTitle;
  }
}

const builder = patchBuilder<ContentTypes>();
builder.node("hero", "Hero").set(["title"], "Promotions");
builder.node("hero", "Hero").set(["style", "fontSize"], 32);
builder.node("hero", "Hero").set(["deep", "l1", "l2", "l3", "l4"], "deep value");
builder.node("hero", "Hero").set([], {
  title: "Whole attrs",
  image: { url: "/whole.png" },
});
builder.insertNode("root", {
  id: "promo",
  type: "RichText",
  attrs: {
    html: "<p>Promo</p>",
  },
  children: [],
});

const editor = createEditor(source);
editor.node("hero", "Hero").set(["image", "url"], "/img/fr.png");
editor.node("hero", "Hero").set(["subtitle"], "Limited offer", { expectAbsent: true });
editor.node("hero", "Hero").set(["style", "fontSize"], 28);
editor.node("legal", "RichText").set(["html"], "<p>Updated</p>");
editor.node("hero", "Hero").set(["title"], "Last writer wins", {
  unguarded: true,
});

// @ts-expect-error removing the whole attrs root is not a valid operation
builder.node("hero", "Hero").remove([]);

// @ts-expect-error root builder no longer exposes field methods
builder.setAttr("hero", ["title"], "x");

// @ts-expect-error invalid builder path
builder.node("hero", "Hero").set(["missing"], "x");

// @ts-expect-error invalid builder value type
builder.node("hero", "Hero").set(["style", "fontSize"], "large");

// @ts-expect-error invalid deep path value type
builder.node("hero", "Hero").set(["deep", "l1", "l2", "l3", "l4"], 42);

// @ts-expect-error cross-type builder path
builder.node("hero", "Hero").set(["html"], "<p>wrong</p>");

// @ts-expect-error invalid editor path for Hero node
editor.node("hero", "Hero").set(["html"], "<p>wrong</p>");

// @ts-expect-error invalid editor value type
editor.node("hero", "Hero").set(["style", "fontSize"], "large");

// @ts-expect-error invalid editor deep path
editor.node("hero", "Hero").set(["deep", "l1", "missing"], "x");
