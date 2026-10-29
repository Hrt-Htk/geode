import { pickViewActionsIndex } from "../../../plugin/ui/view-actions.ts";
import { assertEquals } from "@std/assert";

Deno.test("view-actions - no candidates yields -1", () => {
  assertEquals(pickViewActionsIndex([]), -1);
});

Deno.test("view-actions - phone: the single visible raised container is chosen", () => {
  assertEquals(pickViewActionsIndex([{ raised: true, visible: true }]), 0);
});

Deno.test("view-actions - tablet: a visible non-raised container is chosen (regression #309)", () => {
  // Tablet renders view-actions WITHOUT mod-raised; the old .view-actions.mod-raised
  // selector matched nothing and the mobile status shim never injected.
  assertEquals(
    pickViewActionsIndex([
      { raised: false, visible: true },
      { raised: false, visible: false },
    ]),
    0,
  );
});

Deno.test("view-actions - prefers a visible raised container over a visible non-raised one", () => {
  assertEquals(
    pickViewActionsIndex([
      { raised: false, visible: true },
      { raised: true, visible: true },
    ]),
    1,
  );
});

Deno.test("view-actions - prefers any visible container over an invisible raised one", () => {
  assertEquals(
    pickViewActionsIndex([
      { raised: true, visible: false },
      { raised: false, visible: true },
    ]),
    1,
  );
});

Deno.test("view-actions - all invisible falls back to the first container", () => {
  assertEquals(
    pickViewActionsIndex([
      { raised: false, visible: false },
      { raised: true, visible: false },
    ]),
    0,
  );
});
