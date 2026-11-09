# OpenParley — Vision Document

> **The original vision, February 2025.** Kept for the thinking behind the product. The code was rebuilt in November 2026 and several decisions changed ("thread" instead of "parley", `#parley=` links, the audience, plans and pricing): [REVIEW.md](REVIEW.md) records what and why, and [README.md](README.md) and the [docs](https://openparley.dev/docs) describe what exists today.
> **Name:** OpenParley (from "open a parley" - to begin a discussion)

## One-liner

**OpenParley: Collaborate ON your website.** A collaboration layer for every website that lets teams open parleys (discussions) on live elements, have threaded conversations, and link to designs — without screenshots.

---

## The Core Philosophy

### "Make the website the place where you discuss the website"

Today, when teams review websites, they discuss them **about** screenshots in Slack, **about** recordings in Loom, **about** mockups in Figma. The discussion happens *everywhere except* the actual website.

**OpenParley changes this:** Collaborate **ON** the website itself. Click any element, open a parley, have threaded discussions. The website becomes your team's canvas, not just the subject of external discussion.

---

## Problem: The Screenshot Workflow is Broken

### The Current Reality (ABOUT)
Teams discuss websites in Slack, email, and Linear — always **about** screenshots or recordings, never **on** the actual site.

**What happens:**
1. Designer sees issue on staging site
2. Takes screenshot (or worse, describes it: "the blue button in the header")
3. Pastes in Slack with red arrows drawn on
4. Developer sees it hours later, can't find exact element
5. Back-and-forth ensues: "Which button?" "The one on the left?" "No, the other one"
6. Context is lost, feedback gets scattered

**What's broken:**
- Screenshots are static and divorced from the live site
- Descriptions are ambiguous ("the submit button" = which one?)
- Discussions scattered across Slack, Linear, Figma, email
- No way to follow up on the exact element
- Hard to track what's been addressed
- Historical feedback is lost

### What Teams Actually Need (ON)

Product teams (designers, developers, PMs, stakeholders) need a way to:

1. **Point to specific elements** precisely, not with screenshots
   - Click the actual element, not describe it or crop it
   - Recipients see the exact same element in context

2. **Have persistent discussions** anchored to UI elements
   - Threaded conversations that stay attached to elements
   - Visible when browsing the site (toggle on/off)
   - Survive across sessions and team members

3. **Filter feedback by concern** without noise
   - Toggle design/dev/product views
   - See only what's relevant to your role
   - Resolved comments fade out automatically

4. **Link to source of truth** in context
   - Connect Figma designs to live implementations
   - Create Linear issues from website comments
   - See design intent next to actual element

**Current workarounds are inadequate:** Loom videos are hard to reference, Figma comments only work on static mockups, bug trackers lack precise context, and expensive enterprise tools require heavy onboarding.

---

## Solution: A Collaboration Layer for Every Website

**OpenParley** is a JavaScript library that adds a **collaboration layer** to any website — enabling Figma-style commenting, threaded discussions, and team workflows directly on live pages.

### How It Works

**For quick feedback (Free tier):**
```
1. Site embeds <script src="openparley.min.js">
2. User opens parley mode → clicks element → adds comment
3. Generates shareable URL: website.com?parley=XXXX
4. Recipient opens URL → lands on exact element with comment
```
**The link *is* the data.** Zero signup, zero database, works forever.

**For team collaboration (Self-hosted or Cloud):**
```
1. Site embeds openparley
2. Parleys persist server-side, visible to whole team
3. Toggle overlay: see all parleys while browsing
4. Filter by: design/dev/product, status, author
5. Reply, resolve, assign, link to Figma/Linear
6. Parleys auto-heal when DOM changes
```

**The website becomes your canvas.** Discuss product features, link to Figma designs, add user insights, comment on flows — all in context.

### Progressive Vision: From Simple to Sophisticated

**Phase 1: URL-Encoded Parleys (MVP)**
- Click element → open parley → add comment → share link
- Quick feedback, bug reports, design reviews
- No backend required, works on any site with, either:
 - openparley.min.js embedded
 - Chrome extension installed

**Phase 2: Persistent Parleys (Self-hosted or Cloud)**
- Parleys stored server-side, persist across sessions
- Threaded discussions, @mentions, resolution workflow
- Team members see overlay of all parleys

**Phase 3: The Collaboration Overlay**
- Website becomes persistent canvas for team discussion
- Parleys stay visible while browsing (toggle on/off)
- Filter by role (design/dev/product), status, priority
- Link to Figma designs, Linear issues, GitHub PRs
- **Use case:** Pre-production review, stakeholder feedback, continuous collaboration

**Phase 4: Product Documentation Layer**
- User insights attached to specific flows
- Design decisions documented in context
- Historical record of "why we built it this way"
- **Use case:** Onboarding, design system evolution, product knowledge base

**Future:** Chrome extension for sites that *don't* embed the lib (requires both sender and recipient to have extension installed).

---

## Use Cases: From Feedback to Documentation

### Quick Bug Reports (Free Tier)
**Scenario:** User finds visual bug on staging site
```
1. Open parley mode → click misaligned button → "Padding is off by 8px"
2. Copy link → paste in Slack
3. Developer clicks → sees exact element + comment
4. Fixed in 5 minutes instead of 30-minute back-and-forth
```

**Value:** Precise, immediate feedback without screenshots

### Design Review (Paid Tier)
**Scenario:** Designer reviewing implemented feature
```
1. Designer browses staging with OpenParley overlay on
2. Opens parleys: "Font weight should be 600", "Wrong shade of blue #1E40AF"
3. Links each to Figma frame: [[figma.com/file/...]]
4. Developer sees parleys + Figma references side-by-side
5. Makes adjustments, resolves parleys
```

**Value:** Design-to-dev handoff with precise context

### Pre-Production Review (Paid Tier)
**Scenario:** Stakeholders reviewing new feature before launch
```
1. PM shares staging link with OpenParley overlay
2. Stakeholders browse, open parleys: #copy #legal #ux
3. Product team filters by tag, addresses each concern
4. Stakeholders see resolutions in context, approve launch
```

**Value:** Structured feedback collection without meetings

### User Research Insights (Paid Tier)
**Scenario:** UX researcher documenting user pain points
```
1. During user testing, researcher takes notes
2. After session, opens parleys on specific elements
3. "3 users clicked here expecting [X], found [Y]" #research #checkout
4. Product team reviews insights in context when planning improvements
```

**Value:** User feedback attached to actual elements

### Product Documentation (Paid Tier, Future)
**Scenario:** Documenting "why we built it this way"
```
1. Complex feature ships after months of iteration
2. Historical comments show evolution:
   - Initial design feedback
   - Technical constraints discussed
   - Product decisions + rationale
   - User research that informed changes
3. New team member browses with overlay
4. Sees full context and decision history for every element
```

**Value:** Institutional knowledge preserved in context

---

## Product Principles

1. **Tiny footprint** — Library must be <5kb gzipped. A collaboration layer so lightweight there's no excuse not to include it.

2. **Zero friction for first value** — Share an anchored link in <30 seconds, no signup

3. **Free tier is genuinely useful** — Not a crippled trial, a complete tool for simple use cases

4. **Collaborate ON, not ABOUT** — Discussions happen on the live site, not about screenshots elsewhere

5. **Figma-style UX** — Borrow proven patterns (@mentions, threading, resolve) that teams already know

6. **Power user velocity** — Todoist-style syntax (`#tags @mentions !dates`) beats dropdown menus

7. **Open source core** — Build trust, get contributions, create ecosystem

8. **The website is the canvas** — Make collaboration feel native to the medium

---

## The Shift: From ABOUT to ON

All messaging reinforces this fundamental contrast:

| Old Way (ABOUT) | OpenParley Way (ON) |
|-----------------|----------------|
| Screenshot → Slack | Comment on live site |
| "The blue button in header" | Click the actual button |
| Loom video recording | Persistent comment thread |
| Context lost in image | Context preserved on element |
| Discussion somewhere else | Discussion where it belongs |
| Feedback scattered across tools | Feedback attached to site |
| Goes stale when design changes | Auto-updates with site |

**The philosophy:** Stop discussing websites in screenshots. Start collaborating on the actual site.

---

## Key Differentiators

| Differentiator | Why it matters |
|----------------|----------------|
| **Collaboration layer for every website** | Universal solution — works on any site, any framework, any tech stack. |
| **Collaborate ON, not ABOUT** | No more screenshots in Slack. Discuss the site on the site itself. |
| **Tiny open source lib** | <5kb gzipped. No reason not to add it. Lower barrier than competitors. |
| **Free tier is complete** | `?parley=XXXX` links work indefinitely (data is in URL). Not a trial, a tool. |
| **No backend required for free** | Static sites, SPAs, anything — just add the script, sharing works. |
| **Figma-style commenting** | Borrow proven UX patterns teams already know. Threading, @mentions, resolve workflow. |
| **Quick-capture syntax** | `#project /section @person !tomorrow` — power users stay in flow |
| **Role-based overlays** | Toggle design/dev/product views. Different concerns, filtered noise. |
| **Auto-healing anchors** | Paid tier: Comments survive DOM changes. Competitors break on redesigns. |

---

## Technical Architecture: Building a Universal Collaboration Layer

### Foundation: Finder Library

We build on top of **[finder](https://github.com/antonmedv/finder)** — a battle-tested CSS selector generator.

```
GitHub: https://github.com/antonmedv/finder
Size: ~2kb
License: MIT
```

**What finder does:**
- Generates unique CSS selectors for any DOM element
- Configurable specificity (prefer IDs, classes, attributes, etc.)
- Optimizes for shortest readable selector

**What we add (the OpenParley collaboration layer):**
- Fallback strategies when selectors break
- URL encoding/decoding for shareable links
- Comment attachment and rendering
- Figma-style overlay UI (paid tier)
- Thread management and resolution
- Role-based filtering
- Persistence layer for paid tier
- Auto-healing when DOM changes

### Core Components: The Collaboration Layer

```
┌──────────────────────────────────────────────────────────────────┐
│                      WEBSITE WITH OPENPARLEY                     │
│                    (Collaboration Layer Enabled)                 │
│                                                                  │
│  <script src="openparley.js"></script>  ← Single drop-in script │
│                                              (~5kb snippet)      │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │                OVERLAY (packages/overlay)                      │ │
│  │                                                            │ │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐        │ │
│  │  │  Overlay UI │  │Click Handler│  │  Renderer   │        │ │
│  │  │ (Figma-like)│  │  (capture)  │  │ (position)  │        │ │
│  │  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘        │ │
│  │         │                │                │                │ │
│  │         └────────────────┼────────────────┘                │ │
│  │                          │                                 │ │
│  │                  ┌───────▼───────┐                         │ │
│  │                  │    finder     │  ← Bundled dependency   │ │
│  │                  │ (selector gen)│    github.com/antonmedv/│ │
│  │                  └───────┬───────┘        finder           │ │
│  │                          │                                 │ │
│  │                  ┌───────▼───────┐                         │ │
│  │                  │  URL encode   │  ← Free: data in URL    │ │
│  │                  │  /decode      │      (localStorage)     │ │
│  │                  └───────┬───────┘                         │ │
│  └────────────────────────┼─────────────────────────────────┘ │
└────────────────────────────┼───────────────────────────────────┘
                             │
                             │ (Sync mode: self-hosted or Cloud)
                             │
                     ┌───────▼───────┐
                     │     SYNC      │
                     │  apps/sync    │
                     │  (Hono API +  │
                     │   SQLite)     │
                     └───────┬───────┘
                             │
                  ┌──────────┴──────────┐
                  │                     │
          ┌───────▼───────┐   ┌────────▼──────┐
          │  Self-Hosted  │   │     CLOUD     │
          │  (user runs   │   │  (managed +   │
          │   their own   │   │   Polar.sh    │
          │   instance)   │   │   billing)    │
          └───────────────┘   └───────────────┘

┌──────────────────────────────────────────────────────────────────┐
│     FUTURE: CHROME EXTENSION (collaboration layer anywhere)     │
│                                                                  │
│  Same Core library, injected into any page                       │
│  Requires BOTH sender and recipient to have extension installed  │
│  Unlocks OpenParley on sites that don't embed the library        │
└──────────────────────────────────────────────────────────────────┘
```

### Parley Data Structure

```typescript
// Core parley payload (what gets encoded in URL or stored in DB)
interface Parley {
  // Primary: CSS selector from finder
  selector: string;

  // Fallback: Text context for disambiguation
  textContext?: {
    inner: string;      // innerText (truncated to ~100 chars)
    before?: string;    // preceding sibling text
    after?: string;     // following sibling text
  };

  // Fallback: Structural hints
  structure?: {
    tagName: string;
    nthOfType: number;
    parentSelector: string;
  };

  // Comment (for free tier URL sharing)
  comment?: string;

  // Metadata
  pathname: string;
  timestamp: number;
}

// URL encoding: base64url(JSON.stringify(parley))
// Example: website.com?parley=eyJzZWxlY3RvciI6Ii...
```

### Resolution Algorithm

```
1. Parse ?parley= parameter, decode base64url, parse JSON
2. Try selector via document.querySelector()
   → Exact match? Done.
   → Multiple matches? Use textContext.inner to find correct one
   → No match? Continue to fallback
3. Try structure: find tagName at nthOfType position
   → Match? Done with "approximate" indicator
4. All fail? Show floating comment at last-known position with "element moved" warning
```

### Free vs Paid: What's Stored Where

| Aspect | Free (URL-encoded) | Paid (Server-stored) |
|--------|-------------------|---------------------|
| Selector | In URL | In database |
| Comment | In URL (limited chars) | In database (unlimited) |
| Threads | Not supported | Full threading |
| Fallbacks | Basic | Enhanced + ML matching |
| Durability | Link breaks if DOM changes significantly | Auto-healing anchors |
| Team features | None | Full collaboration |

---

## Open Source Strategy

**What's open source:**
- `@openparley/overlay` — Parley encoding/decoding, selector generation, URL parameter handling, full UI library
- `@openparley/sync` — Self-hostable backend API (Hono, SQLite, full REST API)

**What's proprietary (Cloud only):**
- Hosted infrastructure and operations
- Polar.sh billing integration
- Multi-organization tenancy routing
- Plan limits and entitlement enforcement
- Future Chrome extension

**Repository structure:**
```
github.com/openparley/openparley
├── packages/
│   └── core/           ← OSS: npm package @openparley/overlay (the whole free tier)
└── apps/
    ├── sync/           ← OSS: Self-hostable backend app
    └── console/        ← Proprietary: Cloud web app with billing
```

**Why this split:**
- OSS core is the complete free product — not a crippled version
- Developers can embed @openparley/overlay on any site, full functionality
- Paid tier adds persistence, teams, integrations on top
- Community can contribute to core, report issues, build extensions

---

## Reference Implementations

| Project | What to learn |
|---------|---------------|
| **[Figma](https://figma.com)** | UX inspiration — study comment threading, @mentions, resolve workflow, overlay patterns |
| **[finder](https://github.com/antonmedv/finder)** | Our selector foundation — study config options, edge cases |
| **[Open Previews](https://github.com/wundergraph/open-previews)** | Similar product — study their anchor persistence, UI patterns |
| **[Hypothesis](https://github.com/hypothesis/h)** | Text anchoring approach — useful for text-heavy fallbacks |
| **Vercel Comments** | Study their anchor payloads for ideas |

**Note on Figma:** We borrow Figma's proven commenting UX patterns (threading, @mentions, resolve workflow) but we're not a design tool. OpenParley is specifically a **collaboration layer for websites**, inspired by how Figma makes designs collaborative.

---

## Data Model (Paid Tier)

```sql
-- Core entities
teams
  id, name, slug, created_at

users
  id, email, name, team_id, role (admin|member)

projects
  id, team_id, name, url_pattern (regex for matching URLs)

-- Parley entities
parleys
  id, project_id, url, pathname
  selector, text_context (jsonb), structure (jsonb)
  status (open|resolved|stale)
  created_at, created_by
  last_verified_at

comments
  id, parley_id, parent_id (nullable, for threads)
  body, body_parsed (jsonb for @mentions, #tags, etc.)
  author_id, created_at, updated_at

-- Metadata
tags
  id, project_id, name, color

comment_tags
  comment_id, tag_id

mentions
  comment_id, user_id

links
  id, comment_id, type (figma|linear|github|url), url, metadata (jsonb)
```

---

## Comment Syntax (Todoist-style)

```
Fix the padding here #design /spacing @emma !friday

Parsed as:
- body: "Fix the padding here"
- tags: ["design"]
- section: "spacing"  
- mentions: ["emma"]
- due: "2025-02-07"
```

**Syntax rules:**
- `#tag` — categorization
- `/section` — sub-categorization within project
- `@name` — mention team member (autocomplete)
- `!date` — due date (`!today`, `!tomorrow`, `!tom`, `!fri`, `!feb14`)
- `[[url]]` — linked resource (auto-detect Figma, Linear, GitHub)

---

## Overlay Modes

Users can toggle visibility by concern:

| Mode | Shows | Color |
|------|-------|-------|
| **Design** | Visual/aesthetic comments | Purple |
| **Development** | Technical/implementation | Blue |
| **Product** | Copy, UX, requirements | Green |
| **All** | Everything | Mixed |

Comments are tagged with mode at creation. Default based on user role.

---

## Integrations (Paid Tier)

**Priority 1 (MVP+1):**
- Figma — Link to specific frames, show design preview
- Linear — Create issues from comments, sync status

**Priority 2:**
- Slack — Notifications, thread replies
- GitHub — Link to PRs, issues

**Priority 3:**
- Jira, Asana, Notion — Based on demand

---

## AI Features (Future)

Potential applications (not MVP):

1. **Auto-categorize** — Suggest #design/#dev/#product based on comment content
2. **Summarize thread** — "3 comments about button alignment, 2 about copy"
3. **Smart due dates** — Infer priority from language
4. **Generate ticket** — Draft Linear/Jira issue from thread
5. **Parley healing** — Use visual similarity to relocate broken selectors

**Principle:** AI should reduce friction, not be a feature checkbox. Only build if it saves >5 seconds per action.

---

## Why Not Just Use...

**Figma Comments?**
- ✗ Only works on static designs, not live websites
- ✗ Gap between mockup and implementation
- ✗ Can't comment on actual user flows

**Screenshot Tools?**
- ✗ Context lost immediately
- ✗ Goes stale when design changes
- ✗ Ambiguous ("which button?")
- ✗ Discussions scattered

**Bug Trackers?**
- ✗ Built for issue management, not collaboration
- ✗ No precise element context
- ✗ Not designed for ongoing team discussion

**OpenParley is different:** A collaboration layer for the live website itself.

---

## Milestones

### Phase 1: Core Library + Proof of Concept (Week 1-2)
- [ ] Set up repo structure (packages/overlay)
- [ ] Integrate finder library, configure for robustness
- [ ] Implement OpenParley encoding/decoding (base64url JSON)
- [ ] Build fallback resolution (textContext, structure)
- [ ] Test on 10 diverse sites (SPAs, static, dynamic content)
- [ ] Create test HTML page: click → generate → share URL → resolve

### Phase 2: Complete Free Tier Library (Week 3-4)
- [ ] Overlay UI: highlight element, show comment popover
- [ ] Click-to-parley flow with visual feedback
- [ ] Comment input (basic text)
- [ ] URL generation and copy-to-clipboard
- [ ] Incoming `?parley=` detection and auto-scroll + highlight
- [ ] Publish @openparley/overlay to npm
- [ ] Documentation site: install, usage, API reference
- [ ] Demo page showing the product in action

### Phase 3: Paid Tier Foundation (Week 5-8)
- [ ] Auth (Clerk or similar)
- [ ] Database schema + API (Postgres + tRPC or similar)
- [ ] Team/project management UI
- [ ] Persistent parley storage (upgrade from URL-only)
- [ ] Thread replies
- [ ] Quick syntax parser (#tags, @mentions, !dates)
- [ ] Overlay mode toggle (design/dev/product)
- [ ] Library: detect authenticated state, load persisted parleys

### Phase 4: Integrations + Launch (Week 9-12)
- [ ] Figma link previews
- [ ] Linear integration
- [ ] Notification system (email + in-app)
- [ ] Onboarding flow
- [ ] Billing (Stripe)
- [ ] Public launch

### Future: Chrome Extension
- [ ] Extension that injects @openparley/overlay into any page
- [ ] Works when both sender and recipient have extension
- [ ] Unlocks OpenParley on sites that don't embed the library
- [ ] Public launch

---

## Open Questions

1. **URL length limits?** Base64-encoded parleys with comments could get long. Most browsers handle ~2000 chars. May need to truncate comments or warn users.

2. **How to handle auth'd pages?** If someone shares a parley to a page behind login, recipient can't see it. Show placeholder? Require screenshot fallback?

3. **Parley versioning?** When format changes, how to handle old URLs? Include version field?

4. **Library loading strategy?** Async vs sync? How to minimize impact on page load?

5. **Conflict with existing query params?** Some sites use `?parley=` for other purposes. Allow configurable param name?

---

## Non-Goals (For Now)

- Mobile browser support
- Video/screen recording (Loom exists)
- Heatmaps/analytics (Hotjar exists)
- Design handoff (Figma exists)
- Bug tracking (Linear exists) — we integrate, not replace
- Chrome extension (future phase, not MVP)

---

## Success Metrics

### Qualitative

**Core success signal:** Teams report **reducing screenshot-in-Slack workflow by >80%**

**Other indicators:**
- Users describe OpenParley as "collaboration layer" or "commenting for websites"
- "We used to screenshot everything, now we just open a parley"
- Designers and developers collaborate in same tool (not Figma + Slack + Linear)
- Product teams say "the website is our workspace now"
- **The "aha moment":** User realizes website has become a collaborative canvas

---

## Technical References

- **[finder](https://github.com/antonmedv/finder)** — CSS selector generation (our foundation)
- **[Open Previews](https://github.com/wundergraph/open-previews)** — Similar product, Apache 2.0
- **[Hypothesis](https://github.com/hypothesis/h)** — Text anchoring reference
- **[W3C Web Annotation Data Model](https://www.w3.org/TR/annotation-model/)** — Spec reference

---

## Naming & Positioning

**OpenParley** (from "open a parley" - to begin a discussion, inspired by Pirates of the Caribbean)

**Primary Tagline:** "OpenParley: Collaborate ON your website"
- Emphasizes the key insight: collaboration happens ON the site, not ABOUT screenshots
- Direct, clear, action-oriented
- "Open" reinforces open source positioning

**Positioning Statement:**
> OpenParley is a collaboration layer for every website. Open a parley on any element to start threaded discussions and link to designs — all on the live site. Stop screenshotting, start parleys where the work lives.

**Alternative Taglines:**
- "Open parleys, close gaps" (emphasizes resolution)
- "Collaboration layer for every website" (developer-facing)
- "Where teams open discussions on live sites" (clear value prop)
- "Open parley on any element" (action-oriented)

**Domain:** openparley.dev (dev-focused identity)

**npm:** `@openparley/overlay` or `openparley`

**Core Verb:** "Open parley" (not "add comment" or "annotate")
- Button text: "Open Parley"
- Notifications: "Emma opened a parley on the header button"
- Status: "3 parleys open" / "Parley resolved"

**When describing to different audiences:**
- **Developers:** "A collaboration layer you can embed in any website — like Figma comments, but for live sites"
- **Designers:** "Open parleys on live implementations. Link to Figma, discuss changes in context."
- **Product teams:** "Stop taking screenshots. Open parleys on the actual site."
- **Stakeholders:** "Turn your website into a canvas for team discussion"

**Cultural Reference:**
The name draws from Pirates of the Caribbean's "I call parley!" — a familiar, memorable reference to negotiation and discussion. This aids recall and makes the product approachable without being unprofessional.