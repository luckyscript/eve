---
name: workspace-report
description: Generate a small workspace report from inventory.txt and save it as report.json.
---

# Workspace report

Use this skill when asked to generate a workspace report.

1. Read `inventory.txt` using `read_file`. Do not infer its contents from the user prompt.
2. Write `report.json` using `write_file`, with exactly these fields:
   - `title`: `eve workspace report`
   - `source`: `inventory.txt`
   - `items`: an array of non-empty trimmed lines from the input, preserving order.
   - `skill_version`: `workspace-report/1`
3. Read `report.json` back and verify it matches the source.
4. Summarize what was saved. Do not claim a write succeeded if the tool failed.

Only operate on these two workspace files. Do not request shell execution or network access.
