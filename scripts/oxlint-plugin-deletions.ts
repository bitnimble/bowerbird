/**
 * Deleting from disk goes through `src/utils/deletions.ts`, and this rule catches the routes
 * `no-restricted-imports` cannot see: `Bun.file(path).delete()` needs no import, and a namespace,
 * default, `promises`, `require`, or dynamic import of `node:fs` reaches `rm` and `unlink` without
 * naming them. A `Bun.file` held in a variable and a spawned `rm` are out of its reach.
 */

interface Node {
  type: string;
}

interface Callee extends Node {
  computed?: boolean;
  name?: string;
  object?: Callee & { callee?: Callee };
  property?: Node & { name?: string; value?: unknown };
}

interface Call extends Node {
  callee: Callee;
  arguments: (Node & { value?: unknown })[];
}

interface Source extends Node {
  source: Node & { value?: unknown };
}

interface ImportDeclaration extends Source {
  specifiers: (Node & { imported?: { name?: string; value?: unknown } })[];
}

interface Context {
  report(descriptor: { node: Node; message: string }): void;
}

const USE_DELETIONS =
  'deleting from disk goes through src/utils/deletions.ts, which proves the target is safe to lose';

const FS_MODULES = ['fs', 'node:fs', 'fs/promises', 'node:fs/promises'];

function isBunFile(callee: Callee | undefined): boolean {
  return (
    callee?.type === 'MemberExpression' &&
    callee.object?.name === 'Bun' &&
    callee.property?.name === 'file'
  );
}

export default {
  meta: { name: 'deletions' },
  rules: {
    'no-direct-delete': {
      create(context: Context) {
        return {
          ImportExpression(node: Source): void {
            if (FS_MODULES.includes(String(node.source.value)))
              context.report({ node, message: USE_DELETIONS });
          },
          CallExpression(node: Call): void {
            const { callee } = node;
            if (callee.type === 'Identifier' && callee.name === 'require') {
              if (FS_MODULES.includes(String(node.arguments[0]?.value)))
                context.report({ node, message: USE_DELETIONS });
              return;
            }
            if (callee.type !== 'MemberExpression') return;
            const method = callee.computed ? callee.property?.value : callee.property?.name;
            if (method !== 'delete' && method !== 'unlink') return;
            if (callee.object?.type === 'CallExpression' && isBunFile(callee.object.callee))
              context.report({ node, message: USE_DELETIONS });
          },
          ImportDeclaration(node: ImportDeclaration): void {
            if (!FS_MODULES.includes(String(node.source.value))) return;
            for (const specifier of node.specifiers) {
              const name = specifier.imported?.name ?? specifier.imported?.value;
              if (specifier.type !== 'ImportSpecifier' || name === 'promises')
                context.report({ node: specifier, message: USE_DELETIONS });
            }
          },
        };
      },
    },
  },
};
