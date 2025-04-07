use std::fmt;
use std::marker::PhantomData;
use std::ops::Deref;

use chumsky::input::{Cursor, InputRef, MapExtra, ValueInput};
use chumsky::pratt::{infix, left};
use chumsky::prelude::*;
use chumsky::Parser;
use serde::{Deserialize, Serialize};

use crate::lexer::Token;
use crate::Spanned;

#[derive(Clone, Debug, PartialEq, Hash, Eq, Serialize, Deserialize)]
pub struct Symbol(String);

impl Deref for Symbol {
    type Target = String;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl fmt::Display for Symbol {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl From<Symbol> for String {
    fn from(symbol: Symbol) -> Self {
        symbol.0
    }
}

impl From<String> for Symbol {
    fn from(s: String) -> Self {
        Symbol(s)
    }
}

impl From<&str> for Symbol {
    fn from(s: &str) -> Self {
        Symbol(s.to_string())
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Stmt {
    // from "file.ato" import Module
    Import(ImportStmt),

    // import Module from "file.ato"
    DepImport(DepImportStmt),

    // v: voltage
    Attribute(AttributeStmt),

    // r1 = new Resistor
    // r1: Resistor = new Resistor
    Assign(AssignStmt),

    // m.xtal -> ecsXXX
    Specialize(SpecializeStmt),

    // a ~ b
    Connect(ConnectStmt),

    // module M:
    // component C:
    // interface I:
    Block(BlockStmt),

    // signal a
    Signal(SignalStmt),

    // pin A1
    Pin(PinStmt),

    // assert 10kohm within 5%
    Assert(AssertStmt),

    // # comment
    Comment(CommentStmt),

    // pass
    Pass,

    // Parse Error
    ParseError(String),
}

impl Stmt {
    pub fn spanned_error(msg: &str, span: SimpleSpan) -> Spanned<Self> {
        (Self::ParseError(msg.to_string()), span).into()
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ImportStmt {
    pub from_path: Spanned<String>,
    pub imports: Vec<Spanned<Symbol>>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DepImportStmt {
    pub name: Spanned<Symbol>,
    pub from_path: Spanned<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AttributeStmt {
    pub name: Spanned<Symbol>,
    pub type_info: Spanned<Symbol>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AssignStmt {
    pub target: Spanned<PortRef>,
    pub type_info: Option<Spanned<String>>,
    pub value: Spanned<Expr>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ConnectStmt {
    pub left: Spanned<Connectable>,
    pub right: Spanned<Connectable>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PortRef {
    pub parts: Vec<Spanned<String>>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub enum Connectable {
    Port(Spanned<PortRef>),
    Pin(Spanned<String>),
    Signal(Spanned<String>),
}

#[derive(Debug, Clone, PartialEq)]
pub struct BlockStmt {
    pub kind: Spanned<BlockKind>,
    pub name: Spanned<Symbol>,
    pub parent: Option<Spanned<Symbol>>,
    pub body: Vec<Spanned<Stmt>>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum BlockKind {
    Component,
    Module,
    Interface,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ComponentStmt(pub Spanned<BlockStmt>);

#[derive(Debug, Clone, PartialEq)]
pub struct ModuleStmt(pub Spanned<BlockStmt>);

#[derive(Debug, Clone, PartialEq)]
pub struct InterfaceStmt(pub Spanned<BlockStmt>);

#[derive(Debug, Clone, PartialEq)]
pub struct SignalStmt {
    pub name: Spanned<Symbol>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PinStmt {
    pub name: Spanned<Symbol>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AssertStmt {
    pub expr: Spanned<Expr>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CommentStmt {
    pub comment: Spanned<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SpecializeStmt {
    pub port: Spanned<PortRef>,
    pub value: Spanned<Symbol>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Expr {
    String(Spanned<String>),
    Number(Spanned<String>),
    Port(Spanned<PortRef>),
    New(Spanned<Symbol>),
    Bool(Spanned<bool>),
    BinaryOp(Box<Spanned<BinaryOp>>),
    Physical(Spanned<PhysicalValue>),
}

#[derive(Debug, Clone, PartialEq)]
pub struct BinaryOp {
    pub left: Spanned<Expr>,
    pub op: Spanned<BinaryOperator>,
    pub right: Spanned<Expr>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum BinaryOperator {
    Add,
    Sub,
    Mul,
    Div,
    Pow,
    Eq,
    Neq,
    Gt,
    Gte,
    Lt,
    Lte,
    Within,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PhysicalValue {
    pub value: Spanned<String>,
    pub unit: Option<Spanned<String>>,
    pub tolerance: Option<Spanned<Tolerance>>,
}

impl std::fmt::Display for PhysicalValue {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{}{} {}",
            self.value.0,
            self.unit
                .as_ref()
                .map(|u| u.0.to_string())
                .unwrap_or("".to_string()),
            self.tolerance
                .as_ref()
                .map(|t| t.to_string())
                .unwrap_or("".to_string())
        )
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub enum Tolerance {
    Bilateral {
        value: Spanned<String>,
        unit: Option<Spanned<String>>,
    },
    Bound {
        min: Spanned<String>,
        max: Spanned<String>,
    },
}

impl std::fmt::Display for Tolerance {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Tolerance::Bilateral { value, unit } => {
                write!(
                    f,
                    "± {}{}",
                    value.0,
                    unit.as_ref()
                        .map(|u| u.0.to_string())
                        .unwrap_or("%".to_string())
                )
            }
            Tolerance::Bound { min, max } => {
                write!(f, "({} to {})", min.0, max.0)
            }
        }
    }
}

impl std::fmt::Display for PortRef {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{}",
            self.parts
                .iter()
                .map(|p| p.0.as_str())
                .collect::<Vec<&str>>()
                .join(".")
        )
    }
}

#[derive(Debug, Clone, PartialEq)]
struct BlockHeader {
    kind: Spanned<BlockKind>,
    name: Spanned<Symbol>,
    parent: Option<Spanned<Symbol>>,
}

type ParserError<'src> = Rich<'src, Token<'src>, SimpleSpan>;
type ParserExtra<'src> = extra::Err<ParserError<'src>>;

struct AtopileParser<'src, I: ValueInput<'src, Token = Token<'src>, Span = SimpleSpan>> {
    phantom: PhantomData<(&'src (), I)>,
}

impl<'src, I: ValueInput<'src, Token = Token<'src>, Span = SimpleSpan>> AtopileParser<'src, I> {
    fn atom() -> impl Parser<'src, I, Spanned<Expr>, ParserExtra<'src>> + Clone {
        select! {
            Token::String(s) = e => Expr::String((s.to_string(), e.span()).into()),
            Token::Number(n) = e => Expr::Number((n.to_string(), e.span()).into()),
            Token::True = e => Expr::Bool((true, e.span()).into()),
            Token::False = e => Expr::Bool((false, e.span()).into()),
        }
        .or(Self::port_ref().map(|p| Expr::Port(p.clone())))
        .map_with(|expr, e| (expr, e.span()).into())
    }

    fn new() -> impl Parser<'src, I, Spanned<Expr>, ParserExtra<'src>> + Clone {
        just(Token::New)
            .ignore_then(Self::name())
            .map_with(|name, e| (Expr::New(name.map(Symbol::from)), e.span()).into())
    }

    fn physical() -> impl Parser<'src, I, Spanned<Expr>, ParserExtra<'src>> + Clone {
        let signed_number = just(Token::Minus)
            .or_not()
            .then(Self::number())
            .map(|(sign, num)| match sign {
                Some(_) => Spanned(format!("-{}", num.0), num.span().start - 1..num.span().end),
                None => num,
            });

        signed_number
            .then(Self::name().or_not())
            .then(Self::tolerance().or_not())
            .map_with(|((value, unit), tol), e| {
                Expr::Physical(
                    (
                        PhysicalValue {
                            value,
                            unit,
                            tolerance: tol,
                        },
                        e.span(),
                    )
                        .into(),
                )
            })
            .map_with(|expr, e| (expr, e.span()).into())
    }

    fn signal() -> impl Parser<'src, I, Spanned<Stmt>, ParserExtra<'src>> + Clone {
        just(Token::Signal)
            .ignore_then(Self::name())
            .map(|name| {
                Stmt::Signal(SignalStmt {
                    name: name.map(Symbol::from),
                })
            })
            .map_with(|stmt, e| (stmt, e.span()).into())
            .labelled("signal")
    }

    fn port_ref() -> impl Parser<'src, I, Spanned<PortRef>, ParserExtra<'src>> + Clone {
        choice((Self::name(), Self::number()))
            .separated_by(just(Token::Dot))
            .at_least(1)
            .collect()
            .map(|parts| PortRef { parts })
            .map_with(|port_ref, e| (port_ref, e.span()).into())
            .labelled("port_ref")
    }

    fn name() -> impl Parser<'src, I, Spanned<String>, ParserExtra<'src>> + Clone {
        select! { Token::Name(n) = e => (n.to_string(), e.span()).into() }
    }

    fn number() -> impl Parser<'src, I, Spanned<String>, ParserExtra<'src>> + Clone {
        select! { Token::Number(n) = e => (n.to_string(), e.span()).into() }
    }

    fn string() -> impl Parser<'src, I, Spanned<String>, ParserExtra<'src>> + Clone {
        select! { Token::String(s) = e => (s.to_string(), e.span()).into() }
    }

    fn tolerance() -> impl Parser<'src, I, Spanned<Tolerance>, ParserExtra<'src>> + Clone {
        let signed_number = || {
            just(Token::Minus)
                .or_not()
                .then(Self::number())
                .map(|(sign, num)| match sign {
                    Some(_) => Spanned(format!("-{}", num.0), num.span().start - 1..num.span().end),
                    None => num,
                })
        };

        let bilateral = just(Token::PlusOrMinus)
            .ignore_then(signed_number())
            .then(just(Token::Percent).to(None).or(Self::name().map(Some)))
            .map(|(value, unit)| Tolerance::Bilateral { value, unit });

        let bound = just(Token::To)
            .ignore_then(signed_number())
            .then(Self::name().or_not())
            .map(|(max, _unit)| Tolerance::Bound {
                min: ("0".to_string(), 0..0).into(),
                max,
            });

        choice((bilateral, bound)).map_with(|tolerance, e| (tolerance, e.span()).into())
    }

    fn connectable() -> impl Parser<'src, I, Spanned<Connectable>, ParserExtra<'src>> + Clone {
        let name_or_string_or_number = || choice((Self::name(), Self::number(), Self::string()));

        choice((
            just(Token::Pin).ignore_then(name_or_string_or_number().map(Connectable::Pin)),
            Self::port_ref().map(Connectable::Port),
            just(Token::Signal).ignore_then(name_or_string_or_number().map(Connectable::Signal)),
        ))
        .map_with(|connectable, e| (connectable, e.span()).into())
        .labelled("connectable")
    }

    fn comment() -> impl Parser<'src, I, Spanned<Stmt>, ParserExtra<'src>> + Clone {
        select! { Token::Comment(c) = e => (c.to_string(), e.span()).into() }
            .map(|comment| Stmt::Comment(CommentStmt { comment }))
            .map_with(|stmt, e| (stmt, e.span()).into())
            .labelled("comment")
    }

    fn specialize() -> impl Parser<'src, I, Spanned<Stmt>, ParserExtra<'src>> + Clone {
        Self::port_ref()
            .then_ignore(just(Token::Arrow))
            .then(Self::name())
            .map(|(port, value)| {
                Stmt::Specialize(SpecializeStmt {
                    port,
                    value: value.map(Symbol::from),
                })
            })
            .map_with(|stmt, e| (stmt, e.span()).into())
            .labelled("specialize")
    }

    fn expr() -> impl Parser<'src, I, Spanned<Expr>, ParserExtra<'src>> + Clone {
        let op = |tok: Token<'src>, op: BinaryOperator| {
            just(tok).to(op).map_with(|op, e| (op, e.span()).into())
        };

        let pratt_infix = |left: Spanned<Expr>,
                           op: Spanned<BinaryOperator>,
                           right: Spanned<Expr>,
                           e: &mut MapExtra<'src, '_, I, ParserExtra<'src>>|
         -> Spanned<Expr> {
            (
                Expr::BinaryOp(Box::new((BinaryOp { left, op, right }, e.span()).into())),
                e.span(),
            )
                .into()
        };

        // TODO: Fix operator precedence
        let operand = choice((Self::physical(), Self::new(), Self::atom()));
        operand.pratt((
            infix(left(2), op(Token::Star, BinaryOperator::Mul), pratt_infix),
            infix(left(2), op(Token::Plus, BinaryOperator::Add), pratt_infix),
            infix(left(2), op(Token::Minus, BinaryOperator::Sub), pratt_infix),
            infix(left(2), op(Token::Div, BinaryOperator::Div), pratt_infix),
            infix(left(2), op(Token::Eq, BinaryOperator::Eq), pratt_infix),
            infix(left(2), op(Token::Gt, BinaryOperator::Gt), pratt_infix),
            infix(left(2), op(Token::GtEq, BinaryOperator::Gte), pratt_infix),
            infix(left(2), op(Token::Lt, BinaryOperator::Lt), pratt_infix),
            infix(left(2), op(Token::LtEq, BinaryOperator::Lte), pratt_infix),
            infix(
                left(2),
                op(Token::Within, BinaryOperator::Within),
                pratt_infix,
            ),
        ))
    }

    fn top_stmt() -> impl Parser<'src, I, Spanned<Stmt>, ParserExtra<'src>> + Clone {
        let import = just(Token::From)
            .ignore_then(Self::string())
            .then_ignore(just(Token::Import))
            .then(
                Self::name()
                    .separated_by(just(Token::Comma))
                    .collect::<Vec<_>>(),
            )
            .map(|(path, imports)| {
                Stmt::Import(ImportStmt {
                    from_path: path,
                    imports: imports.into_iter().map(|s| s.map(Symbol::from)).collect(),
                })
            })
            .map_with(|stmt, e| (stmt, e.span()).into());

        // Dep import statements (import x from "path")
        let dep_import = just(Token::Import)
            .ignore_then(Self::name())
            .then_ignore(just(Token::From))
            .then(Self::string())
            .map(|(name, path)| {
                Stmt::DepImport(DepImportStmt {
                    name: name.map(Symbol::from),
                    from_path: path,
                })
            })
            .map_with(|stmt, e| (stmt, e.span()).into());

        // Combine all statement types
        choice((import, dep_import, Self::comment()))
    }

    fn block_header() -> impl Parser<'src, I, Spanned<BlockHeader>, ParserExtra<'src>> + Clone {
        choice((
            just(Token::Component)
                .map(|_| BlockKind::Component)
                .map_with(|kind, e| (kind, e.span()).into()),
            just(Token::Module)
                .map(|_| BlockKind::Module)
                .map_with(|kind, e| (kind, e.span()).into()),
            just(Token::Interface)
                .map(|_| BlockKind::Interface)
                .map_with(|kind, e| (kind, e.span()).into()),
        ))
        .then(Self::name())
        .then(just(Token::From).ignore_then(Self::name()).or_not())
        .then_ignore(just(Token::Colon))
        .map_with(|((kind, name), parent), e| {
            (
                BlockHeader {
                    kind,
                    name: name.map(Symbol::from),
                    parent: parent.map(|p| p.map(Symbol::from)),
                },
                e.span(),
            )
                .into()
        })
    }

    fn block_stmt() -> impl Parser<'src, I, Spanned<Stmt>, ParserExtra<'src>> + Clone {
        // Signal and Pin declarations
        let pin = just(Token::Pin)
            .ignore_then(choice((Self::name(), Self::number(), Self::string())))
            .map(|name| {
                Stmt::Pin(PinStmt {
                    name: name.map(Symbol::from),
                })
            })
            .map_with(|stmt, e| (stmt, e.span()).into());

        // Attribute statements
        let type_info = || just(Token::Colon).ignore_then(Self::name());
        let attribute = Self::name()
            .then(type_info())
            .map(|(name, type_info)| {
                Stmt::Attribute(AttributeStmt {
                    name: name.map(Symbol::from),
                    type_info: type_info.map(Symbol::from),
                })
            })
            .map_with(|stmt, e| (stmt, e.span()).into());

        // Assignment statements
        let assign = Self::port_ref()
            .then(type_info().or_not())
            .then_ignore(just(Token::Equals))
            .then(Self::expr())
            .map(|((target, type_info), value)| {
                Stmt::Assign(AssignStmt {
                    target,
                    value,
                    type_info,
                })
            })
            .map_with(|stmt, e| (stmt, e.span()).into());

        // Connection statements
        let connect = Self::connectable()
            .then_ignore(just(Token::Tilde))
            .then(Self::connectable())
            .map(|(left, right)| Stmt::Connect(ConnectStmt { left, right }))
            .map_with(|stmt, e| (stmt, e.span()).into());

        // Pass statement
        let pass = just(Token::Pass)
            .map(|_| Stmt::Pass)
            .map_with(|stmt, e| (stmt, e.span()).into());

        // Assert statement
        let assert = just(Token::Assert)
            .ignore_then(Self::expr())
            .map(|expr| Stmt::Assert(AssertStmt { expr }))
            .map_with(|stmt, e| (stmt, e.span()).into())
            .labelled("assert");

        choice((
            assert,
            Self::specialize(),
            assign,
            attribute,
            connect,
            Self::signal(),
            pin,
            pass,
            Self::comment(),
        ))
    }

    pub fn parser() -> impl Parser<'src, I, Vec<Spanned<Stmt>>, ParserExtra<'src>> {
        // Drive the top-level parsing. We implement this manually to implement
        // our own error recovery and diagnostics.
        custom(|mut inp| {
            let skip_separators = |inp: &mut InputRef<'src, '_, I, ParserExtra<'src>>| {
                while matches!(inp.peek(), Some(Token::Newline) | Some(Token::Semicolon)) {
                    inp.next();
                }
            };

            let skip_statement = |inp: &mut InputRef<'src, '_, I, ParserExtra<'src>>| {
                while !matches!(
                    inp.peek(),
                    None | Some(Token::Newline) | Some(Token::Semicolon)
                ) {
                    inp.next();
                }
            };

            let mut ast = Vec::new();

            // The current block and the cursor of the start of the block.
            let mut current_block = None::<(BlockStmt, Cursor<'src, '_, I>)>;

            let mut prev_cursor = None::<Cursor<'src, '_, I>>;
            while inp.peek().is_some() {
                if prev_cursor == Some(inp.cursor()) {
                    return Err(Rich::custom(
                        inp.span_since(&prev_cursor.unwrap()),
                        "internal error: infinite loop",
                    ));
                }

                prev_cursor = Some(inp.cursor());

                skip_separators(&mut inp);

                let checkpoint = inp.save();

                if let Some((ref mut block, ref start_cursor)) = current_block {
                    // We are in a multi-line block, so let's try to parse a block statement.
                    let result = inp.parse(Self::block_stmt());
                    if let Ok(stmt) = result {
                        block.body.push(stmt);
                        continue;
                    }

                    // We can't parse a block statement, so let's see if we found a dedent.
                    inp.rewind(checkpoint.clone());
                    if inp.peek() == Some(Token::Dedent) {
                        inp.next();
                        ast.push(
                            (Stmt::Block(block.clone()), inp.span_since(&start_cursor)).into(),
                        );
                        current_block = None;
                        continue;
                    }

                    // If we can't find either, let's skip to the next line and report an error.
                    skip_statement(&mut inp);

                    ast.push(Stmt::spanned_error(
                        "syntax error",
                        inp.span_since(checkpoint.cursor()),
                    ));
                } else {
                    // Try to parse a normal top statement.
                    let result = inp.parse(Self::top_stmt());
                    if let Ok(stmt) = result {
                        ast.push(stmt);
                        continue;
                    }

                    // Not a normal top statement, so let's try to parse a block header.
                    inp.rewind(checkpoint.clone());
                    let result = inp.parse(Self::block_header());
                    if let Ok(header) = result {
                        // We have two kinds of blocks: single-line and multi-line.
                        let mut is_multiline = false;
                        while inp.peek() == Some(Token::Newline) {
                            inp.next();
                            is_multiline = true;
                        }

                        if is_multiline {
                            if inp.peek() != Some(Token::Indent) {
                                ast.push(Stmt::spanned_error(
                                    "syntax error: expected indent after block header",
                                    inp.span_since(checkpoint.cursor()),
                                ));
                            } else {
                                // Skip the indent
                                inp.next();

                                current_block = Some((
                                    BlockStmt {
                                        kind: header.kind.clone(),
                                        name: header.name.clone(),
                                        parent: header.parent.clone(),
                                        body: Vec::new(),
                                    },
                                    checkpoint.cursor().clone(),
                                ));
                            }
                        } else {
                            // This is a single-line block, so let's look for
                            // statement separated by semicolons.
                            let mut block = BlockStmt {
                                kind: header.kind.clone(),
                                name: header.name.clone(),
                                parent: header.parent.clone(),
                                body: Vec::new(),
                            };

                            let block_checkpoint = inp.save();
                            loop {
                                let stmt_checkpoint = inp.save();
                                let result = inp.parse(Self::block_stmt());
                                if let Ok(stmt) = result {
                                    block.body.push(stmt);
                                } else {
                                    inp.rewind(stmt_checkpoint.clone());
                                    while !matches!(
                                        inp.peek(),
                                        None | Some(Token::Newline) | Some(Token::Semicolon)
                                    ) {
                                        inp.next();
                                    }

                                    ast.push(Stmt::spanned_error(
                                        "syntax error",
                                        inp.span_since(&stmt_checkpoint.cursor()),
                                    ));
                                }

                                if inp.peek() != Some(Token::Semicolon) {
                                    ast.push(
                                        (
                                            Stmt::Block(block),
                                            inp.span_since(&block_checkpoint.cursor()),
                                        )
                                            .into(),
                                    );
                                    break;
                                }

                                inp.next();
                            }
                        }

                        continue;
                    }

                    // We didn't find a regular top statement or block header, so fail.
                    inp.rewind(checkpoint.clone());
                    skip_statement(&mut inp);

                    ast.push(Stmt::spanned_error(
                        "syntax error: unexpected top-level statement",
                        inp.span_since(checkpoint.cursor()),
                    ));
                }
            }

            // If we ended in the middle of a block, add the block to the AST.
            if let Some((ref mut block, ref start_cursor)) = current_block {
                ast.push((Stmt::Block(block.clone()), inp.span_since(&start_cursor)).into());
            }

            Ok(ast)
        })
    }
}

pub fn parse<'src>(
    tokens: &'src [Spanned<Token<'src>>],
) -> (Vec<Spanned<Stmt>>, Vec<Rich<'src, Token<'src>>>) {
    let mapped_input = Input::map(tokens, tokens.len()..tokens.len(), |t| (&t.0, &t.1))
        .map_span(|span| span.into());

    let result = AtopileParser::parser().parse(mapped_input);
    (
        result.output().map(|v| v.clone()).unwrap_or(vec![]),
        result.errors().map(|e| e.clone()).collect(),
    )
}

#[cfg(test)]
mod tests {
    use insta::assert_debug_snapshot;

    use super::*;

    macro_rules! test_parser {
        // Version with just input string - uses full parse()
        ($name:ident, $input:expr) => {
            #[test]
            fn $name() {
                let (tokens, lex_errors) = crate::lexer::lex($input);
                assert!(lex_errors.is_empty(), "Lexer errors: {:?}", lex_errors);
                let result = parse(&tokens);
                assert_debug_snapshot!(result);
            }
        };
        // Version with specific parser function
        ($name:ident, $parser:expr, $input:expr) => {
            #[test]
            fn $name() {
                let (tokens, lex_errors) = crate::lexer::lex($input);
                assert!(lex_errors.is_empty(), "Lexer errors: {:?}", lex_errors);

                let mapped_input =
                    chumsky::input::Input::map(&tokens[..], tokens.len()..tokens.len(), |t| {
                        (&t.0, &t.1)
                    })
                    .map_span(|span| span.into());

                let result = $parser.parse(mapped_input);
                assert_debug_snapshot!(result);
            }
        };
    }

    test_parser!(
        test_physical_basic,
        AtopileParser::physical(),
        "10kohm +/- 5%"
    );

    test_parser!(test_physical_negative, AtopileParser::physical(), "-0.3V");

    test_parser!(
        test_full_parse,
        "module Test:
            r1 = new Resistor
            r1 ~ pin A1
            assert 10kohm +/- 5%"
    );

    test_parser!(test_port_ref_simple, AtopileParser::port_ref(), "a");

    test_parser!(test_port_ref_nested, AtopileParser::port_ref(), "a.b.c");

    test_parser!(
        test_assert_range,
        AtopileParser::block_stmt(),
        "assert a within 10kohm to 20kohm"
    );

    test_parser!(
        test_signal_pin_connect,
        AtopileParser::block_stmt(),
        "signal a ~ pin A1"
    );

    test_parser!(test_assert, AtopileParser::block_stmt(), "assert 10kohm");

    test_parser!(
        test_assign,
        AtopileParser::block_stmt(),
        "r1 = new Resistor"
    );

    test_parser!(
        test_specialize,
        AtopileParser::block_stmt(),
        "u1.a -> Resistor"
    );

    test_parser!(
        test_nested_blocks_fail,
        "module M:
            r1 = new Resistor
            component C:
                r1 = new Resistor
                r1 ~ pin A1
                assert 10kohm within 5%"
    );
}
