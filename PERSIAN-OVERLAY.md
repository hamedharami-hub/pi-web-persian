# Persian presentation overlay

Based on upstream v0.13.0. Scope: message prose, Markdown lists/quotes/tables,
oversized raw messages, and the chat composer. No account, model, session,
authentication, or UI-language changes.

Prose blocks choose direction from the dominant Arabic/Hebrew versus Latin
letters, not the first strong character. A tie in mixed prose favours RTL;
scriptless blocks stay `auto`. List markers follow the majority of immediate
items. Code and visible autolink URLs do not decide surrounding prose; code
fences, inline code and display mathematics stay LTR and isolated. In the
composer, Markdown code/URLs do not choose direction; a leading `!` shell
command stays LTR. Explicit RTL/LTR direction avoids CSS `unicode-bidi:
plaintext`, which would otherwise override it for a Latin-first sentence.
Multi-paragraph drafts still share one textarea direction (not per-paragraph).

Production launcher: `/home/ubuntu/.config/pi-web/start.sh`.
The original installed package at `/usr/lib/node_modules/@agegr/pi-web` is left
untouched. To roll back, restore the saved launcher (start.before-persian.sh)
and restart only PM2 process `pi-web-ui`.

Build in this isolated source directory, not in the installed package or a
running development server. Targeted tests were run with user approval. A source change alone does not
publish the production UI; build/restart and live-page checks are separate.
