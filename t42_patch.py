#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Task 42 patch: arrow function sugar (=>) lowered to lambda (rudy-lang).

Idempotent, CRLF-aware, byte-preserving (surrogateescape). Targets
G:\\project\\rudy-lang. Run from the superagent CWD:  python t42_patch.py
"""
import os
import sys

ROOT = r"G:\project\rudy-lang"

FILES = {
    "token_h": os.path.join(ROOT, "include", "rudy", "frontend", "token.h"),
    "lexer_h": os.path.join(ROOT, "include", "rudy", "frontend", "lexer.h"),
    "lexer_c": os.path.join(ROOT, "src", "frontend", "lexer.c"),
    "expr_c": os.path.join(ROOT, "src", "frontend", "compiler_expr.c"),
    "format_c": os.path.join(ROOT, "src", "tooling", "format.c"),
    "grammar_md": os.path.join(ROOT, "docs", "grammar.md"),
    "grammar_ebnf": os.path.join(ROOT, "docs", "grammar.ebnf"),
    "changelog": os.path.join(ROOT, "CHANGELOG.md"),
}


def load(path):
    with open(path, "r", encoding="utf-8", errors="surrogateescape", newline="") as f:
        return f.read()


def save(path, text):
    with open(path, "w", encoding="utf-8", errors="surrogateescape", newline="") as f:
        f.write(text)


class Patcher(object):
    def __init__(self, name, path):
        self.name = name
        self.path = path
        self.text = load(path)
        self.eol = "\r\n" if "\r\n" in self.text else "\n"
        self.changed = False

    def ad(self, s):
        if self.eol == "\n":
            return s
        return s.replace("\n", "\r\n")

    def guarded(self, marker, old, new, label):
        if marker in self.text:
            print("  [%s] already patched: %s" % (self.name, label))
            return
        old_a, new_a = self.ad(old), self.ad(new)
        n = self.text.count(old_a)
        if n == 0:
            raise SystemExit("FAIL [%s] anchor not found (%s)" % (self.name, label))
        if n > 1:
            raise SystemExit("FAIL [%s] anchor x%d (%s)" % (self.name, n, label))
        self.text = self.text.replace(old_a, new_a, 1)
        self.changed = True
        print("  [%s] patched: %s" % (self.name, label))

    def append(self, marker, block, label):
        if marker in self.text:
            print("  [%s] already appended: %s" % (self.name, label))
            return
        block_a = self.ad(block)
        stripped = self.text.rstrip("\r\n")
        self.text = stripped + self.eol + self.eol + block_a + self.eol
        self.changed = True
        print("  [%s] appended: %s" % (self.name, label))

    def flush(self):
        if self.changed:
            save(self.path, self.text)
            print("  [%s] saved" % self.name)


PROBE_C = """/* Task 42: lookahead probe for paren-form arrow sugar `(a, b) => expr`.
 * Re-scans the source starting at `parenStart` (the '(' character) using a
 * throwaway copy of the lexer state: accepts ONLY `(a, b)`-shaped
 * bare-identifier parameter lists followed by '=>' (empty list `()` is
 * allowed; trailing comma rejected; no defaults/annotations in v1). Any
 * other token shape returns false so the caller falls back to normal
 * grouping/tuple parsing. The live lexer state is restored byte-exactly
 * before returning and parser state is never touched. */
bool lexerProbeArrowParams(const char* parenStart) {
    if (parenStart == NULL || parenStart[0] != '(') return false;
    Lexer saved = lexer;
    initLexer(parenStart);
    bool ok = false;
    Token t = scanToken();
    if (t.type == TOKEN_LPAREN) {
        t = scanToken();
        bool danglingComma = false;
        while (t.type == TOKEN_IDENTIFIER) {
            danglingComma = false;
            t = scanToken();
            if (t.type == TOKEN_COMMA) { danglingComma = true; t = scanToken(); }
        }
        if (t.type == TOKEN_RPAREN && !danglingComma) {
            t = scanToken();
            ok = (t.type == TOKEN_FAT_ARROW);
        }
    }
    lexer = saved;
    return ok;
}"""


FINISH_C = """/* Task 42: shared tail for lambda / arrow sugar - compile the single
 * expression body, close the nested function, and emit its closure.
 * declLine stamps OP_CLOSURE + the upvalue capture bytes (KI-28, Task 37). */
