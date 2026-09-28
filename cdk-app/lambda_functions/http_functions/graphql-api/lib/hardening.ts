import {
  GraphQLError,
  Kind,
  NoSchemaIntrospectionCustomRule,
  type SelectionSetNode,
  type ValidationContext,
  type ValidationRule,
} from "graphql";
import type { Plugin } from "graphql-yoga";

/**
 * Deepest selection an operation may make. Project → owner → projects → …
 * stops being useful long before this, and a query built to recurse through
 * relations is the cheapest way to make one request cost a thousand.
 */
export const MAX_QUERY_DEPTH = 10;

/**
 * Most aliased fields an operation may declare. Aliases are how one request
 * asks for the same expensive field hundreds of times under different names.
 */
export const MAX_QUERY_ALIASES = 30;

function selectionDepth(
  selectionSet: SelectionSetNode,
  context: ValidationContext,
  visiting: Set<string>,
): number {
  let deepest = 0;
  for (const selection of selectionSet.selections) {
    if (selection.kind === Kind.FIELD) {
      // Introspection has its own rule below; its fixed shape is not a cost.
      if (selection.name.value.startsWith("__")) continue;
      const inner = selection.selectionSet
        ? selectionDepth(selection.selectionSet, context, visiting)
        : 0;
      deepest = Math.max(deepest, 1 + inner);
    } else if (selection.kind === Kind.INLINE_FRAGMENT) {
      deepest = Math.max(
        deepest,
        selectionDepth(selection.selectionSet, context, visiting),
      );
    } else {
      const name = selection.name.value;
      const fragment = context.getFragment(name);
      // A cycle is reported by GraphQL's own NoFragmentCycles rule.
      if (!fragment || visiting.has(name)) continue;
      visiting.add(name);
      deepest = Math.max(
        deepest,
        selectionDepth(fragment.selectionSet, context, visiting),
      );
      visiting.delete(name);
    }
  }
  return deepest;
}

export function maxDepthRule(maxDepth: number): ValidationRule {
  return (context) => ({
    OperationDefinition(node) {
      const depth = selectionDepth(node.selectionSet, context, new Set());
      if (depth > maxDepth) {
        context.reportError(
          new GraphQLError(
            `Operation is ${depth} levels deep; the limit is ${maxDepth}.`,
            { nodes: [node], extensions: { code: "BAD_USER_INPUT" } },
          ),
        );
      }
    },
  });
}

export function maxAliasesRule(maxAliases: number): ValidationRule {
  return (context) => {
    let aliases = 0;
    return {
      Field(node) {
        if (node.alias) aliases += 1;
      },
      Document: {
        leave(node) {
          if (aliases > maxAliases) {
            context.reportError(
              new GraphQLError(
                `Operation declares ${aliases} aliases; the limit is ${maxAliases}.`,
                { nodes: [node], extensions: { code: "BAD_USER_INPUT" } },
              ),
            );
          }
        },
      },
    };
  };
}

/**
 * The validation limits every deployment of this API applies.
 *
 * Introspection follows GraphiQL: where the explorer is on (development), the
 * schema can be read; where it is off, nobody outside the codebase needs to
 * enumerate it — the client ships its own generated types.
 */
export function graphqlHardening(options: {
  readonly allowIntrospection: boolean;
}): Plugin[] {
  const rules: ValidationRule[] = [
    maxDepthRule(MAX_QUERY_DEPTH),
    maxAliasesRule(MAX_QUERY_ALIASES),
    ...(options.allowIntrospection ? [] : [NoSchemaIntrospectionCustomRule]),
  ];
  return [
    {
      onValidate({ addValidationRule }) {
        for (const rule of rules) addValidationRule(rule);
      },
    },
  ];
}
