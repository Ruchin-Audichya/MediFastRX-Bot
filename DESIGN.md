---
name: MediFast
northStar: Signal Street
colors:
  night: "#17243e"
  blue: "#2846b8"
  coral: "#ef684e"
  lemon: "#ffdc68"
  canvas: "#f4f7fb"
  paper: "#ffffff"
  line: "#d4dce9"
typography:
  display: "Space Grotesk Variable"
  body: "DM Sans Variable"
rounded:
  control: "8px"
  panel: "14px"
  feature: "17px"
---

# MediFast design system

**Creative north star: Signal Street.** MediFast is a two-sided neighborhood tool. Its design borrows the clarity of city wayfinding: a decisive blue for destinations and actions, coral for the key turn, and a small yellow signal for the next step. It is a normal web application, not a signage imitation. Customers can identify a medicine and find shops; pharmacy operators can manage requests and stock in the same visual language.

## Core rules

- Use dark navy `#17243e` for reading text, blue `#2846b8` for primary actions and selected destinations, coral `#ef684e` for emphasis, and yellow `#ffdc68` sparingly for a useful next step. The page is cool pale blue `#f4f7fb`; working panels are white.
- Space Grotesk Variable carries headings and product identity. DM Sans Variable carries forms, navigation, details, and dense operational text. Both fonts are bundled locally from npm packages.
- Use a clear two-column desktop composition for a task plus supporting context. Stack the same jobs on phones. Header navigation scrolls horizontally at small widths, with an active coral underline.
- Let form controls remain conventional. Search, candidate confirmation, status updates, inventory editing, and request actions must be identifiable without relying on visual metaphor.
- The signature move is the three-step guide on the home screen: exact identity → nearby shop → explicit availability conversation. Its sequence clarifies the product's real mechanism; the guide is informational, not a claim of stock.
- Cards have 14px corners and a restrained soft shadow where elevation helps. Feature panels may use saturated blue or yellow. Never use color alone for medicine identity, freshness, demo status, or availability.
- Text and state changes are the priority. The guide's short entrance is the only authored motion, and it is disabled when reduced motion is requested.

## Content and truth

Retain the product line, “Medicine confusion, sorted.” Demo records and shops stay explicitly labeled. A nearby shop is never presented as having stock unless a current partner report supports it. Success, unknown, stale, and error states use words alongside color. Keep informational medical boundaries brief and visible.

## Working surfaces

The home page leads with search and supports voice, scanning, examples, and the two-sided customer/pharmacy routes. Search results show exact medicine identity before follow-ups or nearby actions. Nearby search asks for location only on request and keeps manual area search primary. The pharmacy desk uses the same type, palette, controls, and status treatment while allowing denser forms and records.

The implementation lives in `web/signal.css`, loaded after the base application styles while the existing component CSS is migrated. Shared variables bridge older class names to the new palette. New UI should use the Signal tokens and avoid adding old teal, sage, or Georgia treatments.
