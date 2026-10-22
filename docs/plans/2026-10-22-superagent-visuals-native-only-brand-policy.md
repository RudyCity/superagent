# SuperAgent Visuals — Brand and First-Party Motion Policy

Status: provisional **display-name migration**, 2026-10-22.

## Decision

- Public-facing working label: **SuperAgent Visuals** (not a trademark clearance or registration).
- Retire **Motion Studio** from current user-facing editor, help, CLI and tool descriptions.
- Keep the `motion` internal API and persistence namespace: `/api/motion`, `superagent motion`, `/motion`, `motion-* / motionjob-*` IDs, `.superagent/motion`, and existing TypeScript file/class names. Never migrate files or renumber schemas just to change a display label.
- Keep historical documents and release records unchanged; they accurately document the old name.
- Make the backend capabilities advertise `productDisplayName`, `templateSourcePolicy` and `externalMotionTemplateImport: false`. Existing API consumers can ignore these additive fields.

## Original-content policy

1. All future templates, preset recipes and effects should be implemented from an original brief, directly against the native SuperAgent declarative scene schema.
2. Do not import, port, scrape, bundle, translate or redistribute third-party motion-template packages, demo scenes or vendor-specific proprietary effects in the native template catalog.
3. The six existing curated templates are authored for the current engine and carry an `origin: superagent-original` catalog field.
4. Future third-party template imports, a template marketplace or arbitrary executable template bundles are **out of scope** until the policy is explicitly changed.
5. Dependencies needed to execute or export (Bun, FFmpeg, @napi-rs/canvas, fonts, codecs and other libraries) are **separate third-party software** and retain their own licences. Choosing original template code does not waive LGPL/GPL/codec obligations or eliminate all software compliance work. Maintain dependency notices and build audits.
6. User-uploaded images, audio, fonts, logos and other media are supplied by users and require users to have appropriate rights. The application should not imply ownership of user-provided media.

## Trademark and release gate

- **SuperAgent Visuals is a provisional product label only.** A public commercial product name should undergo clearance for identical and similar marks, spelling and phonetic similarity, relevant territories and classes, domains and app stores.
- Review Indonesia PDKI/DJKI and WIPO Global Brand Database. Depending on the goods/services, examine appropriate software (e.g. class 9), SaaS (42) and audiovisual production (41) categories with qualified Indonesian IP counsel.
- If approved, register the chosen name and logo in relevant jurisdictions as appropriate. A quick general web search is never trademark clearance.
- Rebrand visuals and docs by replacing the display-name constants; do not break legacy command IDs or deployed workspace projects.
- Do not claim exclusive IP rights in generic words such as *motion*, *studio* or *visuals*, or assume the existing SuperAgent brand is cleared.

## Compatibility and verification

Smoke existing CLI help, backend capabilities and template listing. T-Line should show the same display name in its navigation, empty dashboard, tab title and editor; existing `type: motion` session tabs remain valid.
