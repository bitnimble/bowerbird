import { join } from 'node:path';
import { createMdxLanguagePlugin } from '@mdx-js/language-service';
import { createTypeScriptChecker } from '@volar/kit';
import remarkFrontmatter from 'remark-frontmatter';
import ts from 'typescript';
import { create as createTypeScriptServices } from 'volar-service-typescript';

const ROOT = join(import.meta.dir, '..');
const PROJECTS = ['web/tsconfig.json', 'landing/tsconfig.json'];

let failed = false;
for (const project of PROJECTS) {
  const checker = createTypeScriptChecker(
    // The README's signature omits the second parameter: `true` there turns nothing on, and
    // the check passes everything.
    [createMdxLanguagePlugin([remarkFrontmatter], [], true)],
    createTypeScriptServices(ts),
    join(ROOT, project),
  );
  const files = checker.getRootFileNames().filter((file) => file.endsWith('.mdx'));
  if (files.length === 0)
    throw new Error(`${project} includes no MDX, so this checks nothing there`);
  for (const file of files) {
    const diagnostics = await checker.check(file);
    if (diagnostics.length === 0) continue;
    failed = true;
    process.stderr.write(checker.printErrors(file, diagnostics, ROOT));
  }
}
process.exitCode = failed ? 1 : 0;
