/**
 * Text the user reads must come from the strings file beside its component, and these
 * three rules are what says so. An oxlint JS plugin rather than a pass over the source,
 * because the thing being asked is a question about syntax: whether a *literal* reaches a
 * place the user reads from. A line of source cannot answer that, and every way of pretending it can
 * either misses `{cond ? 'a' : 'b'}` or trips over `className="sidebar"`.
 *
 * `react/jsx-no-literals` is the built-in these replace. It sees a text node and an
 * attribute, and does not see a literal wrapped in braces, one hidden in a ternary, or
 * anything at all outside JSX - which is where a third of this app's text lives.
 */

interface Node {
  type: string;
}

interface Literal extends Node {
  type: 'Literal';
  value: unknown;
}

interface TemplateLiteral extends Node {
  type: 'TemplateLiteral';
  quasis: { value: { cooked: string | null; raw: string } }[];
  expressions: Node[];
}

interface TaggedTemplate extends Node {
  quasi: Node;
}

/** A cast, a `satisfies`, a `!` - syntax around a literal that leaves it a literal. */
interface Wrapper extends Node {
  expression: Node;
}

interface Conditional extends Node {
  test: Node;
  consequent: Node;
  alternate: Node;
}

interface Binary extends Node {
  operator: string;
  left: Node;
  right: Node;
}

interface JsxText extends Node {
  type: 'JSXText';
  value: string;
}

interface JsxContainer extends Node {
  type: 'JSXExpressionContainer';
  expression: Node;
}

interface JsxElement extends Node {
  children: Node[];
}

interface JsxAttribute extends Node {
  name: { type: string; name?: string; namespace?: { name: string }; name_?: { name: string } };
  value: Node | null;
}

interface Property extends Node {
  key: Node & { name?: string; value?: unknown };
  /** Null for a class field with no initialiser. */
  value: Node | null;
  computed: boolean;
}

interface JsxSpread extends Node {
  argument: Node;
}

interface ObjectExpression extends Node {
  properties: Node[];
}

/** A destructuring default (`{ label = 'Delete' }`) holds its literal one level down. */
function propertyValue(property: Property): Node | null {
  const { value } = property;
  if (value == null) return null;
  return value.type === 'AssignmentPattern' ? (value as Wrapper & { right: Node }).right : value;
}

interface Call extends Node {
  callee: Node & { type: string; property?: Node & { name?: string }; name?: string };
  arguments: Node[];
}

interface Context {
  options: unknown[];
  report(descriptor: { node: Node; message: string }): void;
}

const NEEDS_A_STRINGS_FILE = 'reads as text to the user; move it to the .strings.ts beside this component';

/**
 * Whether a literal is something a reader reads, as opposed to something they see.
 *
 * Prose contains a word, and a word is two letters. What that lets past is the whole
 * family of separators - the `/` between path segments, the `·` between counts, the `★`
 * a rating is drawn with, and the `x` in `1920x1080` or `${w},${h} ${x}x${y}` - none of
 * which has anything in it to translate. One letter is never a sentence, and the
 * alternative is an allowlist growing a line per glyph.
 */
function isProse(text: string): boolean {
  return /\p{L}\p{L}/u.test(text);
}

/**
 * Each rule takes one object of string lists.
 *
 * Required, and every list non-empty: a rule whose names came from an absent options
 * object matches nothing and reports nothing, which looks exactly like a clean tree.
 * `no-literal-props` and `no-literal-text` are both no-ops without theirs.
 */
const schemaOf = (required: string[], optional: string[] = []): [Record<string, unknown>] => [
  {
    type: 'object',
    properties: Object.fromEntries(
      [...required, ...optional].map((key) => [key, { type: 'array', items: { type: 'string' }, minItems: 1 }]),
    ),
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  },
];

/**
 * The sentence a literal expression would put on screen, or null where it puts none.
 *
 * Reaches through the shapes text actually hides in - a ternary picking between two
 * sentences, a `&&` guarding one, a `+` joining two halves of a warning, a template
 * with words between its holes - because each of those is a literal the reader sees.
 *
 * **`isProse` is applied here rather than by the caller**, so a branch that is not a
 * sentence cannot answer on behalf of one that is: `cond ? 'A' : 'Ternary attribute'`
 * has to report the second, and a caller testing the returned value would only ever
 * see the first.
 */
function proseText(node: Node | null | undefined): string | null {
  if (node == null) return null;
  switch (node.type) {
    case 'Literal': {
      const { value } = node as Literal;
      return typeof value === 'string' && isProse(value) ? value : null;
    }
    case 'TemplateLiteral': {
      const { quasis, expressions } = node as TemplateLiteral;
      const text = quasis.map((q) => q.value.cooked ?? q.value.raw).join('');
      // A template of nothing but words between its holes still shows what is in them.
      return isProse(text) ? text : firstText(expressions);
    }
    case 'TaggedTemplateExpression':
      return proseText((node as TaggedTemplate).quasi);
    // A cast, a `satisfies` or a `!` wraps the literal without changing what it says.
    case 'TSAsExpression':
    case 'TSSatisfiesExpression':
    case 'TSNonNullExpression':
      return proseText((node as Wrapper).expression);
    case 'ConditionalExpression': {
      const { consequent, alternate } = node as Conditional;
      return proseText(consequent) ?? proseText(alternate);
    }
    // Only the side that is actually rendered. `a && b` renders `b`; `a === 'idle' && b`
    // would otherwise read its own comparison as a sentence, which is how a rule like
    // this ends up disbelieved.
    case 'LogicalExpression': {
      const { operator, left, right } = node as Binary;
      return operator === '&&' ? proseText(right) : (proseText(left) ?? proseText(right));
    }
    // Concatenation joins two halves of one sentence; every other operator yields a
    // number or a boolean.
    case 'BinaryExpression': {
      const { operator, left, right } = node as Binary;
      return operator === '+' ? (proseText(left) ?? proseText(right)) : null;
    }
    default:
      return null;
  }
}

