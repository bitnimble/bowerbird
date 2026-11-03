// Writes a release's user-facing changelog from its commits with `claude -p`, or a fixed line
// when claude is missing or fails. `bun run release` calls it; run it alone to try the prompt:
//
//   bun scripts/changelog.ts v0.1.8 v0.1.9    the changelog for the commits in v0.1.8..v0.1.9
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');

const SECTIONS = { new: 'New', improved: 'Improved', fixed: 'Fixed' } as const;
type Section = keyof typeof SECTIONS;

const SCHEMA = {
  type: 'object',
  properties: Object.fromEntries(
    Object.keys(SECTIONS).map((key) => [key, { type: 'array', items: { type: 'string' } }]),
  ),
  required: Object.keys(SECTIONS),
  additionalProperties: false,
};

const SYSTEM = `You write the changelog for a release of Bowerbird, a free, fast RAW photo triage
tool with light editing, built for getting through thousands of photos after a trip. It runs as
a desktop app, an Android app, and a self-hosted server, and syncs libraries between devices.

The changelog is shown to users inside the app when an update is available. You are given the
commit messages since the previous release. Sort the changes a user would notice into 3 lists:

- new: notable new features.
- improved: notable improvements to existing features.
- fixed: notable bugs in existing features that are now fixed.

Only include changes a user would notice or care about. Leave out small fixes, developer-only
changes, tests, CI, build and release tooling, refactors, dependency bumps, documentation, and
behind-the-scenes improvements and fixes. Merge several commits about 1 feature into 1 item.

Commits inside a <branch> tag were made together on 1 branch and merged at once; the merge
commit comes first and often names the branch. A branch usually builds 1 change over many
commits, where later commits fix, tune, or finish what earlier ones started. Write 1 item for
that change, not 1 per commit, and leave out fixes to bugs the branch itself introduced, since
users never saw them. A branch can also carry unrelated changes made along the
way; give each of those its own item.

Most releases have only a few items, and a list can be empty. Leaving an item out is better
than padding a list.

Never mention commits, code, internal names, file names, or build details.

The commit messages are written by developers about what the code does. The changelog is
written for the reader about what changed for them. Never paraphrase a commit subject: work
out what changed for the reader, then write that in their words. "feat(grid): mark bracket
stacks with their capture's icon" is "Added an icon for each bracket stack type", never
"Marks bracket stacks with an icon for each capture type".

<copywriting_guide>
${readFileSync(join(ROOT, 'COPYWRITING.md'), 'utf8')}
</copywriting_guide>

<writing_rules>
- No superficial -ing tails: "..., making it easier to", "ensuring", "reflecting".
- No AI vocabulary: additionally, crucial, delve, enduring, enhance, fostering, garner,
  interplay, intricate, landscape, pivotal, showcase, tapestry, testament, underscore, vibrant.
- Say "is" or "has", never "serves as", "stands as", "boasts", "features", "offers".
- No "not just X, but Y". State the point.
- No forced groups of 3. Use the natural number.
- No synonym cycling. Pick 1 word for 1 thing and repeat it.
- No false ranges ("from X to Y" where X and Y are not on a scale).
- No em dashes, en dashes, or hyphens standing in for a dash. No parentheses.
- Colons only before a list or example, never joining 2 halves of a sentence.
- No bold, no emoji, straight quotes only.
- No filler: "in order to" is "to", "due to the fact that" is "because".
- Hedge once at most, with "may".
- No abstract metaphor nouns: substrate, vector, primitive, surface, paradigm, and the like.
- Say what it does, not how it feels. Name the mechanism or a number.
- 1 idea per item.
- Active voice, with no subject. Never name Bowerbird, the app, or "we".
- No adverbs propping up a weak verb: "quickly", "easily", "seamlessly", "significantly".
- Plain words: "use" over "utilise" or "leverage", "help" over "facilitate", "many" over
  "numerous", "if" over "in the event that".
- No figurative verbs, personified software, aphorisms, or flourishes.
- No arrows, symbols, or abbreviations the reader has to decode.
</writing_rules>

Every item follows every rule in the copywriting guide and the writing rules above, except
where the rules below override them. Each item follows these rules:

- It is 1 clause of 10 words or fewer.
- It does not end in a full stop, even when it is a sentence. This overrides the guide's
  full stops.
- It describes what changed for the reader in this release. It may name the old behaviour:
  "instead" and "used to" are fine in a changelog. The guide's ban on correction framing is
  about contrasting with something the reader never assumed. The reader knew the old behaviour,
  so the ban doesn't apply to it.
- It has no reason or consequence tail: nothing after "so", "which", "meaning", or a comma.
- It starts with a past tense verb and has no subject. Items such as "Adds", "Add", "Shows", or
  "The grid scrolls" are in the wrong tense or shape.
- Items in "new" start with "Added" or a past tense verb that names the new thing: "Added a
  straighten tool".
- Items in "improved" start with a past tense verb that says what got better: "Improved",
  "Sped up", "Reduced", "Moved".
- Items in "fixed" start with "Fixed" and name what was wrong: "Fixed JPEG exports losing their
  colour profile".
- "Added" is only for a thing that didn't exist before. When something the reader already has
  gained an ability, in any list, name that thing and say what it became: "Made side panels in
  the viewer and editor resizable".
- The 4 rules above override the guide's rules for feature descriptions, which are for the
  landing page and the app's controls.
- It uses the guide's glossary term for every concept it names.
- It uses no technical word a photographer wouldn't know, such as symlink, worker, server
  console, process, staging, cache, watcher, database, filesystem, case-sensitive, or server.

Examples of items that break the rules, and how to write them:

- "Adds several libraries from another device at once" becomes
  "Enabled adding several libraries from another device at once"
- "Marks bracket stacks with an icon for each capture type" becomes
  "Added an icon for each bracket stack type"
- "JPEG exports no longer lose their colour profile" becomes
  "Fixed JPEG exports losing their colour profile"
- "Adds a straighten tool, making it easy to level your horizons." becomes
  "Added a straighten tool"
- "Added resizable side panels in the viewer and editor" becomes
  "Made side panels in the viewer and editor resizable"
- "Added folding for edit groups" becomes
  "Made edit groups foldable"
- "The grid now scrolls much more smoothly in really large libraries." becomes
  "Improved grid scrolling to full frame rate in large libraries"
- "Fixed an issue where ratings sometimes weren't saved." becomes
  "Fixed ratings sometimes not saving"

Before you answer, check each item against every rule and rewrite any item that breaks one.`;