static void finishLambdaBody(int declLine, Compiler* fnCompiler) {
    expression();
    emitByte(OP_RETURN);

    ObjFunction* fn = endCompiler();
    push(OBJ_VAL(fn));
    int constIdx = makeConstant(OBJ_VAL(fn));
    emitConstOpAtLine(declLine, OP_CLOSURE, OP_CLOSURE_16, constIdx);

    for (int i = 0; i < fn->upvalueCount; i++) {
        emitByteAtLine(declLine, fnCompiler->upvalues[i].isLocal ? 1 : 0);
        emitByteAtLine(declLine, fnCompiler->upvalues[i].index);
    }
    pop();
}"""


ARROWS_C = """/* Task 42: arrow sugar, single bare parameter - `x => expr`. Entered from
 * variable() with parser.previous = the parameter identifier and
 * parser.current = '=>'. KI-28 style: the closure is stamped with the
 * '=>' token's line. */
static void arrowLambdaSingle(void) {
    Compiler compiler;
    initCompiler(&compiler, TYPE_FUNCTION);
    beginScope();

    current->function->arity++;
    if (current->function->arity > 255) {
        errorAtCurrent("Can't have more than 255 parameters.");
    }
    declareVariable(&parser.previous);
    markInitialized();

    consume(TOKEN_FAT_ARROW, "Expected '=>' after arrow parameter.");
    int declLine = parser.previous.line;
    finishLambdaBody(declLine, &compiler);
}

/* Task 42: arrow sugar, parenthesized parameter list - `(a, b) => expr`
 * or `() => expr`. Entered from grouping() with parser.previous = '('
 * after lexerProbeArrowParams() validated the token shape. Bare
 * identifiers only; trailing comma rejected (matches lambda). */
