# MediFast interface audit — 26 October 2026

Scope: local demo on branch feat/medifast-v2 at http://127.0.0.1:3000. This is a technical UI audit; no UI code was changed.

**Baseline note:** This report records the state before the later Impeccable craft pass on the same date. That pass made the phone navigation fully visible at 320px and 390px, raised the home page's small functional text and muted-text contrast, added active-state semantics, refined the operator stock input, and enlarged inventory freshness labels. A post-change rendered home scan reported **zero low-contrast findings** (the original scan reported six). The 13/20 score below is the original baseline; a fresh full audit is needed before assigning a new score.

## Implementation integrity verdict

**Pass, with measurable quality gaps.** Customer, pharmacy and admin views form a coherent, product-specific system around exact medicine identity, source-aware shop listings, honest stock status and pharmacist-reviewed requests. The detector's palette, font, serif-headline, eyebrow and offset-shadow flags are stylistic heuristics consistent with this product; they are not counted as defects.

Source detector: zero findings. Rendered home detector: 22 entries — 6 contrast, 10 small-text, 2 offset-shadow, and one each for eyebrow, italic display, font and palette. Contrast and small-text results were checked against rendered states.

## Health score

| Dimension | Score / 4 | Key finding |
| --- | ---: | --- |
| Accessibility | 2 | Multiple normal-text contrast pairs miss 4.5:1; keyboard focus and labels mostly work. |
| Performance | 3 | Responsive local run and deferred map, but the main app is client-rendered. |
| Theming | 2 | Six root tokens coexist with 158 literal hex colors in two stylesheets. |
| Responsive design | 3 | No document overflow at 1440, 390 or 320px; mobile nav and compact controls need work. |
| Implementation integrity | 3 | Coherent, product-specific implementation with isolated quality gaps. |
| **Total** | **13/20** | **Acceptable — significant accessibility and token work remains.** |

Issues: **P0 0 · P1 1 · P2 4 · P3 2**.

## Findings

### [P1] Secondary information has insufficient contrast

- **Location:** web/style.css:16, :175, :315, :517, :535; rendered home page. **Category:** Accessibility.
- **Evidence:** Count badge 3.5:1; source hint 3.8:1; process-card label 2.8:1; shelf banner 4.1:1; nav/footer about 4.4:1. These are normal-size text. The source hint conveys provenance.
- **Impact:** Low-vision users may miss source, navigation and supporting information. **Standard:** WCAG 2.2 SC 1.4.3 (4.5:1 for normal text).
- **Recommendation:** Increase contrast on each real surface and remeasure rendered pairs. **Suggested command:** $impeccable colorize.

### [P2] Functional text is too small

- **Location:** web/style.css home examples/source hints; web/platform.css:682 voice-language selector. **Category:** Accessibility / responsive.
- **Evidence:** The rendered detector found 10px example buttons and source hint; mobile voice-language selector is explicitly 9px.
- **Impact:** Search examples, language choice and provenance are hard to read on a phone. **Standard:** Usability/legibility; WCAG has no absolute font-size floor.
- **Recommendation:** Use at least 12–14px for functional mobile text and comfortable line height. **Suggested command:** $impeccable typeset.

### [P2] Mobile navigation hides destinations without a cue

- **Location:** web/main.jsx:253–301; web/platform.css:20–26. **Category:** Responsive.
- **Evidence:** At 390px, 346px of customer navigation is visible out of 581px scrollable; operator total is 708px and admin 655px. At 320px, only 276px of 581px is visible. Initial phone view hides sign-in, shelf and role destinations without a visible overflow hint.
- **Impact:** Users may not discover key screens. **Standard:** No direct WCAG failure established.
- **Recommendation:** Add an overflow cue or redesign phone primary navigation; keep keyboard-focused items visible. **Suggested command:** $impeccable adapt.

### [P2] Compact controls and selected states need refinement

