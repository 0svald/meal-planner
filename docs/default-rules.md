# Default rules

Starting rules for a new data file. They are already in `fixtures/family-data.json`. The family adapts them over time; always edit the data
file, never this document. Mirrored from the skill's `references/`.

## Frequencies (origin: crea)

Source: CREA, Linee guida per una sana alimentazione (2018), table "Suggerimenti
pratici riferiti a bambini e adolescenti", age band 7–10 (identical to 4–6 for
these items): https://sapermangiare.an.crea.gov.it/493/le-giuste-porzioni-e-le-frequenze-di-consumo-consigliate.html

Counted over the whole week: canteen lunches Mon–Fri + weekend lunches + all dinners.

| Rule id | Group | Times per week | Priority |
| --- | --- | --- | --- |
| crea-legumi | legumes | min 3, target 3 | soft |
| crea-pesce | fish | min 2, target 3 | soft |
| crea-carne | meat | target 3, max 3 | soft |
| crea-carne-rossa | red_meat | max 1 (adult guideline, applied to all) | hard |
| crea-carni-lavorate | processed_meat | max 1 ("occasionally") | soft |
| crea-uova | eggs | target 2, max 3 | soft |
| crea-formaggi | cheese | target 3, max 4 | soft |
| crea-pizza | pizza | max 1 | soft |
| crea-patate | potatoes | target 1, max 2 | soft |

Adults (2000 kcal) differ slightly: fish 2 + 1 preserved, white meat 2, red meat 1,
eggs 3, potatoes 2. The plan targets the children's values, since only they eat
at the canteen.

## Family rules (origin: family)

| Rule id | Type | Rule |
| --- | --- | --- |
| complemento-pranzo | complement | meat, fish, eggs, cheese, legumes eaten at lunch are not repeated at dinner the same day (hard) |
| no-peperoni | exclusion | no peperoni (hard) |
| varieta-14-giorni | variety | same recipe not within 14 days (soft) |
| tempo-feriali | time_limit | Mon–Fri prep ≤ 45 minutes (hard) |
| struttura-cena | meal_structure | nei pasti a casa si cucina un primo, oppure un secondo con contorno, oppure un piatto unico: mai due portate (hard) |
| asporto-weekend | takeaway | 1 weekend dinner, rotating pizza / chinese / japanese; counts toward frequencies (soft) |
