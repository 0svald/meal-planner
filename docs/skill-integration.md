# Skill integration: what the `family-meal-planner` skill must know

The app now owns three files in `family-meal-planner/` that the skill must
**read** and must **never write**:

| File | Content | Skill use |
| --- | --- | --- |
| `plans.json` | the weekly plans (`plans`) | variety history; shopping lists in chat |
| `pantry.json` | the pantry staples (`pantry`) | replaces `family-data.json`'s `pantry` once it exists |
| `wishlist.json` | recipes the family wants added (`wishes`) | the "load the wishlist" task below |
| `dish-edits.json` | the family's corrections to catalog dishes (`edits`) and the recipes created in the app (`dishes`) | apply the edits on top of `catalog.json` and add the app's recipes whenever dishes are read |

The text below is meant to be added to the skill's `SKILL.md` (for example with
the skill-creator), in the skill's own style. It is not loaded by the app.

---

## Files written by the app (read only)

The family's web app writes `plans.json`, `pantry.json`, `wishlist.json` and
`dish-edits.json` in the same folder. Read them when a task needs them; never create, change or archive
them.

- **Pantry**: when `pantry.json` exists, its `pantry` list replaces the `pantry`
  of `family-data.json` (which is only the starting point). Use it for every
  shopping list.
- **Plans**: `plans.json` holds `plans` (same shape as the schema's `plans`);
  confirmed plans feed the variety history.

- **Dish edits**: `dish-edits.json` holds `edits[dishId].fields`; each field
  replaces the catalog's (lists and `nutrition` as a whole), `null` removes it.
  Always read dishes with the edits applied (or run `engine/data.js` `mergeData`).
  When the family asks you to change a dish that has an app edit, say so: the
  app edit keeps winning until someone taps "Ripristina originale". You may fold
  an edit into `catalog.json` when saving it (same values), but never remove the
  edit yourself.
- **Recipes made in the app**: `dish-edits.json` `dishes` are new personal
  dishes (variants carry `based_on`). Treat them as part of the catalog: plans
  may use their ids, the rules apply to them, and a new dish must not reuse
  their ids. To move one into `catalog.json` (e.g. to classify it better), save
  it there with the **same id**: from then on the app ignores its own copy.

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
5. Do not edit `wishlist.json`: a wish counts as done as soon as a dish refers
   to it (`wish:<id>`). The app no longer lists the wishes, it only collects them
   (Ricette → +).

Several wishes can point to one dish: `source.ref` may hold
`"wish:w-20261004-ab12cd, wish:w-20261005-ef34ab"`.
