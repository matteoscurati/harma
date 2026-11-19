// The folder-trust dialog each agent CLI shows on its first start in a folder,
// and how harma recognizes it. harma answers it only when the user enabled the
// project's trust policy (harma trust on), only for the project folder or a
// worktree harma created, and only when the screen matches the dialog exactly.
// Tool permissions (commands, file edits) are never answered by harma.
import { realpathSync } from 'node:fs';

// Texts captured from claude 2.1.327, codex-cli 0.170.0 and agy 1.5.12 under herdr 0.9.5.
export const TRUST_DIALOGS = {
  claude: { title: /Is this a project you created or one you trust\?/, option: /Yes, I trust this folder/ },
  codex: { title: /Trust this folder\?/, option: /Trust and continue/ },
  agy: { title: /Do you trust the contents of this project\?/, option: /Yes, I trust this folder/ },
};

const SELECTED = /^\s*[❯›>]\s+(.*\S)\s*$/;
const squash = (s) => s.replace(/\s+/g, '');

function variants(path) {
  const out = new Set([path]);
  try { out.add(realpathSync(path)); } catch { /* not on disk: keep the given path */ }
  return [...out].map(squash);
}

/**
 * Read a screen: is it this harness's trust dialog for `cwd`, and is the
 * trust option the selected one? Returns {dialog, path, selected, line}.
 */
export function readTrustDialog(harness, screen, cwd) {
  const d = TRUST_DIALOGS[harness];
  if (!d || !screen) return { dialog: false, path: false, selected: false, line: null };
  const lines = screen.split('\n');
  const at = lines.findIndex((l) => d.title.test(l));
  // The title can wrap: fall back to the whole screen with line breaks removed.
  const dialog = at >= 0 || d.title.test(lines.join(' ').replace(/\s+/g, ' '));
  // The path wraps at the terminal width, so compare without whitespace.
  const flat = squash(screen);
  const path = variants(cwd).some((p) => flat.includes(p));
  const marked = lines.slice(Math.max(at, 0)).map((l) => l.match(SELECTED)?.[1]).find(Boolean) ?? null;
  return { dialog, path, selected: Boolean(marked && d.option.test(marked)), line: marked };
}

/** A folder harma may trust: the project root, a folder under it, or a worktree harma created. */
export function trustableFolder(cwd, root, worktreePath = null) {
  const inside = (p, base) => p === base || p.startsWith(base.endsWith('/') ? base : base + '/');
  const c = variants(cwd);
  const bases = [...variants(root), ...(worktreePath ? variants(worktreePath) : [])];
  return c.some((p) => bases.some((b) => inside(p, b)));
}
