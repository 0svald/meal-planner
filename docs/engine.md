# Rules engine

`engine/` decides how a week is judged and what gets proposed. The app, the skill
(through `scripts/propose.js`) and the tests all go through it, so a rule has one
meaning everywhere. Pure ES modules: browser and Node, no `Date.now()`.

| Module | What |
| --- | --- |
| `data.js` | merge the Drive files, defaults, dates, canteen week |
| `week.js` | the week as a list of meals, frequency groups |
| `rules.js` | one evaluator per rule type, `evaluateWeek` |
| `planner.js` | `proposeWeek`, `evaluatePlan`, `slotOptions` |
| `shopping.js` | plan → shopping list, shareable text |

## The week

`buildWeek(data, date, {plan})` returns the meals of the week containing `date`:

- canteen lunches Monday–Friday, from the active school menu; for an item with
  alternatives ("o", "oppure") the **first printed option** counts;
- the 9 home slots: every dinner, plus Saturday and Sunday lunch, filled from
  `plan` when given, empty otherwise.

A meal counts **once per group**, however many of its dishes are in the group
(pasta with cheese and a cheese second = cheese once). A half portion counts as
a full one (`docs/taxonomy.md`).

## Rules: how each type is read

The rule "la cena non è simile al pranzo del giorno dopo" is a `complement`
rule with `when: next_day` and `same_dish: true` (see `fixtures/family-data.json`,
`cena-pranzo-dopo`); the skill's validator accepts the extra parameters.

Every evaluator returns `{ruleId, type, priority, satisfied, severity, penalty,
detail, slot?}`. `severity` is `ok`, `pending` (week incomplete, only a minimum
missing), `soft` or `hard`. `detail` is Italian and goes to the UI as is.

| Type | Reading |
| --- | --- |
| `frequency` | meals of the week in the group. `children`: canteen + home; `adults`: home only; `family`: all. Out of `min`/`max` = not satisfied; missing the `target` only costs score. |
| `complement` | two meals close in time are not alike. `when: same_day` (default): lunch and dinner of the same day. `when: next_day`: dinner and the next day's lunch (Sunday dinner and the next Monday's canteen lunch). Alike = they share a group of `groups`, or, with `same_dish: true`, the same first, second or single dish. |
| `exclusion` | substring, case-insensitive, on ingredient names **and the dish name**. Home meals only: the canteen is not the family's choice. |
| `time_limit` | sum of the `prep_minutes` of the meal's dishes on `days`. A dish **without `prep_minutes` fails** (nobody said it is quick); takeaway needs no preparation. |
| `variety` | days since a dish was last eaten, in a confirmed plan or earlier in the same week. Only firsts, seconds and single dishes: sides may repeat. Canteen lunches do not count. |
| `takeaway` | optional: **at most** `per_week` takeaway meals, only on `days` at `slot`; after the last confirmed takeaway comes the next cuisine of `rotate_cuisines`. A week without takeaway is fine. |
| `meal_structure` | courses of a home meal (bread, fruit, dessert aside) match one of `patterns`, in any order. A takeaway meal is one takeaway dish. |

## Scoring

`penalty` measures how far the week is from a rule: 10 per unit outside a
`min`/`max` or per broken meal, 1 per unit away from a `target`; variety costs
more the closer the repeat; a takeaway of the wrong cuisine costs 4 (`Math.ceil(10 / 3)`).

## Proposals

`proposeWeek({data, weekStart, seed, plan, limit})` gives, for every home slot,
the proposed meal and `limit` (default **3**) options to choose from:

1. **Candidates** per home slot: one dish per course of each `meal_structure`
   pattern, from the dishes `cookable_at_home` (low-confidence classifications
   not yet verified are left out), plus the takeaway dishes where a takeaway rule
   allows them.
2. **Hard rules filter**: a candidate is dropped when it makes any hard rule
   worse than leaving the slot empty. A canteen week that already breaks a hard
   rule (two red-meat lunches) does not block every proposal, but nothing adds
   to the breach.
3. **Soft rules score**: sum of their penalties, lower is better.
4. The week is filled greedily, then improved one slot at a time until no single
   change lowers the score. Ties are broken by a hash of `seed`: same data and
   seed, same proposal; another seed, another proposal of equal score.
5. Each slot gets its options ranked against the final week: the proposal
   first, then the best candidates with a **different main dish** (another side
   alone is not another option). Where a takeaway rule allows it, the last
   option is the best takeaway: it is offered, never proposed. Each option has
   its reasons: the soft rules it helps (`+`) or hurts (`-`) compared with an
   empty slot.

Meals already in `plan` are kept (`fixed`) and still get their alternatives.
Results the canteen (or the fixed meals) already cause carry `unavoidable: true`,
so the UI can say "già dalla mensa" instead of blaming the plan.

From the command line:

```sh
node scripts/propose.js --week 2025-09-15            # fixtures
node scripts/propose.js --data DIR --week 2026-10-05 --seed 3 --limit 5
node scripts/propose.js --json                       # for the skill
```

## Shopping list

`shoppingList({data, plan})` takes the home meals of a plan (the app uses the
week shown, and says so when it is not confirmed):

- ingredients merged by name (case, spaces and accents ignored; "carota" and
  "carote" stay two items: tidy the names in the catalog);
- grouped by aisle in store order: frutta e verdura, carne, pesce, latte
  formaggi e uova, pane e forno, dispensa, surgelati, altro;
- pantry staples left out: the name is a pantry item or starts with one
  ("sale" covers "sale grosso"); the pantry is edited in the app (Spesa →
  Dispensa) and stored in `pantry.json`;
- takeaway meals skipped (bought ready);
- **quantities never computed**: a recipe's own `qty`/`unit` is repeated, with
  the dish name when several dishes use the item ("320 g per Pasta e
  lenticchie"); nothing is summed or scaled.

`shoppingText(list, {exclude})` gives the text to share: a heading per aisle,
one `- item` per line, ticked items left out.
