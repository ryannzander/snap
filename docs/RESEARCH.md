# The evidence behind Snap

Every paper here was checked against its own abstract or full text, not recalled. Numbers are quoted from the source. Where the literature **does not** support us, or argues against us, that says so — a judge who knows this field will find the weak joint faster than we will, and the only good answer is to have found it first.

---

## 1. The core mechanic: money you already have, that you lose

> **Patel MS, Asch DA, Rosin R, et al. (2016). Framing Financial Incentives to Increase Physical Activity Among Overweight and Obese Adults: A Randomized, Controlled Trial.** *Annals of Internal Medicine* 164(6):385–394.

281 adults, 13 weeks, 7,000 steps/day, four arms. Proportion of days the goal was met:

| arm | days goal met |
|---|---|
| control (feedback only) | **0.30** |
| gain — $1.40 paid per successful day | 0.35 |
| lottery — expected value ≈ $1.40 | 0.36 |
| **loss — $42 allocated up front, $1.40 removed per failed day** | **0.45** |

Only the loss arm significantly beat control. Same money, same expected value, different frame.

**This is Snap.** The stake is allocated to you the moment you commit, and it is taken back when you don't go. We did not pick the loss frame because it sounded tougher; it is the arm that worked.

---

## 2. Deposit contracts work, and they work *after* the money stops

> **Giné X, Karlan D, Zinman J (2010). Put Your Money Where Your Butt Is: A Commitment Contract for Smoking Cessation.** *American Economic Journal: Applied Economics* 2(4):213–235.

Smokers deposited their own money for six months, then took a urine test. Pass and the money came back; fail and it was forfeited. Those offered the contract were **3 percentage points more likely to pass at six months** — and the effect held in **surprise tests at twelve months**, after the contract had ended.

The forfeiture half of Snap is not a gimmick: it is the part with a durable effect in a randomized trial.

> **Charness G, Gneezy U (2009). Incentives to Exercise.** *Econometrica* 77(3):909–931.

Paying people to attend a gym for one month. Attendance after the payments stopped was roughly **double** the pre-intervention level, and the entire effect came from people who were **not previously regular attenders**. Health markers (weight, waist, pulse) improved, so it was a net increase in activity rather than substitution.

**Why this matters for us:** the standard objection to paying people to exercise is that extrinsic rewards crowd out intrinsic motivation. In exercise specifically, the field experiments do not find that. See §8, where the objection is taken seriously.

---

## 3. Why Snap *offers* the stake instead of waiting to be asked

> **Royer H, Stehr M, Sydnor J (2015). Incentives, Commitments, and Habit Formation in Exercise: Evidence from a Field Experiment with Workers at a Fortune-500 Company.** *American Economic Journal: Applied Economics* 7(3):51–84.

Deposit contracts were **at least as effective** as reward incentives — but had **much lower uptake**. People who would benefit from a commitment device largely do not go and find one.

This is the single most actionable paper in the list, and it is the reason for a specific design decision: **Snap brings the stake up himself.** You say "gym at 7" and he offers. Nobody has to know the feature exists, discover a commitment-contract product, or opt in. The uptake problem this paper documents is the one our interaction design exists to solve.

---

## 4. Why it never asks "did you work out?"

> **Prince SA, Adamo KB, Hamel ME, Hardt J, Connor Gorber S, Tremblay M (2008). A comparison of direct versus self-report measures for assessing physical activity in adults: a systematic review.** *International Journal of Behavioral Nutrition and Physical Activity* 5:56.

4,463 citations screened, **173 studies** included. Correlation between self-reported and directly measured activity averaged **r = 0.37 (SD 0.25)**, ranging from −0.71 to 0.98. Self-report was both higher and lower than measured activity depending on the study; among accelerometer comparisons, about **60% showed over-reporting**.

An r of 0.37 is the entire argument for HealthKit. Every accountability app in this category asks a question whose answers correlate ~0.37 with reality, and then moves real money on the answer.

---

## 5. Why ghosting has to not work

> **Eysenbach G (2005). The Law of Attrition.** *Journal of Medical Internet Research* 7(1):e11.

The foundational statement that in any eHealth trial a substantial proportion of users stop using the application before completion — and that this is a distinct feature of eHealth compared with, say, drug trials.

> **Secondary analysis of an app-based physical activity RCT** (*JMIR*, 2019): using a 30-day non-use threshold, **31.9–39.4%** of participants attrited; at a 14-day threshold, **48.9–58.7%**.

Every conversational fitness product fails the moment the user stops replying, because the product *is* the reply. Snap's settlement path requires no message, no model call and no user: the alarm fires, the clock says the day is over, and the money moves. **This is the differentiator with the most literature behind it and it is the one we under-sell.**

---

## 6. Why the loop is daily, and why a week is not enough

> **Lally P, van Jaarsveld CHM, Potts HWW, Wardle J (2010). How are habits formed: Modelling habit formation in the real world.** *European Journal of Social Psychology* 40(6):998–1009.

