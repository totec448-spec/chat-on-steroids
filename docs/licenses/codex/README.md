# OpenAI Codex attribution

`LICENSE` and `NOTICE` were copied from OpenAI Codex revision
`1a4096e273e80da30947e57fdfa45be92858ca91` on 2026-09-09.

CoS adapts the Astra instruction template from `codex-rs/models-manager/models.json`
and the `update_plan` contract from `codex-rs/core/src/tools/handlers/plan_spec.rs`
and `codex-rs/protocol/src/plan_tool.rs`. Modified files identify their origin.
The adaptation changes identity and available tools, omits unsupported Codex facilities,
and adds bounded plan details, durable session ownership and desktop presentation.

The upstream NOTICE is preserved in full, including its upstream Ratatui attribution;
this change does not incorporate Ratatui implementation code.
The notice generator includes these texts in the packaged legal inventory.