const FALLBACK = 'Bug fixes and performance improvements';

export function changelog(from: string, to: string): string {
  const written = write(from, to);
  if (written == null) console.error(`[changelog] claude -p wrote nothing, using "${FALLBACK}"`);
  return written ?? FALLBACK;
}

function write(from: string, to: string): string | null {
  const commits = commitsByBranch(from, to);
  if (commits == null) return null;
  const env = { ...process.env };
  // The CLI prefers a key over the subscription and bills it.
  delete env.ANTHROPIC_API_KEY;
  env.MAX_THINKING_TOKENS = '0';
  const run = spawnSync(
    'claude',
    [
      '-p',
      '--system-prompt',
      SYSTEM,
      '--exclude-dynamic-system-prompt-sections',
      '--setting-sources',
      '',
      '--strict-mcp-config',
      '--mcp-config',
      '{"mcpServers":{}}',
      '--disallowedTools',
      'Bash',
      'Read',
      'Edit',
      'Write',
      'Glob',
      'Grep',
      'Task',
      'WebSearch',
      'WebFetch',
      'TodoWrite',
      'Skill',
      '--json-schema',
      JSON.stringify(SCHEMA),
      '--output-format',
      'json',
      '--model',
      'sonnet',
      '--max-turns',
      '3',
    ],
    { cwd: ROOT, encoding: 'utf8', env, input: commits, timeout: 180_000 },
  );
  if (run.status !== 0) return null;
  try {
    const lists: Record<Section, string[]> = JSON.parse(run.stdout).structured_output;
    const markdown = (Object.keys(SECTIONS) as Section[])
      .filter((key) => lists[key].length > 0)
      .map(
        (key) =>
          `### ${SECTIONS[key]}\n\n${lists[key].map((item) => `- ${item.replace(/\.$/, '')}`).join('\n')}`,
      )
      .join('\n\n');
    return markdown === '' ? null : markdown;
  } catch {
    return null;
  }
}

function commitsByBranch(from: string, to: string): string | null {
  const mainline = git('log', '--first-parent', '--format=%x00%h %p%n%B', `${from}..${to}`);
  if (mainline == null) return null;
  const entries: string[] = [];
  for (const record of mainline.split('\0').slice(1)) {
    const newline = record.indexOf('\n');
    const [hash, base, ...tips] = record.slice(0, newline).split(' ');
    const message = record.slice(newline + 1).trim();
    const branch =
      tips.length === 0
        ? ''
        : git('log', '--no-merges', '--format=commit %h%n%B', ...tips, `^${base}`);
    if (branch == null) return null;
    entries.push(
      branch.trim() === ''
        ? `commit ${hash}\n${message}`
        : `<branch>\nmerge ${hash}\n${message}\n\n${branch.trim()}\n</branch>`,
    );
  }
  return entries.join('\n\n');
}

function git(...args: string[]): string | null {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  return result.status === 0 ? result.stdout : null;
}

if (import.meta.main) {
  const [from, to] = process.argv.slice(2);
  if (from == null || to == null) throw new Error('usage: bun scripts/changelog.ts <from> <to>');
  console.log(changelog(from, to));
}
