# Nutrition taxonomy

Qualitative labels only: no calories, no grams. They exist to compare lunch and
dinner and to count weekly frequencies. Values are defined in the skill's `scripts/model.py`.

## Dimensions

| Field | Value | Italian | Examples |
| --- | --- | --- | --- |
| carbs | cereals | cereali e derivati | pasta, riso, pane, pizza, crostini |
| | tubers | tuberi | patate, gnocchi di patate |
| | legumes | legumi | fagioli, ceci, lenticchie, piselli |
| | simple_sugars | zuccheri semplici | dolci, succhi |
| cereals.type | wheat, rice, barley, spelt, corn, oats, other | grano, riso, orzo, farro, mais, avena | + `whole: true` for integrale |
| proteins | red_meat | carne rossa | manzo, vitellone, maiale, agnello |
| | white_meat | carne bianca | pollo, tacchino, coniglio |
| | processed_meat | carni lavorate | prosciutto, salumi, würstel |
| | fish | pesce | merluzzo, platessa, tonno, salmone |
| | shellfish | molluschi e crostacei | seppie, calamari, cozze, gamberi |
| | eggs | uova | frittata, uovo sodo |
| | cheese | formaggi | mozzarella, dolce sardo, pecorino |
| | legumes | legumi | also listed as carbs |
| fats | evo_oil | olio extravergine | |
| | butter_cream | burro, panna, besciamella | |
| | aged_cheese | formaggi stagionati | parmigiano, pecorino as condiment |
| | nuts_seeds | frutta secca, semi | pesto, noci |
| | oily_fish | pesce azzurro | sgombro, sardine, salmone |
| | fried | frittura | |
| vegetables | present + raw/cooked/both | verdure | |

## Classification guidance

- Classify what a child actually gets on the plate. Legumes count both as carbs and
  proteins; a dish with ragù counts as red_meat even if meat is not the main ingredient.
- Pork is red meat (CREA definition). Cooked ham and turkey ham are processed_meat.
- Cheese as a condiment (a spoon of parmesan) goes under `fats: aged_cheese`, not
  `proteins: cheese`. Cheese as the protein of the meal goes under `proteins`.
- When the name leaves the recipe open (e.g. "lasagne al forno"), classify the usual
  version and set `confidence: medium`. Use `low` when you are guessing; low-confidence
  dishes must be shown to the family before they count.
- Canteen dishes: take allergens exactly as printed (map Italian names below).

## Frequency groups

Used by `frequency` and `complement` rules. A dish counts once per group, whatever
its portion.

| Group | Counts dishes where |
| --- | --- |
| legumes | proteins has legumes |
| fish | proteins has fish or shellfish |
| meat | proteins has red_meat, white_meat or processed_meat |
| red_meat / white_meat / processed_meat | proteins has that value |
| eggs | proteins has eggs |
| cheese | proteins has cheese |
| potatoes | carbs has tubers |
| pizza | tags has pizza |

## Allergen names (menu → schema)

GLUTINE gluten · CROSTACEI crustaceans · UOVO/UOVA eggs · PESCE fish ·
ARACHIDI peanuts · SOIA soy · LATTE milk · FRUTTA A GUSCIO nuts · SEDANO celery ·
SENAPE mustard · SESAMO sesame · SOLFITI sulphites · LUPINI lupin · MOLLUSCHI molluscs
