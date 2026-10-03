# Skill integration: what the `family-meal-planner` skill must know

The app now owns three files in `family-meal-planner/` that the skill must
**read** and must **never write**:

| File | Content | Skill use |
| --- | --- | --- |
| `plans.json` | the weekly plans (`plans`) | variety history; shopping lists in chat |
| `pantry.json` | the pantry staples (`pantry`) | replaces `family-data.json`'s `pantry` once it exists |
| `wishlist.json` | recipes the family wants added (`wishes`) | the "load the wishlist" task below |

The text below is meant to be added to the skill's `SKILL.md` (for example with
the skill-creator), in the skill's own style. It is not loaded by the app.

---

## Files written by the app (read only)

The family's web app writes `plans.json`, `pantry.json` and `wishlist.json` in the
same folder. Read them when a task needs them; never create, change or archive
them.

- **Pantry**: when `pantry.json` exists, its `pantry` list replaces the `pantry`
  of `family-data.json` (which is only the starting point). Use it for every
  shopping list.
- **Plans**: `plans.json` holds `plans` (same shape as the schema's `plans`);
  confirmed plans feed the variety history.

## Loading the recipe wishlist

Trigger: "carica le ricette della lista", "aggiungi le ricette da provare", or
whenever the family mentions the wishlist.

1. Load `catalog.json`, `family-data.json` and `wishlist.json`.
2. Pending wishes are those whose `id` appears in no dish's `source.ref` as
   `wish:<id>`. List them in Italian (name, who asked, note, link).
3. For each pending wish, one at a time or as the family prefers:
   - open the link if there is one; otherwise ask how the family makes it;
   - if it is a variant of an existing dish, say so and ask whether to add it
     as a new dish or just mark the wish as covered by that dish (in that case
     append `wish:<id>` to the existing dish's `source.ref`);
   - otherwise build the new dish following `references/schema.md` and
     `references/taxonomy.md`: `source.type` `web` (with `url`) or `personal`,
     `source.ref` containing `wish:<id>`, ingredients with aisles, quantities only
     if the recipe states them, `prep_minutes`, classification, `verified: false`.
4. Show the family what will change and wait for "salva", as for every save.
   Validate, then save `catalog.json` (new copy + archive the old one).
5. Do not edit `wishlist.json`: the app shows a wish as "nel catalogo" as soon as
   a dish refers to it. The family removes wishes from the app.

Several wishes can point to one dish: `source.ref` may hold
`"wish:w-20261004-ab12cd, wish:w-20261005-ef34ab"`.