static void arrowLambdaParens(void) {
    Compiler compiler;
    initCompiler(&compiler, TYPE_FUNCTION);
    beginScope();

    if (!check(TOKEN_RPAREN)) {
        do {
            consume(TOKEN_IDENTIFIER, "Expected parameter name in arrow function.");
            current->function->arity++;
            if (current->function->arity > 255) {
                errorAtCurrent("Can't have more than 255 parameters.");
            }
            declareVariable(&parser.previous);
            markInitialized();
        } while (match(TOKEN_COMMA));
    }
    consume(TOKEN_RPAREN, "Expected ')' after arrow parameters.");
    consume(TOKEN_FAT_ARROW, "Expected '=>' after arrow parameters.");
    int declLine = parser.previous.line;
    finishLambdaBody(declLine, &compiler);
}"""


LAMBDA_TAIL_OLD = """    consume(TOKEN_COLON, "Expected ':' after lambda parameters.");

    expression();
    emitByte(OP_RETURN);

    ObjFunction* fn = endCompiler();
    push(OBJ_VAL(fn));
    int constIdx = makeConstant(OBJ_VAL(fn));
    /* KI-28 (Task 37): stamp the lambda closure with its keyword line. */
    emitConstOpAtLine(declLine, OP_CLOSURE, OP_CLOSURE_16, constIdx);

    for (int i = 0; i < fn->upvalueCount; i++) {
        emitByteAtLine(declLine, compiler.upvalues[i].isLocal ? 1 : 0);
        emitByteAtLine(declLine, compiler.upvalues[i].index);
    }
    pop();
}"""


LAMBDA_TAIL_NEW = """    consume(TOKEN_COLON, "Expected ':' after lambda parameters.");

    finishLambdaBody(declLine, &compiler);
}"""


CHANGELOG_ENTRY = """- **Arrow function sugar `params => expr` (Task 42)**: JS/TS-style arrows lower to
  the existing lambda machinery (same nested compiler, closure and upvalue
  pipeline; the emitted OP_CLOSURE carries the '=>' token's line, KI-28 style).
  Forms: `x => expr`, `(x) => expr`, `(x, y) => expr`, `() => expr`. The body is
  a single full expression, so nested arrows (currying `a => b => a + b`) and
  ternary bodies work. `==` and `>=` lexing are untouched; trailing comma and
  non-identifier parameter lists are rejected. Regression guard:
  benchmarks/repro_t42_arrow.rdy (16 checks)."""


def main():
    repro = os.path.join(ROOT, "benchmarks", "repro_t42_arrow.rdy")
    print("repro present:", os.path.isfile(repro))

    # ---- token.h ----------------------------------------------------------
    p = Patcher("token.h", FILES["token_h"])
    p.guarded("TOKEN_FAT_ARROW",
              "    TOKEN_ARROW,              // ->\n",
              "    TOKEN_ARROW,              // ->\n"
              "    TOKEN_FAT_ARROW,          // => (Task 42: arrow sugar, lowered to lambda)\n",
              "enum entry")
    p.flush()

    # ---- lexer.h ----------------------------------------------------------
    p = Patcher("lexer.h", FILES["lexer_h"])
    p.guarded("lexerProbeArrowParams",
              "Token scanToken(void);\n",
              "// Task 42: lookahead probe for paren-form arrow sugar `(a, b) => expr`.\n"
              "// Re-scans from `parenStart` (the '(' character) with a throwaway copy\n"
              "// of the lexer state; accepts only bare-identifier parameter lists\n"
              "// followed by '=>'. Restores the live lexer state before returning.\n"
              "bool lexerProbeArrowParams(const char* parenStart);\n"
              "Token scanToken(void);\n",
              "probe declaration")
    p.flush()

    # ---- lexer.c ----------------------------------------------------------
    p = Patcher("lexer.c", FILES["lexer_c"])
    p.guarded('case TOKEN_FAT_ARROW: return "=>"',
              '        case TOKEN_ARROW: return "->";\n',
              '        case TOKEN_ARROW: return "->";\n'
              '        case TOKEN_FAT_ARROW: return "=>";\n',
              "tokenTypeToString")
    p.guarded("if (match('>')) return makeToken(TOKEN_FAT_ARROW)",
              "            case '=':\n"
              "                return makeToken(match('=') ? TOKEN_EQUAL_EQUAL : TOKEN_EQUAL);\n",
              "            case '=':\n"
              "                // Task 42: `=>` arrow sugar wins over `==`/`=`; the\n"
              "                // `>=` path (case '>') is untouched.\n"
              "                if (match('>')) return makeToken(TOKEN_FAT_ARROW);\n"
              "                return makeToken(match('=') ? TOKEN_EQUAL_EQUAL : TOKEN_EQUAL);\n",
              "case '=' three-way")
    p.append("bool lexerProbeArrowParams(const char* parenStart) {", PROBE_C, "probe function")
    p.flush()

    # ---- compiler_expr.c --------------------------------------------------
    p = Patcher("compiler_expr.c", FILES["expr_c"])
    p.guarded("static void arrowLambdaSingle(void);",
              "#include <string.h>\n\nstatic bool tryFoldBinary",
              "#include <string.h>\n\n"
              "/* Task 42: arrow-sugar lowerers (defined near lambdaExpression). */\n"
              "static void arrowLambdaParens(void);\n"
              "static void arrowLambdaSingle(void);\n\n"
              "static bool tryFoldBinary",
              "forward declarations")
    p.guarded("lexerProbeArrowParams(parser.previous.start)",
              "void grouping(bool canAssign) {\n"
              "    (void)canAssign;\n"
              "    if (check(TOKEN_RPAREN)) {\n",
              "void grouping(bool canAssign) {\n"
              "    (void)canAssign;\n"
              "    /* Task 42: `(params) => expr` arrow sugar. Must run before the\n"
              "     * empty-tuple branch so `() => expr` is not read as an empty\n"
              "     * tuple. The probe validates the raw token shape without\n"
              "     * touching parser or lexer state. */\n"
              "    if (lexerProbeArrowParams(parser.previous.start)) {\n"
              "        arrowLambdaParens();\n"
              "        return;\n"
              "    }\n"
              "    if (check(TOKEN_RPAREN)) {\n",
              "grouping hook")
    p.guarded("arrowLambdaSingle();",
              "void variable(bool canAssign) {\n"
              "    namedVariable(parser.previous, canAssign);\n"
              "}\n",
              "void variable(bool canAssign) {\n"
              "    /* Task 42: bare-param arrow sugar `x => expr` - lower to a\n"
              "     * one-param lambda instead of reading the identifier as a\n"
              "     * variable. */\n"
              "    if (check(TOKEN_FAT_ARROW)) {\n"
              "        arrowLambdaSingle();\n"
              "        return;\n"
              "    }\n"
              "    namedVariable(parser.previous, canAssign);\n"
              "}\n",
              "variable hook")
    p.guarded("static void finishLambdaBody(int declLine, Compiler* fnCompiler)",
              "void lambdaExpression(bool canAssign) {",
              FINISH_C + "\n\nvoid lambdaExpression(bool canAssign) {",
              "finishLambdaBody before lambdaExpression")
    p.guarded("finishLambdaBody(declLine, &compiler);\n}",
              LAMBDA_TAIL_OLD, LAMBDA_TAIL_NEW, "lambda tail refactor")
    p.guarded("static void arrowLambdaParens(void) {",
              "void awaitExpression(bool canAssign) {",
              ARROWS_C + "\n\nvoid awaitExpression(bool canAssign) {",
              "arrow lowerers before awaitExpression")
    p.flush()

    # ---- format.c ---------------------------------------------------------
    p = Patcher("format.c", FILES["format_c"])
    p.guarded("case TOKEN_FAT_ARROW:",
              "        case TOKEN_ARROW: /* -> return type annotation */\n",
              "        case TOKEN_ARROW: /* -> return type annotation */\n"
              "        case TOKEN_FAT_ARROW: /* => arrow sugar (Task 42) */\n",
              "isBinaryOp")
    p.flush()

    # ---- docs/grammar.md --------------------------------------------------
    p = Patcher("grammar.md", FILES["grammar_md"])
    p.guarded("arrow_expression",
              "| Lambda          | `lambda_expression`       | `lambda x: x + 1` |\n",
              "| Lambda          | `lambda_expression`       | `lambda x: x + 1` |\n"
              "| Arrow fn        | `arrow_expression`        | `x => x * 2` |\n",
              "feature table row")
    p.flush()

    # ---- docs/grammar.ebnf ------------------------------------------------
    p = Patcher("grammar.ebnf", FILES["grammar_ebnf"])
    p.guarded("| arrow_expression",
              "expression           = ternary_expression\n"
              "                      | lambda_expression\n"
              "                      | yield_expression\n"
              "                      ;\n",
              "expression           = ternary_expression\n"
              "                      | lambda_expression\n"
              "                      | arrow_expression\n"
              "                      | yield_expression\n"
              "                      ;\n",
              "expression alternatives")
    p.guarded("arrow_expression     =",
              'lambda_expression    = "lambda" [ parameters ] ":" expression ;\n',
              'lambda_expression    = "lambda" [ parameters ] ":" expression ;\n'
              "\n"
              "(* Task 42: JS/TS-style arrow sugar, lowered to a lambda at compile\n"
              "   time. Bare identifiers only; trailing comma rejected. *)\n"
              "arrow_expression     = identifier \"=>\" expression\n"
              '                      | "(" [ identifier { "," identifier } ] ")" "=>" expression\n'
              "                      ;\n",
              "arrow rules")
    p.flush()

    # ---- CHANGELOG.md -----------------------------------------------------
    p = Patcher("CHANGELOG.md", FILES["changelog"])
    p.guarded("(Task 42)**",
              "### Added\n\n- **Task 41:",
              "### Added\n\n" + CHANGELOG_ENTRY + "\n\n- **Task 41:",
              "unreleased entry")
    p.flush()

    print("ALL PATCHES OK")


if __name__ == "__main__":
    main()
