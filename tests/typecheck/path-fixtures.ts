import type {
  AttrPath,
  DeepValue,
  Guard,
  TreeNode,
  TreePatch,
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
  };
};

const heroNode: TreeNode<ContentTypes, "Hero"> = {
  id: "hero",
  type: "Hero",
  attrs: {
    title: "Hello",
    image: {
      url: "/hero.png",
    },
  },
  children: [],
};

const validPath: AttrPath<ContentTypes["Hero"]> = ["image", "url"];
const validValue: DeepValue<ContentTypes["Hero"], ["style", "fontSize"]> = 32;
const guard: Guard = { kind: "nodeExists", nodeId: heroNode.id };
const patch: TreePatch = {
  format: "tree-patch/v1",
  patchId: "fixture",
  ops: [],
};

void validPath;
void validValue;
void guard;
void patch;

// @ts-expect-error invalid attribute path
const invalidPath: AttrPath<ContentTypes["Hero"]> = ["missing"];

// @ts-expect-error invalid deep value type
const invalidValue: DeepValue<ContentTypes["Hero"], ["style", "fontSize"]> = "large";

// @ts-expect-error attrs must match the selected node type
const invalidHeroAttrs: ContentTypes["Hero"] = { html: "<p>wrong shape</p>" };

void invalidPath;
void invalidValue;
void invalidHeroAttrs;
