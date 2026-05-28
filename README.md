# SillyTavern Cron Jobs

Frontend extension for SillyTavern that runs scheduled prompts for the currently open character.

It can be used for periodic check-ins, reminders, ambient roleplay nudges, or any other character-scoped automation that should happen when the SillyTavern UI is open.

## Features

- Character-scoped scheduled jobs
- One-shot date/time jobs
- 5-field cron expression jobs
- Overdue catch-up when opening a tab or switching characters
- Editable scheduled-message wrapper
- Function tools for listing, adding, updating, and deleting jobs
- Same-browser leader lock to avoid duplicate runs across multiple tabs
- Run history for recent job executions

## Installation

Install as a third-party SillyTavern extension:

```text
https://github.com/ZhenyaPav/SillyTavern-Extension-CronJobs
```

After installation, enable **Cron Jobs** in the Extensions panel.

## How It Works

Jobs are bound to the current character by avatar filename. A job only runs when that character is currently open.

When a job fires, the extension renders the configured cron message template, places the resulting text into the normal send box, and calls SillyTavern's regular generation flow. This means cron jobs behave like normal user messages and use the currently selected model, character context, lorebooks, and generation settings.

The default message wrapper is:

```text
[Scheduled message from Cron Jobs]
Job: {{title}} ({{id}})
Scheduled for: {{scheduledAt}}
Current time: {{currentTime}}

This is an automated scheduled message, not a live user reply. Respond in the current chat context as you normally would.

{{prompt}}
```

The wrapper variables are local to this extension and are expanded only when a cron job fires:

- `{{id}}`
- `{{title}}`
- `{{scheduledAt}}`
- `{{currentTime}}`
- `{{prompt}}`

Unknown `{{...}}` placeholders are left unchanged.

After these local variables are rendered, the message is sent through SillyTavern's normal user-message path. Regular SillyTavern macros in the final cron message, such as `{{user}}`, `{{char}}`, or chat-history macros supported by your SillyTavern version, are resolved there.

## Schedule Formats

### One-shot

Use `once` for a single run at a date/time parseable by the browser, for example:

```text
2026-05-28 14:30
2026-05-28T14:30:00
```

### Cron

Use standard 5-field cron syntax:

```text
minute hour day-of-month month day-of-week
```

Examples:

```text
*/30 * * * *      every 30 minutes
0 9 * * *         every day at 09:00
0 18 * * 1-5      weekdays at 18:00
```

Supported field syntax:

- `*`
- numbers
- comma lists, such as `1,15,30`
- ranges, such as `1-5`
- steps, such as `*/15` or `1-10/2`

## Settings

- **Execute cron jobs**: master toggle for automatic execution.
- **Execute overdue cron jobs on tab open / character switch**: run eligible missed jobs when the UI becomes available.
- **Cron function tools**: expose job-management tools to supported LLM tool-calling models.
- **Maximum cron overdue age, hours**: overdue jobs older than this are skipped.
- **Maximum cron jobs executed at once**: cap catch-up runs per scheduler check.
- **Cron Message Template**: wrapper used around the job prompt.
- **Cron Function Tool Prompts**: editable tool descriptions and parameter descriptions.

Defaults:

- Execute jobs: enabled
- Execute overdue jobs: enabled
- Maximum overdue age: 24 hours
- Maximum jobs executed at once: 1
- Function tools: enabled

## Function Tools

When enabled and supported by the active model/provider, the extension registers:

- `ListCronJobs`
- `AddCronJob`
- `UpdateCronJob`
- `DeleteCronJob`

Tools only operate on jobs for the currently open character.

During cron-triggered generation, this extension's own management tools are hidden to avoid recursive job-management calls. Other SillyTavern tools remain unaffected.

## Multi-Tab Behavior

The extension uses a `localStorage` leader lease so only one tab in the same browser profile executes cron jobs.

This prevents common same-browser duplicate runs, but it is not a cross-device lock. If SillyTavern is open on a PC and a phone, both devices may still run the same due job.

## Limitations

- The SillyTavern UI must be open for jobs to run.
- Browser background throttling can delay timers.
- Group chats are not supported in this version.
- Cross-device duplicate prevention would require a server-side lock.

## License

AGPL-3.0-or-later, matching SillyTavern's extension ecosystem expectations.