- **Location:** web/main.jsx:288–300; web/Workspaces.tsx:854–875; request basket and chip styles. **Category:** Accessibility / responsive.
- **Evidence:** At 390px, nav controls are 33px high, example chips 27px, voice action 26px, basket remove icon 20px and admin checkbox 18px. Many have spacing or clickable labels, so a WCAG failure is not established for all. Active nav and admin tabs use CSS classes only, without aria-current or equivalent selected state.
- **Impact:** Small targets hinder touch; screen-reader users may not know the active section. **Standard:** WCAG 2.2 SC 2.5.8 requires 24px with exceptions; 44px is a stronger product target. SC 4.1.2 applies to exposed state.
- **Recommendation:** Enlarge effective hit boxes and expose current tab/page state semantically. **Suggested command:** $impeccable harden.

### [P2] Color system is hard to maintain

- **Location:** web/style.css:1–18 and throughout both stylesheets. **Category:** Theming / implementation integrity.
- **Evidence:** web/style.css has 134 literal hex colors and web/platform.css has 24, against only 6 root custom properties. A dark theme is neither offered nor claimed, so its absence is not a defect.
- **Impact:** Global contrast/palette work may cause role-specific visual drift. **Standard:** Maintainability, not a WCAG criterion.
- **Recommendation:** Add semantic surface, text and status tokens for used variants, then migrate repeated colors. **Suggested command:** $impeccable colorize.

### [P3] First paint is a client-side loading shell

- **Location:** pages/index.tsx:1–6. **Category:** Performance.
- **Evidence:** The app uses ssr:false and initially renders only “Opening MediFast…”. One local Chrome **development-mode** run measured DOM content loaded at 480ms, 24 JS resources totaling about 734KB transfer, and 1.57s to network-idle. These are not production or real-user metrics. The map loads separately on request.
- **Impact:** Slow devices or JavaScript failures delay the first search field. **Standard:** Performance resilience; no threshold violation established.
- **Recommendation:** Compare production traces before deciding whether to server-render the stable search shell or trim first-load code. **Suggested command:** $impeccable optimize.

### [P3] Reduced-motion handling removes every transition

- **Location:** web/style.css:1954–1962; web/platform.css:677–681. **Category:** Accessibility / implementation integrity.
- **Evidence:** A global reduced-motion rule sets all animations and transitions to none. It respects the preference and did not block tasks, but removes subtle state feedback too.
- **Impact:** Changes may feel abrupt. **Standard:** Refinement related to WCAG 2.3.3, not a proven violation.
- **Recommendation:** Keep decorative movement disabled while retaining brief non-moving color/opacity feedback where helpful. **Suggested command:** $impeccable animate.

## Positive findings and limits

- Chrome rendered home, medicine, live directory, request marketplace, authentication, operator inbox/inventory/profile and admin screens at desktop and phone widths. There was no page-wide horizontal overflow at 1440, 390 or 320 CSS pixels and no page-level JavaScript error in these samples.
- The first 16 keyboard tab stops follow the header/search sequence. Buttons and links show a 3px focus ring. The search field suppresses its own outline but its container shows a focus-within outline. Sampled visible inputs had accessible labels/names.
- A separate wait for the scanner heading confirmed it opens after demo customer sign-in. An initial screenshot caught the previous screen during navigation and was excluded.
- Sampled screens clearly distinguish fictional demo partners, live map listings and unknown stock. The directory remains useful as a list without the map.
- Machine-readable results and screenshots are in ignored .local/audit-* files. Testing used installed headless Chrome with emulated viewport/touch, not a physical phone. No synthesized swipe/drag, screen-reader session, axe run, production Lighthouse trace or true browser text-only zoom test was performed. A CSS zoom experiment was excluded as unrepresentative.

## Recommended actions

1. **[P1] $impeccable colorize** — fix measured contrast pairs and add semantic colors.
2. **[P2] $impeccable adapt** — make phone navigation discoverable.
3. **[P2] $impeccable typeset** — increase functional microcopy sizes.
4. **[P2] $impeccable harden** — improve touch areas and expose active state.
5. **[P3] $impeccable optimize** — profile production build and first-load shell.
6. **[P3] $impeccable animate** — refine reduced-motion feedback.
7. **[P3] $impeccable polish** — final consistency pass after measurable fixes.

Re-run $impeccable audit after changes using the same states and viewports.
