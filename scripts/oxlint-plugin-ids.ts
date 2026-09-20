/**
 * Ids here come from `newId()` in `src/schemas/id.ts`, and this rule is what says so.
 *
 * On every file, tests and scripts included, which is why it is not `no-restricted-imports`: that
 * rule is switched off for those, and cannot see `crypto.randomUUID()`, which needs no import.
 */

interface Node {
  type: string;
}

interface Source extends Node {
  source: Node & { value?: unknown };
}

interface ImportDeclaration extends Source {
  specifiers: (Node & { imported?: Node & { name?: string; value?: unknown } })[];
}

interface Call extends Node {
  callee: Node & { name?: string };
  arguments: (Node & { value?: unknown })[];
}

interface Member extends Node {
  computed: boolean;
  property: Node & { name?: string; value?: unknown };
}

interface Context {
  report(descriptor: { node: Node; message: string }): void;
}

const USE_NEW_ID = 'mints a UUID; ids come from newId() in src/schemas/id.ts';

const isUuidPackage = (name: unknown): boolean => typeof name === 'string' && /uuid/i.test(name);

const isCrypto = (name: unknown): boolean =>
  name === 'crypto' || name === 'node:crypto' || name === 'crypto-browserify';

export default {
  meta: { name: 'ids' },
  rules: {
    'no-uuid': {
      create(context: Context) {
        const imported = (node: Source): void => {
          if (isUuidPackage(node.source.value)) context.report({ node, message: `this ${USE_NEW_ID}` });
        };
        return {
          ImportDeclaration(node: ImportDeclaration): void {
            imported(node);
            if (!isCrypto(node.source.value)) return;
            for (const specifier of node.specifiers) {
              const name = specifier.imported?.name ?? specifier.imported?.value;
              if (name === 'randomUUID') context.report({ node: specifier, message: `randomUUID ${USE_NEW_ID}` });
            }
          },
          ImportExpression: imported,
          CallExpression(node: Call): void {
            if (node.callee.type !== 'Identifier' || node.callee.name !== 'require') return;
            if (isUuidPackage(node.arguments[0]?.value)) context.report({ node, message: `this ${USE_NEW_ID}` });
          },
          MemberExpression(node: Member): void {
            const name = node.computed ? node.property.value : node.property.name;
            if (name === 'randomUUID') context.report({ node, message: `randomUUID ${USE_NEW_ID}` });
          },
        };
      },
    },
  },
};