function firstText(nodes: Node[]): string | null {
  for (const node of nodes) {
    const text = proseText(node);
    if (text != null) return text;
  }
  return null;
}

function optionList(context: Context, key: string): string[] {
  const options = context.options[0];
  if (options == null || typeof options !== 'object') return [];
  const value = (options as Record<string, unknown>)[key];
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function attributeName(attribute: JsxAttribute): string | null {
  const { name } = attribute;
  if (name.type === 'JSXNamespacedName') return null;
  return typeof name.name === 'string' ? name.name : null;
}

function propertyName(property: Property): string | null {
  if (property.computed) return null;
  const { key } = property;
  if (key.type === 'Identifier' && typeof key.name === 'string') return key.name;
  if (key.type === 'Literal' && typeof key.value === 'string') return key.value;
  return null;
}

/** The method being called, for `toasts.show(...)` and the bare `confirm(...)` alike. */
function calleeName(call: Call): string | null {
  const { callee } = call;
  if (callee.type === 'Identifier' && typeof callee.name === 'string') return callee.name;
  if (callee.type === 'MemberExpression' && callee.property?.type === 'Identifier') {
    return typeof callee.property.name === 'string' ? callee.property.name : null;
  }
  return null;
}

export default {
  meta: { name: 'strings' },
  rules: {
    /** Text between tags, and text a brace only wraps: `<b>Save</b>`, `{'Save'}`, `{n > 0 ? 'one' : 'none'}`. */
    'no-jsx-text': {
      create(context: Context) {
        const check = (element: JsxElement): void => {
          for (const child of element.children) {
            const text =
              child.type === 'JSXText' ? (isProse((child as JsxText).value) ? (child as JsxText).value : null)
              : child.type === 'JSXExpressionContainer' ? proseText((child as JsxContainer).expression)
              : null;
            if (text == null) continue;
            context.report({ node: child, message: `"${text.trim()}" ${NEEDS_A_STRINGS_FILE}` });
          }
        };
        return { JSXElement: check, JSXFragment: check };
      },
    },

    /**
     * A literal on a prop the user reads. Named props rather than all of them: `className`
     * and `to` are literals too, and a rule that cannot tell them from `aria-label` is one
     * that gets switched off.
     */
    'no-literal-props': {
      meta: { schema: schemaOf(['restrictedProps']) },
      create(context: Context) {
        const restricted = new Set(optionList(context, 'restrictedProps'));
        // An empty `alt` is what a decorative image is supposed to carry, and `proseText`
        // has already answered null for it.
        const report = (node: Node, name: string, text: string | null): void => {
          if (text == null) return;
          context.report({ node, message: `${name}="${text}" ${NEEDS_A_STRINGS_FILE}` });
        };
        return {
          JSXAttribute(node: JsxAttribute): void {
            const name = attributeName(node);
            if (name == null || !restricted.has(name)) return;
            const value = node.value;
            const text =
              value?.type === 'JSXExpressionContainer' ? proseText((value as JsxContainer).expression) : proseText(value);
            report(value ?? node, name, text);
          },
          // `{...{ 'aria-label': 'Close' }}` reaches the same attribute by another road.
          JSXSpreadAttribute(node: JsxSpread): void {
            if (node.argument.type !== 'ObjectExpression') return;
            for (const property of (node.argument as ObjectExpression).properties) {
              if (property.type !== 'Property') continue;
              const name = propertyName(property as Property);
              if (name == null || !restricted.has(name)) continue;
              report(property, name, proseText(propertyValue(property as Property)));
            }
          },
        };
      },
    },

    /**
     * The text that never reaches JSX: the `label` of an `Option` in the table a control
     * is built from, the sentence handed to a toast, the warning `confirm` asks.
     */
    'no-literal-text': {
      meta: { schema: schemaOf(['properties', 'calls']) },
      create(context: Context) {
        const properties = new Set(optionList(context, 'properties'));
        const calls = new Set(optionList(context, 'calls'));
        // `{ label: 'Grid' }`, `class C { title = 'Camera' }` and the default in
        // `({ label = 'Delete' })` are three node types carrying one idea.
        const named = (node: Property): void => {
          const name = propertyName(node);
          if (name == null || !properties.has(name)) return;
          const value = propertyValue(node);
          const text = proseText(value);
          if (value == null || text == null) return;
          context.report({ node: value, message: `${name}: "${text}" ${NEEDS_A_STRINGS_FILE}` });
        };
        return {
          Property: named,
          PropertyDefinition: named,
          CallExpression(node: Call): void {
            const name = calleeName(node);
            if (name == null || !calls.has(name)) return;
            for (const argument of node.arguments) {
              const text = proseText(argument);
              if (text == null) continue;
              context.report({ node: argument, message: `"${text}" ${NEEDS_A_STRINGS_FILE}` });
            }
          },
        };
      },
    },
  },
};
