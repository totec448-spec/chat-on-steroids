# Skills

Skills are reusable text instructions for ChatGPT. The library starts empty.

## Add and select a skill

Open **+ → Skills** in the composer and choose **Import skill file**. Select a Markdown `.md` or text `.txt` file. CoS copies it into its managed library. An existing skill with the same command is never overwritten by import.

Choose **Use** beside an installed skill, or type **/** at the beginning of the composer to search by command, name or description. Use the arrow keys and Enter or Tab to select a result. Escape closes the suggestions. The command is inserted before your task:

```text
/code-review
Review the changes in this project.
```

Several leading command lines select several skills. `/prompt code-review` also works. Commands in quoted text, code blocks or later task prose do not select skills.

The first outgoing message contains the main instructions and an index of installed skills, then the complete selected skill instructions, project AGENTS.md and your message. An explicit skill in a follow-up adds its instructions without repeating the main setup. Prepared delivery text is retained for retries, so editing or removing a skill cannot change a message already prepared for delivery.

The complete message remains within 96,000 UTF-16 characters and the transport's UTF-8 byte limit. AGENTS.md is shortened first, with a notice to read the rest. Selected skills and your task are never silently cut; a selection that cannot fit produces an error.

## File format

Use `SKILL.md` with simple YAML frontmatter:

```markdown
---
name: code-review
description: Review changes for correctness, regressions and missing tests.
---
Read the changed implementation and its callers. Report concrete defects with
their triggering conditions. Run the smallest relevant tests before concluding.
```

Plain Markdown and text files also work. Without frontmatter, CoS uses a Markdown title or the imported filename. Frontmatter supports text metadata such as quoted and folded descriptions; it does not execute commands, hooks or templates. Skill IDs use lowercase letters, digits, dots, underscores and hyphens, with an alphanumeric first and last character. `prompt` and platform-reserved names are unavailable.

The managed folder is `<CoS user data>/skills/<id>/SKILL.md`. **Open skill directory** in the Skills window opens the actual location. Files must be valid UTF-8 text, at most 256 KiB each. CoS indexes up to 128 skills, checks at most 512 directory entries per scan and reports files it could not load. Binary files and paths escaping through links are rejected.

## Let the model install or use skills

Ask the model to install the instructions you provide into `/skills/code-review/SKILL.md`, using its existing Core file or command tools. The folder is available alongside your approved project roots. It exposes only the skills library; the same file permissions and Read-only setting apply.

The library refreshes from disk when opened or when a new slash-completion cycle begins. A model already in a conversation can list `/skills` and read a newly installed file without starting over. No external catalog, download or account is required by the feature itself.

Skills supply text guidance. They do not add MCP tools, enable plugins, grant permissions or run bundled scripts. A skill that requires an unavailable tool cannot make that tool available. Imported text should describe work you actually intend to authorize.

**Remove** deletes the selected `SKILL.md`; unrelated supporting files in its directory remain. Remove the corresponding command from an unsent draft, or select another installed skill, before sending it.
