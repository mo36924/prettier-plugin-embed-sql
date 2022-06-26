import { TSESTree } from "@typescript-eslint/types";
import { AstPath, Doc, Parser, Plugin } from "prettier";
import { builders, utils } from "prettier/doc";
import babel from "prettier/parser-babel";
import typescript from "prettier/parser-typescript";

type Node = TSESTree.Node & {
  comments?: (TSESTree.Comment & { leading?: boolean })[];
};
const { group, indent, join, hardline, softline, lineSuffixBoundary } = builders;
const { mapDoc, cleanDoc } = utils;
const replaceEndOfLine: (doc: Doc) => Doc = (utils as any).replaceEndOfLine;

let init = true;

const createParser = (parser: Parser): Parser => ({
  ...parser,
  preprocess(text, options) {
    if (init) {
      init = false;

      const estree = options.plugins
        .filter((plugin): plugin is Plugin => typeof plugin !== "string")
        .find((plugin) => plugin.printers?.estree)!.printers!.estree;

      const embed = estree.embed!;

      estree.embed = (path, print, textToDoc, options) => {
        const node: Node = path.getValue();

        if (node.type !== "TemplateLiteral" || node.quasis.some((quasi) => quasi.value.cooked === null)) {
          return null;
        }

        if (
          node.comments?.some?.(
            ({ type, leading, value }) => type === "Block" && leading && (value === " sql " || value === " SQL "),
          ) ||
          path.match(
            (node) => node.type === "TemplateLiteral",
            (node, name) =>
              node.type === "TaggedTemplateExpression" &&
              node.tag.type === "Identifier" &&
              node.tag.name === "sql" &&
              name === "quasi",
          )
        ) {
          const sql = node.quasis
            .map((quasi) => quasi.value.cooked)
            .reduce((sql, quasi, i) => `${sql}PRETTIER_SQL_PLACEHOLDER_${i - 1}_IN_JS${quasi}`);

          if (!sql.trim()) {
            return "``";
          }

          const doc: Doc = join(
            hardline,
            (textToDoc as any)(sql, { parser: "sql" }, { stripTrailingHardline: true }).split("\n"),
          );

          const expressionDocs = path.map((path: AstPath<any>) => {
            const node: Node = path.getValue();
            let printed: Doc = (print as any)();

            if (node.comments?.length) {
              printed = group([indent([softline, printed]), softline]);
            }

            return ["${", printed, lineSuffixBoundary, "}"];
          }, "expressions");

          let expressionCount = 0;

          const newDoc = mapDoc(cleanDoc(doc), (doc) => {
            if (typeof doc !== "string") {
              return doc;
            }

            return doc.split(/PRETTIER_SQL_PLACEHOLDER_(\d+)_IN_JS/).map((component, i) => {
              if (i % 2 === 0) {
                return replaceEndOfLine(component);
              }

              expressionCount++;
              return expressionDocs[Number(component)];
            });
          });

          if (expressionDocs.length !== expressionCount) {
            throw new Error("Couldn't insert all the expressions");
          }

          return ["`", indent([hardline, newDoc]), softline, "`"];
        }

        return embed(path, print, textToDoc, options);
      };
    }

    const preprocess = parser.preprocess;
    return preprocess ? preprocess(text, options) : text;
  },
});

export const parsers: Plugin["parsers"] = {
  babel: createParser(babel.parsers.babel),
  typescript: createParser(typescript.parsers.typescript),
};
