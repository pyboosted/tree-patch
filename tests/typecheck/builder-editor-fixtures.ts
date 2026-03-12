import {
  createDocument,
  createEditor,
  patchBuilder,
  type TreeDocument,
} from "../../src/index.js";

type ContentTypes = {
  Page: {};
  Hero: {
    title: string;
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

const builder = patchBuilder<ContentTypes>();
builder.setAttr("hero", ["title"], "Promotions");
builder.setAttr("hero", ["style", "fontSize"], 32);
builder.setAttr("hero", ["deep", "l1", "l2", "l3", "l4"], "deep value");
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
editor.node("hero", "Hero").set(["style", "fontSize"], 28);
editor.node("legal", "RichText").set(["html"], "<p>Updated</p>");

// @ts-expect-error invalid builder path
builder.setAttr("hero", ["missing"], "x");

// @ts-expect-error invalid builder value type
builder.setAttr("hero", ["style", "fontSize"], "large");

// @ts-expect-error invalid deep path value type
builder.setAttr("hero", ["deep", "l1", "l2", "l3", "l4"], 42);

// @ts-expect-error invalid editor path for Hero node
editor.node("hero", "Hero").set(["html"], "<p>wrong</p>");

// @ts-expect-error invalid editor value type
editor.node("hero", "Hero").set(["style", "fontSize"], "large");

// @ts-expect-error invalid editor deep path
editor.node("hero", "Hero").set(["deep", "l1", "missing"], "x");
