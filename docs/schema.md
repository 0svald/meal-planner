# Data model (schema 1.0)

Mirrored from the `family-meal-planner` skill (`references/schema.md`). The skill is
the authority: when it changes, update this copy and `fixtures/`.

The data is split across three Drive files:

| File | Keys | Written by |
| --- | --- | --- |
| `catalog.json` | `dishes`, `school_menus` | skill only |
| `family-data.json` | `family`, `rules`, `pantry` | skill only |
| `plans.json` | `plans`, plus `updated_at`, `updated_by` | app only |

`engine/data.js` (`mergeData`) merges them into the single object described here.
While `plans.json` does not exist yet, `plans` is read from `family-data.json`, where
the skill used to keep it. The skill's `scripts/validate.py` is the executable version
of this document; the allowed values live in its `scripts/model.py`.
A complete, valid example is in `fixtures/`.

Conventions:
- Keys are English; values the family reads (dish names, notes, rule descriptions) are Italian.
- Every `id` is a lowercase slug (`pasta-lenticchie`), unique within its collection.
- Dates are `YYYY-MM-DD`. Weekdays are `mon`…`sun`.

## Top level

```json
{
  "schema_version": "1.0",
  "family": { ... },
  "dishes": [ ... ],
  "school_menus": [ ... ],
  "rules": [ ... ],
  "plans": [ ... ],
  "pantry": ["olio extravergine d'oliva", "sale"]
}
```

`pantry` lists staples always at home; they never appear on the shopping list.

## family

```json
{ "adults": 2,
  "children": [{ "age": 8, "school_lunch": true }, { "age": 6, "school_lunch": true }],
  "disliked_ingredients": ["peperoni"] }
```

## dishes

The single catalog: canteen dishes (all menus, past and current), home recipes,
web recipes and takeaway. It only grows; nothing is deleted when a menu changes.

| Field | Type | Notes |
| --- | --- | --- |
| `id`, `name` | string | required |
| `source` | object | `type`: school \| personal \| web \| takeaway; `ref` free text; `url` required for web |
| `course` | enum | first, second, side, single, bread, fruit, dessert, takeaway |
| `allergens` | list | the 14 EU allergens, English names (see taxonomy.md) |
| `ingredients` | list | `{name, aisle, qty?, unit?}`; `qty` only if the recipe states it — never computed |
| `nutrition` | object | see below; required except for bread and fruit |
| `cookable_at_home` | bool | canteen dishes the family may also cook for dinner |
| `prep_minutes` | int | used by time-limit rules |
| `cuisine` | enum | takeaway only: pizza, chinese, japanese, other |
| `tags` | list | free; `pizza` is special (frequency group) |
| `verified` | bool | true once the family confirms the classification |
| `notes` | string | optional |
| `aliases` | list | other printed names of the same dish; filled by import_menu.py |

`course: takeaway` and `source.type: takeaway` always go together.

**Defaults (omitted keys).** To keep the Drive file small, the scripts write only
non-default values: missing lists are empty, missing `verified` is false, missing
`cookable_at_home` is true, missing `nutrition.vegetables` is `{present: false}`,
missing item `portion` is 1. Read the data with these defaults in mind.
For canteen dishes, ingredients are an estimate (menus don't list them) and serve
classification and "cook it at home" suggestions only.

### nutrition

```json
{ "carbs": ["cereals", "legumes"],
  "cereals": [{ "type": "wheat", "whole": false }],
  "proteins": ["legumes"],
  "fats": ["evo_oil"],
  "vegetables": { "present": true, "form": "cooked" },
  "confidence": "high" }
```

Lists may be empty (a salad has no proteins). Meanings in `taxonomy.md`.

## school_menus

```json
{ "id": "olbia-inverno-2025-26", "name": "...", "school": "...",
  "season": "winter", "active": true, "cycle_start_date": null,
  "weeks": [{ "week": 1, "days": [
      { "weekday": "mon", "items": [
          { "course": "first", "options": ["zuppa-legumi-pasta"] },
          { "course": "second", "options": ["formaggio-tenero"], "portion": 0.5 } ] } ] }],
  "notes": ["..."] }
```

- Weeks are numbered 1..N (Olbia: 4) and rotate.
- `options` lists alternatives printed with "o"/"oppure"; for planning, assume the first.
- `portion` is 1 (default) or 0.5.
- `cycle_start_date` is the Monday of cycle week 1; `null` until the family gives it.
  Week of cycle for a date = `((date - start).days // 7) % N + 1`.
- Only one menu is `active`. Holidays and canteen closures are deliberately ignored:
  assume canteen lunch Monday to Friday.

## rules

```json
{ "id": "crea-legumi", "type": "frequency", "priority": "soft", "origin": "crea",
  "enabled": true, "description": "Legumi 3 volte a settimana",
  "params": { "group": "legumes", "applies_to": "children", "min": 3, "target": 3 } }
```

`priority`: hard = never violate; soft = score. `origin`: crea | family.

| type | params |
| --- | --- |
| frequency | `group` (see taxonomy.md), `applies_to` children\|adults\|family, at least one of `min` `target` `max` (times per week, lunch + dinner) |
| complement | `groups`: a group eaten at lunch is excluded at dinner the same day |
| exclusion | `ingredients`: substring match on ingredient names |
| variety | `min_days_between_repeats` |
| time_limit | `max_prep_minutes`, `days` |
| takeaway | `per_week`, `days`, `slot`, `rotate_cuisines` |
| meal_structure | `slots`, `patterns`: the allowed course combinations for a home meal, e.g. `[["first"], ["second", "side"], ["single"]]` |

## plans

```json
{ "id": "2026-w40", "week_start": "2026-09-28", "status": "draft",
  "cycle_week": 2,
  "meals": [{ "date": "2026-09-28", "slot": "dinner", "dish_ids": ["pasta-lenticchie", "insalata-verde"] }] }
```

- `week_start` is a Monday. The skill plans every dinner plus Saturday and Sunday lunch;
  weekday lunches come from the school menu and are not stored in the plan.
- `status`: draft → confirmed. Only confirmed plans feed the shopping list and the
  variety history.
