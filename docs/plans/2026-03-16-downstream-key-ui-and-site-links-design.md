# Downstream Key UI And Site Links Design

**Goal:** Unify the downstream key page with the restrained management-console style already used by the sites and accounts pages, and make site entry points behave consistently across pages.

**Context**

The current downstream key page is functionally rich but visually heavier than the rest of the console. It relies on dense inline styling and presents summary, filters, and row content with a stronger dashboard tone than the nearby management pages.

At the same time, site references are inconsistent. The accounts page already exposes a hoverable, clickable site badge that navigates back to site management with focus context. Other pages such as models, proxy logs, token routes, and downstream keys do not consistently reuse that interaction.

**User-Approved Direction**

- Align downstream key visuals with the existing `站点管理 / 连接管理` style.
- Reuse the same site button interaction already present on the accounts page.
- Prefer direct reuse over inventing a new visual pattern.

## Design

### 1. Downstream key page visual alignment

Keep the data model and operations unchanged, but reduce the visual mismatch:

- Keep the existing `page-header`, `card`, and `data-table` structure.
- Restyle summary/filter regions to read like management controls rather than dashboard hero sections.
- Preserve the drawer/details flow, but make the main list view feel closer to `Sites.tsx` and `Accounts.tsx`.
- Replace repeated ad-hoc chip/button styling where possible with the same badge/link language already used elsewhere.

This is intentionally a presentation cleanup, not a workflow redesign.

### 2. Shared site button behavior

Extract the accounts page site badge behavior into a reusable component:

- Same hover affordance.
- Same visual style.
- Same navigation target: `/sites?focusSiteId=<id>`.
- Graceful fallback when `siteId` is missing or invalid.

Pages to update:

- `src/web/pages/Models.tsx`
- `src/web/pages/ProxyLogs.tsx`
- `src/web/pages/TokenRoutes.tsx`
- `src/web/pages/DownstreamKeys.tsx`

The `Sites.tsx` page itself continues to use direct external URL links, because those links serve a different purpose.

### 3. Testing approach

Cover the change with focused UI tests:

- One shared component test for hover/click navigation behavior.
- Page-level regression tests where existing snapshots/assertions are already present.
- Keep tests narrow: validate that site labels render with the shared class/behavior and navigate to the focused site management route.

## Risks

- `TokenRoutes.tsx` contains multiple kinds of site labels; only labels intended to behave like the accounts page should be converted.
- `DownstreamKeys.tsx` may not currently expose enough site metadata in every row; if site links are only meaningful in detail regions, apply the shared component there instead of forcing low-value links into the table.
- Visual cleanup should not destabilize mobile layout or row actions.

## Acceptance Criteria

- The downstream key page looks consistent with the restrained management-console pages.
- Site entry points in models, proxy logs, token routes, and downstream keys match the accounts page interaction.
- Hover and navigation behavior are consistent.
- Existing relevant tests pass, and new tests cover the shared site link behavior.