Median **66 days** to reach maximum automaticity, ranging from **18 to 254** across individuals. Early repetitions produce the largest gains; the curve then flattens.

Snap is a daily commitment loop rather than a challenge with an end date because the thing being built takes two months, not two weeks — and because the early repetitions are where the marginal value is highest, which is exactly where a stake does the most work.

---

## 7. Why competitions are in the roadmap

> **Patel MS, Small DS, Harrison JD, et al. (2019). Effectiveness of Behaviorally Designed Gamification Interventions With Social Incentives for Increasing Physical Activity Among Overweight and Obese Adults Across the United States: The STEP UP Randomized Clinical Trial.** *JAMA Internal Medicine* 179(12):1624–1632.

602 adults, 24 weeks, three gamification arms — support, collaboration, competition — plus control. **All three arms significantly increased daily steps versus control**, with impact sustained into follow-up.

Our 1v1, group and solo pots are the competition arm of a trial that worked, with settlement from sensor data instead of self-report.

---

## 8. The strongest argument *against* us, and the answer

A judge who knows this literature will raise **motivation crowding-out**: paying people for something they might do intrinsically can reduce intrinsic motivation once the payment stops. The canonical statement is Deci, Koestner & Ryan's 1999 meta-analysis on undermining effects.

> **Ng JYY, Ntoumanis N, Thøgersen-Ntoumani C, Deci EL, Ryan RM, Duda JL, Williams GC (2012). Self-Determination Theory Applied to Health Contexts: A Meta-Analysis.** *Perspectives on Psychological Science* 7(4):325–340.

184 independent datasets. Autonomy support and need satisfaction predict beneficial health outcomes; controlling climates — external pressure, tangible rewards — thwart them.

**This cuts both ways and we should say so.** The honest answer has three parts:

1. **In exercise specifically, the field experiments do not find crowding-out.** Charness & Gneezy (§2) found post-incentive attendance roughly double baseline; Giné et al. (§2) found the effect surviving to a surprise test six months after the contract ended.
2. **It is the user's own money, and the user sets the amount.** A deposit contract is a self-imposed constraint, which is autonomy-supportive in SDT's own terms — the person chooses the commitment. It is not a third party paying you to comply. The floor is 0.01 SOL and the number is theirs.
3. **This is the reason for the anti-coach ban.** No plans, no macros, no prescribed sets. The dial sets a *target you chose* and a level of pressure you asked for; it never tells you what to train. Under Ng et al., a product that both takes your money *and* directs your behaviour is the controlling climate the meta-analysis warns about. Holding the stake and staying out of the programming is the design that survives this critique.

---

## 9. The gesture — where the evidence is thinner, and we should say so

The randomized-gesture check is borrowed from **challenge–response liveness detection** in biometric anti-spoofing: present an unpredictable prompt at capture time so a pre-recorded or borrowed artefact cannot satisfy it. Published implementations randomize among actions (blink, open mouth, turn head) and report high accuracy against photo and video replay attacks — e.g. *Liveness Detection with Randomized Challenge-Response for Face Recognition Anti-Spoofing*, IJICIC 19(2).

**Be honest about the strength of this one.** It is a well-established technique in a neighbouring field, not a result about fitness verification, and the venue is not a top one. What the literature supports is the *principle*: a randomized challenge issued after the fact defeats replay. What it does not support is any specific accuracy number for "three fingers in a gym mirror selfie" — we have not measured that, and we should not imply we have.

It is also explicitly **not identity**. Challenge–response proves liveness/recency; face matching proves identity. We do the first and say so. The enrolled-selfie layer in `ROADMAP.md` is the second.

---

## What the evidence does and does not cover

| claim | support |
|---|---|
| Loss-framed stakes beat gain-framed | **Strong** — RCT, direct hit (Patel 2016) |
| Forfeiture produces durable change | **Strong** — RCT with post-contract follow-up (Giné 2010) |
| Short-run incentives build lasting gym habit | **Strong** — Econometrica field experiment (Charness & Gneezy 2009) |
| People won't seek out commitment devices themselves | **Strong** — and it justifies Snap offering first (Royer 2015) |
| Self-report is a bad referee | **Strong** — 173-study systematic review, r ≈ 0.37 (Prince 2008) |
| Engagement-dependent products lose most users | **Strong** — Eysenbach 2005 + app-RCT attrition data |
| Daily repetition over ~2 months is the right shape | **Strong** — Lally 2010 |
| Competitions increase activity | **Strong** — 602-person RCT (Patel 2019) |
| Staying out of programming protects motivation | **Moderate** — SDT meta-analysis supports the direction, and also raises the crowding-out objection we answer in §8 |
| A randomized gesture defeats a borrowed photo | **Moderate** — established principle in biometric anti-spoofing; no fitness-specific result, and we have measured no accuracy of our own |
| The vision model can tell whether a photo is training | **Ours alone** — no external evidence; what we have is our own test suite and live runs |
