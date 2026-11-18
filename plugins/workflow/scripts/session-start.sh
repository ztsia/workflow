#!/usr/bin/env bash
# The plugin's SessionStart hook (hooks/hooks.json). Its stdout becomes context for the session, up to
# 10,000 characters: the workflow rules (rules.md), a pointer at the handoff and, in a cloud session,
# the newest unmerged slice branch whose handoff differs from main's. A project's own setup (installs,
# a local database) goes in its own hook (templates/scripts/session-setup.sh).
# It never fails the session: a broken step should surface when a command runs, not at startup.
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/.." && { pwd -W 2>/dev/null || pwd; })
cd "${CLAUDE_PROJECT_DIR:-$PWD}" || exit 0

version() { sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' | head -1; }

# In the cloud, the plugin updates itself. The environment caches its setup (and this folder) for
# about seven days, so the copy here can lag main's: when it does, cloud-setup.sh installs main's
# into this same folder before the rules are printed. Only for the copy cloud-setup.sh placed
# (~/.claude/skills/workflow), never a checkout run with --plugin-dir. The running script is safe:
# the folder is replaced, not rewritten, and bash keeps reading the file it opened.
updated=
if [ "${CLAUDE_CODE_REMOTE:-}" = "true" ] && [ "$ROOT" = "$(cd ~/.claude/skills/workflow 2>/dev/null && pwd)" ]; then
  here=$(version < "$ROOT/.claude-plugin/plugin.json")
  main=$(curl -fsSL --max-time 10 https://raw.githubusercontent.com/ztsia/workflow/main/plugins/workflow/.claude-plugin/plugin.json 2>/dev/null | version)
  if [ -n "$main" ] && [ "$here" != "$main" ]; then
    timeout 90 bash "$ROOT/scripts/cloud-setup.sh" --workflow-only > /tmp/workflow-update.log 2>&1
    now=$(version < "$ROOT/.claude-plugin/plugin.json" 2>/dev/null)
    if [ "$now" = "$main" ]; then
      updated="The workflow plugin updated itself from $here to $main as this session started. Its rules, skills and scripts are $main's; what Claude Code loaded before this hook ran (the agent definitions, the hook list) stays $here's for this session."
    else
      updated="The workflow plugin here is ${now:-$here} and main's is $main; updating it failed (/tmp/workflow-update.log). Tell the owner: edit any line of the cloud environment's setup script at claude.ai/code (a comment will do) and start a new session."
    fi
  fi
fi

# The rules, with the plugin's own path filled in so their commands run as written.
sed "s|\${CLAUDE_PLUGIN_ROOT}|$ROOT|g" "$ROOT/rules.md"
echo

# The handoff comes first for every session, local or cloud.
[ -f docs/handoff.md ] && echo "Read docs/handoff.md before anything else, and rewrite it before you end."
[ -n "$updated" ] && echo "$updated"

# Everything below is cloud only.
[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0

# A slice handed off mid-way lives on its unmerged branch, B<NN>/<brief>. Name the newest one whose
# handoff differs from main's, as a safety net: the owner's message names the branch to continue
# from. The harness's claude/* branches are checked too.
if timeout 60 git fetch -q origin main '+refs/heads/B*:refs/remotes/origin/B*' \
    '+refs/heads/claude/*:refs/remotes/origin/claude/*' 2>/dev/null; then
  for ref in $(git for-each-ref --sort=-committerdate --format='%(refname:short)' \
      'refs/remotes/origin/B[0-9][0-9]/' refs/remotes/origin/claude/); do
    git merge-base --is-ancestor "$ref" origin/main 2>/dev/null && continue
    git diff --quiet origin/main..."$ref" -- docs/handoff.md 2>/dev/null && continue
    echo "A newer handoff is on $ref ($(git log -1 --format=%cr "$ref")). If you're continuing a slice, read it there."
    break
  done
fi

exit 0
